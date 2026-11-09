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

/* ================= 壁纸题材：只看自然风光 =================
   Bing 每日图接口没有题材参数（HPImageArchive 只认 format / idx / n / mkt / pid），
   能带 q= 的图片搜索 API 又在 2025-08-11 随 Bing Search API 一起退役了。
   好在这批图自带文案：title + copyright（含地名），可以据此分类。
   排除法优先于加词法 —— 自然词表永远列不全，但「教堂 / 城堡 / 街区」这类词很明确。 */
const NATURE_MIN = 4;   // 自然图少于这个数才把人文图补回来：宁缺毋滥，但绝不空白

const HUMAN_WORDS = [
  '城市', '街区', '街道', '广场', '建筑', '教堂', '城堡', '宫殿', '博物馆', '美术馆',
  '室内', '图书', '市场', '集市', '工厂', '车站', '机场', '地铁', '桥', '灯塔',
  '遗迹', '立石', '巨石', '遗址', '古迹', '雕塑', '壁画', '节日', '灯笼', '烟花',
  'city', 'street', 'square', 'building', 'church', 'castle', 'palace', 'museum',
  'indoor', 'market', 'factory', 'station', 'bridge', 'ruins', 'temple', 'festival'
];

const NATURE_WORDS = [
  '国家公园', '自然公园', '保护区', '野生动物', '山脉', '群峰', '湖', '森林', '树林',
  '草原', '瀑布', '冰川', '雪山', '海岸', '海滩', '沙漠', '沙丘', '峡谷', '湿地',
  '竹林', '秋叶', '秋林', '云海', '极光', '星空', '田野', '花海', '河', '溪', '岛', '海湾',
  '湾', '峰', '岭', '峡', '杉', '礁', '熊', '鹤', '鹿', '鲸', '海豹', '企鹅', '鸟',
  'national park', 'nature', 'mountain', 'lake', 'forest', 'grassland', 'waterfall',
  'glacier', 'coast', 'beach', 'desert', 'canyon', 'wetland', 'aurora', 'valley', 'river'
];

const has = (s, w) => s.includes(w);

// 2 = 自然，1 = 说不清（无关键词），0 = 人造
export function natureGroup(img) {
  const s = `${img?.title || ''} ${img?.credit || ''}`.toLowerCase();
  let human = 0, nature = 0;
  for (const w of HUMAN_WORDS) if (has(s, w)) human++;
  for (const w of NATURE_WORDS) if (has(s, w)) nature++;
  if (human > nature) return 0;
  return nature > 0 ? 2 : 1;
}

// 自然在前、说不清的居中、人造的在最后；自然图够数就把人造的整段丢掉
export function pickNature(list) {
  const tagged = (list || []).map((img, i) => ({ img, i, g: natureGroup(img) }));
  tagged.sort((a, b) => b.g - a.g || a.i - b.i);
  const naturals = tagged.filter((t) => t.g === 2).length;
  const kept = naturals >= NATURE_MIN ? tagged.filter((t) => t.g > 0) : tagged;
  return kept.map((t) => t.img);
}

// 兜底清单：网络断了 / 过滤后一张不剩时用。都是 Bing 每日图里的自然风光，
// 署名照旧显示在右下角；图挂了会自然落到下一个源，不会卡住。
const NATURE_FALLBACK = [
  { url: 'https://cn.bing.com/th?id=OHR.AlpineBraies_ZH-CN7307997866_1920x1080.jpg', credit: '布莱埃斯湖，多洛米蒂山脉，意大利 (© leonid_tit/Getty Images)' },
  { url: 'https://cn.bing.com/th?id=OHR.SchwarzwaldAutumn_ZH-CN6323627599_1920x1080.jpg', credit: '黑森林，巴登-符腾堡州，德国 (© Britus/Getty Images)' },
  { url: 'https://cn.bing.com/th?id=OHR.SitovoWaterfall_ZH-CN8495214046_1920x1080.jpg', credit: '秋日瀑布，普罗夫迪夫州，保加利亚 (© Nadya85/Getty Images)' },
  { url: 'https://cn.bing.com/th?id=OHR.PondCypress_ZH-CN9472607734_1920x1080.jpg', credit: '秋叶缤纷的池杉林，乔治亚州，美国 (© Chris Moore/Getty Images)' },
  { url: 'https://cn.bing.com/th?id=OHR.DakotaBison_ZH-CN2302503868_1920x1080.jpg', credit: '草原上的一头野牛，西奥多·罗斯福国家公园，美国 (© Tandem Stock/Adobe Stock)' },
  { url: 'https://cn.bing.com/th?id=OHR.PipiwaiTrail_ZH-CN1811194311_1920x1080.jpg', credit: '竹林，哈莱亚卡拉国家公园，毛伊岛 (© MNStudio/Getty Images)' },
  { url: 'https://cn.bing.com/th?id=OHR.AutumnCranes_ZH-CN5772055404_1920x1080.jpg', credit: '沙丘鹤，博斯克德尔阿帕奇国家野生动物保护区，美国 (© Terry St.Louis/Getty Images)' },
  { url: 'https://cn.bing.com/th?id=OHR.AutumnChina_ZH-CN7665959692_1920x1080.jpg', credit: '五彩落羽杉间划船的人们，宣城，安徽省 (© Jackal Pan/Getty Images)' },
  { url: 'https://cn.bing.com/th?id=OHR.HudsonBear_ZH-CN6630706907_1920x1080.jpg', credit: '北极熊和幼崽，哈得孙湾畔，马尼托巴省，加拿大 (© Danita Delimont/Adobe Stock)' },
  { url: 'https://cn.bing.com/th?id=OHR.StileCrossing_ZH-CN9811465935_1920x1080.jpg', credit: '石墙边的木制翻越梯，湖区，英格兰 (© Alex Treadway/Getty Images)' }
];

// 题材开关：默认只看自然风光（老用户没这个字段也按自然处理）
function natureOnly() {
  return (state.data?.settings?.wallpaperScene || 'nature') === 'nature';
}


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
  // 只载自然风光时跳过 Lorem Picsum：它是随机图库，没有题材可言，
  // 与其塞一张可能是城市街景的照片，不如直接落到内置的自然风光清单
  const pool = natureOnly() ? ONLINE_SOURCES.filter((s) => s.id !== 'picsum') : ONLINE_SOURCES;
  const front =
    pref === 'bing' ? ['bing', 'mirror'] : pref === 'custom' ? ['custom'] : [];
  if (!front.length) return pool;
  return [
    ...pool.filter((s) => front.includes(s.id)),
    ...pool.filter((s) => !front.includes(s.id))
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
      blur: current.blur ?? 12,
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

  document.querySelectorAll('#onlineScene button').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.data.settings.wallpaperScene = btn.dataset.val;
      // 缓存里的列表是按旧题材筛过的，换规则就作废，否则「不限」切回来还是那几张
      state.data.settings.wallpaper.online = {};
      persist();
      syncSettingsUI();
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
        blur: state.data.settings.wallpaper.blur ?? 12,
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
      blur: state.data.settings.wallpaper.blur ?? 12
    });
  });

  /* 壁纸模糊：滑杆直接改 CSS 变量，逐帧改全屏 blur 比较贵，用 rAF 合并到一帧一次 */
  let blurRaf = 0;
  const paintBlur = (v) => {
    cancelAnimationFrame(blurRaf);
    blurRaf = requestAnimationFrame(() => {
      document.documentElement.style.setProperty('--bg-blur', `${v}px`);
    });
  };
  $('#blurRange').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    state.data.settings.wallpaper.blur = v;
    $('#blurVal').textContent = `${v}px`;
    paintBlur(v);
  });
  $('#blurRange').addEventListener('change', persist);
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
        blur: state.data.settings.wallpaper.blur ?? 12
      });
    box.append(btn);
  });
}

export function setWallpaper(wallpaper) {
  // 兜底带上 blur：调用点只关心自己那一项，不该顺手把模糊程度抹掉
  const prev = state.data.settings.wallpaper || {};
  state.data.settings.wallpaper = { ...wallpaper, blur: wallpaper.blur ?? prev.blur ?? 12 };
  persist();
  applyWallpaper();
  syncSettingsUI();
}

export async function applyWallpaper({ advanceOnline = false } = {}) {
  const wallpaper = state.data.settings.wallpaper;
  const bg = $('#bg');
  state.currentCredit = '';

  // 模糊先落定：后面要取图 / 取在线壁纸，任何一步失败都不该顺带把模糊丢掉
  document.documentElement.style.setProperty('--bg-blur', `${wallpaper.blur ?? 12}px`);

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

  // 固定遮罩由 CSS 控制（1.2.3 起不再可调），这里只负责把署名写上去
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
  // 最后一道：接口全挂或过滤后一张不剩时，用内置的自然风光清单，别让新标签页空着
  if (natureOnly()) {
    attempts.push({
      images: NATURE_FALLBACK.map((i) => ({ ...i })),
      source: 'fallback',
      sourceName: '内置自然风光'
    });
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

/* 每日图归档一次最多回 8 天（n 上限就是 8），idx 往后翻到第 16 天就翻不动了。
   所以抓两批（idx=0 / idx=8）拼成约 15 天的池子 —— 过滤掉人文题材后还剩下十张左右，
   只抓一批的话很可能只剩三四张，轮换两天就重复。 */
async function fetchBingArchive() {
  const endpoints = ['https://www.bing.com', 'https://cn.bing.com'];
  for (const base of endpoints) {
    try {
      const batches = await Promise.all(
        [0, 8].map((idx) =>
          fetchWithTimeout(`${base}/HPImageArchive.aspx?format=js&idx=${idx}&n=8&mkt=zh-CN`, 8000)
            .then((res) => (res.ok ? res.json() : null))
            .catch(() => null)
        )
      );
      const seen = new Set();
      const images = [];
      for (const json of batches) {
        for (const img of json?.images || []) {
          const url = img.url?.startsWith('http') ? img.url : base + (img.url || '');
          if (!url || seen.has(url)) continue;
          seen.add(url);
          images.push({ url, title: img.title || '', credit: img.copyright || img.title || '', date: img.startdate || '' });
        }
      }
      if (!images.length) continue;

      // 按日期倒序：daily 模式取 list[0]，语义仍是「最新的一张（自然图）」
      images.sort((a, b) => String(b.date).localeCompare(String(a.date)));
      const picked = natureOnly() ? pickNature(images) : images;
      if (!picked.length) continue;
      // title 只用来分类，不进缓存（settings 段还要走浏览器同步，别为它撑大体积）
      return picked.map(({ url, credit }) => ({ url, credit }));
    } catch (err) {
      console.warn('Bing 官方接口失败', base, err);
    }
  }
  return natureOnly() ? NATURE_FALLBACK.map((i) => ({ ...i })) : [];
}

async function fetchBingMirror() {
  const jobs = [0, 1, 2, 3, 4, 5, 6, 7].map(async (index) => {
    const res = await fetchWithTimeout(
      `https://bing.biturl.top/?resolution=1920&format=json&index=${index}&mkt=zh-CN`,
      8000
    );
    if (!res.ok) return null;
    const json = await res.json();
    if (!json?.url) return null;
    return { url: json.url, title: '', credit: json.copyright || '', date: json.start_date || '' };
  });

  const results = await Promise.allSettled(jobs);
  const list = results
    .filter((r) => r.status === 'fulfilled' && r.value)
    .map((r) => r.value);
  const picked = natureOnly() ? pickNature(list) : list;
  return picked.map(({ url, credit }) => ({ url, credit }));
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
      blur: state.data.settings.wallpaper.blur ?? 12
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
