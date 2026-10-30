// RSS 阅读器内核：抓取 + 解析（RSS 2.0 / Atom / RDF）+ 30 分钟 TTL 本地缓存。
// 条目缓存只存本机（store.js 的 monk.feedcache.v1），不参与浏览器账号同步。
import { loadFeedCache, saveFeedCache } from '../core/store.js';
import { fetchWithTimeout, escapeHtml } from '../core/utils.js';

const TTL = 30 * 60 * 1000; // 同一源 30 分钟内不重复抓取
const MAX_ITEMS = 20; // 每源最多保留条数，防止缓存膨胀

/* ---------- 站点访问权限（与 manifest 的 optional_host_permissions 严格一致） ---------- */
// 只能声明 manifest 里列出的 origins，否则 contains/request 会直接抛错
const OPTIONAL_ORIGINS = ['https://*/*'];

export async function hasFetchAccess() {
  if (typeof chrome === 'undefined' || !chrome.permissions?.contains) return false;
  try {
    return await chrome.permissions.contains({ origins: OPTIONAL_ORIGINS });
  } catch {
    return false;
  }
}

export async function requestFetchAccess() {
  if (typeof chrome === 'undefined' || !chrome.permissions?.request) return false;
  try {
    return await chrome.permissions.request({ origins: OPTIONAL_ORIGINS });
  } catch {
    return false;
  }
}

/* ---------- 解析 ---------- */
function childText(node, names) {
  for (const el of node.children) {
    if (names.includes(el.localName.toLowerCase()) && el.textContent.trim()) {
      return el.textContent.trim();
    }
  }
  return '';
}

function linkOf(node) {
  let fallback = '';
  for (const el of node.children) {
    if (el.localName !== 'link') continue;
    const href = el.getAttribute('href');
    if (href) {
      const rel = (el.getAttribute('rel') || 'alternate').toLowerCase();
      if (rel === 'alternate') return href; // Atom 正文链接
      if (!fallback) fallback = href;
    } else if (el.textContent.trim()) {
      return el.textContent.trim(); // RSS 2.0 <link> 文本
    }
  }
  return fallback;
}

export function parseFeed(xml) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  if (doc.querySelector('parsererror')) throw new Error('bad xml');
  const feedTitle =
    doc.querySelector('channel > title')?.textContent.trim() ||
    doc.querySelector('feed > title')?.textContent.trim() ||
    '';
  const items = [...doc.querySelectorAll('item, entry')]
    .slice(0, MAX_ITEMS)
    .map((node) => {
      const title = childText(node, ['title']);
      const link = linkOf(node);
      // pubDate / published / updated / dc:date（localName 已去命名空间前缀）
      const time = Date.parse(childText(node, ['pubdate', 'published', 'updated', 'date', 'created'])) || 0;
      const id = childText(node, ['guid', 'id']) || link || title;
      return { id, title, link, time };
    })
    .filter((it) => it.title && it.link);
  if (!items.length && !feedTitle) throw new Error('not a feed');
  return { title: feedTitle, items };
}

/* ---------- 抓取 + 缓存 ---------- */
// 失败也写入 fetchedAt：TTL 内不再重试，避免每次打开都打挂掉的源。
// 源标题为空的会在抓到时自动回填到 feed 对象，调用方负责 persist。
export async function refreshFeeds(feeds, { force = false } = {}) {
  const cache = await loadFeedCache();
  const stale = feeds.filter(
    (f) => force || !cache[f.id] || Date.now() - (cache[f.id].fetchedAt || 0) > TTL
  );
  const queue = [...stale];
  let dirty = false;

  async function worker() {
    let f;
    while ((f = queue.shift())) {
      const prev = cache[f.id] || { items: [] };
      try {
        const res = await fetchWithTimeout(f.url, 8000);
        if (!res.ok) throw new Error('http ' + res.status);
        const parsed = parseFeed(await res.text());
        cache[f.id] = { fetchedAt: Date.now(), error: '', items: parsed.items };
        if (!f.title && parsed.title) f.title = parsed.title; // 回填源标题
      } catch {
        cache[f.id] = { ...prev, fetchedAt: Date.now(), error: '拉取失败' };
      }
      dirty = true;
    }
  }

  await Promise.all([worker(), worker()]);
  if (dirty) await saveFeedCache(cache);
  return cache;
}

/* ---------- 待机跑马灯：newtab 页 idle 模式下的氛围组件 ---------- */
// 进入待机时调用：TTL 内增量刷新后，把最新 30 条标题铺成全宽无缝滚动条。
// 无订阅源 / 无条目时保持 ticker-empty，页面完全不显示该条。
export async function updateIdleTicker(feeds) {
  const el = document.getElementById('ticker');
  const track = document.getElementById('tickerTrack');
  if (!el || !track) return;
  if (!feeds.length) {
    el.classList.add('ticker-empty');
    return;
  }
  const cache = await refreshFeeds(feeds);
  const items = aggregate(feeds, cache).slice(0, 30);
  if (!items.length) {
    el.classList.add('ticker-empty');
    return;
  }
  const sep = '<span class="ticker-sep"></span>';
  const half =
    items
      .map(
        (it) =>
          `<span class="ticker-item"><b>${escapeHtml(it.feedTitle)}</b>${escapeHtml(it.title)}</span>`
      )
      .join(sep) + sep;
  track.innerHTML = half + half; // 双份内容，translateX(-50%) 无缝循环
  el.classList.remove('ticker-empty');
  // 恒速 50px/s：按一半内容的实际宽度折算时长
  requestAnimationFrame(() => {
    const halfWidth = track.scrollWidth / 2;
    track.style.animationDuration = `${Math.max(24, halfWidth / 50)}s`;
  });
}

/* ---------- 聚合：合并全部源按时间倒序 ---------- */
export function aggregate(feeds, cache, feedId = 'all') {
  const out = [];
  for (const f of feeds) {
    if (feedId !== 'all' && f.id !== feedId) continue;
    const c = cache[f.id];
    if (!c || !Array.isArray(c.items)) continue;
    for (const it of c.items) {
      out.push({ ...it, feedId: f.id, feedTitle: f.title || '未命名源' });
    }
  }
  return out.sort((a, b) => (b.time || 0) - (a.time || 0));
}
