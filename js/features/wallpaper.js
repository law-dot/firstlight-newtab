// 壁纸：预设渐变 / 纯色 / 在线多源降级 / 本地上传，二进制存 IndexedDB
import { state, persist } from '../core/state.js';
import { $, toast, fetchWithTimeout } from '../core/utils.js';
import {
  getWallpaper,
  putWallpaper,
  getBlob,
  putBlob,
  deleteBlob,
  listBlobKeys
} from '../core/store.js';
import { syncSettingsUI } from './settings.js';

export const PRESETS = [
  { id: 'dusk', name: '暮色', css: 'linear-gradient(160deg, #241b47 0%, #141a2e 55%, #0b0e16 100%)' },
  { id: 'ocean', name: '深海', css: 'linear-gradient(160deg, #0f2027 0%, #203a43 50%, #2c5364 100%)' },
  { id: 'forest', name: '林间', css: 'linear-gradient(160deg, #134e5e 0%, #2d6a4f 60%, #71b280 100%)' },
  { id: 'neon', name: '霓虹', css: 'linear-gradient(160deg, #360033 0%, #0b8793 100%)' },
  { id: 'peach', name: '暖阳', css: 'linear-gradient(160deg, #ffecd2 0%, #fcb69f 100%)' },
  { id: 'graphite', name: '石墨', css: 'linear-gradient(160deg, #232526 0%, #414345 100%)' }
];

const ONLINE_TTL = 3 * 60 * 60 * 1000;

// 多个免费壁纸源，按顺序自动降级
const ONLINE_SOURCES = [
  { id: 'bing', name: 'Bing 官方', list: () => fetchBingArchive() },
  { id: 'mirror', name: 'Bing 镜像', list: () => fetchBingMirror() },
  { id: 'picsum', name: 'Lorem Picsum', list: () => fetchPicsum() },
  { id: 'custom', name: '自选网站', list: () => fetchCustomSite() }
];

// 用户偏好的源排在前面，其余仍然保留，避免某一源不可用时直接空白
function sourceMatches(src, pref) {
  if (pref === 'auto') return true;
  if (pref === 'bing') return ['bing', 'mirror'].includes(src);
  return src === pref;
}

function orderedSources() {
  const pref = state.data?.settings?.onlineSource || 'auto';
  const front =
    pref === 'bing' ? ['bing', 'mirror'] : pref === 'custom' ? ['custom'] : [];
  if (!front.length) return ONLINE_SOURCES;
  return [
    ...ONLINE_SOURCES.filter((s) => front.includes(s.id)),
    ...ONLINE_SOURCES.filter((s) => !front.includes(s.id))
  ];
}

/* ================= 事件绑定 ================= */
export function bindWallpaper() {
  $('#btnUpload').addEventListener('click', () => $('#fileWallpaper').click());
  $('#fileWallpaper').addEventListener('change', onWallpaperPicked);

  $('#btnOnline').addEventListener('click', () => {
    const current = state.data.settings.wallpaper;
    setWallpaper({
      type: 'online',
      value: '',
      dim: current.dim ?? 30,
      online: current.online
    });
    toast('正在获取在线壁纸…');
  });

  $('#btnOnlineNext').addEventListener('click', () => {
    if (state.data.settings.wallpaper.type !== 'online') {
      toast('先切换到在线壁纸');
      return;
    }
    $('#onlineStatus').textContent = '正在换一张…';
    applyWallpaper({ advanceOnline: true });
  });

  document.querySelectorAll('#onlineMode button').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.data.settings.onlineMode = btn.dataset.val;
      persist();
      syncSettingsUI();
      restartOnlineInterval();
      if (state.data.settings.wallpaper.type === 'online') applyWallpaper();
    });
  });

  document.querySelectorAll('#onlineInterval button').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.data.settings.onlineInterval = Number(btn.dataset.val);
      persist();
      syncSettingsUI();
      restartOnlineInterval();
      toast(`每 ${state.data.settings.onlineInterval} 分钟自动换一张`);
    });
  });

  document.querySelectorAll('#onlineSource button').forEach((btn) => {
    btn.addEventListener('click', async () => {
      state.data.settings.onlineSource = btn.dataset.val;
      persist();
      syncSettingsUI();
      if (btn.dataset.val === 'custom') {
        $('#customWallpaper').focus();
        if (state.data.settings.wallpaper.type !== 'online') toast('填入地址后会自动获取');
        return;
      }
      if (state.data.settings.wallpaper.type === 'online') applyWallpaper();
    });
  });

  $('#customWallpaper').addEventListener('change', async (e) => {
    const url = e.target.value.trim();
    state.data.settings.customWallpaperUrl = url;
    state.data.settings.onlineSource = 'custom';
    persist();
    syncSettingsUI();
    if (!url) return;

    const granted = await ensureCustomAccess();
    if (!granted) toast('没有获得访问权限，自选网站可能取不到图');
    if (state.data.settings.wallpaper.type !== 'online') {
      setWallpaper({
        type: 'online',
        value: '',
        dim: state.data.settings.wallpaper.dim ?? 30,
        online: state.data.settings.wallpaper.online
      });
    } else {
      $('#onlineStatus').textContent = '正在从自选网站取图…';
      applyWallpaper();
    }
  });

  $('#colorWallpaper').addEventListener('change', (e) => {
    setWallpaper({
      type: 'color',
      value: e.target.value,
      dim: state.data.settings.wallpaper.dim ?? 30
    });
  });

  $('#dimRange').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    state.data.settings.wallpaper.dim = v;
    $('#dimVal').textContent = `${v}%`;
    $('#dim').style.opacity = String(v / 100);
  });
  $('#dimRange').addEventListener('change', persist);
}

export function buildSwatches() {
  const box = $('#swatches');
  PRESETS.forEach((preset) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'swatch';
    btn.dataset.id = preset.id;
    btn.title = preset.name;
    btn.style.backgroundImage = preset.css;
    btn.onclick = () =>
      setWallpaper({
        type: 'preset',
        value: preset.id,
        dim: state.data.settings.wallpaper.dim ?? 30
      });
    box.append(btn);
  });
}

export function setWallpaper(wallpaper) {
  state.data.settings.wallpaper = wallpaper;
  persist();
  applyWallpaper();
  syncSettingsUI();
}

export async function applyWallpaper({ advanceOnline = false } = {}) {
  const wallpaper = state.data.settings.wallpaper;
  const bg = $('#bg');
  state.currentCredit = '';

  if (state.bgUrl) {
    URL.revokeObjectURL(state.bgUrl);
    state.bgUrl = null;
  }

  if (wallpaper.type === 'image') {
    const blob = await getWallpaper();
    if (blob) {
      state.bgUrl = URL.createObjectURL(blob);
      bg.style.backgroundImage = `url("${state.bgUrl}")`;
      bg.style.backgroundColor = '#12141a';
    } else {
      bg.style.backgroundImage = PRESETS[0].css;
    }
  } else if (wallpaper.type === 'color') {
    bg.style.backgroundImage = 'none';
    bg.style.backgroundColor = wallpaper.value;
  } else if (wallpaper.type === 'online') {
    const item = await ensureOnline(wallpaper, advanceOnline);
    if (item) {
      state.bgUrl = URL.createObjectURL(item.blob);
      bg.style.backgroundImage = `url("${state.bgUrl}")`;
      bg.style.backgroundColor = '#12141a';
      state.currentCredit = item.credit || '';
    } else {
      bg.style.backgroundImage = PRESETS[0].css;
      bg.style.backgroundColor = '#0b0e16';
      if (!state.onlineFailNotified) {
        state.onlineFailNotified = true;
        toast('在线壁纸获取失败，先用了内置渐变');
      }
    }
  } else {
    const preset = PRESETS.find((p) => p.id === wallpaper.value) || PRESETS[0];
    bg.style.backgroundImage = preset.css;
    bg.style.backgroundColor = '#0b0e16';
  }

  $('#dim').style.opacity = String((wallpaper.dim ?? 30) / 100);
  $('#bgCredit').textContent = state.currentCredit;
  syncSettingsUI();
}

/* ================= 在线壁纸 ================= */
async function ensureOnline(wallpaper, advance) {
  const online = wallpaper.online || {};
  const cached = Array.isArray(online.images) ? online.images : [];
  const stale = !online.fetchedAt || Date.now() - online.fetchedAt > ONLINE_TTL;
  const pref = state.data.settings.onlineSource || 'auto';

  // 候选顺序：未过期缓存 → 各在线源 → 过期缓存（兜底）
  const attempts = [];
  if (cached.length && !stale && sourceMatches(online.source, pref)) {
    attempts.push({ images: cached, source: online.source, sourceName: online.sourceName });
  }
  for (const source of orderedSources()) {
    if (cached.length && !stale && sourceMatches(online.source, pref) && source.id === online.source) continue;
    attempts.push({ source });
  }
  if (cached.length && stale) {
    attempts.push({ images: cached, source: online.source, sourceName: `${online.sourceName || '缓存'}（缓存）` });
  }

  for (const attempt of attempts) {
    let list = attempt.images;
    if (!list) {
      try {
        list = await attempt.source.list();
      } catch (err) {
        console.warn(`壁纸源「${attempt.source.name}」失败`, err);
        list = [];
      }
      if (!list.length) continue;
    }

    const rotate = state.data.settings.onlineMode === 'rotate';
    const start = rotate
      ? (online.cursor || 0) % list.length
      : advance
        ? state.manualIndex % list.length
        : 0;
    const order = [start, ...list.map((_, i) => i).filter((i) => i !== start)].slice(0, 3);

    // 某个源即便列表拿到了，图片也可能下不下来，这时继续试下一个源
    for (const i of order) {
      const image = list[i];
      const key = `online:${hashKey(image.url)}`;
      let blob = await getBlob(key);
      if (!blob) {
        blob = await downloadImage(image.url);
        if (blob) await putBlob(key, blob);
      }
      if (!blob) continue;

      wallpaper.online = {
        fetchedAt: Date.now(),
        source: attempt.source?.id || attempt.source || online.source,
        sourceName: attempt.sourceName || attempt.source.name,
        images: list,
        cursor: rotate ? (i + 1) % list.length : i
      };
      if (!rotate && advance) state.manualIndex = (i + 1) % list.length;
      persist();
      pruneOnlineCache(list);
      return { ...image, blob };
    }
  }

  return null;
}

async function fetchBingArchive() {
  const endpoints = [
    'https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=8&mkt=zh-CN',
    'https://cn.bing.com/HPImageArchive.aspx?format=js&idx=0&n=8&mkt=zh-CN'
  ];
  for (const endpoint of endpoints) {
    try {
      const res = await fetchWithTimeout(endpoint, 8000);
      if (!res.ok) continue;
      const json = await res.json();
      const base = new URL(endpoint).origin;
      const images = (json.images || [])
        .map((img) => ({
          url: img.url?.startsWith('http') ? img.url : base + (img.url || ''),
          credit: img.copyright || img.title || ''
        }))
        .filter((img) => img.url);
      if (images.length) return images;
    } catch (err) {
      console.warn('Bing 官方接口失败', endpoint, err);
    }
  }
  return [];
}

async function fetchBingMirror() {
  const jobs = [0, 1, 2, 3].map(async (index) => {
    const res = await fetchWithTimeout(
      `https://bing.biturl.top/?resolution=1920&format=json&index=${index}&mkt=zh-CN`,
      8000
    );
    if (!res.ok) return null;
    const json = await res.json();
    if (!json?.url) return null;
    return { url: json.url, credit: json.copyright || '' };
  });

  const results = await Promise.allSettled(jobs);
  return results
    .filter((r) => r.status === 'fulfilled' && r.value)
    .map((r) => r.value);
}

async function fetchPicsum() {
  const page = 1 + Math.floor(Math.random() * 12);
  const res = await fetchWithTimeout(
    `https://picsum.photos/v2/list?page=${page}&limit=8`,
    8000
  );
  if (!res.ok) return [];
  const json = await res.json();
  return json.map((item) => ({
    url: `https://picsum.photos/id/${item.id}/1920/1080`,
    credit: `Photo by ${item.author} / Lorem Picsum`
  }));
}

async function fetchCustomSite() {
  const raw = (state.data.settings.customWallpaperUrl || '').trim();
  if (!raw) return [];
  let pageUrl;
  try {
    pageUrl = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    return [];
  }

  const res = await fetchWithTimeout(pageUrl.href, 12000);
  if (!res.ok) return [];
  const type = res.headers.get('content-type') || '';
  if (type.startsWith('image/')) {
    return [{ url: pageUrl.href, credit: pageUrl.hostname }];
  }

  const html = await res.text();
  const urls = [];
  const push = (u) => {
    if (!u) return;
    try {
      const abs = new URL(u, pageUrl.href);
      if (/^https?:$/.test(abs.protocol) && !urls.includes(abs.href)) urls.push(abs.href);
    } catch {
      /* 忽略无法解析的地址 */
    }
  };

  const og =
    html.match(/<meta[^>]+(?:property|name)=["']og:image["'][^>]*content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:image["']/i);
  if (og) push(og[1]);

  let m;
  const imgRe = /<img\b[^>]*\bsrc=["']([^"']+)["']/gi;
  while ((m = imgRe.exec(html)) && urls.length < 14) push(m[1]);

  const srcsetRe = /<img\b[^>]*\bsrcset=["']([^"']+)["']/gi;
  while ((m = srcsetRe.exec(html)) && urls.length < 14) {
    const first = m[1].split(',')[0].trim().split(/\s+/)[0];
    push(first);
  }

  return urls.slice(0, 14).map((u) => ({ url: u, credit: pageUrl.hostname }));
}

// 自选网站里的图可能来自任意域名，按需申请全站访问权限（仅用户填写地址后触发）
async function ensureCustomAccess() {
  if (typeof chrome === 'undefined' || !chrome.permissions?.request) return true;
  try {
    const has = await chrome.permissions.contains({ origins: ['https://*/*'] });
    if (has) return true;
    return await chrome.permissions.request({ origins: ['https://*/*'] });
  } catch {
    return false;
  }
}

async function downloadImage(url) {
  try {
    const res = await fetchWithTimeout(url, 15000);
    if (!res.ok) return null;
    return await res.blob();
  } catch (err) {
    console.warn('壁纸图片下载失败', url, err);
    return null;
  }
}

/* ================= 在线壁纸：定时轮播 ================= */

let intervalTimer = null;

export function restartOnlineInterval() {
  if (intervalTimer) { clearInterval(intervalTimer); intervalTimer = null; }
  const mode = state.data.settings.onlineMode;
  if (mode !== 'interval') return;
  if (state.data.settings.wallpaper.type !== 'online') return;
  const minutes = [10, 30, 60].includes(state.data.settings.onlineInterval)
    ? state.data.settings.onlineInterval : 30;
  intervalTimer = setInterval(() => {
    // 待机时不切，避免打扰；也节省下载
    if (document.body.classList.contains('idle-mode')) return;
    applyWallpaper({ advanceOnline: true });
  }, minutes * 60 * 1000);
}

export function checkOnlineRefresh() {
  const wallpaper = state.data.settings.wallpaper;
  if (wallpaper.type !== 'online') return;
  if (Date.now() - (wallpaper.online?.fetchedAt || 0) > ONLINE_TTL) {
    applyWallpaper();
  }
}

async function pruneOnlineCache(images) {
  const keep = new Set(images.map((img) => `online:${hashKey(img.url)}`));
  try {
    const keys = await listBlobKeys();
    for (const key of keys) {
      if (typeof key !== 'string') continue;
      const isOnline = key.startsWith('online:') && !keep.has(key);
      const isLegacy = key.startsWith('bing:');
      if (isOnline || isLegacy) await deleteBlob(key);
    }
  } catch (err) {
    console.warn('清理在线壁纸缓存失败', err);
  }
}

function hashKey(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i += 1) {
    h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

async function onWallpaperPicked(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;

  try {
    const blob = await compressImage(file);
    await putWallpaper(blob);
    setWallpaper({
      type: 'image',
      value: '',
      dim: state.data.settings.wallpaper.dim ?? 30
    });
    toast('壁纸已更新');
  } catch (err) {
    console.error(err);
    toast('图片处理失败');
  }
}

async function compressImage(file) {
  const bitmap = await createImageBitmap(file);
  const max = 2560;
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.86));
}
