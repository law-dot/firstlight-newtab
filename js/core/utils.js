// 通用工具：DOM 选择、提示、URL 与图标、网络

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

let toastTimer = null;

function toastEl() {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.append(el);
  }
  return el;
}

export function toast(msg, ms = 1800) {
  const el = toastEl();
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

// 带一个动作按钮的提示：导错了能一键撤销，小白才敢点
export function toastAction(msg, label, onAction, ms = 7000) {
  const el = toastEl();
  el.textContent = '';
  const text = document.createElement('span');
  text.textContent = msg;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'toast-act';
  btn.textContent = label;
  btn.onclick = () => {
    el.classList.remove('show');
    clearTimeout(toastTimer);
    onAction();
  };
  el.append(text, btn);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
    el.textContent = '';
  }, ms);
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

/* FNV-1a + 收尾混合。不能用 hashHue 那种 h*31 的老写法：
   收藏夹里的域名前缀高度相似（wiki. / photo. / oa.），散不开，
   一排色块会全挤在同一个色相区间（实测全是紫的）。 */
function hash32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return h >>> 0;
}

/* 主题强调色的色相（读 CSS 变量，强调色是用户在设置里改的） */
export function accentHue() {
  const v = (getComputedStyle(document.documentElement).getPropertyValue('--accent') || '').trim();
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
  if (!m) return 250;
  let hex = m[1];
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (!d) return 250;
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

/* 无图标时的字母色块颜色：强调色色相 ±120° 散开、亮度 44–55%。
   锚在主题色上，整排才像「一套主题的五颜六色」；纯随机色相会跟界面脱节。
   同一个域名每次算出来一样，不会刷新一次换个颜色。 */
export function letterColor(seed) {
  const key = String(seed || '');
  const hue = Math.round((accentHue() + (hash32(key) % 241) - 120 + 360) % 360);
  const light = 44 + (hash32(key + '#l') % 12);
  return `hsl(${hue} 64% ${light}%)`;
}

export function paintLetter(ico, site) {
  const source = (site.title || hostOf(site.url) || '?').trim();
  ico.textContent = source.charAt(0).toUpperCase();
  const color = letterColor(site.url);
  const tile = ico.closest('.tile');
  if (tile) {
    // 1.3.0 详情模式：色块在 .tile 上，首字只出字不出底
    tile.style.background = color;
    ico.style.background = '';
  } else {
    ico.style.background = color;
  }
}

/* ---------- 品牌色块取色（1.3.0 详情模式） ---------- */

/* 从图标像素里采一个「能压得住白字」的主色：
   - 只统计不透明像素，按色相分桶（36 桶）取权重最大的一桶；
   - 亮度压到 36–50%、饱和度钳到 45–72%，保证白 logo / 白首字可读；
   - 全灰的 logo（Apple、Steam 这类）给一档深板岩灰，别硬凑彩色；
   - 跨域 favicon 会污染画布（getImageData 抛 SecurityError），按取不到处理，
     tile 保持 paintLetter 留下的哈希色 —— 不会比原来更差。 */
const brandCache = new Map(); // img.src -> {color, whiten}

function extractBrand(img) {
  const empty = { color: '', whiten: false };
  try {
    const w = Math.max(1, img.naturalWidth || 64);
    const h = Math.max(1, img.naturalHeight || 64);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;

    const BUCKETS = 36;
    const weight = new Float64Array(BUCKETS);
    const sumR = new Float64Array(BUCKETS);
    const sumG = new Float64Array(BUCKETS);
    const sumB = new Float64Array(BUCKETS);
    let opaque = 0;

    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];
      if (a < 24) continue; // 透明像素：logo 的形状部分
      opaque++;
      const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const sat = max === 0 ? 0 : (max - min) / max;
      if (sat >= 0.14 && max >= 0.12 && max <= 0.96) {
        const bucket = Math.min(BUCKETS - 1, Math.floor(hueOf(data[i], data[i + 1], data[i + 2]) / 10));
        const wgt = (a / 255) * sat;
        weight[bucket] += wgt;
        sumR[bucket] += r * wgt;
        sumG[bucket] += g * wgt;
        sumB[bucket] += b * wgt;
      }
      // 无彩像素不单独记账：走「主色桶权重不足 → 深板岩灰」那条路
    }

    if (opaque < Math.max(8, (w * h) * 0.03)) {
      // 整张图几乎全透明：读得到像素但没有可见图案（有的站 favicon 是空图）。
      // 交给调用方回退首字，别留一个没色的空块。
      return { color: '', whiten: false, blank: true };
    }

    let best = -1;
    for (let k = 0; k < BUCKETS; k++) {
      if (weight[k] > 0 && (best < 0 || weight[k] > weight[best])) best = k;
    }
    // 主色桶权重不够大 = 图标基本无彩（Apple 黑标、Steam 白标、灰图标）
    const colorful = best >= 0 && weight[best] > opaque * 0.06;

    let hue, sat, light;
    if (colorful) {
      const wgt = weight[best];
      const r = sumR[best] / wgt, g = sumG[best] / wgt, b = sumB[best] / wgt;
      const l0 = (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
      const s0 = l0 === 0 || l0 === 1
        ? 0
        : (Math.max(r, g, b) - Math.min(r, g, b)) / (1 - Math.abs(2 * l0 - 1));
      hue = hueOf(Math.round(r * 255), Math.round(g * 255), Math.round(b * 255));
      sat = Math.min(72, Math.max(45, Math.round(s0 * 100)));
      light = Math.round(Math.min(50, Math.max(36, l0 * 80)));
    } else {
      // 无彩 logo：给一档深板岩灰（贴合 Steam / Apple 官方深色调），别硬凑彩色
      hue = 220;
      sat = 8;
      light = 24;
    }

    // 透明底的 logo 才描白；整块不透明方图白化会变成一个白方块
    const whiten = opaque / (w * h) < 0.6;
    return { color: `hsl(${Math.round(hue)} ${sat}% ${light}%)`, whiten };
  } catch {
    return empty;
  }
}

/* hueOf 消费 0-255 整数（与上面 rgbToHsl 类函数不同源，独立小实现） */
function hueOf(r8, g8, b8) {
  const r = r8 / 255, g = g8 / 255, b = b8 / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  if (!d) return 0;
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

/* 图标加载成功后调用：给详情卡的 .tile 上主色 + 决定要不要描白。
   三种结局：
   - 取到色 → 上色（+ 透明底 logo 描白）；
   - 画布被污染（跨域 favicon）→ 保留 paintLetter 的哈希色，图标原样显示；
   - 图是空白的 → 撤掉 img、退回首字，色块用哈希色。 */
export function applyBrandColor(tile, img, site) {
  const src = img.currentSrc || img.src || '';
  if (!src) return;
  let res = brandCache.get(src);
  if (res === undefined) {
    res = extractBrand(img);
    brandCache.set(src, res);
  }

  if (res.blank) {
    img.remove();
    const ico = tile.querySelector('.ico');
    if (ico && site) paintLetter(ico, site);
    return;
  }

  if (res.color) {
    tile.style.background = res.color;
  } else {
    // 跨域 favicon 读不到像素（国内站大多如此）：给中性板岩灰。
    // 不能退哈希色 —— 彩色 logo 压在同色系块上会糊成一片花。
    tile.style.background = 'hsl(220 10% 21%)';
  }

  img.classList.toggle('wht', !!res.whiten);
}

/* ---------- 站点图标安装（sidebar 卡片与 dock 共用） ---------- */

/* 浏览器自带图标库：chrome-extension://<id>/_favicon/?pageUrl=...&size=64
   读的是浏览器浏览时在本机攒下的图标数据库，零网络请求，跟网络环境无关。
   需要 manifest 的 "favicon" 权限。 */
export function chromeFavicon(pageUrl) {
  try {
    const url = new URL(chrome.runtime.getURL('/_favicon/'));
    url.searchParams.set('pageUrl', pageUrl);
    url.searchParams.set('size', '64');
    return url.toString();
  } catch {
    return ''; // 非扩展环境（本地静态调试页）没有 chrome.runtime
  }
}

/* 只对「访问过」的站用图标库：没访问过的站 _favicon 会返回浏览器默认地球图标，
   把首字色块顶掉。用 history 判断——这个权限扩展本来就有，不新增暴露面。 */
async function visitedInBrowser(siteUrl) {
  try {
    if (chrome.history?.getVisits) {
      const visits = await chrome.history.getVisits({ url: siteUrl });
      if (visits.length > 0) return true;
      const origin = new URL(siteUrl).origin;
      const items = await chrome.history.search({ text: origin, maxResults: 10 });
      if (items.some((it) => (it.url || '').startsWith(origin))) return true;
    }
  } catch { /* history 拿不到就按没访问过处理 */ }
  return false;
}

/* 把站点图标装进 .ico 容器。时序设计：
   - 首字色块 150ms 就亮相（原来 3 秒）：快图（缓存命中）照样先上，几乎无感；
     挂住的请求不再让人对着空格子干等。
   - img 加载成功前不进 DOM，省得和字母叠在一起；加载完一次性换上。
   - 404 立刻回退首字；_favicon 库没有的站走原来的 /favicon.ico，最坏跟从前一样。 */
export async function installIcon(ico, site) {
  const customIcon = site.icon || '';
  const letterTimer = setTimeout(() => paintLetter(ico, site), 150);

  const finishWithImg = (img) => {
    clearTimeout(letterTimer);
    ico.textContent = '';
    ico.style.background = '';
    ico.append(img);
    // 1.3.0 详情模式：色块跟图标主色走（.tile 只在详情卡里存在，dock 不受影响）
    const tile = ico.closest('.tile');
    if (tile) applyBrandColor(tile, img, site);
  };

  let src = customIcon;
  if (!src) {
    const fav = chromeFavicon(site.url);
    if (fav && (await visitedInBrowser(site.url))) src = fav;
  }
  if (!src) src = faviconOf(site.url);

  if (!src) {
    clearTimeout(letterTimer);
    paintLetter(ico, site);
    return;
  }

  const img = document.createElement('img');
  img.alt = '';
  img.referrerPolicy = 'no-referrer';
  img.draggable = false;
  img.style.pointerEvents = 'none';
  if (!customIcon) img.className = 'fav';
  img.onload = () => finishWithImg(img);
  img.onerror = () => {
    clearTimeout(letterTimer);
    img.remove(); // img 从未入 DOM，remove 是保险
    paintLetter(ico, site);
  };
  img.src = src; // 未入 DOM 的 img 同样会发起加载
}

/* 清除所有拖拽落点标记（卡片 / 分组标签 / dock） */
export function clearDropMarks() {
  $$('.card').forEach((el) => el.classList.remove('drop-before', 'drop-after'));
  $$('.tab').forEach((el) => el.classList.remove('drop-over', 'drop-before', 'drop-after'));
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
