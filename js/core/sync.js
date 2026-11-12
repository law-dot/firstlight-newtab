// 同步引擎：本地优先，远程后端可插拔。
// browser 后端 = chrome.storage.sync（Edge/Chrome 账号同步）；
// webdav 后端 = 用户自己的 WebDAV 网盘（坚果云等），全量快照，见下方说明。
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
  loadUnits,
  saveUnit,
  removeUnit,
  removeUnits,
  loadSyncConf,
  saveSyncConf
} from './store.js';
import { toast } from './utils.js';

const hasSync =
  typeof chrome !== 'undefined' && !!(chrome.storage && chrome.storage.sync);

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
  'monk.migrate.backup.v1', 'monk.data.v1', 'monk.groups.v1'
]);
const isOurs = (key) =>
  typeof key === 'string' && key.startsWith('monk.') && !LOCAL_ONLY.has(key);

const gidOf = (key) => key.slice(GROUP_PREFIX.length).replace(/\.v1$/, '');
const gkey = (id) => `${GROUP_PREFIX}${id}.v1`;

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

// 设置页保存完 WebDAV 配置后必须调这个：否则本模块的 conf 还是上一次 initSync 读到的旧值
// （典型症状：明明填对了账号密码，一点「保存并连接」就报「地址不合法」）
export async function reloadSyncConf() {
  conf = await loadSyncConf();
  return conf;
}

// state.js persist() 保存成功后调用，参数是本次变更的存储键
export function notifyChanged(changedUnits = []) {
  if ((conf.mode !== 'browser' && conf.mode !== 'webdav') || !hasSync) return;
  for (const k of changedUnits) if (isOurs(k)) pendingPush.add(k);
  if (!pendingPush.size) return;
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
   返回 { pulled, toPush }：pulled = 本机有更新需要重载界面；
   toPush = 本机更新的记录，调用方决定往哪个后端推。 */
export async function pullMerge(remote) {
  const local = await loadUnits();
  let pulled = false;
  const toPush = {};

  const keys = new Set([...Object.keys(local), ...Object.keys(remote).filter(isOurs)]);
  for (const key of keys) {
    if (!isOurs(key) || key === GROUP_INDEX_KEY) continue; // 索引单独处理
    const r = remote[key];
    const l = local[key];
    const rt = r?.updatedAt || 0;
    const lt = l?.updatedAt || 0;
    if (r && r.v != null && rt > lt) {
      await saveUnit(key, r);
      pulled = true;
    } else if (l && l.v != null && lt > rt) {
      toPush[key] = l;
    }
  }

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
  return { pulled, toPush };
}

/* ---------- 启动合并：逐条记录比较 updatedAt，新者胜出 ---------- */
async function initialMerge() {
  let pulled = false;
  try {
    const remote = await chrome.storage.sync.get(null);
    const res = await pullMerge(remote);
    pulled = res.pulled;
    if (Object.keys(res.toPush).length) await pushRecords(res.toPush);
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
    // WebDAV 没有逐键写：一次「拉-合并-推」全量往返，把积压一次清掉
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
  // 索引变了 = 分组有增删，顺手把云端已不存在分组的记录清掉
  if (keys.includes(GROUP_INDEX_KEY)) {
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

// 云端多于索引的分组记录：删掉。让本机的「删除分组」能传到其他设备
async function pruneRemoteGroups(indexRec) {
  try {
    const keep = new Set(((indexRec?.v) || []).map(String));
    const tombs = indexRec?.d || {};
    const remote = await chrome.storage.sync.get(null);
    const drop = Object.keys(remote).filter(
      (k) => k.startsWith(GROUP_PREFIX) && (!keep.has(gidOf(k)) || tombs[gidOf(k)])
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
export async function overwriteLocalFromRemote() {
  if (conf.mode !== 'browser' || !hasSync) return { ok: false, count: 0, reason: 'off' };
  try {
    const remote = await chrome.storage.sync.get(null);
    let count = 0;
    for (const [key, rec] of Object.entries(remote)) {
      if (!isOurs(key) || rec?.v == null) continue;
      await saveUnit(key, rec);
      count += 1;
    }
    const idx = remote[GROUP_INDEX_KEY];
    if (idx) await reconcileGroups(idx, true);
    if (count) {
      conf.lastSyncAt = Date.now();
      await saveSyncConf(conf);
    }
    return { ok: count > 0, count };
  } catch (err) {
    console.warn('sync overwrite failed', err);
    return { ok: false, count: 0, reason: 'error' };
  }
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
      await saveUnit(key, rec);
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

/* ================= WebDAV 后端 =================
   与浏览器后端的本质差别：没有变更推送通道，也没有 8KB 配额压力。
   所以走「全量快照」：一个 JSON 文件 = 全部 monk.* 记录（含订阅内容）。
   每次同步 = 拉快照 → 按记录合并（与浏览器后端同一套 pullMerge）→ 把合并后的
   完整快照传回去。**先拉后推**保证并发安全：另一台设备刚推的新数据不会
   被本机的旧状态直接盖掉——本机先把它并进来，再上传合并结果。
   快照文件本身就是备份：用户随时可以下载一份当离线保命符。 */
const WEBDAV_FILE = 'firstlight-sync.json';

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

async function davGet(dconf, opt = {}) {
  const base = davUrl(dconf);
  if (!base) return { error: 'badurl' };
  if (!hasCred(dconf)) return { error: 'nocred' };
  if (!opt.force) {
    const cool = davCooling();
    if (cool) return { error: cool, cooled: true };
  }
  try {
    const res = await davFetch(base + WEBDAV_FILE, 15000, { headers: davHeaders(dconf) });
    const bad = classify(res);
    // 404 有两种：文件还没推过（合法的空桶），或者目录压根不存在。
    // 这里当空桶处理，写的时候 PUT 会拿到 409 再回来告诉我们目录有问题。
    if (bad) return bad;
    if (res.status === 404) return { snapshot: null };
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
    if (!json || json.app !== 'firstlight' || typeof json.records !== 'object') {
      return { error: 'format' };
    }
    return { snapshot: json };
  } catch (err) {
    return { error: netErr(err) };
  }
}

async function davPut(dconf, body) {
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
    let res = await davFetch(base + WEBDAV_FILE, 20000, putInit);
    if (res.status === 409 || res.status === 404) {
      // 目录不存在：先建目录再重试一次（坚果云要求同步目录已存在）。
      // MKCOL 到已存在的目录会回 405，那是好事，继续重试 PUT 就行。
      await davFetch(base.replace(/\/+$/, ''), 15000, {
        method: 'MKCOL',
        headers: davHeaders(dconf)
      }).catch(() => {});
      res = await davFetch(base + WEBDAV_FILE, 20000, putInit);
    }
    const bad = classify(res);
    if (bad) return bad;
    if (!res.ok) return { error: `http ${res.status}`, status: res.status };
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
    // 降级：直接测真实快照路径
    const got = await davGet(dconf, { force: true });
    const body = got.snapshot || { app: 'firstlight', ver: 1, savedAt: 0, deviceId: '', records: {} };
    const put = await davPut(dconf, body);
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

async function davRoundInner() {
  const dconf = conf.webdav;
  if (!hasCred(dconf)) {
    lastDavCheck = { ok: false, error: 'nocred', at: Date.now() };
    return { ok: false, reason: 'nocred' };
  }
  const got = await davGet(dconf);
  if (got.error) {
    lastDavCheck = { ok: false, error: got.error, at: Date.now() };
    return { ok: false, reason: got.error };
  }
  let pulled = false;
  if (got.snapshot) {
    const res = await pullMerge(got.snapshot.records || {});
    pulled = res.pulled;
  }
  const units = await loadUnits();
  const put = await davPut(dconf, {
    app: 'firstlight',
    ver: 1,
    savedAt: Date.now(),
    deviceId: conf.deviceId || '',
    records: units
  });
  if (put.error) {
    lastDavCheck = { ok: false, error: put.error, at: Date.now() };
    return { ok: false, reason: put.error };
  }
  conf.lastSyncAt = Date.now();
  await saveSyncConf(conf);
  lastDavCheck = { ok: true, at: Date.now() };
  return { ok: true, pulled };
}

/* 设置页「测试连接」：读一次 + 真写一个探针文件再删掉。
   只测读会把「没写权限」误报成「连接成功」——用户随后点保存，就会在 PUT 那步失败。 */
export async function testWebdav(dconf) {
  resetDavCooldown();
  if (!davUrl(dconf)) return { ok: false, reason: 'badurl' };
  if (!hasCred(dconf)) return { ok: false, reason: 'nocred' };
  const got = await davGet(dconf, { force: true });
  if (got.error) return { ok: false, reason: got.error };
  const w = await davProbe(dconf);
  if (!w.ok) {
    return { ok: false, reason: w.error, canRead: true, canWrite: false, probeStatus: w.probeStatus };
  }
  return {
    ok: true,
    canRead: true,
    canWrite: true,
    hasSnapshot: !!got.snapshot,
    savedAt: got.snapshot?.savedAt || 0,
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
    off: '同步未开启'
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

  const got = await davGet(dconf, { force: true });
  add(
    '④ 读快照 GET',
    !got.error,
    got.error
      ? davErrText(got.error)
      : got.snapshot
        ? `200 · 已有快照，${Object.keys(got.snapshot.records || {}).length} 条记录`
        : '404 · 还没有快照（首次同步正常）'
  );

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
  const base = {
    mode: conf.mode,
    lastSyncAt: conf.lastSyncAt || 0,
    deviceId: conf.deviceId || '',
    local: summarizeUnits(units)
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
    const got = await davGet(conf.webdav || {}, { force: true });
    lastDavCheck = { ok: !got.error, error: got.error, at: Date.now() };
    return {
      ...base,
      url: conf.webdav?.url || '',
      remote: got.snapshot ? summarizeUnits(got.snapshot.records || {}) : null,
      remoteSavedAt: got.snapshot?.savedAt || 0,
      remoteDeviceId: got.snapshot?.deviceId || '',
      error: got.error
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
    return webdavRound();
  }
  return { ok: false, reason: 'off' };
}
