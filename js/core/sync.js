// 同步引擎：本地优先，远程后端可插拔。
// browser 后端 = chrome.storage.sync（Edge/Chrome 账号同步），逐记录读写；
// webdav 后端 = 用户自己的 WebDAV 网盘（坚果云等），分文件快照，见下方说明。
// 同步配置只存本机（store.js 的 loadSyncConf），永不参与同步。
//
// 数据通路：store.js 的 loadUnits / saveUnit / removeUnit / removeUnits。
// **合并粒度是「存储记录」，不是「逻辑段」**：groups 被拆成
// monk.groupidx.v1 + 每个分组一条 monk.group.<id>.v1，于是
// 单个分组数据量再大也不会连累其他分组，49 个站点的 8KB 天花板被摊到每组。
//
// 分组索引不能「整份覆盖」——两台各自加过分组的设备一同步就会丢一边。
// 所以索引按「并集 + 墓碑」合并：
//   - 两边都有的 id：保留，顺序以较新的索引为准
//   - 只有一边有的 id：保留（那是另一边还没同步到的新增）
//   - 墓碑里有的 id：一律真删，本地记录一并清掉
// 删除策略是「删除赢」，不看记录时间：索引里没有逐条删除的时间可比较，
// 补时间比较反而会造出「甲删了、乙离线改过名，组又活了」的僵尸分组。
// 代价与边界（写在这里免得下次有人以为是 bug）：
//   1) A 删组、B 同时编辑该组 → B 的这次编辑会被静默丢弃（删除赢的必然结果）
//   2) 墓碑本身有 TTL：90 天过期、最多留 60 条（见 store.js 的 TOMB_TTL / TOMB_MAX）。
//      所以离线超过 90 天的设备再上线，被删的分组可能被它带回来。
//   3) 逐条删除（storage 里某 key 消失）不单独传播，删除一律由索引裁决。
import {
  GROUP_INDEX_KEY,
  GROUP_PREFIX,
  SITE_TOMBS_KEY,
  externalLocalKeys,
  isFreshLocal,
  isRecentLocalWrite,
  loadUnits,
  saveUnit,
  removeUnit,
  removeUnits,
  loadSyncConf,
  saveSyncConf
} from './store.js';
import { toast } from './utils.js';
import { compareVer, compareFamily } from './update.js';

const hasSync =
  typeof chrome !== 'undefined' && !!(chrome.storage && chrome.storage.sync);

// store.js 乐观锁的冲突广播：别的窗口/设备刚写过存储，本页内存已陈旧，
// 立刻走重载（与 onLocalChange 同一条路径，幂等）。1.5.0 真机回滚事故的
// 保险丝之一：没有它，陈旧内存的下一次 persist 就会赢回整段数据。
if (typeof document !== 'undefined') {
  document.addEventListener('fl:store-conflict', (e) => {
    console.warn('sync: 检测到写入冲突，重载最新数据', e?.detail);
    if (remoteListener) remoteListener();
  });
}

const SETTINGS_KEY = 'monk.settings.v1';

/* 壁纸这一项单独按 wallpaperAt 比新旧。
   整段设置用 LWW 合并时，另一端（尤其还在跑老版本的机器，或者一个还开着旧
   内存态的窗口）会把「旧壁纸 + 新时间戳」整份推上来，对本机来说就是
   「刚换的那张闪一下又被盖回去」。其他字段照旧按记录时间戳裁决，
   只有 wallpaper 这一项取 wallpaperAt 更大的那份。 */
export function keepNewerWallpaper(remoteV, localV) {
  const lw = localV?.wallpaper;
  const rw = remoteV?.wallpaper;
  if (!lw || !rw) return remoteV;
  const la = Number(lw.wallpaperAt) || 0;
  const ra = Number(rw.wallpaperAt) || 0;
  return la > ra ? { ...remoteV, wallpaper: lw } : remoteV;
}

/* 本机版本：只用来给快照打标记，不从 app.js 引（那会绕成循环依赖）。
   自检页里没有扩展上下文，用 __FIRSTLIGHT_VERSION__ 顶一下。 */
function appVersion() {
  try {
    if (globalThis.__FIRSTLIGHT_VERSION__) return String(globalThis.__FIRSTLIGHT_VERSION__);
    return (chrome.runtime?.getManifest?.().version) || '';
  } catch {
    return '';
  }
}

/* 从这个版本起，快照里会带 appVer / caps，也能识别 sitetombs。
   低于它的设备是全量推送型（旧版 loadUnits 的白名单里没有 sitetombs），
   它推一次就会把卡片删除记录抹掉 —— 这层只能告警，拦不住对面。 */
const CAPS_VER = '1.4.0';
const CAPS = ['sitetombs', 'groupidx', 'davbak', 'davsplit'];

// storage.sync 限额：单项 8KB / 总量 100KB / 写频率 120 次每分钟。
// 单项按 7.6KB 预警线检查（含键名），超限跳过并提示。
const ITEM_LIMIT = 7800;
const PUSH_DEBOUNCE = 2000;
const PULL_DEBOUNCE = 1000;

// 只存本机、永不参与同步的键
// 只存本机、永不参与同步的键。
// 判断标准：内容是「这台机器算出来的」，别的设备自己能重新算一遍。
//   feedcache / calfeeds = 抓取结果，同步过去只是白占 8KB 配额，还会让旧内容盖掉新内容。
const LOCAL_ONLY = new Set([
  'monk.syncconf.v1', 'monk.feedcache.v1', 'monk.calfeeds.v1',
  'monk.migrate.backup.v1', 'monk.data.v1', 'monk.groups.v1',
  // 弹窗收藏的瞬态队列与本机偏好：本机产生、本机消费，同步过去毫无意义
  'monk.pendingadds.v1', 'monk.popupconf.v1',
  // 稍后读（1.5.0）：条目会攒到上百条，塞进 storage.sync 必然撞 8KB 单项上限；
  // 「这台机器还欠几篇没读」本来就是各机器各算的事。将来按分组分片再谈同步。
  'monk.reading.v1', 'monk.pendingreads.v1'
]);
const isOurs = (key) =>
  typeof key === 'string' && key.startsWith('monk.') && !LOCAL_ONLY.has(key);

const gidOf = (key) => key.slice(GROUP_PREFIX.length).replace(/\.v1$/, '');
const gkey = (id) => `${GROUP_PREFIX}${id}.v1`;

/* 卡片墓碑的合并：只做「并集 + 取最大时间戳」，永不整体覆盖。
   墓碑是删除的凭证，必须单调累积 —— 谁都无权用自己那份把它覆盖掉，
   否则「A 删的卡」会被 B 手里的旧墓碑表冲掉，卡片复活。
   语义与分组索引的墓碑相同，只是 v 本身就是映射表。 */
function sigOfTombs(rec) {
  return JSON.stringify(rec?.v || {});
}

function mergeTombs(a, b) {
  if (!a && !b) return null;
  const v = {};
  for (const src of [a, b]) {
    for (const [id, ts] of Object.entries(src?.v || {})) {
      v[id] = Math.max(v[id] || 0, Number(ts) || 0);
    }
  }
  const stamp = Math.max(a?.updatedAt || 0, b?.updatedAt || 0);
  return { v, updatedAt: stamp ? stamp + 1 : 0 };
}

let conf = { mode: 'off' };
let remoteListener = null; // 远端有更新时回调（app.js 注册，负责重载数据与重渲染）
let pushTimer = null;
let pullTimer = null;
const pendingPush = new Set(); // 待推送的存储键

export function isSyncAvailable() {
  return hasSync;
}

export function onSyncRemote(fn) {
  remoteListener = fn;
}

// 返回 true 表示从远端拉到了更新，调用方需要重新 loadData()
export async function initSync() {
  conf = await loadSyncConf();
  if (!conf.deviceId) {
    conf.deviceId = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    await saveSyncConf(conf);
  }
  unwatchRemote();
  unwatchLocal();
  if (isManual()) {
    // 手动模式：启动不做任何同步，也不挂监听 —— 数据只在用户点「立即同步」
    // 或「覆盖」时流动。这是 1.5.0 真机事故的直接回应：自动同步在
    // 「新装机 + 多窗口」场景下会互相回写，宁可让用户多按一次按钮。
    return false;
  }
  watchLocal(); // 本机其他窗口的变更通知：所有模式都需要（哪怕同步关闭）
  if (conf.mode === 'browser' && hasSync) {
    const pulled = await initialMerge();
    watchRemote();
    return pulled;
  }
  if (conf.mode === 'webdav') {
    try {
      const r = await webdavRound();
      return !!r.pulled;
    } catch (err) {
      console.warn('webdav sync failed', err);
      toast('WebDAV 同步失败，请检查网络或稍后在设置里重试');
      return false;
    }
  }
  return false;
}

// autoSync 默认 true：老配置没有这个字段，行为与 1.4.x 一致
export function isManual() {
  return conf.mode !== 'off' && conf.mode != null && conf.autoSync === false;
}

// 设置页保存完 WebDAV 配置后必须调这个：否则本模块的 conf 还是上一次 initSync 读到的旧值
// （典型症状：明明填对了账号密码，一点「保存并连接」就报「地址不合法」）
export async function reloadSyncConf() {
  conf = await loadSyncConf();
  return conf;
}

// 自动/手动切换后调用：按新模式重挂监听、清掉残留定时器
export async function applySyncMode() {
  conf = await loadSyncConf();
  unwatchRemote();
  unwatchLocal();
  clearTimeout(pushTimer);
  clearTimeout(pullTimer);
  clearTimeout(localTimer);
  if (isManual()) return;
  watchLocal();
  if (conf.mode === 'browser' && hasSync) {
    watchRemote();
  }
}

// state.js persist() 保存成功后调用，参数是本次变更的存储键
export function notifyChanged(changedUnits = []) {
  if ((conf.mode !== 'browser' && conf.mode !== 'webdav') || !hasSync) return;
  for (const k of changedUnits) if (isOurs(k)) pendingPush.add(k);
  if (!pendingPush.size) return;
  if (isManual()) return; // 手动模式：只记账，等「立即同步」一起推
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushPending, PUSH_DEBOUNCE);
}

/* ---------- 分组索引的合并 ---------- */
function sigOf(rec) {
  const v = (rec?.v || []).map(String);
  const d = Object.entries(rec?.d || {}).sort(([x], [y]) => (x < y ? -1 : 1));
  return JSON.stringify({ v, d });
}

function mergeIndex(a, b) {
  if (!a && !b) return null;
  const tombs = {};
  for (const src of [a, b]) {
    for (const [id, ts] of Object.entries(src?.d || {})) {
      tombs[id] = Math.max(tombs[id] || 0, Number(ts) || 0);
    }
  }
  const newerFirst =
    (a?.updatedAt || 0) >= (b?.updatedAt || 0)
      ? [...(a?.v || []), ...(b?.v || [])]
      : [...(b?.v || []), ...(a?.v || [])];

  const v = [];
  const seen = new Set();
  for (const raw of newerFirst) {
    const id = String(raw);
    if (seen.has(id) || tombs[id]) continue;
    seen.add(id);
    v.push(id);
  }
  const stamp = Math.max(a?.updatedAt || 0, b?.updatedAt || 0);
  return { v, d: tombs, updatedAt: stamp ? stamp + 1 : 0 };
}

// 墓碑里的分组：本地记录清掉
async function dropTombstoned(rec) {
  const ids = Object.keys(rec?.d || {});
  if (!ids.length) return 0;
  return removeUnits(ids.map(gkey));
}

// 索引里没有、而且比索引更旧的分组记录 → 判定为已被别处删除。
// 比索引新的孤儿保留：那是还没并进索引的并发新增，宁可多留也不丢。
async function reconcileGroups(indexRec, force = false) {
  const keep = new Set((indexRec?.v || []).map(String));
  const idxTs = indexRec?.updatedAt || 0;
  const local = await loadUnits();
  const drop = [];
  for (const [k, rec] of Object.entries(local)) {
    if (!k.startsWith(GROUP_PREFIX)) continue;
    const id = gidOf(k);
    if (keep.has(id)) continue;
    if (force || (rec?.updatedAt || 0) < idxTs) drop.push(k);
  }
  return drop.length ? removeUnits(drop) : 0;
}

/* ---------- 远端记录并入本地（两个后端共用） ----------
   relevant：可选的键集合（Set）。分文件同步下一次只拉了部分段，
   传入它可把「没拉的段」从比较中剔除——否则本地较新的未拉段会被
   误判成「需要推送」，白写一轮云端还虚抬代际号。
   返回 { pulled, toPush }：pulled = 本机有更新需要重载界面；
   toPush = 本机更新的记录，调用方决定往哪个后端推。 */
export async function pullMerge(remote, relevant = null) {
  const local = await loadUnits();
  let pulled = false;
  const toPush = {};

  const keys = new Set([...Object.keys(local), ...Object.keys(remote).filter(isOurs)]);
  const consider = (key) => !relevant || relevant.has(key);
  for (const key of keys) {
    if (!consider(key)) continue;
    if (!isOurs(key) || key === GROUP_INDEX_KEY || key === SITE_TOMBS_KEY) continue; // 索引与卡片墓碑单独处理
    const r = remote[key];
    const l = local[key];
    const rt = r?.updatedAt || 0;
    const lt = l?.updatedAt || 0;
    if (r && r.v != null && rt > lt) {
      /* 本页刚手动改过（换壁纸、改设置）就先按住不放：
         另一端（尤其还开着新标签页的机器）会把整段设置连同旧值一起重写，
         时间戳永远比这里新。不挡的话，用户刚换的壁纸会在几秒后被拉回旧的那张，
         表现就是「闪一下又变回原来的」。窗口外的合并照常按时间戳走。 */
      if (isRecentLocalWrite(key)) continue;
      if (key === SETTINGS_KEY) {
        const mergedV = keepNewerWallpaper(r.v, l?.v);
        if (mergedV !== r.v) {
          /* 壁纸这一项本机更新：只把这一个字段留住不够，还得带着新时间戳
             回传一次，否则云端一直存着旧壁纸，下次重启又从那边拉回来。 */
          const rec = { v: mergedV, updatedAt: Math.max(rt, Date.now()) };
          await saveUnit(key, rec);
          toPush[key] = rec;
          pulled = true;
          continue;
        }
      }
      await saveUnit(key, r);
      pulled = true;
    } else if (l && l.v != null && lt > rt) {
      toPush[key] = l;
    }
  }

  /* 卡片墓碑：并集合并（见 mergeTombs 的注释）。放在分组合并之后，
     这样刚拉回来的分组记录在下次 loadSections 时就会被墓碑过滤掉。

     只有本轮真拉过 sites 段才做这段。没拉过的段不能参与「谁有更新」的裁决：
     远端一侧恒为 null，下面「远端 ≠ 合并结果」就永远成立，于是每轮都往
     toPush 里塞一条索引/墓碑，target 因此多出 sites 段 —— 表现是「只改了个
     待办，整个收藏段被重传一遍」。跨设备时两台机器互相触发，流量来回放大。 */
  if (consider(SITE_TOMBS_KEY)) {
    const ltombs = local[SITE_TOMBS_KEY] || null;
    const rtombs = remote[SITE_TOMBS_KEY] || null;
    if (ltombs || rtombs) {
      const mergedT = mergeTombs(ltombs, rtombs);
      if (sigOfTombs(ltombs) !== sigOfTombs(mergedT)) {
        await saveUnit(SITE_TOMBS_KEY, mergedT);
        pulled = true;
      }
      if (sigOfTombs(rtombs) !== sigOfTombs(mergedT)) toPush[SITE_TOMBS_KEY] = mergedT;
    }
  }

  if (consider(GROUP_INDEX_KEY)) {
    const li = local[GROUP_INDEX_KEY] || null;
    const ri = remote[GROUP_INDEX_KEY] || null;
    if (li || ri) {
      const merged = mergeIndex(li, ri);
      if (sigOf(li) !== sigOf(merged)) {
        await saveUnit(GROUP_INDEX_KEY, merged);
        pulled = true;
      }
      if (sigOf(ri) !== sigOf(merged)) toPush[GROUP_INDEX_KEY] = merged;
      if (li && ri) {
        await dropTombstoned(merged);
        await reconcileGroups(merged);
        // 判定为「已删除」的分组记录别再推上去，否则云端永远留着垃圾
        for (const id of Object.keys(merged.d || {})) delete toPush[gkey(id)];
      }
    }
  }
  return { pulled, toPush };
}

/* ---------- 启动合并：逐条记录比较 updatedAt，新者胜出 ---------- */
// 成功合并过一次之后置 true（存本机）。在那之前 prune 是危险的：
// 本机索引可能残缺（首装没拉到、拉取失败），把「云端有、本地没有」当成「已删除」
// 会把其他设备的分组记录从云端真的删掉 —— 唯一能造成不可逆清空的路径。
async function markMerged() {
  if (!conf.mergedOnce) {
    conf.mergedOnce = true;
    await saveSyncConf(conf);
  }
}

/* 1.5.0 起，首次合并（mergedOnce=false）不再盲用 LWW。
   真机事故复盘：新装机哪怕只真实保存过一次（改壁纸、收藏一个网站），
   本机记录的时间戳就比云端的新 —— initialMerge 会把这份接近初始的数据
   推上云端，把另一台机器攒了几个星期的数据静默冲掉。
   所以首次合并分三种情况：
   ① 云端没数据 → 正常推本机（本来就是「注册」云端）；
   ② 本机是初始状态（isFreshLocal）→ 云端直接覆盖本地，正是用户预期；
   ③ 本机使用中 + 云端有数据 → **绝不静默合并**，把选择权交给设置页
      （takeDirectionChoice），由用户决定哪边覆盖哪边。 */
let pendingDirectionChoice = null;
export function takeDirectionChoice() {
  const c = pendingDirectionChoice;
  pendingDirectionChoice = null;
  return c;
}

async function initialMerge() {
  let pulled = false;
  try {
    const remote = await chrome.storage.sync.get(null);
    let cloudCount = 0;
    for (const [k, v] of Object.entries(remote)) {
      if (isOurs(k) && k !== GROUP_INDEX_KEY && k !== SITE_TOMBS_KEY && v?.v != null) cloudCount += 1;
    }

    if (cloudCount > 0 && !conf.mergedOnce && !(await isFreshLocal())) {
      pendingDirectionChoice = { cloudCount };
      return false;
    }

    const res = await pullMerge(remote);
    pulled = res.pulled;
    if (Object.keys(res.toPush).length) await pushRecords(res.toPush);
    await markMerged();
  } catch (err) {
    console.warn('sync init failed', err);
    toast('同步初始化失败，请确认浏览器已登录账号');
  }
  return pulled;
}

/* ---------- 推送本地变更到 sync 区 ---------- */
let pushRetry = 0;

async function pushPending() {
  const keys = [...pendingPush];
  pendingPush.clear();
  if (!keys.length) return;
  if (conf.mode === 'webdav') {
    // WebDAV 没有逐键写：一次「拉-合并-推」往返。分文件版只上传有改动的段，
    // 这里先把待推键换算成段号记入 davWanted，本轮结束后才清账。
    for (const k of keys) {
      const s = davSectionOf(k);
      if (s) davWanted.add(s);
    }
    const r = await webdavRound();
    if (!r.ok) {
      // 认证类错误重试一万次也还是 401，而每一次 401 都可能换来一个原生登录弹窗。
      // 遇到这类直接丢掉这批 key、停掉自动重试，等用户改好配置手动触发。
      if (['auth', 'forbidden', 'nocred', 'badurl', 'redirect', 'html'].includes(r.reason)) {
        pushRetry = 0;
        return;
      }
      for (const k of keys) pendingPush.add(k);
      pushRetry = Math.min(pushRetry + 1, 5);
      clearTimeout(pushTimer);
      pushTimer = setTimeout(pushPending, Math.min(60000, PUSH_DEBOUNCE * 2 ** pushRetry));
    } else {
      pushRetry = 0;
      // 往返里若从云端拉到了其他设备的更新，别把 pulled 丢掉：
      // 这里是「后台保存顺带同步」的路径，拉到的数据必须驱动一次重渲染，
      // 否则 UI 一直停留在旧数据上（1.3.5~1.3.8 的实际缺口）。
      if (r.pulled && remoteListener) remoteListener();
    }
    return;
  }
  const units = await loadUnits();
  const writes = {};
  for (const k of keys) if (units[k]) writes[k] = units[k];
  const ok = await pushRecords(writes);
  if (!ok) {
    // 推送失败必须把这批 key 放回队列：否则「先 clear 再推」会让这批改动
    // 永远不再同步（失败原因通常只是暂时的：离线、未登录、撞写频率上限）
    for (const k of keys) pendingPush.add(k);
    pushRetry = Math.min(pushRetry + 1, 5);
    clearTimeout(pushTimer);
    pushTimer = setTimeout(pushPending, Math.min(60000, PUSH_DEBOUNCE * 2 ** pushRetry));
    return;
  }
  pushRetry = 0;
  // 索引变了 = 分组有增删，顺手清掉云端带墓碑的分组记录。
  // 只清「墓碑里有的」——「索引里没有」不再构成删除依据：
  // 本机索引残缺时（拉取失败、离线用过一阵），那半条判断会误删其他设备的分组。
  if (keys.includes(GROUP_INDEX_KEY) && conf.mergedOnce) {
    await pruneRemoteGroups(units[GROUP_INDEX_KEY]);
  }
}

const encoder = new TextEncoder();

async function pushRecords(writes) {
  const ok = {};
  for (const [key, rec] of Object.entries(writes)) {
    const bytes = encoder.encode(JSON.stringify(rec)).length + key.length;
    if (bytes > ITEM_LIMIT) {
      // 分片之后还会超限的，只剩「单个分组自己太大」这一种
      const label = key.startsWith(GROUP_PREFIX) ? `分组「${rec?.v?.name || '未命名'}」` : '部分数据';
      toast(`${label}超过浏览器同步大小限制（约 49 个网站），这一组暂未同步`, 4000);
      continue;
    }
    ok[key] = rec;
  }
  if (!Object.keys(ok).length) return true;
  try {
    await chrome.storage.sync.set(ok);
    conf.lastSyncAt = Date.now();
    await saveSyncConf(conf);
    return true;
  } catch (err) {
    // 未登录账号 / 离线 / 超写频率（120 次每分钟）都会抛错，本地数据不受影响
    console.warn('sync push failed', err);
    return false;
  }
}

// 云端带墓碑的分组记录：删掉。让本机的「删除分组」能传到其他设备。
// 只按墓碑删，不看「在不在本地索引里」——索引残缺时后者就是一颗地雷。
async function pruneRemoteGroups(indexRec) {
  try {
    const tombs = indexRec?.d || {};
    const remote = await chrome.storage.sync.get(null);
    const drop = Object.keys(remote).filter(
      (k) => k.startsWith(GROUP_PREFIX) && tombs[gidOf(k)]
    );
    if (drop.length) await chrome.storage.sync.remove(drop);
  } catch (err) {
    console.warn('sync prune failed', err);
  }
}

/* ---------- 强制以云端为准 ---------- */
// 不比较 updatedAt，远端有哪条就覆盖本机哪条。
// 用途：某台设备先离线用过一阵（本地数据时间戳比云端还新），
// 开启同步后按「新者胜」会把它推上去，把真正想要的云端数据冲掉。
// 这个入口给用户一次显式的「我确定要云端那份」的机会。
// 1.4.0 起两个后端都支持：WebDAV 之前只有 browser 分支，
// 而 1.3.8 之后最需要这个逃生口的恰恰是用 WebDAV 的人。
export async function overwriteLocalFromRemote() {
  if (conf.mode === 'webdav') return overwriteFromWebdav();
  if (conf.mode !== 'browser' || !hasSync) return { ok: false, count: 0, reason: 'off' };
  try {
    const remote = await chrome.storage.sync.get(null);
    let count = 0;
    for (const [key, rec] of Object.entries(remote)) {
      if (!isOurs(key) || rec?.v == null) continue;
      await saveUnit(key, rec);
      count += 1;
    }
    // 索引在上面的循环里已按「我们的键」整份强制落盘，这里只按它清掉多余分组
    const idx = remote[GROUP_INDEX_KEY];
    if (idx) await reconcileGroups(idx, true);
    if (count) {
      conf.lastSyncAt = Date.now();
      await saveSyncConf(conf);
    }
    await markMerged();
    // 覆盖是全量变更：广播所有页面立刻重载，别等各自的 onLocalChange 防抖
    if (remoteListener) remoteListener();
    return { ok: count > 0, count };
  } catch (err) {
    console.warn('sync overwrite failed', err);
    return { ok: false, count: 0, reason: 'error' };
  }
}

/* WebDAV 版逃生口：分文件优先，没有 meta（还没迁移的旧云端）退回读旧快照。
   读到什么就逐条强制落盘（不看时间戳），再按云端索引清掉多余分组。
   三条与 browser 版一致的语义，外加两条 WebDAV 特有的：
   - 云端墓碑表也一并接管：本机私有的删除记录不能反过来把云端数据藏起来；
   - 云端没有数据时明确返回 empty，而不是「成功恢复 0 项」这种让人误以为生效的结果。 */
async function overwriteFromWebdav() {
  const dconf = conf.webdav || {};
  const m = await davGetMeta(dconf, { force: true });
  if (m.error) return { ok: false, count: 0, reason: m.error };
  let records = null;
  if (m.data) {
    records = {};
    for (const sec of DAV_SECTIONS) {
      const r = await davGetSection(dconf, sec, { force: true });
      if (r.error) return { ok: false, count: 0, reason: r.error };
      Object.assign(records, r.data?.records || {});
    }
  } else {
    const got = await davGetLegacy(dconf, { force: true });
    if (got.error) return { ok: false, count: 0, reason: got.error };
    if (!got.data) return { ok: false, count: 0, reason: 'empty' };
    records = got.data.records || {};
  }
  let count = 0;
  for (const [key, rec] of Object.entries(records)) {
    if (!isOurs(key) || rec?.v == null) continue;
    await saveUnit(key, rec);
    count += 1;
  }
  const remoteTombs = records[SITE_TOMBS_KEY];
  if (remoteTombs) await saveUnit(SITE_TOMBS_KEY, remoteTombs);
  else await removeUnit(SITE_TOMBS_KEY);
  // 索引同样在上面的循环里整份落盘，这里只负责清掉云端索引之外的分组分片
  const idx = records[GROUP_INDEX_KEY];
  if (idx) await reconcileGroups(idx, true);
  if (count) {
    conf.lastSyncAt = Date.now();
  }
  // 代际号基线对齐云端：别让下一轮把刚恢复的数据当成「没见过」再折腾一遍
  if (m.data) {
    conf.davGens = {};
    for (const [s, f] of Object.entries(m.data.files || {})) conf.davGens[s] = f.gen || 0;
    conf.davResync = [];
  }
  await saveSyncConf(conf);
  await markMerged();
  if (remoteListener) remoteListener();
  return { ok: count > 0, count };
}

/* ---------- 强制以本地为准（1.5.0 双向开关的另一向） ----------
   把本机数据整体推上云端，不看时间戳。两个用途：
   ① 首次开启同步且本机是使用状态时，用户明确选择「云端归本机管」；
   ② 云端被污染/旧数据覆盖后，用数据完好的那台机器把它顶回来 ——
      这正是 1.5.0 真机事故的标准恢复手段。 */
export async function overwriteRemoteFromLocal() {
  if (conf.mode === 'webdav') return overwriteWebdavFromLocal();
  if (conf.mode !== 'browser' || !hasSync) return { ok: false, count: 0, reason: 'off' };
  try {
    const units = await loadUnits();
    const writes = {};
    for (const [k, rec] of Object.entries(units)) if (rec?.v != null) writes[k] = rec;
    const ok = await pushRecords(writes);
    if (ok) {
      // 云端有、本机没有的键也清掉，让云端与本机完全一致。
      // 墓碑记录例外：本机可能从来没删过卡片，云端的墓碑留着无害（90 天过期）。
      const remote = await chrome.storage.sync.get(null);
      const drop = Object.keys(remote).filter(
        (k) => isOurs(k) && k !== SITE_TOMBS_KEY && !writes[k]
      );
      if (drop.length) await chrome.storage.sync.remove(drop);
      conf.lastSyncAt = Date.now();
      await saveSyncConf(conf);
      await markMerged();
    }
    return { ok, count: Object.keys(writes).length };
  } catch (err) {
    console.warn('overwrite remote failed', err);
    return { ok: false, count: 0, reason: 'error' };
  }
}

async function overwriteWebdavFromLocal() {
  const dconf = conf.webdav || {};
  if (!hasCred(dconf)) return { ok: false, count: 0, reason: 'nocred' };
  // 先读云端代际号（还没有分文件就从 0 起算），再整库分四份推上去。
  // 用户明确选了方向，这里不走代际号锁——「本机覆盖云端」就是要盖过一切。
  const m = await davGetMeta(dconf, { force: true });
  if (m.error) return { ok: false, count: 0, reason: m.error };
  const units = await loadUnits();
  const now = Date.now();
  const filesMeta = {};
  for (const sec of DAV_SECTIONS) {
    const records = recordsOfSection(units, sec);
    const gen = (m.data?.files?.[sec.id]?.gen || 0) + 1;
    const put = await davPut(
      dconf,
      {
        app: 'firstlight', ver: 2, section: sec.id, gen, savedAt: now,
        deviceId: conf.deviceId || '', appVer: appVersion(), caps: CAPS, records
      },
      sec.file
    );
    if (put.error) return { ok: false, count: 0, reason: put.error };
    filesMeta[sec.id] = { gen, updatedAt: now, deviceId: conf.deviceId || '' };
  }
  const mput = await davPut(
    dconf,
    {
      app: 'firstlight', ver: 2, appVer: appVersion(), caps: CAPS, savedAt: now,
      deviceId: conf.deviceId || '', files: filesMeta
    },
    DAV_META
  );
  if (mput.error) return { ok: false, count: 0, reason: mput.error };
  conf.davGens = {};
  for (const [s, f] of Object.entries(filesMeta)) conf.davGens[s] = f.gen;
  conf.davResync = [];
  conf.lastSyncAt = now;
  await saveSyncConf(conf);
  await markMerged();
  return { ok: true, count: Object.keys(units).length };
}

/* ---------- 接收其他设备的推送 ---------- */
function watchRemote() {
  chrome.storage.onChanged.addListener(onStorageChange);
}

function unwatchRemote() {
  if (!hasSync) return;
  try {
    chrome.storage.onChanged.removeListener(onStorageChange);
  } catch {
    /* 忽略 */
  }
}

/* ---------- 本机其他窗口的变更（1.3.9 新鲜度链路） ----------
   两个新标签页同时开着时，B 页内存里的数据是旧的：B 随手编辑一下，
   persist 会把旧分组状态带上**新时间戳**写回，LWW 合并时盖掉 A 页
   （甚至另一台设备同步来的）新改动——旧数据伪装成新数据，墓碑救不了。
   修法：监听 local 区广播，经 externalLocalKeys 过滤掉自己的回声后，
   防抖重载 + 重渲染。重载是幂等的，误判只多渲染一次，不会成环。 */
let localTimer = null;
function onLocalChange(changes, area) {
  if (area !== 'local') return;
  const ext = externalLocalKeys(changes);
  if (!ext.length) return;
  clearTimeout(localTimer);
  localTimer = setTimeout(() => {
    if (remoteListener) remoteListener();
  }, 250);
}
function watchLocal() {
  if (hasSync) chrome.storage.onChanged.addListener(onLocalChange);
}
function unwatchLocal() {
  if (hasSync) {
    try {
      chrome.storage.onChanged.removeListener(onLocalChange);
    } catch {
      /* 忽略 */
    }
  }
}

// 拉取防抖：1 秒内的多批 onChanged 必须累积，不能只留最后一批——
// 否则前一批的 key 被丢掉，那部分改动要等下一次推送才可能被看到
const pendingPullKeys = new Set();
const pendingPullChanges = {};

function onStorageChange(changes, area) {
  if (area !== 'sync') return;
  const touched = Object.keys(changes).filter(isOurs);
  if (!touched.length) return;
  for (const k of touched) {
    pendingPullKeys.add(k);
    pendingPullChanges[k] = changes[k];
  }
  clearTimeout(pullTimer);
  pullTimer = setTimeout(flushPull, PULL_DEBOUNCE);
}

function flushPull() {
  const keys = [...pendingPullKeys];
  const snapshot = {};
  for (const k of keys) {
    snapshot[k] = pendingPullChanges[k];
    delete pendingPullChanges[k];
  }
  pendingPullKeys.clear();
  if (keys.length) applyRemote(keys, snapshot);
}

async function applyRemote(touched, changes) {
  const local = await loadUnits();
  let pulled = false;
  let remoteIndex = null;

  for (const key of touched) {
    if (key === GROUP_INDEX_KEY) {
      remoteIndex = changes[key].newValue || null;
      continue;
    }
    const rec = changes[key].newValue;
    if (!rec || rec.v == null) continue; // 逐条删除不传播，由索引裁决
    const lt = local[key]?.updatedAt || 0;
    // 严格大于才拉回：自己推送的回声（updatedAt 相等）自然被跳过
    if ((rec.updatedAt || 0) > lt) {
      if (isRecentLocalWrite(key)) continue; // 刚在本页改过，别被别人的旧值盖回（同 pullMerge）
      const v = key === SETTINGS_KEY ? keepNewerWallpaper(rec.v, local[key]?.v) : rec.v;
      await saveUnit(key, v === rec.v ? rec : { ...rec, v });
      pulled = true;
    }
  }

  if (remoteIndex) {
    const merged = mergeIndex(local[GROUP_INDEX_KEY] || null, remoteIndex);
    if (sigOf(local[GROUP_INDEX_KEY]) !== sigOf(merged)) {
      await saveUnit(GROUP_INDEX_KEY, merged);
      pulled = true;
    }
    await dropTombstoned(merged);
    await reconcileGroups(merged);
  }

  if (pulled && remoteListener) remoteListener();
}

/* ================= WebDAV 后端（分文件版） =================
   Essential difference from the browser backend: no change push channel, and no 8KB quota pressure.

   1.5.0 起弃用「单快照全量覆盖」（firstlight-sync.json），改为分文件：
     fl-settings.json  settings / dock / stats（设置·壁纸·统计）
     fl-sites.json     groupidx + 全部分组分片 + 卡片墓碑（收藏域）
     fl-todos.json     todos（待办）
     fl-feeds.json     feeds + events（RSS 订阅与日历）
     fl-meta.json      每个文件的代际号 gen + 更新时间 + 写入设备

   为什么分文件：单快照 = 任何一台设备把「整份数据」推上去。内存陈旧的窗口
   （1.5.0 真机事故的根源）会把云端整体盖回旧版，还带着新时间戳。分文件 +
   代际号后，一次写入只覆盖一个域；写入前重读 meta，云端 gen 比自己合并时
   看到的新 = 有别的设备刚写过 = 放弃本次上传，下一轮重拉重并。这与 store.js
   的本地乐观锁是同一条思路搬到云端。

   每次同步（davRoundInner）：
     读 meta → 只拉 gen 有变化的段 → pullMerge（带 relevant 过滤）→
     重读 meta 做代际号校验 → PUT 有改动的段 → PUT meta。
   先拉后推 + 代际号锁共同保证并发安全。

   旧快照的处理：meta 不存在时读一次 firstlight-sync.json（旧版写入的），
   合并进本地后一次性写成五个新文件，旧文件保留在网盘里不再读写，当存档。
   日备份轮转 bak → bak1 → bak2 改为整库快照写入 fl-backup.json 链，
   每天第一次覆盖前把当时的云端状态存档一份。 */
const WEBDAV_FILE = 'firstlight-sync.json'; // 旧版单快照：只读（迁移源），不再写入
const DAV_META = 'fl-meta.json';
const DAV_BACKUP = 'fl-backup.json';
const DAV_BACKUP1 = 'fl-backup.bak1.json'; // 跨天轮转：昨日
const DAV_BACKUP2 = 'fl-backup.bak2.json'; // 跨天轮转：前日

/* 四个数据域：与用户可见概念一一对应（设置 / 收藏 / 待办 / 订阅）。
   has(k) 决定一个存储键归哪个文件——所有参与同步的 monk.* 键必须恰好归一段。 */
const DAV_SECTIONS = [
  {
    id: 'settings', file: 'fl-settings.json',
    has: (k) => k === 'monk.settings.v1' || k === 'monk.dock.v1' || k === 'monk.stats.v1'
  },
  {
    id: 'sites', file: 'fl-sites.json',
    has: (k) => k === GROUP_INDEX_KEY || k === SITE_TOMBS_KEY || k.startsWith(GROUP_PREFIX)
  },
  { id: 'todos', file: 'fl-todos.json', has: (k) => k === 'monk.todos.v1' },
  { id: 'feeds', file: 'fl-feeds.json', has: (k) => k === 'monk.feeds.v1' || k === 'monk.events.v1' }
];
const davSectionOf = (key) => DAV_SECTIONS.find((s) => s.has(key))?.id || null;

function recordsOfSection(units, sec) {
  const out = {};
  for (const [k, rec] of Object.entries(units || {})) if (sec.has(k)) out[k] = rec;
  return out;
}

// 设置页状态面板最近一次检查的缓存（webdavRound / davGet 顺手填）
export let lastDavCheck = null;

/* 401/403 之后进冷却：打开新标签页、每次改数据、每次点面板都会触发同步，
   而每个 401 都可能换来一个浏览器原生的账号密码弹窗（那个空白的「登录」小窗）。
   冷却期内一律不再发请求，只把上次的结论重复报出来；用户主动点「测试/立即同步/诊断」
   时把冷却清零（那是有意为之的一次尝试，弹一次可以接受，弹一百次不行）。 */
let davCooldownUntil = 0;
let davCooldownReason = '';
const DAV_COOLDOWN = 10 * 60 * 1000;

function coolDown(reason) {
  davCooldownUntil = Date.now() + DAV_COOLDOWN;
  davCooldownReason = reason;
}

function davCooling() {
  return Date.now() < davCooldownUntil ? davCooldownReason || 'auth' : '';
}

export function resetDavCooldown() {
  davCooldownUntil = 0;
  davCooldownReason = '';
}

/* 所有 WebDAV 请求的唯一入口，两条铁律：
   1) credentials:'omit'
      浏览器的 fetch 默认允许「HTTP 认证挑战」，跨源 401 + WWW-Authenticate 会弹出
      原生账号密码框（用户名密码都是空的，看起来就是一个空白登录窗），而且同一轮里
      有几个请求就弹几个。我们自己在 Authorization 头里带 Basic，完全不需要这一套。
   2) redirect:'manual'
      地址写错（漏了 /dav、指到网页版首页）时服务器会 302 到坚果云登录页。默认跟随
      等于把标签页带去登录界面，用户看到的就是「一直弹登录页」。干脆不跟，把 3xx
      当成「这个地址不是 WebDAV 端点」直接报出来。 */
async function davFetch(url, ms, init = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, {
      ...init,
      credentials: 'omit',
      redirect: 'manual',
      cache: 'no-store',
      signal: ctl.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

function isRedirect(res) {
  if (!res) return false;
  if (res.type === 'opaqueredirect') return true;
  return res.status >= 300 && res.status < 400;
}

function netErr(err) {
  return err?.name === 'AbortError' ? 'timeout' : 'network';
}

// 账号/密码可能是非 ASCII（中文密码），btoa 只认 Latin1，先过一遍 UTF-8
function basicAuth(user, pass) {
  const bytes = new TextEncoder().encode(`${user || ''}:${pass || ''}`);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `Basic ${btoa(bin)}`;
}

function davUrl(dconf) {
  const u = String(dconf?.url || '').trim();
  if (!/^https?:\/\//i.test(u)) return null;
  return u.endsWith('/') ? u : `${u}/`;
}

function hasCred(dconf) {
  return !!(dconf && String(dconf.username || '').trim() && String(dconf.password || ''));
}

function davHeaders(dconf, extra = {}) {
  return {
    Authorization: basicAuth(dconf.username, dconf.password),
    ...extra
  };
}

// 把一次响应翻译成「人话错误」：调用方只认这些 key
function classify(res) {
  if (isRedirect(res)) return { error: 'redirect', status: res.status };
  if (res.status === 401) {
    coolDown('auth');
    return { error: 'auth', status: 401 };
  }
  if (res.status === 403) {
    coolDown('forbidden');
    return { error: 'forbidden', status: 403 };
  }
  return null;
}

/* GET 一个云端 JSON 文件的公共实现：404 = 文件不存在（返回 data:null，不算错）。 */
async function davGetJson(dconf, name, validate, opt = {}) {
  const base = davUrl(dconf);
  if (!base) return { error: 'badurl' };
  if (!hasCred(dconf)) return { error: 'nocred' };
  if (!opt.force) {
    const cool = davCooling();
    if (cool) return { error: cool, cooled: true };
  }
  try {
    const res = await davFetch(base + name, 15000, { headers: davHeaders(dconf) });
    const bad = classify(res);
    // 404 有两种：文件还没推过（合法的空桶），或者目录压根不存在。
    // 这里当空桶处理，写的时候 PUT 会拿到 409 再回来告诉我们目录有问题。
    if (bad) return bad;
    if (res.status === 404) return { data: null };
    if (!res.ok) return { error: `http ${res.status}`, status: res.status };
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const text = await res.text();
    // 返回 HTML = 地址指到了网页而不是 WebDAV 目录
    if (ct.includes('text/html') || /^\s*<(?:!doctype|html)/i.test(text)) return { error: 'html' };
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      return { error: 'format' };
    }
    if (!validate(json)) return { error: 'format' };
    return { data: json };
  } catch (err) {
    return { error: netErr(err) };
  }
}

const isLegacySnapshot = (j) => !!j && j.app === 'firstlight' && typeof j.records === 'object';
const isMetaFile = (j) => !!j && j.app === 'firstlight' && typeof j.files === 'object';
const isSectionFile = (sec) => (j) =>
  !!j && j.app === 'firstlight' && j.section === sec.id && typeof j.records === 'object';

// 旧版单快照：只在「云端还没有 fl-meta.json」时读一次，作为迁移的数据源
const davGetLegacy = (dconf, opt = {}) =>
  davGetJson(dconf, WEBDAV_FILE, isLegacySnapshot, opt);

const davGetMeta = (dconf, opt = {}) =>
  davGetJson(dconf, DAV_META, isMetaFile, opt);

const davGetSection = (dconf, sec, opt = {}) =>
  davGetJson(dconf, sec.file, isSectionFile(sec), opt);

async function davPut(dconf, body, name = WEBDAV_FILE) {
  const base = davUrl(dconf);
  if (!base) return { error: 'badurl' };
  if (!hasCred(dconf)) return { error: 'nocred' };
  const payload = JSON.stringify(body);
  const putInit = {
    method: 'PUT',
    headers: davHeaders(dconf, { 'Content-Type': 'application/json' }),
    body: payload
  };
  try {
    let res = await davFetch(base + name, 20000, putInit);
    if (res.status === 409 || res.status === 404) {
      // 目录不存在：先建目录再重试一次（坚果云要求同步目录已存在）。
      // MKCOL 到已存在的目录会回 405，那是好事，继续重试 PUT 就行。
      await davFetch(base.replace(/\/+$/, ''), 15000, {
        method: 'MKCOL',
        headers: davHeaders(dconf)
      }).catch(() => {});
      res = await davFetch(base + name, 20000, putInit);
    }
    const bad = classify(res);
    if (bad) return bad;
    if (!res.ok) return { error: `http ${res.status}`, status: res.status };
    return { ok: true };
  } catch (err) {
    return { error: netErr(err) };
  }
}

/* WebDAV MOVE：备份轮转用（bak → bak1 → bak2）。
   Destination 必须是完整 URL（RFC 4918 允许绝对路径，但坚果云等实现只认绝对 URL）。
   源文件不存在（还没备份过）返回 ok+skipped，不算错。 */
async function davMove(dconf, from, to) {
  const base = davUrl(dconf);
  if (!base) return { error: 'badurl' };
  if (!hasCred(dconf)) return { error: 'nocred' };
  try {
    const res = await davFetch(base + from, 12000, {
      method: 'MOVE',
      headers: davHeaders(dconf, { Destination: new URL(to, base).href, Overwrite: 'T' })
    });
    if (res.status === 404) return { ok: true, skipped: true };
    const bad = classify(res);
    if (bad) return bad;
    if (!res.ok) return { error: `http ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { error: netErr(err) };
  }
}

/* 写探针：真正上传一个几十字节的小文件再删掉。
   「测试连接」只做 GET 是不够的 —— 只读账号、没有写权限的目录、免费空间写满，
   全都表现为「测试成功、同步失败」，而失败点藏在 PUT 那一步。

   两条实战经验（1.3.6 第一版就栽在第一条）：
   1) 文件名不能用点开头。坚果云等网盘把 . 开头的当系统文件，PUT 直接 404，
      「能写」被误判成「写不了」。
   2) 探针被拒也不等于目录写不了。有些服务器对临时文件/某些扩展名有洁癖，
      但快照文件照收。所以探针失败后拿真实快照路径再试一次：写回读到的原样
      （没有快照就写一份空快照，跟首次同步完全一样），能写成就说明只是探针被嫌弃。 */
async function davProbe(dconf) {
  const base = davUrl(dconf);
  if (!base) return { ok: false, error: 'badurl' };
  if (!hasCred(dconf)) return { ok: false, error: 'nocred' };
  const url = `${base}firstlight-probe-${Date.now().toString(36)}.txt`;
  const init = {
    method: 'PUT',
    headers: davHeaders(dconf, { 'Content-Type': 'text/plain' }),
    body: 'firstlight probe'
  };
  let status = 0;
  try {
    let res = await davFetch(url, 15000, init);
    status = res.status;
    if (res.status === 409 || res.status === 404) {
      const mk = await davFetch(base.replace(/\/+$/, ''), 15000, {
        method: 'MKCOL',
        headers: davHeaders(dconf)
      }).catch(() => null);
      status = mk ? `${res.status}→MKCOL ${mk.status}` : `${res.status}`;
      res = await davFetch(url, 15000, init);
    }
    const bad = classify(res);
    // 不管成没成，探针文件都清掉，别在用户网盘里留垃圾
    await davFetch(url, 8000, { method: 'DELETE', headers: davHeaders(dconf) }).catch(() => {});
    if (!bad && res.ok) return { ok: true };
    if (bad) return { ok: false, error: bad.error, status: bad.status, probeStatus: status };
    const probeErr = `http ${res.status}`;
    /* 降级：直接测真实数据路径（meta 文件）。
       注意「本来没有 meta」时必须写完再删掉 —— 否则一次连接测试就会凭空
       造出一个空 meta，让后续同步误判「云端已是分文件格式」，从而跳过
       旧快照迁移，旧云端的数据就再也并不进来了。 */
    const m = await davGetMeta(dconf, { force: true });
    const hadMeta = !!m.data;
    const body = m.data || {
      app: 'firstlight', ver: 2, appVer: appVersion(), caps: CAPS,
      savedAt: 0, deviceId: '', files: {}
    };
    const put = await davPut(dconf, body, DAV_META);
    if (put.ok && !hadMeta) {
      await davFetch(base + DAV_META, 8000, { method: 'DELETE', headers: davHeaders(dconf) }).catch(() => {});
    }
    if (put.ok) return { ok: true, viaSnapshot: true, probeBlocked: probeErr };
    return { ok: false, error: put.error || probeErr, status: put.status, probeStatus: status };
  } catch (err) {
    return { ok: false, error: netErr(err), probeStatus: status };
  }
}

/* 一轮完整同步：拉 → 合并 → 推。启动、保存防抖、手动按钮三个入口共用。
   单飞：同一时刻只允许一轮在跑。不然「打开标签页 + 改了一条数据 + 手点了立即同步」
   会叠出三轮往返，服务器那边就是同一秒钟三个 401 —— 弹窗一个接一个的根源。 */
let davRoundPromise = null;

function webdavRound() {
  if (!davRoundPromise) {
    davRoundPromise = davRoundInner().finally(() => {
      davRoundPromise = null;
    });
  }
  return davRoundPromise;
}

/* 切回前台时的「顺手拉一次」（1.3.9 新鲜度链路的跨设备入口）。
   只在 WebDAV 模式有意义：browser 模式 storage.sync 自带推送通道。
   节流：10 分钟内存变量，扩展重启即重置——启动时 initSync 反正会拉一次。
   拉取挂在 davRoundPromise 单飞锁上，与手动同步/推送天然互斥。
   失败也计入节流：离线时反复切窗口不该反复打网盘。 */
const PULL_THROTTLE = 10 * 60 * 1000;
let lastAutoPullAt = 0;
let autoPullTimer = null;

export function backgroundPull() {
  if (!hasSync || conf.mode !== 'webdav') return;
  if (isManual()) return; // 手动模式：切回前台也不拉，只有「立即同步」才动云端
  if (typeof document !== 'undefined' && document.hidden) return;
  const now = Date.now();
  if (now - lastAutoPullAt < PULL_THROTTLE) return;
  lastAutoPullAt = now;
  clearTimeout(autoPullTimer);
  autoPullTimer = setTimeout(async () => {
    try {
      const r = await webdavRound();
      if (r.ok && r.pulled && remoteListener) remoteListener();
    } catch (err) {
      console.warn('background pull failed', err);
    }
  }, 400);
}

/* 最近一次看到的「对面是什么版本」。null = 没读过快照。
   设置页用它提示「有台设备在用旧版，可能抹掉卡片删除记录」。 */
export let lastDavPeer = null;

/* 待上传的段号集合（pushPending 记账）。本轮成功上传后才清账；
   单飞轮次进行中新增的键留给下一轮，不会丢。 */
const davWanted = new Set();

/* 每天第一次覆盖前的整库存档：fl-backup.json → bak1 → bak2 轮转。
   本轮已拉取的段直接复用，没拉到的段现拉一次——备份必须是覆盖前的
   完整云端状态，不能拿本机合并后的结果冒充。

   三条硬要求（都是「备份看着有、真要用时是废的」的坑）：
   1) 某一段读失败就整次放弃，不要拿残缺数据当备份，也不要推进
      lastBackupDay —— 下轮还能再试一次；
   2) 轮转的 MOVE 失败必须中止，否则接下来 PUT 会盖掉 bak，历史备份
      白丢一层；
   3) PUT 失败同样不推进日期，否则当天再也不会重试（原来这里连返回值
      都没看，备份失败是彻底静默的）。 */
async function davBackup(dconf, fetched, opt = {}) {
  const today = new Date().toISOString().slice(0, 10);
  if (conf.lastBackupDay === today) return { ok: true, skipped: true };
  const records = { ...fetched };
  // 迁移/空桶路径下四个段文件必然不存在，别为它们各发一次注定 404 的 GET
  if (!opt.skipFetch) {
    for (const sec of DAV_SECTIONS) {
      if (Object.keys(records).some((k) => sec.has(k))) continue;
      const r = await davGetSection(dconf, sec, { force: true });
      if (r.error) return { ok: false, reason: r.error };
      if (!r.data) continue; // 404：这段云端本来就没有，不算残缺
      Object.assign(records, r.data.records || {});
    }
  }
  const m1 = await davMove(dconf, DAV_BACKUP1, DAV_BACKUP2);
  if (m1.error) return { ok: false, reason: m1.error };
  const m2 = await davMove(dconf, DAV_BACKUP, DAV_BACKUP1);
  if (m2.error) return { ok: false, reason: m2.error };
  const put = await davPut(dconf, {
    app: 'firstlight', ver: 2, appVer: appVersion(), caps: CAPS,
    savedAt: Date.now(), deviceId: conf.deviceId || '', records
  }, DAV_BACKUP);
  if (put.error) return { ok: false, reason: put.error };
  conf.lastBackupDay = today;
  await saveSyncConf(conf);
  return { ok: true };
}

async function davRoundInner() {
  const dconf = conf.webdav;
  if (!hasCred(dconf)) {
    lastDavCheck = { ok: false, error: 'nocred', at: Date.now() };
    return { ok: false, reason: 'nocred' };
  }
  const wanted = new Set(davWanted); // 本轮快照；成功上传后才从 davWanted 清掉

  /* ① 读 meta（代际号总表）。404 = 云端还没有分文件：要么是空桶，
     要么还是旧版单快照（需要迁移）。 */
  const mres = await davGetMeta(dconf);
  if (mres.error) {
    lastDavCheck = { ok: false, error: mres.error, at: Date.now() };
    return { ok: false, reason: mres.error };
  }
  const cloudMeta = mres.data;
  let legacy = null;
  if (!cloudMeta) {
    const lres = await davGetLegacy(dconf);
    if (lres.error) {
      lastDavCheck = { ok: false, error: lres.error, at: Date.now() };
      return { ok: false, reason: lres.error };
    }
    legacy = lres.data;
  }

  const mine = appVersion();
  /* 版本不对称的三档，先判再合并（依据 meta 或旧快照的 appVer）：
     ① 云端由比本机更新的**代**（主.次）写过 → 拒绝写。旧代码不认识新字段，
        写一次就把新版的数据降级了。patch 级差异不算。
     ② 云端没有 appVer（1.4.0 之前的版本写的）→ 只能告警。
     ③ 两边都够新 → 正常。 */
  const peerSrc = cloudMeta || legacy || null;
  const cloudVer = String(peerSrc?.appVer || '');
  const cloudCaps = Array.isArray(peerSrc?.caps) ? peerSrc.caps.map(String) : [];
  if (peerSrc && cloudVer && compareFamily(cloudVer, mine) > 0) {
    lastDavPeer = { ver: cloudVer, caps: cloudCaps, legacy: !cloudMeta, newer: true };
    lastDavCheck = { ok: false, error: 'newercloud', at: Date.now() };
    return { ok: false, reason: 'newercloud', cloudVer };
  }
  if (peerSrc) {
    const legacyPeer = !cloudVer || compareVer(cloudVer, CAPS_VER) < 0;
    lastDavPeer = { ver: cloudVer || '未知（1.4.0 之前）', caps: cloudCaps, legacy: legacyPeer, newer: false };
  } else {
    lastDavPeer = null;
  }

  /* ② 拉取。分文件版只拉「gen 有变化的段」；迁移/空桶走整库。 */
  let pulled = false;
  let pushAll = false;
  const toPush = {};
  const fetched = {}; // 本轮真正看到的云端记录（mergebad 保险丝 + 日备份用）
  const fetchedKeys = new Set();
  const baseGens = {}; // 各段本轮看到的云端 gen（代际号锁的基准）

  if (legacy && !cloudMeta) {
    /* ---- 迁移：旧单快照并进本地，然后整库写成五个新文件 ----
       旧文件保留在网盘里不再读写。合并结果保存在本地，靠下面的整库推送上云。 */
    for (const [k, rec] of Object.entries(legacy.records || {})) fetched[k] = rec;
    const res = await pullMerge(legacy.records || {});
    pulled = res.pulled;
    Object.assign(toPush, res.toPush);
    pushAll = true;
    await markMerged();
  } else if (!cloudMeta && !legacy) {
    /* ---- 空桶首同步：整库推上去（与旧版「注册云端」行为一致）---- */
    pushAll = true;
    await markMerged();
  } else {
    for (const sec of DAV_SECTIONS) baseGens[sec.id] = cloudMeta.files?.[sec.id]?.gen || 0;
    // davResync：上一轮 meta 写失败留下的「文件与 meta 可能不一致」的段，强制重拉
    const stale = DAV_SECTIONS.filter(
      (sec) =>
        (Array.isArray(conf.davResync) && conf.davResync.includes(sec.id)) ||
        (conf.davGens?.[sec.id] ?? -1) !== baseGens[sec.id]
    );
    for (const sec of stale) {
      const r = await davGetSection(dconf, sec);
      if (r.error) {
        lastDavCheck = { ok: false, error: r.error, at: Date.now() };
        return { ok: false, reason: r.error };
      }
      if (r.data) {
        for (const [k, rec] of Object.entries(r.data.records || {})) {
          fetched[k] = rec;
          fetchedKeys.add(k);
        }
        /* 重拉成功就把这段的 resync 标记摘掉。不摘的话它会一直挂在链表里：
           本轮若恰好没有要上传的段（target 为空），下面清标记的分支根本
           走不到，于是往后每一轮都白白重拉这一个段，永远清不掉。 */
        if (Array.isArray(conf.davResync) && conf.davResync.includes(sec.id)) {
          conf.davResync = conf.davResync.filter((x) => x !== sec.id);
        }
      }
      conf.davGens = conf.davGens || {};
      conf.davGens[sec.id] = baseGens[sec.id];
    }
    if (stale.length) {
      // relevant：只比较拉过的段，没拉的段不参与「谁新谁旧」的裁决
      const res = await pullMerge(fetched, fetchedKeys);
      pulled = res.pulled;
      Object.assign(toPush, res.toPush);
      await markMerged();
      await saveSyncConf(conf); // 记住 gen 基线，下轮好跳过没变的段
    }
  }

  /* ③ 要上传的段 = 合并产出 ∪ pushPending 记账 ∪ 迁移/空桶的整库 */
  const target = new Set();
  for (const k of Object.keys(toPush)) {
    const s = davSectionOf(k);
    if (s) target.add(s);
  }
  for (const s of wanted) target.add(s);
  if (pushAll) for (const sec of DAV_SECTIONS) target.add(sec.id);

  if (target.size) {
    const units = await loadUnits();
    /* 保险丝：合并完整性校验（只查本轮拉到的段）。
       云端有记录、但合并后本地缺了其中任何一条 = 合并环节出了问题，
       宁可不写，让用户先查清楚。 */
    const allKeys = Object.keys(fetched);
    const cloudKeys = allKeys.filter(isOurs);
    // 分组记录缺席要有豁免：id 在本地分组墓碑里的，是刚被合法清掉的，不是合并失败
    const idxTombs = units[GROUP_INDEX_KEY]?.d || {};
    // 空的卡片墓碑表也豁免：它不携带任何信息（没有删过卡），本地缺这份记录是常态。
    // 云端有 {v:{}}、本地没有，并不等于合并丢了东西。
    const emptyTombs = (k, rec) => k === SITE_TOMBS_KEY && !Object.keys(rec?.v || {}).length;
    const missing = cloudKeys.filter(
      (k) =>
        !units[k] &&
        !emptyTombs(k, fetched[k]) &&
        !(k.startsWith(GROUP_PREFIX) && idxTombs[gidOf(k)])
    );
    if ((allKeys.length > 0 && cloudKeys.length === 0) || missing.length > 0) {
      lastDavCheck = { ok: false, error: 'mergebad', at: Date.now() };
      return { ok: false, reason: 'mergebad' };
    }

    /* 保险丝：每天第一次覆盖前把云端旧状态存档（⑥ 日备份）。
       空桶 + 无旧快照时没有可备份的东西，跳过。
       备份失败不阻断同步（同步是用户的主诉求），但要留痕：下一轮会再试，
       因为失败时 lastBackupDay 没推进。 */
    if (cloudMeta || legacy) {
      const bk = await davBackup(dconf, fetched, { skipFetch: !cloudMeta });
      if (!bk.ok) console.warn('云端日备份失败，下轮重试', bk.reason);
    }

    /* 代际号锁：重读 meta，任一目标段的 gen 比本轮看到的新
       = 别的设备刚写过 = 放弃上传，下一轮重拉重并。 */
    const fresh = await davGetMeta(dconf, { force: true });
    if (fresh.error) {
      lastDavCheck = { ok: false, error: fresh.error, at: Date.now() };
      return { ok: false, reason: fresh.error };
    }
    const concurrent = (() => {
      if (cloudMeta) {
        if (!fresh.data) return true; // meta 中途消失（被人为删了）
        // target 里存的是段号，不是段对象——这里按 id 取，别写成 sec.id
        for (const id of target) {
          const g = fresh.data.files?.[id]?.gen || 0;
          if (g !== (baseGens[id] || 0)) return true;
        }
        return false;
      }
      // 本轮走迁移/空桶路径：中途冒出了 meta = 有设备并发迁移，重来一轮
      return !!fresh.data;
    })();
    if (concurrent) {
      lastDavCheck = { ok: false, error: 'concurrent', at: Date.now() };
      return { ok: false, reason: 'concurrent' };
    }

    /* PUT 有改动的段（gen = 本轮基准 + 1），最后写 meta。 */
    const now = Date.now();
    const filesMeta = {};
    let putErr = null;
    for (const sec of DAV_SECTIONS) {
      if (!target.has(sec.id)) {
        const f = cloudMeta?.files?.[sec.id];
        filesMeta[sec.id] = f
          ? { gen: f.gen || 0, updatedAt: f.updatedAt || 0, deviceId: f.deviceId || '' }
          : { gen: 0, updatedAt: 0, deviceId: '' };
        continue;
      }
      const records = recordsOfSection(units, sec);
      const gen = (baseGens[sec.id] || 0) + 1;
      const put = await davPut(
        dconf,
        {
          app: 'firstlight', ver: 2, section: sec.id, gen, savedAt: now,
          deviceId: conf.deviceId || '', appVer: mine, caps: CAPS, records
        },
        sec.file
      );
      if (put.error) { putErr = put.error; break; }
      filesMeta[sec.id] = { gen, updatedAt: now, deviceId: conf.deviceId || '' };
    }
    if (putErr) {
      /* 部分段文件已写、meta 没更新：标记这些段下轮强制重拉，
         宁可多几次请求也不让「文件与 meta 各说各话」。 */
      conf.davResync = DAV_SECTIONS.filter((s) => target.has(s.id)).map((s) => s.id);
      await saveSyncConf(conf);
      lastDavCheck = { ok: false, error: putErr, at: Date.now() };
      return { ok: false, reason: putErr };
    }
    const mput = await davPut(
      dconf,
      {
        app: 'firstlight', ver: 2, appVer: mine, caps: CAPS, savedAt: now,
        deviceId: conf.deviceId || '', files: filesMeta
      },
      DAV_META
    );
    if (mput.error) {
      conf.davResync = DAV_SECTIONS.filter((s) => target.has(s.id)).map((s) => s.id);
      await saveSyncConf(conf);
      lastDavCheck = { ok: false, error: mput.error, at: Date.now() };
      return { ok: false, reason: mput.error };
    }
    conf.davGens = {};
    for (const [s, f] of Object.entries(filesMeta)) conf.davGens[s] = f.gen;
    conf.davResync = [];
    conf.lastSyncAt = now;
    await saveSyncConf(conf);
    for (const s of wanted) davWanted.delete(s);
  }

  lastDavCheck = { ok: true, at: Date.now() };
  return { ok: true, pulled };
}

/* 设置页「测试连接」：读一次 + 真写一个探针文件再删掉。
   只测读会把「没写权限」误报成「连接成功」——用户随后点保存，就会在 PUT 那步失败。 */
export async function testWebdav(dconf) {
  resetDavCooldown();
  if (!davUrl(dconf)) return { ok: false, reason: 'badurl' };
  if (!hasCred(dconf)) return { ok: false, reason: 'nocred' };
  const m = await davGetMeta(dconf, { force: true });
  if (m.error) return { ok: false, reason: m.error };
  let hasSnapshot = !!m.data;
  let savedAt = m.data?.savedAt || 0;
  if (!m.data) {
    // 云端还没有分文件：看一眼旧快照在不在（迁移前状态）
    const got = await davGetLegacy(dconf, { force: true });
    if (got.error) return { ok: false, reason: got.error };
    hasSnapshot = !!got.data;
    savedAt = got.data?.savedAt || 0;
  }
  const w = await davProbe(dconf);
  if (!w.ok) {
    return { ok: false, reason: w.error, canRead: true, canWrite: false, probeStatus: w.probeStatus };
  }
  return {
    ok: true,
    canRead: true,
    canWrite: true,
    hasSnapshot,
    savedAt,
    probeBlocked: w.probeBlocked || ''
  };
}

const HTTP_TEXT = {
  400: '请求被服务器拒绝（地址里可能有空格、中文没转义或多余的字符）',
  401: '账号或密码被拒（坚果云要用应用密码，不是登录密码）',
  403: '账号能登录，但没有这个目录的写权限',
  404: '找不到这个目录（地址要精确到网盘里已建好的文件夹，不能带不存在的子目录）',
  405: '服务器不允许这个操作（地址可能指向了网页，而不是 WebDAV 目录）',
  409: '目录不存在或层级不对（先在网盘里把同步目录建好）',
  412: '服务器上的文件状态不对，稍后重试',
  423: '文件被锁定（网盘里可能正在同步同一个文件）',
  429: '请求太频繁，被网盘限流了，等几分钟再试',
  500: '网盘服务器内部错误',
  502: '网盘网关错误，稍后重试',
  503: '网盘服务暂时不可用，稍后重试',
  507: '网盘空间不足，写不进去'
};

export function davErrText(reason) {
  const map = {
    badurl: '地址不合法（要以 http(s):// 开头，且指向一个目录）',
    nocred: '还没填账号密码（或填了没保存）',
    auth: '账号或密码被拒（坚果云要用应用密码，不是登录密码；用户名填注册邮箱）',
    forbidden: '账号能登录，但没有这个目录的写权限',
    authcool: '上次认证失败，已暂停自动同步 10 分钟；改好账号密码后点「测试连接」',
    redirect: '这个地址被重定向了（多半漏了 /dav，或指向了网页版首页）',
    html: '这个地址返回的是网页，不是 WebDAV 目录（检查地址结尾）',
    format: '服务器上的文件不是本插件的快照（可能是别的文件同名）',
    network: '连不上服务器（检查地址、网络或防火墙）',
    timeout: '连接超时',
    off: '同步未开启',
    newercloud: '云端快照由更新版本的初见写入。为避免把新版数据降级覆盖，这次没有上传 —— 请先把本机升级到最新版再同步',
    empty: '云端还没有数据（先点「保存并连接」把本机数据推一份上去）',
    error: '覆盖没有完成，请稍后重试',
    concurrent: '云端刚被另一台设备更新过，这次没有上传 —— 稍后会自动拉取并重试',
    mergebad: '云端数据的记录没能完整合并进本地（可能是版本兼容问题），为防覆盖云端正本，这次没有写入。请把设置页的「诊断」结果发给开发者'
  };
  if (map[reason]) return map[reason];
  // 形如 "http 404"：按状态码翻译，别再给用户看「未知错误」
  const m = /^http (\d{3})$/.exec(String(reason || ''));
  if (m) {
    const code = Number(m[1]);
    return `服务器返回 ${code}：${HTTP_TEXT[code] || (code >= 500 ? '网盘服务端出错，稍后重试' : '请求没有被接受')}`;
  }
  return `未知错误（${reason}）`;
}

/* ---- 诊断：把一次同步拆成 5 步逐条报，用户抄回来就知道卡在哪 ---- */
export async function diagnoseWebdav(dconf) {
  resetDavCooldown();
  const rows = [];
  const add = (name, ok, detail) => rows.push({ name, ok, detail: detail || '' });
  const show = (res) => {
    if (res.type === 'opaqueredirect') return '3xx（被重定向，未跟随）';
    const s = res.status;
    const ct = (res.headers.get('content-type') || '').split(';')[0];
    return `${s}${ct ? ` · ${ct}` : ''}`;
  };

  let u = null;
  try {
    u = new URL(String(dconf?.url || '').trim());
  } catch {
    add('① 地址解析', false, '不是合法 URL（要 http(s):// 开头）');
    return rows;
  }
  const base = davUrl(dconf);
  add(
    '① 地址解析',
    true,
    `${u.origin}${u.pathname}${u.pathname.endsWith('/') ? '' : '（已自动补 /）'}`
  );
  if (!hasCred(dconf)) {
    add('② 账号密码', false, '为空，请先填好并点「保存并连接」');
    return rows;
  }
  add('② 账号密码', true, `用户名 ${dconf.username}，密码 ${String(dconf.password).length} 位`);

  try {
    const res = await davFetch(base, 15000, {
      method: 'PROPFIND',
      headers: davHeaders(dconf, { Depth: '0', 'Content-Type': 'application/xml' }),
      body: '<?xml version="1.0"?><propfind xmlns="DAV:"><prop><resourcetype/></prop></propfind>'
    });
    const s = res.status;
    add(
      '③ 目录探测 PROPFIND',
      s === 207 || s === 200,
      s === 207 || s === 200
        ? `${show(res)}（目录存在）`
        : `${show(res)}${
            s === 401 ? '（认证被拒）'
              : s === 403 ? '（没有这个目录的访问权限）'
                : s === 404 ? '（这个目录不存在，地址要精确到已建好的文件夹）'
                  : s === 405 ? '（服务器不允许 PROPFIND，通常不影响 PUT）'
                    : ''
          }`
    );
    if (s === 401) coolDown('auth');
    else if (s === 403) coolDown('forbidden');
  } catch (err) {
    add('③ 目录探测 PROPFIND', false, netErr(err) === 'timeout' ? '超时' : '网络失败');
    return rows;
  }

  const m = await davGetMeta(dconf, { force: true });
  if (m.error) {
    add('④ 读云端 meta', false, davErrText(m.error));
  } else if (m.data) {
    let n = 0;
    let secErr = '';
    const gens = [];
    for (const sec of DAV_SECTIONS) {
      const r = await davGetSection(dconf, sec, { force: true });
      if (r.error && !secErr) secErr = r.error;
      if (r.data) {
        n += Object.keys(r.data.records || {}).length;
        gens.push(`${sec.id}:g${r.data.gen}`);
      }
    }
    let tail = '';
    if (!secErr) {
      // 旧快照残留检测：有台设备还在跑旧版、往 firstlight-sync.json 里写新数据
      const lg = await davGetLegacy(dconf, { force: true });
      if (lg.data) {
        tail = (lg.data.savedAt || 0) > (m.data.savedAt || 0)
          ? '；⚠ 旧快照比分文件新，说明有一台设备还在跑旧版插件，请全部升级'
          : '；旧快照存档仍在（不再读写）';
      }
    }
    add(
      '④ 读云端（分文件）',
      !secErr,
      secErr
        ? davErrText(secErr)
        : `meta OK · ${n} 条记录 · ${gens.join(' ')}${tail}`
    );
  } else {
    const got = await davGetLegacy(dconf, { force: true });
    add(
      '④ 读云端',
      !got.error,
      got.error
        ? davErrText(got.error)
        : got.data
          ? `200 · 旧版单快照（${Object.keys(got.data.records || {}).length} 条记录），下次同步自动迁移为分文件`
          : '404 · 云端还没有数据（首次同步正常）'
    );
  }

  const w = await davProbe(dconf);
  // 坚果云对「根目录直接建文件」时灵时不灵，一直 404 时给个可执行的下一步
  let tip = '';
  try {
    const uu = new URL(base);
    if (!w.ok && uu.pathname.replace(/\/+$/, '') === '/dav') {
      tip = `；如果一直 404，可以在网盘里新建一个 firstlight 文件夹，地址改填 ${uu.origin}/dav/firstlight/`;
    }
  } catch {
    /* 地址已经解析过，这里出错就忽略 */
  }
  add(
    '⑤ 写探针 PUT+DELETE',
    w.ok,
    w.ok
      ? w.probeBlocked
        ? `可写（临时文件名被服务器拒了 ${w.probeBlocked}，改用快照路径写入成功，不影响同步）`
        : '可写，探针文件已删除'
      : `${davErrText(w.error)}${w.probeStatus ? `　探针过程：${w.probeStatus}` : ''}${tip}`
  );
  return rows;
}

/* ================= 状态诊断：把黑盒变白盒 ================= */
function summarizeUnits(records) {
  const s = { records: 0, groups: 0, sites: 0, todos: 0, events: 0, feeds: 0, calfeeds: 0, bytes: 0 };
  for (const [k, rec] of Object.entries(records || {})) {
    s.records += 1;
    try {
      s.bytes += encoder.encode(JSON.stringify(rec)).length + k.length;
    } catch {
      /* 忽略不可序列化 */
    }
    if (k.startsWith(GROUP_PREFIX) && k !== GROUP_INDEX_KEY) {
      s.groups += 1;
      s.sites += (rec?.v?.sites || []).length;
    } else if (k === 'monk.todos.v1') s.todos = (rec?.v || []).length;
    else if (k === 'monk.events.v1') s.events = (rec?.v || []).length;
    else if (k === 'monk.feeds.v1') s.feeds = (rec?.v || []).length;
    else if (k === 'monk.calfeeds.v1') s.calfeeds = Object.keys(rec?.v || {}).length;
  }
  return s;
}

// 面板数据：本机一把抓；云端按后端各查各的。读取失败不抛，把错误放结果里。
export async function getSyncStatus() {
  const units = await loadUnits();
  /* 面板上「本机 / 云端」两个数字要能对比：本机专属数据（稍后读、日历缓存、
     弹窗队列）永不上云，混进 local.records 会让用户以为云端丢了东西。 */
  const syncable = {};
  let localOnly = 0;
  for (const [k, v] of Object.entries(units)) {
    if (!isOurs(k)) {
      localOnly += 1;
      continue;
    }
    syncable[k] = v;
  }
  const base = {
    mode: conf.mode,
    autoSync: conf.autoSync !== false,
    lastSyncAt: conf.lastSyncAt || 0,
    deviceId: conf.deviceId || '',
    local: summarizeUnits(syncable),
    localOnly
  };
  if (conf.mode === 'browser' && hasSync) {
    try {
      const remote = await chrome.storage.sync.get(null);
      const ours = {};
      for (const [k, v] of Object.entries(remote)) if (isOurs(k)) ours[k] = v;
      return { ...base, extId: chrome.runtime.id || '', remote: summarizeUnits(ours) };
    } catch (err) {
      console.warn('sync status failed', err);
      return { ...base, extId: chrome.runtime.id || '', error: 'read-failed' };
    }
  }
  if (conf.mode === 'webdav') {
    // 面板是用户主动点开看的，忽略冷却期，拿一次真实结果
    const dconf = conf.webdav || {};
    const m = await davGetMeta(dconf, { force: true });
    let error = m.error || '';
    let remote = null;
    let remoteSavedAt = 0;
    let remoteDeviceId = '';
    let peer = null;
    const peerOf = (src) => ({
      ver: src.appVer || '',
      legacy: !src.appVer || compareVer(src.appVer, CAPS_VER) < 0,
      newer: !!src.appVer && compareFamily(src.appVer, appVersion()) > 0,
      caps: Array.isArray(src.caps) ? src.caps.map(String) : []
    });
    if (!error && m.data) {
      // 分文件云端：meta 概况 + 四个段逐一读（并行，网盘慢时别排队等 4 个往返）
      remoteSavedAt = m.data.savedAt || 0;
      remoteDeviceId = m.data.deviceId || '';
      const records = {};
      const parts = await Promise.all(
        DAV_SECTIONS.map((sec) => davGetSection(dconf, sec, { force: true }))
      );
      parts.forEach((r) => {
        if (r.error && !error) error = r.error;
        Object.assign(records, r.data?.records || {});
      });
      remote = summarizeUnits(records);
      peer = { ...peerOf(m.data), split: true };
    } else if (!error) {
      // 还没迁移：读旧单快照
      const got = await davGetLegacy(dconf, { force: true });
      error = got.error || '';
      if (got.data) {
        remote = summarizeUnits(got.data.records || {});
        remoteSavedAt = got.data.savedAt || 0;
        remoteDeviceId = got.data.deviceId || '';
        peer = { ...peerOf(got.data), split: false };
      }
    }
    lastDavCheck = { ok: !error, error, at: Date.now() };
    return {
      ...base,
      url: conf.webdav?.url || '',
      remote,
      remoteSavedAt,
      remoteDeviceId,
      peer,
      error
    };
  }
  return base;
}

/* ================= 手动同步（两个后端通用） ================= */
export async function syncNow() {
  if (conf.mode === 'browser' && hasSync) {
    const pulled = await initialMerge();
    clearTimeout(pushTimer);
    await pushPending(); // 把积压的待推记录立即清掉
    return { ok: true, pulled };
  }
  if (conf.mode === 'webdav') {
    resetDavCooldown(); // 手动点「立即同步」= 用户明确要求再试一次
    // 手动模式 / 还没到防抖时间的改动都记在 pendingPush 里，先换算成段号；
    // 转完清掉 pendingPush，本轮失败由 davWanted 兜底重试。
    for (const k of pendingPush) {
      const s = davSectionOf(k);
      if (s) davWanted.add(s);
    }
    pendingPush.clear();
    return webdavRound();
  }
  return { ok: false, reason: 'off' };
}
