// 网站简介（详情模式）：
//   1) 手动填写的 desc 最优先
//   2) 已抓到的 autoDesc
//   3) 从标题里截出中文段当临时简介（零成本，不发请求）
//   4) 「分组名 · 域名」兜底 —— 宁可信息少，也不能留白（留白会被当成坏了）
// 自动抓取是**懒的**：卡片滚进视口才抓，且必须先拿到全站访问权限。
// 权限申请推迟到用户真的在看卡片时才提供入口，绝不在首屏弹窗劝退。
import { state, persist } from '../core/state.js';
import { fetchWithTimeout, hostOf } from '../core/utils.js';
import { hasFetchAccess, requestFetchAccess } from '../core/permissions.js';

const inFlight = new Set(); // 正在抓的 site.id，防重入
const queued = new Set();   // 已排队但还没开始的 site.id
const done = new Set();     // 本页已尝试过且失败的（不要反复重试同一张卡）
const queue = [];
let active = 0;
const MAX_CONCURRENT = 2;
let noteShown = false;

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

// 从 HTML 头部提取简介，兼容 name/property 与 content 属性顺序
export function parseDescription(html) {
  const head = html.slice(0, 60000);
  const metas = head.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of metas) {
    if (!/(?:name|property)\s*=\s*["'](?:description|og:description)["']/i.test(tag)) {
      continue;
    }
    const m = tag.match(/content\s*=\s*["']([^"']*)["']/i);
    if (m && m[1].trim()) return decodeEntities(m[1].trim()).slice(0, 120);
  }
  return '';
}

// 标题里常带一句人话：「GitHub | 全球最大的代码托管平台」→ 取中文那段
export function descFromTitle(title) {
  const parts = String(title || '')
    .split(/[|｜\-–—_·•/]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length < 2) return '';
  const zh = parts.filter((p) => /[\u4e00-\u9fa5]/.test(p)).sort((a, b) => b.length - a.length);
  const pick = zh[0] || '';
  return pick.length >= 4 ? pick.slice(0, 60) : '';
}

// 兜底文案：保证详情模式任何一张卡都有内容
export function fallbackDesc(site, group) {
  if (!site) return '';
  if (site.desc) return site.desc;
  if (site.autoDesc) return site.autoDesc;
  const guess = descFromTitle(site.title);
  if (guess) return guess;
  const host = hostOf(site.url || '');
  if (group?.name && host) return `${group.name} · ${host}`;
  return host || group?.name || '';
}

/* ================= 懒抓取 ================= */
function needsFetch(site) {
  return !!site && /^https?:/.test(site.url || '') && !site.desc && !site.autoDesc;
}

let observer = null;

// 卡片创建时调用：把「要不要抓」的判断推迟到它真的出现在屏幕上
export function watchCard(card, site, group) {
  if (!needsFetch(site)) return;
  if (state.data?.settings?.siteMode !== 'detail') return;

  if (!observer) {
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const { siteId, groupId } = entry.target.dataset;
          observer.unobserve(entry.target);
          onCardVisible(entry.target, siteId, groupId);
        }
      },
      { root: null, rootMargin: '120px' }
    );
  }
  card.dataset.siteId = site.id;
  card.dataset.groupId = group?.id || '';
  observer.observe(card);
}

async function onCardVisible(card, siteId, groupId) {
  const group = state.data?.groups.find((g) => g.id === groupId);
  const site = group?.sites.find((s) => s.id === siteId);
  if (!site || !needsFetch(site)) return;

  if (!(await hasFetchAccess())) {
    maybeShowNote(); // 没授权：不弹窗，只露出一个可点的入口
    return;
  }
  enqueue(site);
}

function enqueue(site) {
  if (inFlight.has(site.id) || queued.has(site.id) || done.has(site.id)) return;
  queued.add(site.id);
  queue.push(site);
  pump();
}

function pump() {
  while (active < MAX_CONCURRENT && queue.length) {
    const site = queue.shift();
    queued.delete(site.id);
    active += 1;
    fetchOne(site)
      .catch(() => false)
      .then((ok) => {
        active -= 1;
        if (!ok) done.add(site.id);
        if (ok) paintDesc(site);
        pump();
      })
      .finally(() => {
        if (!queue.length && !active) persistOnce();
      });
  }
}

async function fetchOne(site) {
  if (inFlight.has(site.id)) return false;
  inFlight.add(site.id);
  try {
    const res = await fetchWithTimeout(site.url, 6000);
    if (!res.ok) return false;
    const desc = parseDescription(await res.text());
    if (!desc) return false;
    site.autoDesc = desc;
    return true;
  } catch {
    return false;
  } finally {
    inFlight.delete(site.id);
  }
}

// 抓到一条就就地更新那张卡的文字，不整页重渲染（否则滚动位置和动画都会抖）
function paintDesc(site) {
  const card = document.querySelector(`.card[data-site-id="${CSS.escape(site.id)}"]`);
  const node = card?.querySelector('.desc');
  const group = state.data?.groups.find((g) => g.sites.some((s) => s.id === site.id));
  if (node) node.textContent = fallbackDesc(site, group);
}

let persistTimer = null;
function persistOnce() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => persist(), 800);
}

/* ================= 授权入口（首屏不弹，等用户在看卡片时） ================= */
// 什么时候露出入口：卡片第一次滚进视口、且还没授权。滚动本身就是「我在看这些卡片」的信号。
function maybeShowNote() {
  if (noteShown) return;
  if (state.data?.settings?.descPromptOff) return;
  const note = document.getElementById('descNote');
  if (!note) return;
  noteShown = true;
  note.hidden = false;
}

export function bindDescNote() {
  const note = document.getElementById('descNote');
  if (!note) return;
  note.querySelector('#descEnable')?.addEventListener('click', async () => {
    const ok = await requestFetchAccess(); // 点击是真实手势，浏览器才允许申请
    note.hidden = true;
    if (!ok) return;
    // 把当前视口里的卡片重新排一次队
    document.querySelectorAll('.card[data-site-id]').forEach((card) => {
      const group = state.data?.groups.find((g) => g.id === card.dataset.groupId);
      const site = group?.sites.find((s) => s.id === card.dataset.siteId);
      if (site && needsFetch(site)) enqueue(site);
    });
  });
  note.querySelector('#descDismiss')?.addEventListener('click', () => {
    note.hidden = true;
    state.data.settings.descPromptOff = true;
    persist();
  });
}

// 设置里打开「自动获取简介」时走这里：用户点击本身就是手势
export async function enableDescriptionsNow() {
  const ok = await requestFetchAccess();
  if (!ok) return false;
  document.querySelectorAll('.card[data-site-id]').forEach((card) => {
    const group = state.data?.groups.find((g) => g.id === card.dataset.groupId);
    const site = group?.sites.find((s) => s.id === card.dataset.siteId);
    if (site && needsFetch(site)) enqueue(site);
  });
  return true;
}

// 重新渲染后旧的观察目标已脱离文档，断开即可（队列里没抓完的不清，别把活丢了）
export function resetDescObserver() {
  observer?.disconnect();
  observer = null;
}
