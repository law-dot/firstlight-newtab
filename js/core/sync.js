// 同步引擎：本地优先，远程后端可插拔。
// v1.5 实现 browser 后端 = chrome.storage.sync（Edge/Chrome 账号同步）；
// WebDAV 后端留待 v1.6。同步配置只存本机（store.js 的 loadSyncConf），永不参与同步。
//
// 数据通路：store.js 的 SECTIONS / loadSections / saveSection 分段读写；
// 本地每次保存由 state.js persist() → notifyChanged(changedSections) 通知这里防抖推送；
// 远端推送（其他设备写入 sync 区）经 chrome.storage.onChanged 监听，防抖后拉回并回调 UI。
import {
  SECTIONS,
  loadSections,
  saveSection,
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

// 远端键名与本地分段键名一致：monk.{section}.v1
const syncKey = (s) => `monk.${s}.v1`;

let conf = { mode: 'off' };
let remoteListener = null; // 远端有更新时回调（app.js 注册，负责重载数据与重渲染）
let pushTimer = null;
let pullTimer = null;
const pendingPush = new Set();

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

// state.js persist() 保存成功后调用，changedSections 为本次变更的分段名
export function notifyChanged(changedSections = []) {
  if (conf.mode !== 'browser' || !hasSync) return;
  for (const s of changedSections) pendingPush.add(s);
  if (!pendingPush.size) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushPending, PUSH_DEBOUNCE);
}

/* ---------- 启动合并：逐段比较 updatedAt，新者胜出 ---------- */
async function initialMerge() {
  let pulled = false;
  try {
    const [remote, local] = await Promise.all([
      chrome.storage.sync.get(SECTIONS.map(syncKey)),
      loadSections()
    ]);
    const toPush = {};
    for (const s of SECTIONS) {
      const r = remote[syncKey(s)];
      const l = local[s];
      const rt = r?.updatedAt || 0;
      const lt = l?.updatedAt || 0;
      if (r && r.v != null && rt > lt) {
        await saveSection(s, r.v, r.updatedAt);
        pulled = true;
      } else if (l && lt > rt) {
        toPush[syncKey(s)] = l;
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
async function pushPending() {
  const names = [...pendingPush];
  pendingPush.clear();
  if (!names.length) return;
  const local = await loadSections();
  const writes = {};
  for (const s of names) {
    if (local[s]) writes[syncKey(s)] = local[s];
  }
  await pushRecords(writes);
}

const encoder = new TextEncoder();

async function pushRecords(writes) {
  const ok = {};
  for (const [key, rec] of Object.entries(writes)) {
    const bytes = encoder.encode(JSON.stringify(rec)).length + key.length;
    if (bytes > ITEM_LIMIT) {
      toast('数据超过浏览器同步的大小限制，部分内容未同步');
      continue;
    }
    ok[key] = rec;
  }
  if (!Object.keys(ok).length) return;
  try {
    await chrome.storage.sync.set(ok);
    conf.lastSyncAt = Date.now();
    await saveSyncConf(conf);
  } catch (err) {
    // 未登录账号 / 超写频率都会抛错，本地数据不受影响，静默降级
    console.warn('sync push failed', err);
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

function onStorageChange(changes, area) {
  if (area !== 'sync') return;
  const touched = SECTIONS.filter((s) => changes[syncKey(s)]);
  if (!touched.length) return;
  clearTimeout(pullTimer);
  pullTimer = setTimeout(() => applyRemote(touched, changes), PULL_DEBOUNCE);
}

async function applyRemote(touched, changes) {
  const local = await loadSections();
  let pulled = false;
  for (const s of touched) {
    const rec = changes[syncKey(s)].newValue;
    if (!rec || rec.v == null) continue; // 远端删除不传播，本地数据保留
    const lt = local[s]?.updatedAt || 0;
    // 严格大于才拉回：自己推送的回声（updatedAt 相等）自然被跳过
    if ((rec.updatedAt || 0) > lt) {
      await saveSection(s, rec.v, rec.updatedAt);
      pulled = true;
    }
  }
  if (pulled && remoteListener) remoteListener();
}
