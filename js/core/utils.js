// 通用工具：DOM 选择、防抖、提示、URL 与图标、网络

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

let toastTimer = null;
export function toast(msg, ms = 1800) {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.append(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

export function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ---------- URL / 站点图标 ---------- */
export function normalizeUrl(value) {
  if (!value) return '';
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    return new URL(withScheme).href;
  } catch {
    return '';
  }
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/* 网站没填自定义图标时，尝试站点根目录的 favicon；取不到则回退字母图标 */
export function faviconOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.origin + '/favicon.ico';
  } catch {
    return '';
  }
}

export function hashHue(str) {
  let h = 0;
  for (let i = 0; i < str.length; i += 1) {
    h = (h * 31 + str.charCodeAt(i)) % 360;
  }
  return h;
}

export function paintLetter(ico, site) {
  const source = (site.title || hostOf(site.url) || '?').trim();
  ico.textContent = source.charAt(0).toUpperCase();
  ico.style.background = `hsl(${hashHue(site.url)} 62% 46%)`;
}

/* 清除所有拖拽落点标记（卡片 / 分组标签 / dock） */
export function clearDropMarks() {
  $$('.card').forEach((el) => el.classList.remove('drop-before', 'drop-after'));
  $$('.tab').forEach((el) => el.classList.remove('drop-over'));
  $$('.dock-item').forEach((el) => el.classList.remove('drop-before', 'drop-after'));
}

/* ---------- 网络 ---------- */
export async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal, cache: 'no-store' });
  } finally {
    clearTimeout(timer);
  }
}
