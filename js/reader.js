/* 初见 · 稍后读的「阅读态」注入脚本
 *
 * 这个文件不依赖任何扩展 API，只做 DOM 操作，所以既能被
 * chrome.scripting.executeScript 注入，也能被本地测试页直接 <script> 引入。
 *
 * 思路：查不多余的东西一律不删，只打标记（data-fl-hide / data-fl-reader-body），
 * 隐藏交给 css/reader.css 里带 html.fl-reader 前缀的规则。
 * 于是「退出阅读」= 删掉 html 上的那个类 + 去掉标记，页面 100% 还原，零侵入。
 */
(() => {
  'use strict';
  if (window.__flReader) return;
  // 注意：这里不能提前把 __flReader 置真 —— 底部的挂载判断要靠它区分
  // 「这个文档已经处理过」和「还没有」。置真放在真正挂载的那一刻。

  const MIN_TEXT = 140;      // 少于这么多字不算正文候选
  const MAX_SCAN = 2000;     // 扫描上限，避免超大页面卡顿
  const MIN_SCORE = 420;     // 低于这个分说明不像文章，走降级模式

  // 导航 / 工具栏 / 广告 / 评论 / 推荐位这一类，靠 class 或 id 就能认出来
  const NOISE_RE = new RegExp(
    '(^|[-_\\s])(' + [
      'nav', 'navbar', 'navigation', 'menu', 'sidebar', 'side-bar', 'footer',
      'header', 'topbar', 'toolbar', 'share', 'social', 'comment', 'comments',
      'related', 'recommend', 'promo', 'banner', 'advert', 'ads', 'adslot',
      'ad-slot', 'sponsor', 'cookie', 'popup', 'modal', 'subscribe',
      'newsletter', 'breadcrumb', 'pagination', 'pager', 'tags', 'author-bio',
      'login', 'signup', 'qrcode', 'download-app', 'backtop', 'gotop'
    ].join('|') + ')([-_\\s]|$)', 'i');

  // 正文内部还要再清一遍的东西（命中就藏）
  const INNER_NOISE_RE = new RegExp(
    '(^|[-_\\s])(' + [
      'advert', 'adsbygoogle', 'adslot', 'ad-slot', 'sponsor', 'share',
      'social', 'related', 'recommend', 'comment', 'cookie', 'subscribe',
      'newsletter', 'paywall', 'promo', 'reward', 'qrcode', 'backtop',
      'gotop', 'crumb', 'breadcrumb'
    ].join('|') + ')([-_\\s]|$)', 'i');

  const sigOf = (el) =>
    `${el.id || ''} ${typeof el.className === 'string' ? el.className : ''}`;

  // innerText 会触发重排，所以先用便宜的 textContent 粗筛，再精确测可见字数
  function visibleLen(el) {
    const t = el.innerText;
    return t ? t.replace(/\s+/g, ' ').trim().length : 0;
  }

  function score(el, len) {
    const q = (sel) => el.querySelectorAll(sel).length;
    let s = len;
    s += Math.min(q('p'), 30) * 28;
    s += Math.min(q('h2, h3'), 10) * 12;
    s += Math.min(q('img'), 12) * 6;
    s += Math.min(q('pre, blockquote, ul, ol, figure'), 12) * 5;

    // 链接密度：全是链接的那块肯定是导航或目录
    let linkLen = 0;
    for (const a of el.querySelectorAll('a')) linkLen += (a.innerText || '').length;
    const density = len > 0 ? linkLen / len : 1;
    if (density > 0.5) s *= 0.2;
    else if (density > 0.33) s *= 0.55;

    if (NOISE_RE.test(sigOf(el))) s *= 0.2;
    if (el.tagName === 'ARTICLE' || el.tagName === 'MAIN') s *= 1.3;
    if (el.getAttribute('role') === 'main') s *= 1.25;
    return s;
  }

  // 选中最高分之后，如果它有一个子容器吃掉了大半内容，就继续往下钻，
  // 免得把整个 <div id="app"> 当成正文（那等于没清理）。
  // 但已经是 article / main 的就不再钻 —— 那本来就是语义正确的正文容器，
  // 再往下钻会把标题和作者行一起丢在外面，读起来反而缺头少尾。
  function descend(start) {
    let cur = start;
    for (let guard = 0; guard < 6; guard++) {
      if (!cur.len) break;
      if (cur.el.tagName === 'ARTICLE' || cur.el.tagName === 'MAIN') break;
      if (cur.el.getAttribute('role') === 'main') break;
      let next = null;
      for (const c of cur.el.children) {
        if (/^(P|H1|H2|H3|H4|LI|PRE|BLOCKQUOTE|TABLE|FIGURE)$/.test(c.tagName)) continue;
        if (c.textContent.length < MIN_TEXT) continue;
        const len = visibleLen(c);
        if (len < MIN_TEXT || len / cur.len < 0.6) continue;
        const s = score(c, len);
        if (!next || s > next.s) next = { el: c, len, s };
      }
      if (!next) break;
      if (next.s < cur.s * 0.45) break;   // 子容器明显像噪音（链接墙/评论区），别钻
      cur = next;
    }
    return cur;
  }

  /* 这段内容像不像「一篇文章」。
     不做这层判断的话，新闻列表页 / 首页也会被套上单栏排版：
     一堆条目被挤成窄条、缩略图错位，比不清洗还难受。
     三个信号，命中任意一个就认定不是文章：
       ① 结构重复 —— 5 个以上同标签同 class 的兄弟，那是一条条列表项；
       ② 段落太碎 —— 平均每段不到 45 字，典型的「标题 + 两行摘要」；
       ③ 标题成堆 —— 没有 h1 却有 4 个以上 h2/h3。 */
  function looksLikeList(el) {
    const kids = Array.from(el.children);
    if (kids.length >= 5) {
      const groups = new Map();
      for (const k of kids) {
        const key = `${k.tagName}|${typeof k.className === 'string' ? k.className : ''}`;
        groups.set(key, (groups.get(key) || 0) + 1);
      }
      for (const n of groups.values()) if (n >= 5) return true;
    }

    const ps = el.querySelectorAll('p');
    if (ps.length >= 5) {
      let total = 0;
      for (const p of ps) total += (p.innerText || '').replace(/\s+/g, ' ').trim().length;
      if (total / ps.length < 45) return true;
    }

    if (!el.querySelector('h1') && el.querySelectorAll('h2, h3').length >= 4) return true;
    return false;
  }

  function pick() {
    const pool = document.body.querySelectorAll('article, main, [role="main"], section, div, td');
    const cands = [];
    let scanned = 0;
    for (const el of pool) {
      if (++scanned > MAX_SCAN) break;
      if (el.textContent.length < MIN_TEXT) continue;
      const len = visibleLen(el);
      if (len < MIN_TEXT) continue;
      cands.push({ el, len, s: score(el, len) });
    }
    if (!cands.length) return null;
    cands.sort((a, b) => b.s - a.s);
    // 从高分往下依次校验，碰到第一个「像文章」的就用它
    for (const c of cands.slice(0, 10)) {
      if (looksLikeList(c.el)) continue;
      const d = descend(c);
      if (looksLikeList(d.el)) continue;
      return d;
    }
    return null;
  }

  // 把正文容器祖先链上每一层的「旁支兄弟」全部标记隐藏，
  // 并且给祖先链本身打 data-fl-keep —— 这一步不只为隐藏，更是为了拆布局。
  // 光把侧栏 display:none 是没用的：父级的 grid-template-columns 还在，
  // 剩下的正文会被塞进第一列，变成一条一百来像素宽的窄缝。
  function isolate(container) {
    let node = container;
    while (node && node !== document.body) {
      const parent = node.parentElement;
      if (!parent) break;
      for (const sib of Array.from(parent.children)) {
        if (sib === node || sib.contains(container)) continue;
        if (!sib.__flHidden) {
          sib.setAttribute('data-fl-hide', '');
          sib.__flHidden = true;
        }
      }
      // 容器自己不打 keep：它的排版由 [data-fl-reader-body] 那套规则负责
      if (parent !== document.body) parent.setAttribute('data-fl-keep', '');
      node = parent;
    }
    document.body.setAttribute('data-fl-keep', '');
  }

  function sweepNoise(root) {
    // 降级模式下容器就是 body，直接扫直接子级，别深入（深入容易误伤）
    const scope = root === document.body ? root.children : root.querySelectorAll('[class],[id]');
    for (const el of scope) {
      if (el === root) continue;
      if (el.hasAttribute('data-fl-reader-body')) continue;
      if (INNER_NOISE_RE.test(sigOf(el))) {
        el.setAttribute('data-fl-hide', '');
        el.__flHidden = true;
      }
    }
  }

  // 懒加载的图在隐藏掉导航后会一直在视口外，这里直接唤醒
  function wakeImages(root) {
    for (const img of root.querySelectorAll('img')) {
      try {
        if (!img.getAttribute('src') || /^data:image\/(gif|svg)/.test(img.getAttribute('src') || '')) {
          const real = img.dataset.src || img.dataset.original || img.dataset.lazySrc || '';
          if (real && !real.startsWith('data:')) img.setAttribute('src', real);
        }
        img.setAttribute('loading', 'eager');
      } catch (_) { /* 单个图出错不影响整体 */ }
    }
  }

  let savedScrollY = 0;

  function exit() {
    document.documentElement.classList.remove('fl-reader');
    for (const el of document.querySelectorAll('[data-fl-hide], [data-fl-keep]')) {
      el.removeAttribute('data-fl-hide');
      el.removeAttribute('data-fl-keep');
      el.__flHidden = false;
    }
    for (const el of document.querySelectorAll('[data-fl-reader-body]')) {
      el.removeAttribute('data-fl-reader-body');
    }
    const btn = document.querySelector('.fl-reader-exit');
    if (btn) btn.remove();
    document.removeEventListener('keydown', onKey, true);
    window.scrollTo(0, savedScrollY);
    mountEntry();   // 浮窗回归，随时可以再进一次
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      exit();
    }
  }

  function mountExitButton() {
    const btn = document.createElement('button');
    btn.className = 'fl-reader-exit';
    btn.type = 'button';
    btn.title = '退出阅读，恢复原页面（Esc）';
    btn.innerHTML = '退出阅读 <kbd>Esc</kbd>';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      exit();
    });
    document.body.appendChild(btn);
  }

  /* 入口浮窗：只有从稍后读打开（URL 带 #fl-read）的页面才会有。
     主动点击才清洗 —— 不看这个页面的人不该被打扰，
     而且点不点、什么时候点，决定权在用户手里。 */
  function mountEntry() {
    if (document.querySelector('.fl-reader-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'fl-reader-btn';
    btn.type = 'button';
    btn.title = '进入阅读模式';
    btn.setAttribute('aria-label', '进入阅读模式');
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M12 6.6C10.3 5 7.9 4.3 4.8 4.3v12.9c3.1 0 5.5.7 7.2 2.3 1.7-1.6 4.1-2.3 7.2-2.3V4.3c-3.1 0-5.5.7-7.2 2.3z"/>' +
      '<path d="M12 6.6v12.9"/></svg>' +
      '<span class="fl-reader-btn-label">阅读模式</span>';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      enter(btn);
    });
    document.body.appendChild(btn);
  }

  function enter(btn) {
    if (!run()) {
      // 认不出正文：按钮上给一句短反馈，两秒后恢复，页面保持原样
      btn.classList.add('is-fail');
      btn.querySelector('.fl-reader-btn-label').textContent = '识别不出正文';
      setTimeout(() => {
        btn.classList.remove('is-fail');
        btn.querySelector('.fl-reader-btn-label').textContent = '阅读模式';
      }, 2000);
      return;
    }
    btn.remove();
    mountExitButton();
    document.addEventListener('keydown', onKey, true);
  }

  function apply(container) {
    savedScrollY = window.scrollY || 0;
    document.documentElement.classList.add('fl-reader');

    container.setAttribute('data-fl-reader-body', '');
    isolate(container);
    sweepNoise(container);
    wakeImages(container);

    window.scrollTo(0, 0);
    return true;
  }

  /* 认不出正文就什么都不做。
     以前这里有个「降级模式」：随便找个容器套上排版。实测下来副作用太大 ——
     非文章页（列表页、工具页）被强行改成 40rem 居中，比原样更难看。
     宁可不清理，也不要清理错。 */
  function run() {
    if (!document.body) return false;
    const best = pick();
    if (!best || best.s < MIN_SCORE) return false;
    return apply(best.el);
  }

  // SPA 页面首屏可能还没渲染完：点浮窗那一刻正文还没出来，让用户再点一次即可，
  // 不做自动重试 —— 手动触发的好处就是「点了才算数」。
  function boot() {
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', () => mountEntry(), { once: true });
      return;
    }
    mountEntry();
  }

  // 只认 #fl-read：从稍后读点开的页面才挂浮窗，别的页面一个字节都不动。
  // 这个文件是常驻内容脚本，没有这个守卫它会在全网页运行。
  if (/^fl-read/.test(location.hash.slice(1))) {
    window.__flReader = true;
    boot();
  }
})();
