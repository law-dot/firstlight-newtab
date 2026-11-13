// 稍后读（1.5.0）
// 形态：左侧抽屉里的一个入口（带未读角标）→ 点开滑出管理面板。
// 主页上不再占任何面积；列表能滚动、能筛选、能删，收几百条都不挤。
//
// 阅读净化（1.5.0 收口）：授权后把 reader.js 注册成常驻内容脚本，
// 只有 URL 带 #fl-read 标记（从面板点开时加上）的页面才会显示浮窗按钮，
// 用户点浮窗才清洗。主页不放任何按钮和提示。
import { state, persist } from '../core/state.js';
import { $, toast } from '../core/utils.js';
import { hasFetchAccess, requestFetchAccess } from '../core/permissions.js';

const SCRIPT_ID = 'fl-reader';
const OPEN_FLAG = 'fl-read';   // URL hash 标记：内容脚本只认这个

let open = false;
let query = '';
let lastSig = null;

const sigOf = (list) =>
  list.map((r) => `${r.id}:${r.readAt || 0}:${r.title}`).join('|') +
  `#${query}#${list.length}`;

function readingList() {
  if (!Array.isArray(state.data.reading)) state.data.reading = [];
  return state.data.reading;
}

function unreadCount() {
  return readingList().filter((r) => !r.readAt).length;
}

// 未读在前，同类里按加入时间倒序
function sortedList() {
  return [...readingList()].sort(
    (a, b) => (a.readAt ? 1 : 0) - (b.readAt ? 1 : 0) || (b.addedAt || 0) - (a.addedAt || 0)
  );
}

/* ---------- 面板渲染 ---------- */

function itemEl(it) {
  const li = document.createElement('li');
  li.className = 'rpanel-item' + (it.readAt ? ' is-read' : '');
  li.dataset.id = it.id;

  const a = document.createElement('a');
  a.className = 'rpanel-link';
  a.href = it.url;
  a.title = `${it.title}\n${it.url}`;

  // 圆点即已读开关：点它手动改状态，不用进条目
  const dot = document.createElement('span');
  dot.className = 'rpanel-dot';
  dot.title = it.readAt ? '标为未读' : '标为已读';
  dot.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleRead(it.id);
  });

  const text = document.createElement('span');
  text.className = 'rpanel-text';
  text.textContent = it.title;

  const host = document.createElement('span');
  host.className = 'rpanel-host';
  host.textContent = it.host;

  a.append(dot, text, host);
  a.addEventListener('click', (e) => {
    e.preventDefault();
    openItem(it);
  });

  const x = document.createElement('button');
  x.className = 'rpanel-x';
  x.type = 'button';
  x.title = '从稍后读移除';
  x.setAttribute('aria-label', '从稍后读移除');
  x.textContent = '×';
  x.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    removeItem(it.id);
  });

  li.append(a, x);
  return li;
}

function filteredList() {
  const q = query.trim().toLowerCase();
  const sorted = sortedList();
  if (!q) return sorted;
  return sorted.filter(
    (r) => (r.title || '').toLowerCase().includes(q) || (r.url || '').toLowerCase().includes(q)
  );
}

export function renderReading() {
  renderBadge();
  const listEl = $('#readingList');
  if (!listEl || !open) { lastSig = null; return; }

  const all = readingList();
  const sig = sigOf(all);
  if (sig === lastSig) return;
  lastSig = sig;

  const shown = filteredList();
  listEl.textContent = '';
  for (const it of shown) listEl.appendChild(itemEl(it));

  const empty = $('#readingEmpty');
  if (empty) empty.hidden = shown.length > 0;

  const unread = unreadCount();
  const countEl = $('#readingCount');
  if (countEl) {
    countEl.textContent = query.trim()
      ? `${shown.length} / ${all.length} 条`
      : (unread ? `${unread} 篇未读` : '都读完了');
  }
  const clear = $('#readingClear');
  if (clear) clear.hidden = !all.some((r) => r.readAt);
}

function renderBadge() {
  const badge = $('#readingBadge');
  if (!badge) return;
  const n = unreadCount();
  badge.hidden = !n;
  badge.textContent = n > 99 ? '99+' : String(n);
}

/* ---------- 开关面板 ---------- */

function setOpen(v) {
  if (open === v) return;
  open = v;
  const panel = $('#readingPanel');
  if (!panel) return;
  panel.setAttribute('aria-hidden', String(!v));
  document.body.classList.toggle('rpanel-open', v);
  lastSig = null;
  if (v) {
    query = '';
    const search = $('#readingSearch');
    if (search) search.value = '';
    renderReading();
    setTimeout(() => search && search.focus(), 80);
    refreshGrantRow();
  } else {
    renderBadge();
  }
}

/* ---------- 条目操作 ---------- */

async function removeItem(id) {
  state.data.reading = readingList().filter((r) => r.id !== id);
  renderReading();
  await persist();
}

async function clearRead() {
  const before = readingList().length;
  state.data.reading = readingList().filter((r) => !r.readAt);
  renderReading();
  await persist();
  toast(`已清掉 ${before - readingList().length} 篇读完的`);
}

async function toggleRead(id) {
  const rec = readingList().find((r) => r.id === id);
  if (!rec) return;
  rec.readAt = rec.readAt ? 0 : Date.now();
  renderReading();
  await persist();
}

/* 开新标签。点开即标已读；URL 挂上 #fl-read，常驻内容脚本看到这个
   标记才显示浮窗。为什么不在 newtab 里直接 location.href：
   那样这个标签页就变成目标网页了，注入代码再没有执行的机会。 */
async function openItem(it) {
  const rec = readingList().find((r) => r.id === it.id);
  if (rec && !rec.readAt) {
    rec.readAt = Date.now();
    renderReading();
    persist();
  }

  let url = it.url;
  try {
    const u = new URL(url);
    u.hash = OPEN_FLAG;
    url = u.toString();
  } catch { /* 非法网址就原样开，顶多没浮窗 */ }

  if (typeof chrome === 'undefined' || !chrome.tabs?.create) {
    window.open(url, '_blank', 'noopener');
    return;
  }
  try {
    await chrome.tabs.create({ url, active: true });
  } catch { /* 被拦截等，忽略 */ }
}

/* ---------- 阅读净化授权 ---------- */

// 授权后把 reader.js 注册成常驻内容脚本：刷新、站内跳转都能接住，
// 不用每次打开都 executeScript 一把。已注册过就安静返回。
async function ensureReaderRegistered() {
  if (typeof chrome === 'undefined' || !chrome.scripting?.registerContentScripts) return false;
  try {
    const regged = await chrome.scripting.getRegisteredContentScripts();
    if (regged.some((s) => s.id === SCRIPT_ID)) return true;
    await chrome.scripting.registerContentScripts([{
      id: SCRIPT_ID,
      // 只注册 https：可选权限只申请了 https://*/*，
      // 把 http 也写进来会让整条注册被浏览器拒绝（一个 origin 不合法就全败）。
      matches: ['https://*/*'],
      js: ['js/reader.js'],
      css: ['css/reader.css'],
      runAt: 'document_idle',
      persistAcrossSessions: true
    }]);
    return true;
  } catch (err) {
    console.warn('register reader script failed', err);
    return false;
  }
}

async function refreshGrantRow() {
  const row = $('#readingGrantRow');
  const btn = $('#readingGrant');
  const text = $('#readingGrantText');
  if (!row || !btn || !text) return;
  const ok = await hasFetchAccess();
  if (ok) {
    await ensureReaderRegistered();
    text.textContent = '阅读净化已开启：打开页面后点右下角浮窗';
    btn.hidden = true;
  } else {
    text.textContent = '未开启：页面保持原样，不会出现浮窗';
    btn.hidden = false;
  }
}

/* ---------- 对外接线 ---------- */

export function bindReading() {
  const entry = $('#readingEntry');
  if (entry) entry.addEventListener('click', () => setOpen(!open));

  const close = $('#readingClose');
  if (close) close.addEventListener('click', () => setOpen(false));

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && open) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  }, true);

  const search = $('#readingSearch');
  if (search) {
    search.addEventListener('input', () => {
      query = search.value;
      renderReading();
    });
  }

  const clear = $('#readingClear');
  if (clear) clear.addEventListener('click', clearRead);

  const grant = $('#readingGrant');
  if (grant) {
    grant.addEventListener('click', async () => {
      const ok = await requestFetchAccess();   // 必须在点击手势里调
      if (ok) await ensureReaderRegistered();
      refreshGrantRow();
      toast(ok ? '已开启：从稍后读打开的页面，右下角会出现阅读浮窗' : '没拿到授权，仍需手动开');
    });
  }

  // 启动时如果已有授权（别的页面开过），把内容脚本补注册上
  hasFetchAccess().then((ok) => { if (ok) ensureReaderRegistered(); });
  renderBadge();
}
