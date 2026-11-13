// 首次使用引导：聚光灯挖洞 + 分步气泡，纯 CSS 过渡驱动动画。
//
// 设计约束（踩过的坑，别改）：
// 1) 用普通 div 而不是 <dialog>。showModal 的 dialog 在 top layer，
//    任何 z-index 都压不住它，之后想加遮罩就得跟浏览器打架。
//    代价是引导期间不能有 dialog 打开 —— startTour() 会先把它们全关掉。
// 2) 高亮不用「四块遮罩拼图」，用一层 box-shadow 0 0 0 9999px 的洞。
//    少 3 个元素、少一处对不齐，圆角也天然正确。
// 3) 目标是「可能不存在」的（分组栏可能收起、待办可能是 hidden 模式），
//    找不到就跳过这一步，绝不把气泡挂到屏幕外。
import { $, clamp } from '../core/utils.js';
import { state, persist } from '../core/state.js';

const STEPS = [
  {
    sel: '#q',
    title: '先搜一下',
    desc: '输入网址回车直达，也可以直接搜索。按 <kbd>/</kbd> 或 <kbd>Ctrl/⌘ + K</kbd> 随时回到这里。'
  },
  {
    sel: '#btnOpenSide',
    title: '网站都在分组里',
    desc: '点这个箭头展开分组栏。编辑模式（右上角铅笔）下可以增删分组、拖拽排序。'
  },
  {
    sel: '#grid',
    title: '这是你的卡片区',
    desc: '现在放的是示例网站。点右上角铅笔进入编辑模式就能添加自己的站，或者直接把浏览器收藏夹整个导进来。'
  },
  {
    sel: '#dock',
    title: '常用站点自动浮上来',
    desc: '底部 Dock 会记住你最常打开的 5 个网站，按使用频率排序，不用每次翻分组。',
    // 全新用户的 Dock 还是空的，别对着一个空框说「这是你的常用站」
    emptyDesc: '这个位置以后会自动浮出你最常打开的 5 个网站，按使用频率排序。用一阵子就有了。'
  },
  {
    sel: '#todoFab',
    title: '今天的事记这里',
    desc: '点一下展开待办面板：待办、日程、日历订阅都在一处。'
  },
  {
    sel: '#btnSettings',
    title: '换张壁纸？改个快捷键？',
    desc: '主题、壁纸、搜索、同步都在设置里。数据默认只存本机，同步需要你自己开启。'
  },
  {
    center: true,
    title: '就这样，开始用吧',
    desc: '这份引导随时能重看：设置右上角的问号，就是完整说明。'
  }
];

const PAD = 8;        // 洞口比目标外扩多少，别让高亮边缘贴着卡片
const GAP = 16;       // 气泡与洞口的距离
const EDGE = 16;      // 气泡距视口边缘的最小距离

let root = null;
let hole = null;
let card = null;
let els = null;
let list = [];
let cur = 0;
let running = false;
let settle = null;
let lastFocus = null;
let appVer = '';

/* ---------------- DOM ---------------- */

function mount() {
  if (root) return;
  root = document.createElement('div');
  root.className = 'tour';
  root.hidden = true;
  root.innerHTML = `
    <div class="tour-hole" aria-hidden="true"></div>
    <div class="tour-card" role="dialog" aria-modal="true" aria-label="使用引导">
      <div class="tour-top">
        <span class="tour-idx"></span>
        <span class="tour-dots"></span>
      </div>
      <div class="tour-body">
        <h3 class="tour-title"></h3>
        <p class="tour-desc"></p>
      </div>
      <div class="tour-actions">
        <button class="tour-skip" type="button" data-act="skip">跳过</button>
        <span class="tour-right">
          <button class="btn small" type="button" data-act="prev">上一步</button>
          <button class="btn primary small" type="button" data-act="next">下一步</button>
        </span>
      </div>
    </div>`;
  document.body.append(root);

  hole = root.querySelector('.tour-hole');
  card = root.querySelector('.tour-card');
  els = {
    idx: root.querySelector('.tour-idx'),
    dots: root.querySelector('.tour-dots'),
    title: root.querySelector('.tour-title'),
    desc: root.querySelector('.tour-desc'),
    next: root.querySelector('[data-act="next"]'),
    prev: root.querySelector('[data-act="prev"]')
  };

  root.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'next') return step(cur + 1);
    if (act === 'prev') return step(cur - 1);
    if (act === 'skip') return finish('skip');
    // 点空白也算「下一步」：说明书式引导里，最自然的动作就是继续
    if (!e.target.closest('.tour-card')) step(cur + 1);
  });

  window.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', relayout);
  window.addEventListener('scroll', relayout, true);
}

function onKey(e) {
  if (!running) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    finish('skip');
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    step(cur + 1);
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    step(cur - 1);
  }
}

/* ---------------- 定位 ---------------- */

// 目标不可见（隐藏、零尺寸、被折叠）时返回 null，调用方跳过该步
function targetRect(step) {
  if (!step.sel) return null;
  const el = $(step.sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 8 || r.height < 8) return null;
  const cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.05) return null;
  if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return null;
  return r;
}

function holeBox(r) {
  const x = clamp(r.left - PAD, 4, innerWidth - 4);
  const y = clamp(r.top - PAD, 4, innerHeight - 4);
  const w = Math.min(r.width + PAD * 2, innerWidth - 8);
  const h = Math.min(r.height + PAD * 2, innerHeight - 8);
  return { x, y, w, h };
}

function place(r) {
  const cw = card.offsetWidth;
  const ch = card.offsetHeight;

  if (!r) {
    // 收尾卡片：居中，洞口缩成一个点藏起来
    hole.style.width = '0px';
    hole.style.height = '0px';
    hole.style.left = `${innerWidth / 2}px`;
    hole.style.top = `${innerHeight / 2}px`;
    hole.style.opacity = '0';
    card.classList.add('center');
    card.style.left = `${Math.round((innerWidth - cw) / 2)}px`;
    card.style.top = `${Math.round((innerHeight - ch) / 2)}px`;
    return;
  }

  const b = holeBox(r);
  hole.style.left = `${b.x}px`;
  hole.style.top = `${b.y}px`;
  hole.style.width = `${b.w}px`;
  hole.style.height = `${b.h}px`;
  hole.style.opacity = '1';
  card.classList.remove('center');

  const below = r.bottom + GAP + ch + EDGE <= innerHeight;
  const above = r.top - GAP - ch - EDGE >= 0;
  let top;
  if (below) top = r.bottom + GAP;
  else if (above) top = r.top - GAP - ch;
  else top = clamp(r.top + r.height / 2 - ch / 2, EDGE, innerHeight - ch - EDGE);

  const left = clamp(r.left + r.width / 2 - cw / 2, EDGE, innerWidth - cw - EDGE);
  card.style.left = `${Math.round(left)}px`;
  card.style.top = `${Math.round(top)}px`;
}

function relayout() {
  if (!running) return;
  place(targetRect(list[cur]));
}

/* ---------------- 渲染与步进 ---------------- */

function paintDots() {
  els.dots.innerHTML = list
    .map((_, i) => `<i class="${i === cur ? 'on' : i < cur ? 'past' : ''}"></i>`)
    .join('');
}

function render(step) {
  els.idx.textContent = `${cur + 1} / ${list.length}`;
  els.title.textContent = step.title;
  // 有些步骤要对「空状态」换个说法（比如 Dock 还没攒够数据）
  const host = step.sel ? $(step.sel) : null;
  const text = step.emptyDesc && host && host.children.length === 0 ? step.emptyDesc : step.desc;
  els.desc.innerHTML = text; // 文案是常量，里面只有 <kbd> / <b>
  els.prev.disabled = cur === 0;
  els.next.textContent = cur === list.length - 1 ? '开始使用' : '下一步';
  paintDots();

  // 换文案时给一个极短的淡入位移，让「跳步」不至于生硬
  card.classList.remove('swap');
  void card.offsetWidth;
  card.classList.add('swap');
}

function step(i) {
  if (!running) return;
  if (i >= list.length) return finish('done');
  if (i < 0) return;

  cur = i;
  const target = list[cur];
  const r = targetRect(target);
  // 目标不在（分组栏收着、待办被隐藏）：跳过，不要挂到屏幕外
  if (target.sel && !r) return step(i + 1);

  render(target);
  place(r);
}

/* ---------------- 对外 ---------------- */

export function shouldTour(settings) {
  const s = settings || state.data?.settings || {};
  if (s.onboardedV) return false;      // 已经完整走过一遍（记录的是当时的版本号）
  return s.showOnboarding !== false;   // 老版本用户手关过说明弹窗的，不再打扰
}

export function isTouring() {
  return running;
}

/* 返回 'done' | 'skip' | 'busy' | 'nodata' */
export function startTour(version = '') {
  if (running) return Promise.resolve('busy');
  if (!state.data?.settings) return Promise.resolve('nodata');

  // 引导期间不能有 dialog：top layer 压不住，气泡会被盖在下面
  document.querySelectorAll('dialog[open]').forEach((d) => {
    try { d.close(); } catch { /* 忽略 */ }
  });
  document.body.classList.remove('drawer-open', 'editing', 'todo-open');
  lastFocus = document.activeElement;

  mount();
  list = STEPS.slice();
  cur = 0;
  running = true;
  appVer = version || versionOf();

  root.hidden = false;
  document.body.classList.add('tour-on');
  // 首帧先定好洞口位置，再打开过渡，否则会从屏幕左上角飞过来
  hole.style.transition = 'none';
  const first = (() => {
    for (let i = 0; i < list.length; i += 1) {
      const r = targetRect(list[i]);
      if (list[i].sel && !r) continue;
      cur = i;
      return { step: list[i], r };
    }
    return { step: list[list.length - 1], r: null };
  })();
  render(first.step);
  place(first.r);
  void hole.offsetWidth;
  hole.style.transition = '';
  // 先重排一次，让 opacity:0 成为「已计算过的样式」，再加类才会走过渡。
  // rAF 在后台标签页会被完全节流，所以补一个定时器兜底：新标签页在后台打开时，
  // 引导不会卡在「看不见但能吃点击」的状态。
  void root.offsetWidth;
  requestAnimationFrame(() => root.classList.add('on'));
  setTimeout(() => root.classList.add('on'), 60);

  return new Promise((res) => { settle = res; });
}

function finish(reason) {
  if (!running) return;
  running = false;
  document.body.classList.remove('tour-on');
  root.classList.remove('on');

  // 走完和跳过都算「看过了」：只记一次，之后不再自动弹
  if (reason === 'done' || reason === 'skip') {
    state.data.settings.onboardedV = state.data.settings.onboardedV || appVer;
    state.data.settings.showOnboarding = false;
    persist();
  }

  setTimeout(() => {
    if (!running && root) {
      root.hidden = true;
      card.classList.remove('swap', 'center');
    }
  }, 220);

  if (lastFocus?.focus) {
    try { lastFocus.focus({ preventScroll: true }); } catch { /* 忽略 */ }
  }
  const done = settle;
  settle = null;
  if (done) done(reason);
}

function versionOf() {
  try {
    return (chrome.runtime?.getManifest?.().version) || '1';
  } catch {
    return '1';
  }
}
