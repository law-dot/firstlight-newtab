// 同步引擎：本地优先，远程后端可插拔。
// browser 后端 = chrome.storage.sync（Edge/Chrome 账号同步）；WebDAV 后端留待以后。
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
  unwatchRemote();
  if (conf.mode !== 'browser' || !hasSync) return false;
  const pulled = await initialMerge();
  watchRemote();
  return pulled;
}

// state.js persist() 保存成功后调用，参数是本次变更的存储键
export function notifyChanged(changedUnits = []) {
  if (conf.mode !== 'browser' || !hasSync) return;
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

/* ---------- 启动合并：逐条记录比较 updatedAt，新者胜出 ---------- */
async function initialMerge() {
  let pulled = false;
  try {
    const [remote, local] = await Promise.all([chrome.storage.sync.get(null), loadUnits()]);
    const keys = new Set([...Object.keys(local), ...Object.keys(remote).filter(isOurs)]);
    const toPush = {};

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

    if (Object.keys(toPush).length) await pushRecords(toPush);
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
