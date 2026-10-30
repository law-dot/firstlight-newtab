// RSS 阅读器页面：聚合时间线 + 按源筛选 + 源管理（添加/删除）
// 复用 core 存储与同步通路：feeds 配置走分段存储（可随浏览器账号同步），条目缓存纯本地。
import { loadData, uid } from './core/store.js';
import { state, persist } from './core/state.js';
import { initSync } from './core/sync.js';
import { $, toast, escapeHtml } from './core/utils.js';
import { refreshFeeds, aggregate, hasFetchAccess, requestFetchAccess } from './features/feed.js';

let cache = {};
let filter = 'all';

init();

async function init() {
  state.data = await loadData();
  // feeds 段参与浏览器账号同步：拉到远端更新则重载本地数据
  if (await initSync()) state.data = await loadData();
  applyTheme();
  bind();
  renderChips();
  renderEntries();
  doRefresh();
}

function applyTheme() {
  const t = state.data.settings.theme;
  const dark =
    t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

/* ---------- 刷新 ---------- */
async function doRefresh(force = false) {
  if (!state.data.feeds.length) return;
  $('#refreshBtn').classList.add('spinning');
  const hadEmpty = state.data.feeds.some((f) => !f.title);
  cache = await refreshFeeds(state.data.feeds, { force });
  // 有源标题被抓取回填 → 入库（走分段存储 + 同步推送）
  if (hadEmpty && state.data.feeds.some((f) => f.title)) persist();
  renderChips();
  renderEntries();
  $('#refreshBtn').classList.remove('spinning');
}

/* ---------- 事件 ---------- */
function bind() {
  $('#refreshBtn').onclick = () => doRefresh(true);
  $('#addFeedBtn').onclick = () => $('#feedDialog').showModal();
  $('#feedDialog').addEventListener('click', (e) => {
    if (e.target === $('#feedDialog') || e.target.dataset.close !== undefined) {
      $('#feedDialog').close();
    }
  });
  $('#feedForm').onsubmit = onAddFeed;
  $('#chips').onclick = onChipClick;
}

async function onAddFeed(e) {
  e.preventDefault();
  try {
    const url = $('#feedUrl').value.trim();
    const title = $('#feedTitle').value.trim();
    if (!/^https?:\/\//i.test(url)) {
      toast('请输入 http(s) 开头的 Feed 地址');
      return;
    }
    if (state.data.feeds.some((f) => f.url === url)) {
      toast('该源已存在');
      return;
    }
    // 用户手势里申请站点访问权限；拒绝也允许保存，抓取时会显示失败
    if (!(await hasFetchAccess())) await requestFetchAccess();
    state.data.feeds.push({ id: uid(), title, url });
    persist();
    $('#feedForm').reset();
    $('#feedDialog').close();
    renderChips();
    toast('已添加，正在拉取…');
    doRefresh(true);
  } catch (err) {
    console.warn('add feed failed', err);
    toast('添加失败，请重试');
  }
}

function onChipClick(e) {
  const del = e.target.closest('[data-del]');
  if (del) {
    const id = del.dataset.del;
    const f = state.data.feeds.find((f) => f.id === id);
    if (f && confirm(`删除订阅源「${f.title || f.url}」？`)) {
      state.data.feeds = state.data.feeds.filter((f) => f.id !== id);
      if (filter === id) filter = 'all';
      persist();
      renderChips();
      renderEntries();
    }
    return;
  }
  const chip = e.target.closest('[data-id]');
  if (chip) {
    filter = chip.dataset.id;
    renderChips();
    renderEntries();
  }
}

/* ---------- 渲染 ---------- */
function renderChips() {
  const feeds = state.data.feeds;
  const box = $('#chips');
  if (!feeds.length) {
    box.innerHTML = '';
    return;
  }
  const errCount = feeds.filter((f) => cache[f.id]?.error).length;
  box.innerHTML =
    `<button class="chip${filter === 'all' ? ' on' : ''}" data-id="all">全部</button>` +
    feeds
      .map(
        (f) => `
      <button class="chip${filter === f.id ? ' on' : ''}" data-id="${f.id}" title="${escapeHtml(f.url)}">
        ${cache[f.id]?.error ? '<i class="dot" title="最近拉取失败"></i>' : ''}
        <span>${escapeHtml(f.title || '拉取中…')}</span>
        <i class="x" data-del="${f.id}" title="删除该源">×</i>
      </button>`
      )
      .join('') +
    (errCount ? `<span class="chip-err">${errCount} 个源拉取失败</span>` : '');
}

function renderEntries() {
  const feeds = state.data.feeds;
  const box = $('#entries');
  if (!feeds.length) {
    box.innerHTML = `
      <div class="empty">
        <p>还没有订阅源</p>
        <p class="empty-sub">点右上角「添加源」粘贴 RSS / Atom 地址。<br>微博、B站、知乎等平台可用 RSSHub 生成地址后添加。</p>
      </div>`;
    return;
  }
  const list = aggregate(feeds, cache, filter);
  if (!list.length) {
    box.innerHTML = `
      <div class="empty">
        <p>暂无内容</p>
        <p class="empty-sub">正在拉取或源暂时不可用。预览环境受跨域限制无法抓取，请在扩展中体验。</p>
      </div>`;
    return;
  }
  box.innerHTML = list
    .map(
      (it) => `
    <a class="entry" href="${escapeHtml(it.link)}" target="_blank" rel="noopener noreferrer">
      <span class="entry-title">${escapeHtml(it.title)}</span>
      <span class="entry-meta">${escapeHtml(it.feedTitle)}${it.time ? ' · ' + relTime(it.time) : ''}</span>
    </a>`
    )
    .join('');
}

function relTime(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} 天前`;
  const d = new Date(t);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}
