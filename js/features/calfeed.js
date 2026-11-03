// 日历订阅管理：添加/删除/刷新 ICS 源，合并进 agenda 统一入口
import { state, persist } from '../core/state.js';
import { uid } from '../core/store.js';
import { parseICS, looksLikeICS } from './ics.js';
import { renderTodo } from './todo.js';
import { cal } from './calendar.js';

const FEED_COLORS = ['#4285F4', '#EA4335', '#34A853', '#FBBC05', '#9C27B0', '#FF9800', '#00BCD4'];

// 只有真正跑在扩展里才有 chrome.runtime.id；Web 预览环境下 chrome 对象可能部分存在（如浏览器注入），
// 但没有 runtime.id，且 chrome.permissions.request 会 hang 住不 resolve。用这个判定扩展环境。
function isExtension() {
  return typeof chrome !== 'undefined' && chrome.runtime && !!chrome.runtime.id;
}

// Web 预览环境 fetch 外部 ICS 会被 CORS 拒。走本地服务器的 /proxy endpoint 兜底。
// 本地 server.py 会把请求直接转发给目标 URL，绕开浏览器同源策略。
const LOCAL_PROXY_BASE = (() => {
  try { return location.origin + '/proxy?url='; } catch { return ''; }
})();
const CORS_PROXY = (url) => LOCAL_PROXY_BASE + encodeURIComponent(url);

export function defaultFeedName(url) {
  try {
    const path = new URL(url).pathname;
    const last = path.split('/').filter(Boolean).pop() || 'calendar';
    return last.replace(/\.ics$/i, '') || '订阅';
  } catch {
    return '订阅';
  }
}

export function feedColor(url) {
  // 稳定哈希 → 固定颜色，同一 URL 总是同色
  let h = 0;
  for (let i = 0; i < url.length; i++) h = (h * 31 + url.charCodeAt(i)) >>> 0;
  return FEED_COLORS[h % FEED_COLORS.length];
}

export function listFeeds() {
  return (state.data.feeds || []).filter((f) => f && typeof f === 'object');
}

export function getFeed(id) {
  return listFeeds().find((f) => f.id === id) || null;
}

export function addFeed({ url, name }) {
  if (!url || !/^https?:\/\//i.test(url)) {
    return { ok: false, error: 'URL 必须以 http:// 或 https:// 开头' };
  }
  const existing = listFeeds().find((f) => f.url === url.trim());
  if (existing) return { ok: false, error: '已订阅该地址' };

  const feed = {
    id: uid(),
    url: url.trim(),
    name: (name || defaultFeedName(url)).trim(),
    color: feedColor(url),
    items: [],
    lastSync: 0,
    error: ''
  };
  state.data.feeds = [...(state.data.feeds || []), feed];
  persist();
  // 立即同步一次
  syncFeed(feed.id);
  return { ok: true, feed };
}

export function removeFeed(id) {
  const before = listFeeds().length;
  state.data.feeds = listFeeds().filter((f) => f.id !== id);
  if (state.data.feeds.length !== before) {
    persist();
    renderTodo();
    cal.render();
  }
}

export function getFeedItems() {
  const all = [];
  for (const f of listFeeds()) {
    for (const it of f.items || []) {
      all.push({ ...it, feedId: f.id, feedName: f.name, color: f.color, kind: 'feed-event' });
    }
  }
  return all;
}

async function fetchICS(url) {
  const ext = isExtension();

  // 扩展环境：直接 fetch（第一次就有权限；被拒则 catch 里弹窗申请后重试）
  // Web 预览：直接 fetch 大概率 CORS，先走 CORS 代理兜底
  let targets = ext ? [url] : [url, CORS_PROXY(url)];

  for (const target of targets) {
    try {
      const resp = await fetch(target, { cache: 'no-store' });
      if (!resp.ok) continue;
      const text = await resp.text();
      if (!looksLikeICS(text)) continue;
      return { ok: true, items: parseICS(text) };
    } catch {
      // 这个 target 失败，试下一个
    }
  }

  // 如果是扩展环境且权限可能未授予，主动弹窗申请后再试一次
  if (ext) {
    try {
      const origin = new URL(url).origin + '/*';
      const granted = await chrome.permissions.request({ origins: [origin] });
      if (granted) {
        try {
          const resp = await fetch(url, { cache: 'no-store' });
          if (resp.ok) {
            const text = await resp.text();
            if (looksLikeICS(text)) return { ok: true, items: parseICS(text) };
          }
        } catch { /* final fallback already exhausted */ }
      }
    } catch { /* permissions.request may throw if not declared in manifest */ }
  }

  return { ok: false, error: ext ? '访问失败（可能权限未授予）' : 'CORS 拦截 + 代理均失败' };
}

/* 主动请求 ICS URL 对应域名的访问权限（添加订阅前调用）
   Web 预览环境直接返回 true（用 CORS 代理兜底，不需要权限弹窗） */
export async function ensureFeedPermission(url) {
  if (!isExtension()) return true; // Web 预览 → 跳过，靠代理兜底
  try {
    const origin = new URL(url).origin + '/*';
    if (await chrome.permissions.contains({ origins: [origin] })) return true;
    return await chrome.permissions.request({ origins: [origin] });
  } catch {
    return false;
  }
}

/* 手动刷新单个订阅源 */
export async function syncFeed(id) {
  const feed = getFeed(id);
  if (!feed) return;
  const result = await fetchICS(feed.url);
  if (result.ok) {
    feed.items = result.items;
    feed.lastSync = Date.now();
    feed.error = '';
  } else {
    feed.error = result.error;
  }
  persist();
  renderTodo();
  cal.render();
}

/* 刷新全部 */
export async function syncAll() {
  for (const f of listFeeds()) {
    await syncFeed(f.id);
  }
}

/* 扩展环境：chrome.alarms 定时（需 "alarms" 权限）
   Web 预览环境：走浏览器原生 setTimeout，每小时触发一次 */
let alarmSetup = false;
export function setupFeedAlarm() {
  if (alarmSetup) return;
  alarmSetup = true;
  if (isExtension() && chrome.alarms) {
    chrome.alarms.create('feed-sync', { periodInMinutes: 60 * 24 });
    chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'feed-sync') syncAll(); });
  } else {
    setInterval(() => { if (listFeeds().length) syncAll(); }, 60 * 60 * 1000);
  }
}
