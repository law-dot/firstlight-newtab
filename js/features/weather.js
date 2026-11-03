// 天气卡片 + 天气动效（雨雪分级 / 风耦合 / 晴天镜头光晕 / 阴天云缝 / 多云=晴+阴 / 雾霾分家）
import { state, persist } from '../core/state.js';
import { $, fetchWithTimeout, toast } from '../core/utils.js';

export const WEATHER_TTL = 2 * 60 * 60 * 1000;

// 内置天气源：用户在设置里选，选错了就等失败让他换，不做自动比对切换
export const WEATHER_SOURCES = [
  { id: 'open-meteo', name: 'Open-Meteo（推荐）', hint: '开源、免 key、国内直连稳定' },
  { id: 'wttr', name: 'wttr.in', hint: '老源，当前被阻断时会失败' },
  { id: 'custom', name: '自定义接口', hint: '自己填 URL，可用 {city} 占位' }
];

/* ---------- 码表 ----------
   WX_CODES 是 wttr.in 用的 WWO 码（113/116/...），后面渲染全靠它。
   Open-Meteo 用的是 WMO 码（0-99），需要一张映射表转到 WWO。 */

// WMO → [WWO code]，一个 WMO 可能对应多个 WWO 分级，这里取最常见的那个
const WMO_TO_WWO = {
  0: 113,   // 晴
  1: 113,   // 主要晴朗
  2: 116,   // 多云
  3: 119,   // 阴
  45: 143,  // 雾
  48: 248,  // 冻雾
  51: 263,  // 小毛毛雨
  53: 266,  // 毛毛雨
  55: 266,  // 大毛毛雨（合并）
  56: 263,  // 冻毛毛雨轻
  57: 182,  // 冻毛毛雨重 → 雨夹雪
  61: 293,  // 小雨
  63: 299,  // 中雨
  65: 305,  // 大雨
  66: 176,  // 冻雨轻 → 局部有雨
  67: 179,  // 冻雨重 → 局部雨夹雪
  71: 323,  // 小雪
  73: 329,  // 中雪
  75: 335,  // 大雪
  77: 350,  // 雪粒
  80: 353,  // 小阵雨
  81: 356,  // 阵雨
  82: 359,  // 暴雨
  85: 368,  // 小阵雪
  86: 371,  // 阵雪
  95: 200,  // 雷阵雨
  96: 386,  // 雷阵雨伴冰雹
  99: 389   // 雷伴强冰雹
};

// WWO 天气代码 → [中文描述, 图标类型, 动效标识]
// 第三项是动效用的：'rain:0..3' 小雨→雷阵雨，'snow:0..3' 小雪→雨夹雪，
// 'partly' = 多云（晴与阴的叠加，见 renderPartly），其余是整类。
// 数据里本来就分了级（wttr 的天气码带级别），1.1.0.4 之前全压成 rain / snow。
const WX_CODES = {
  113: ['晴', 'sun', 'sun'],
  116: ['多云', 'cloudSun', 'partly'],
  119: ['阴', 'cloud', 'cloud'],
  122: ['阴', 'cloud', 'cloud'],
  143: ['薄雾', 'fog', 'fog'],
  149: ['霾', 'fog', 'haze'],
  248: ['雾', 'fog', 'fog'],
  260: ['冻雾', 'fog', 'fog'],
  176: ['局部有雨', 'rain', 'rain:0'],
  263: ['毛毛雨', 'rain', 'rain:0'],
  266: ['毛毛雨', 'rain', 'rain:0'],
  293: ['小雨', 'rain', 'rain:0'],
  296: ['小雨', 'rain', 'rain:0'],
  299: ['中雨', 'rain', 'rain:1'],
  302: ['中雨', 'rain', 'rain:1'],
  305: ['大雨', 'rain', 'rain:2'],
  308: ['大雨', 'rain', 'rain:2'],
  353: ['小阵雨', 'rain', 'rain:0'],
  356: ['阵雨', 'rain', 'rain:1'],
  359: ['暴雨', 'rain', 'rain:3'],
  179: ['局部雨夹雪', 'snow', 'snow:3'],
  182: ['雨夹雪', 'snow', 'snow:3'],
  185: ['冻毛毛雨', 'snow', 'snow:3'],
  227: ['吹雪', 'snow', 'snow:1'],
  230: ['暴风雪', 'snow', 'snow:2'],
  311: ['冻雨', 'snow', 'snow:3'],
  314: ['冻雨', 'snow', 'snow:3'],
  317: ['雨夹雪', 'snow', 'snow:3'],
  320: ['雨夹雪', 'snow', 'snow:3'],
  323: ['小雪', 'snow', 'snow:0'],
  326: ['小雪', 'snow', 'snow:0'],
  329: ['中雪', 'snow', 'snow:1'],
  332: ['中雪', 'snow', 'snow:1'],
  335: ['大雪', 'snow', 'snow:2'],
  338: ['大雪', 'snow', 'snow:2'],
  350: ['冰粒', 'snow', 'snow:0'],
  362: ['雨夹雪', 'snow', 'snow:3'],
  365: ['雨夹雪', 'snow', 'snow:3'],
  368: ['小阵雪', 'snow', 'snow:0'],
  371: ['阵雪', 'snow', 'snow:1'],
  374: ['冰粒', 'snow', 'snow:0'],
  377: ['冰粒', 'snow', 'snow:0'],
  200: ['雷阵雨', 'thunder', 'rain:3'],
  386: ['雷阵雨', 'thunder', 'rain:3'],
  389: ['雷雨', 'thunder', 'rain:3'],
  392: ['雷雪', 'thunder', 'snow:2'],
  395: ['雷雪', 'thunder', 'snow:2']
};

const WX_ICONS = {
  sun:
    '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.3"/><path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6"/></svg>',
  cloudSun:
    '<svg viewBox="0 0 24 24"><path d="M8.6 7.2A3.7 3.7 0 0 1 15.6 6"/><path d="M12 3.2v1.4M6.2 5.4l.9 1M15.7 4.6l.9 1"/><path d="M15.4 13.4a3.6 3.6 0 0 1 .3 7.2H7a3.6 3.6 0 0 1-.3-6.8 5.4 5.4 0 0 1 8.7-.4z"/></svg>',
  cloud:
    '<svg viewBox="0 0 24 24"><path d="M16.8 18.5H7A3.7 3.7 0 0 1 6.7 11a5.6 5.6 0 0 1 10.2 1.6 3 3 0 0 1-.1 5.9z"/></svg>',
  rain:
    '<svg viewBox="0 0 24 24"><path d="M16.8 14.6H7a3.7 3.7 0 0 1-.3-7.4 5.6 5.6 0 0 1 10.2 1.6 3 3 0 0 1-.1 5.8z"/><path d="M9 17.4l-.9 2.4M12.4 17.4l-.9 2.4M15.8 17.4l-.9 2.4"/></svg>',
  snow:
    '<svg viewBox="0 0 24 24"><path d="M16.8 13.6H7a3.7 3.7 0 0 1-.3-7.4 5.6 5.6 0 0 1 10.2 1.6 3 3 0 0 1-.1 5.8z"/><path d="M9 16.6v2.6M9 17.9h.01M12.4 16.6v2.6M12.4 17.9h.01M15.8 16.6v2.6M15.8 17.9h.01"/></svg>',
  thunder:
    '<svg viewBox="0 0 24 24"><path d="M16.8 13.4H7a3.7 3.7 0 0 1-.3-7.4 5.6 5.6 0 0 1 10.2 1.6 3 3 0 0 1-.1 5.8z"/><path d="M12.6 15.4l-2.2 3.4h2.5l-1.6 2.6"/></svg>',
  fog:
    '<svg viewBox="0 0 24 24"><path d="M6.5 9.5h11M5 13h14M7 16.5h10M9 20h6"/></svg>'
};

// 八方位（winddirDegree 是风的「来向」）
const DIR_NAMES = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];

export function bindWeather() {
  $('#weather').addEventListener('click', () => {
    toast('正在刷新天气…');
    refreshWeather(true);
  });

  $('#weatherCity').addEventListener('change', (e) => {
    state.data.settings.weatherCity = e.target.value.trim();
    state.data.settings.weather = null;
    state.data.settings._lastLat = null;  // 换了城市，清掉 geocode 缓存
    state.data.settings._lastLon = null;
    persist();
    refreshWeather(true);
  });

  const srcSel = $('#weatherSource');
  const customUrl = $('#customWeatherUrl');

  const syncCustomVisible = () => {
    if (!customUrl) return;
    customUrl.style.display = srcSel?.value === 'custom' ? '' : 'none';
  };

  if (srcSel) {
    srcSel.value = state.data.settings.weatherSource || 'open-meteo';
    syncCustomVisible();
    srcSel.addEventListener('change', () => {
      state.data.settings.weatherSource = srcSel.value;
      state.data.settings.weather = null;  // 换源后清缓存，强制立即拉新
      persist();
      syncCustomVisible();
      if (srcSel.value === 'custom' && !customUrl?.value) {
        toast('请填写自定义接口 URL');
        return;
      }
      refreshWeather(true);
    });
  }

  if (customUrl) {
    customUrl.value = state.data.settings.customWeatherUrl || '';
    customUrl.addEventListener('change', (e) => {
      state.data.settings.customWeatherUrl = e.target.value.trim();
      persist();
      if (state.data.settings.weatherSource === 'custom') {
        state.data.settings.weather = null;
        refreshWeather(true);
      }
    });
  }

  // 电池状态：不充电时降频 + 减粒子，笔记本能明显少发热
  watchMotionPref();
}

export async function refreshWeather(force = false) {
  const cached = state.data.settings.weather;
  if (!force && cached?.fetchedAt && Date.now() - cached.fetchedAt < WEATHER_TTL) {
    renderWeather(cached, false);
    return;
  }

  const src = state.data.settings.weatherSource || 'open-meteo';
  const city = (state.data.settings.weatherCity || '').trim();

  try {
    const next = await (src === 'open-meteo' ? fetchOpenMeteo(city)
                    : src === 'custom'      ? fetchCustom(city)
                    : /* wttr */              fetchWttr(city));
    state.data.settings.weather = next;
    state.data.settings.weatherSource = src;  // 记录实际用的源
    persist();
    renderWeather(next, false);
  } catch (err) {
    console.warn('天气获取失败 [' + src + ']', err);
    if (cached) {
      renderWeather(cached, true);
    } else {
      $('#wxIcon').innerHTML = WX_ICONS.cloud;
      $('#wxTemp').textContent = '--°';
      $('#wxDesc').textContent = '获取失败';
      $('#wxCity').textContent = '点击重试';
      $('#wxRange').textContent = '';
      $('#weather').classList.remove('is-stale');
      $('#weather').title = `天气源 [${src}] 获取失败，换一个试试`;
    }
  }
}

/* ---------- fetcher 三选一 ----------
   每个 fetcher 返回统一的 weather 对象，renderWeather 完全不关心来源。 */

async function fetchWttr(city) {
  const url = city
    ? `https://wttr.in/${encodeURIComponent(city)}?format=j1&lang=zh`
    : 'https://wttr.in/?format=j1&lang=zh';
  const res = await fetchWithTimeout(url, 12000);
  if (!res.ok) throw new Error(`wttr HTTP ${res.status}`);
  const json = await res.json();
  const cur = json.current_condition?.[0] || {};
  const area = json.nearest_area?.[0] || {};
  const today = json.weather?.[0] || {};
  return {
    fetchedAt: Date.now(),
    city: city || area.areaName?.[0]?.value || '本地',
    temp: Number(cur.temp_C),
    code: Number(cur.weatherCode),
    desc: cur.lang_zh?.[0]?.value || cur.weatherDesc?.[0]?.value || '',
    feels: Number(cur.FeelsLikeC),
    humidity: Number(cur.humidity),
    wind: Number(cur.windspeedKmph),
    windDir: Number(cur.winddirDegree),
    high: Number(today.maxtempC),
    low: Number(today.mintempC)
  };
}

async function fetchOpenMeteo(city) {
  // 用 Open-Meteo 自带的免费 geocoding 拿坐标；未填城市就用浏览器默认
  let lat = state.data.settings._lastLat;
  let lon = state.data.settings._lastLon;
  let resolvedCity = city;
  let tz = 'Asia/Shanghai';

  if (city) {
    const gRes = await fetchWithTimeout(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh&format=json`,
      10000
    );
    if (!gRes.ok) throw new Error(`Open-Meteo geocode HTTP ${gRes.status}`);
    const gJson = await gRes.json();
    const hit = gJson.results?.[0];
    if (!hit) throw new Error(`找不到城市「${city}」`);
    lat = hit.latitude;
    lon = hit.longitude;
    resolvedCity = hit.name;
    tz = hit.timezone || 'Asia/Shanghai';
    // 记住，下次同城市跳过 geocoding
    state.data.settings._lastLat = lat;
    state.data.settings._lastLon = lon;
  } else if (!lat || !lon) {
    // 首次无缓存：用浏览器 geolocation（不支持或用户拒绝就默认北京）
    const pos = await new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
        () => resolve(null),
        { timeout: 6000 }
      );
    }).catch(() => null);
    if (pos) { lat = pos.lat; lon = pos.lon; resolvedCity = '当前位置'; }
    else { lat = 39.9042; lon = 116.4074; resolvedCity = '北京'; }
  }

  const u = `https://api.open-meteo.com/v1/forecast`
    + `?latitude=${lat}&longitude=${lon}`
    + `&current=temperature_2m,weather_code,wind_speed_10m,wind_direction_10m,relative_humidity_2m,apparent_temperature`
    + `&daily=temperature_2m_max,temperature_2m_min`
    + `&timezone=${encodeURIComponent(tz)}`;
  const res = await fetchWithTimeout(u, 12000);
  if (!res.ok) throw new Error(`Open-Meteo forecast HTTP ${res.status}`);
  const j = await res.json();
  const cur = j.current || {};
  const daily = j.daily || {};

  const wmoCode = Number(cur.weather_code);
  const wwoCode = WMO_TO_WWO[wmoCode] ?? wmoCode;
  // 用 WWO 码查描述（Open-Meteo 本身不给中文）
  const mapped = WX_CODES[wwoCode];

  return {
    fetchedAt: Date.now(),
    city: resolvedCity,
    temp: Number(cur.temperature_2m),
    code: wwoCode,
    desc: mapped?.[0] || '',
    feels: Number(cur.apparent_temperature),
    humidity: Number(cur.relative_humidity_2m),
    wind: Number(cur.wind_speed_10m),
    windDir: Number(cur.wind_direction_10m),
    high: Number(daily.temperature_2m_max?.[0]),
    low: Number(daily.temperature_2m_min?.[0])
  };
}

// 自定义接口：URL 支持 {city} 占位；返回 JSON 结构交给用户自己对上 wttr 的字段
// 用户必须返回这些顶层字段：temp, code(WWO), desc, feels, humidity, wind, windDir, high, low, city
async function fetchCustom(city) {
  const url = (state.data.settings.customWeatherUrl || '')
    .replace('{city}', encodeURIComponent(city || ''));
  if (!url) throw new Error('自定义接口 URL 未填写');
  const res = await fetchWithTimeout(url, 12000);
  if (!res.ok) throw new Error(`自定义接口 HTTP ${res.status}`);
  const j = await res.json();
  // 支持用户自定义接口的响应直接贴 wttr 结构或扁平键
  const cur = j.current_condition?.[0] || j.current || j;
  const area = j.nearest_area?.[0] || {};
  const today = j.weather?.[0] || j.daily || {};
  return {
    fetchedAt: Date.now(),
    city: city || area.areaName?.[0]?.value || j.city || '本地',
    temp: Number(cur.temp_C ?? cur.temperature_2m ?? cur.temp),
    code: Number(cur.weatherCode ?? cur.weather_code ?? cur.code),
    desc: cur.lang_zh?.[0]?.value || cur.weatherDesc?.[0]?.value || cur.description || '',
    feels: Number(cur.FeelsLikeC ?? cur.apparent_temperature ?? cur.feels),
    humidity: Number(cur.humidity ?? cur.relative_humidity_2m),
    wind: Number(cur.windspeedKmph ?? cur.wind_speed_10m ?? cur.wind),
    windDir: Number(cur.winddirDegree ?? cur.wind_direction_10m ?? cur.windDir),
    high: Number(today.maxtempC ?? today.temperature_2m_max?.[0] ?? today.high),
    low: Number(today.mintempC ?? today.temperature_2m_min?.[0] ?? today.low)
  };
}

export function renderWeather(w, stale) {
  const mapped = WX_CODES[Number(w.code)];
  const label = mapped?.[0] || w.desc || '—';
  const kind = mapped?.[1] || 'cloud';

  $('#wxIcon').innerHTML = WX_ICONS[kind] || WX_ICONS.cloud;
  $('#wxTemp').textContent = `${Math.round(Number(w.temp))}°`;
  $('#wxDesc').textContent = label;
  $('#wxCity').textContent = w.city || '本地';

  const range = [];
  if (Number.isFinite(w.high) && Number.isFinite(w.low)) {
    range.push(`高 ${Math.round(w.high)}° 低 ${Math.round(w.low)}°`);
  }
  $('#wxRange').textContent = range.join(' ');

  const extra = [];
  if (Number.isFinite(w.feels)) extra.push(`体感 ${Math.round(w.feels)}°`);
  if (Number.isFinite(w.humidity)) extra.push(`湿度 ${Math.round(w.humidity)}%`);
  if (Number.isFinite(w.wind)) extra.push(`${dirName(w.windDir)} ${Math.round(w.wind)} km/h`);
  const time = new Date(w.fetchedAt).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit'
  });
  $('#weather').title = `${label} ${Math.round(Number(w.temp))}° · ${extra.join(' · ')}\n更新于 ${time}${stale ? '（离线缓存）' : ''}`;
  $('#weather').classList.toggle('is-stale', !!stale);
  fxSync();
}

export function checkWeatherRefresh() {
  const w = state.data.settings.weather;
  if (!w?.fetchedAt || Date.now() - w.fetchedAt >= WEATHER_TTL) {
    refreshWeather(true);
  }
}

/* ================= 天气动效 =================
   性能原则（v1.1 重写，v1.1.0.5 大改画法）：
   1) 帧率锁 30fps —— 雨雪雾都是匀速运动，人眼分辨不出 30 与 60，功耗却差一半。
   2) 任何每帧新建的渐变对象都消灭掉了：光晕/星芒/光斑/云团/雾团/霾带/雨丝/雪片
      全部预先烘成雪碧图，绘制只剩 drawImage + globalAlpha。
      唯一保留的整屏渐变（阴天压光、雾堤、霾 tint、地面水雾）按窗口尺寸缓存。
   3) 粒子按景深分层（远细淡慢 / 近粗亮快），并按天气码分级——小雨和暴雨不是一套参数。
   4) 全图层共用同一支风：风向统一驱动云的流向、雨的倾角、雪的横飘、霾带与尘埃。
   5) 1.1.0.6 起不再响应 prefers-reduced-motion（见 watchMotionPref 处的说明）；
      电池供电时自动降到 25fps + 六成粒子。
   6) 雪碧图按需构建：只烘焙当前天气要用的那几张，切天气时整组释放。 */

const TAU = Math.PI * 2;
const MAX_SPLASH = 160;

export const fx = {
  canvas: null,
  ctx: null,
  raf: 0,
  running: false,
  kind: '',         // 'rain:2' / 'snow:0' / 'sun' / 'cloud' / 'fog' / 'haze'
  builtKind: '',
  t: 0,             // 累计动画时间（秒），不用 performance.now：锁帧时也连续
  w: 0,
  h: 0,
  parts: null,
  splash: [],
  flash: 0,
  nextFlash: 6000,
  bolt: null,
  lastTs: 0,
  frameMs: 33,      // 30fps；电池供电时放宽到 40ms
  sprites: null
};

// 绘制期共享的尺寸 / 时间步（每个函数都读，省得层层传参）
let ctx = null;
let W = 1;
let H = 1;
let DT = 0.016;

let batteryLimited = false;

// 1.1.0.6 起不再检测系统「减弱动态效果」：天气动效是纯装饰，被系统开关拦掉后
// 新用户只会以为功能坏了（真机排查确认过这个场景）。想关动效请用设置里的 fxMode。
export function watchMotionPref() {
  // 电池感知：不充电时降频 + 减粒子，笔记本能明显少发热。
  // 只用 charging 这个布尔值——Chromium 出于防指纹把 level 与时间估算做了模糊化，
  // charging 仍然准确，所以这段在 Edge/Chrome 上真实生效；
  // 台式机（无电池）恒为「充电中」，此处静默跳过属预期。
  if (navigator.getBattery) {
    navigator.getBattery()
      .then((b) => {
        const apply = () => {
          batteryLimited = !b.charging;
          fx.frameMs = batteryLimited ? 40 : 33;
        };
        apply();
        b.addEventListener('chargingchange', apply);
      })
      .catch(() => {});
  }
}

function fxActive() {
  const mode = state.data.settings.fxMode || 'always';
  if (mode === 'off') return false;
  // 不再检测系统「减弱动态效果」：这是装饰性动效而非必要信息，
  // 系统开关不该让新用户误以为功能坏了。想关动效请用设置里的 fxMode（1.1.0.6）
  return mode === 'always' ? true : state.idleActive;
}

function fxKind() {
  const code = state.data.settings.weather?.code;
  if (code === undefined || code === null) return '';
  const mapped = WX_CODES[Number(code)];
  return mapped?.[2] || '';
}

export function fxSync() {
  const kind = !fxActive() ? '' : fxKind();
  document.body.classList.toggle('fx-on', !!kind);
  fx.kind = kind;
  if (!kind) {
    fxStop();
    return;
  }
  if (!fx.running) fxStart();
  if (fx.builtKind !== kind) fxBuild(kind);
}

function fxStart() {
  if (fx.running) return;
  fx.canvas = $('#fx');
  fx.ctx = fx.canvas.getContext('2d');
  ctx = fx.ctx;
  fxSize();
  fx.running = true;
  fx.lastTs = 0;
  fx.t = 0;
  fx.raf = requestAnimationFrame(fxLoop);
}

export function fxStop() {
  if (fx.raf) cancelAnimationFrame(fx.raf);
  fx.raf = 0;
  fx.running = false;
  fx.builtKind = '';
  fx.parts = null;
  fx.splash = [];
  fx.sprites = null;
  fx.bolt = null;
  fx.flash = 0;
  if (fx.ctx) fx.ctx.clearRect(0, 0, fx.w, fx.h);
}

export function fxSize() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  fx.w = window.innerWidth;
  fx.h = window.innerHeight;
  fx.canvas.width = Math.round(fx.w * dpr);
  fx.canvas.height = Math.round(fx.h * dpr);
  fx.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  W = fx.w;
  H = fx.h;
  ctx = fx.ctx;
  fxGradients();
}

/* ---------- 雪碧图：把每帧都要重建的渐变，改成建一次 ---------- */
function mk(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  const g = c.getContext('2d');
  draw(g, c.width, c.height);
  return c;
}

function rnd32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

const lerp = (a, b, k) => a + (b - a) * k;

// 软圆：太阳光晕 / 鬼影 / 雪片 / 浮尘都用它
function softDisc(rgb, size = 256, midStop = 0.34, midAlpha = 0.45) {
  return mk(size, size, (g) => {
    const r = size / 2;
    const gr = g.createRadialGradient(r, r, 0, r, r, r);
    gr.addColorStop(0, 'rgba(' + rgb + ',1)');
    gr.addColorStop(midStop, 'rgba(' + rgb + ',' + midAlpha + ')');
    gr.addColorStop(1, 'rgba(' + rgb + ',0)');
    g.fillStyle = gr;
    g.beginPath(); g.arc(r, r, r, 0, TAU); g.fill();
  });
}

// 太阳本体：一点硬核 + 一圈暖边，不能在整屏铺开
function sunDisc() {
  return mk(512, 512, (g) => {
    const r = 256;
    const gr = g.createRadialGradient(r, r, 0, r, r, r);
    gr.addColorStop(0.00, 'rgba(255,253,246,1)');
    gr.addColorStop(0.13, 'rgba(255,246,224,0.98)');
    gr.addColorStop(0.20, 'rgba(255,232,182,0.92)');
    gr.addColorStop(0.30, 'rgba(255,206,138,0.42)');
    gr.addColorStop(0.48, 'rgba(255,182,104,0.13)');
    gr.addColorStop(1.00, 'rgba(255,166,88,0)');
    g.fillStyle = gr;
    g.beginPath(); g.arc(r, r, r, 0, TAU); g.fill();
  });
}

// 光圈环：中心透明、边缘一圈柔光，用于「光圈」质感（不是硬描边）
function ringSprite(rgb, size = 512) {
  return mk(size, size, (g) => {
    const r = size / 2;
    const gr = g.createRadialGradient(r, r, r * 0.58, r, r, r);
    gr.addColorStop(0.00, 'rgba(' + rgb + ',0)');
    gr.addColorStop(0.52, 'rgba(' + rgb + ',0.34)');
    gr.addColorStop(0.74, 'rgba(' + rgb + ',0.09)');
    gr.addColorStop(1.00, 'rgba(' + rgb + ',0)');
    g.fillStyle = gr;
    g.beginPath(); g.arc(r, r, r, 0, TAU); g.fill();
  });
}

// 横向拉丝：电影里那根 1px 的蓝白光条
function streakSprite(rgb, core) {
  return mk(1024, 12, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, w, 0);
    gr.addColorStop(0.00, 'rgba(' + rgb + ',0)');
    gr.addColorStop(0.38, 'rgba(' + rgb + ',' + (core * 0.55) + ')');
    gr.addColorStop(0.50, 'rgba(' + rgb + ',' + core + ')');
    gr.addColorStop(0.62, 'rgba(' + rgb + ',' + (core * 0.55) + ')');
    gr.addColorStop(1.00, 'rgba(' + rgb + ',0)');
    g.fillStyle = gr;
    g.fillRect(0, h / 2 - 1.5, w, 3);
  });
}

/* ---- 镜头光晕三件套：星芒 / 焦外光斑 / 光柱 ---- */

// 星芒：几十根长短不一的柔光射线。真实镜头不是「四根十字」，是密而细的一圈，
// 短刺密、长刺稀，其中两根沿光轴拉到最长——所以整体旋转时方向感很明显。
// 硬三角形在暗背景上会像贴纸，镜头里从来没有锐角的光，所以整体 blur + 弧线轮廓 + 沿长度渐隐。
function flareStar(rgb, seed = 7) {
  const size = 1024;
  return mk(size, size, (g) => {
    const c = size / 2;
    const rnd = rnd32(seed);
    g.translate(c, c);

    const spokes = [];
    const N = 46;
    for (let i = 0; i < N; i++) {
      const long = rnd() > 0.66;
      spokes.push({
        a: (i / N) * TAU + (rnd() - 0.5) * 0.07,
        len: c * (long ? 0.52 + rnd() * 0.40 : 0.11 + rnd() * 0.22),
        wid: (long ? 2.4 : 1.5) * (0.7 + rnd() * 0.7)
      });
    }
    // 两根沿光轴（0° / 180°）的超长刺：转起来才有「在扫」的感觉
    spokes.push({ a: 0, len: c * 0.99, wid: 3.4 });
    spokes.push({ a: Math.PI, len: c * 0.94, wid: 3.0 });

    g.filter = 'blur(2.5px)';
    for (const s of spokes) {
      g.save();
      g.rotate(s.a);
      const gr = g.createLinearGradient(0, 0, s.len, 0);
      gr.addColorStop(0.00, 'rgba(' + rgb + ',0.92)');
      gr.addColorStop(0.16, 'rgba(' + rgb + ',0.40)');
      gr.addColorStop(0.58, 'rgba(' + rgb + ',0.09)');
      gr.addColorStop(1.00, 'rgba(' + rgb + ',0)');
      g.fillStyle = gr;
      g.beginPath();
      g.moveTo(0, -s.wid);
      g.quadraticCurveTo(s.len * 0.5, -s.wid * 0.34, s.len, 0);
      g.quadraticCurveTo(s.len * 0.5, s.wid * 0.34, 0, s.wid);
      g.closePath();
      g.fill();
      g.restore();
    }

    // 过曝的核
    g.filter = 'none';
    const core = g.createRadialGradient(0, 0, 0, 0, 0, c * 0.13);
    core.addColorStop(0.00, 'rgba(255,255,255,1)');
    core.addColorStop(0.34, 'rgba(' + rgb + ',0.66)');
    core.addColorStop(1.00, 'rgba(' + rgb + ',0)');
    g.fillStyle = core;
    g.beginPath(); g.arc(0, 0, c * 0.13, 0, TAU); g.fill();
  });
}

// 焦外光斑（bokeh）：镜头鬼影的本质是光圈叶片的投影——
// 边缘比内部亮、内部半透明，这条「亮边」是它看着通透而不是一团糊的关键。
// sides=0 画圆，sides=6 画六边形（真实光圈多是六叶）。
function bokehSprite(rgb, sides = 0, size = 256) {
  return mk(size, size, (g) => {
    const r = size / 2;
    const path = () => {
      g.beginPath();
      if (!sides) {
        g.arc(r, r, r * 0.90, 0, TAU);
        return;
      }
      for (let i = 0; i < sides; i++) {
        const a = (TAU / sides) * i - Math.PI / 2;
        const x = r + Math.cos(a) * r * 0.90;
        const y = r + Math.sin(a) * r * 0.90;
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.closePath();
    };

    path();
    const fill = g.createRadialGradient(r, r, 0, r, r, r * 0.90);
    fill.addColorStop(0.00, 'rgba(' + rgb + ',0.07)');
    fill.addColorStop(0.72, 'rgba(' + rgb + ',0.13)');
    fill.addColorStop(1.00, 'rgba(' + rgb + ',0.34)');
    g.fillStyle = fill;
    g.fill();

    g.filter = 'blur(1.4px)';
    g.strokeStyle = 'rgba(' + rgb + ',0.66)';
    g.lineWidth = Math.max(1.6, size * 0.013);
    g.stroke();
  });
}

// 光柱：一条从太阳沿光轴铺开的柔光，两头收口（destination-in 挖掉上下边）。
// 它是「方向感」最直观的来源——风一变，整条光柱先扫过去。
function beamSprite(rgb) {
  return mk(1024, 256, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, w, 0);
    // 亮端留 5% 的过渡带：光柱的「根部」多半贴着云缝或太阳，
    // 硬边在透明画布上会显形，宁可浪费这 5% 换一个看不见边缝的光源
    gr.addColorStop(0.00, 'rgba(' + rgb + ',0)');
    gr.addColorStop(0.05, 'rgba(' + rgb + ',0.50)');
    gr.addColorStop(0.12, 'rgba(' + rgb + ',0.26)');
    gr.addColorStop(0.48, 'rgba(' + rgb + ',0.085)');
    gr.addColorStop(1.00, 'rgba(' + rgb + ',0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, w, h);

    g.globalCompositeOperation = 'destination-in';
    const vg = g.createLinearGradient(0, 0, 0, h);
    vg.addColorStop(0.00, 'rgba(0,0,0,0)');
    vg.addColorStop(0.46, 'rgba(0,0,0,1)');
    vg.addColorStop(0.54, 'rgba(0,0,0,1)');
    vg.addColorStop(1.00, 'rgba(0,0,0,0)');
    g.fillStyle = vg;
    g.fillRect(0, 0, w, h);
  });
}

// 云缝：阴天里那一小块亮。不是纯圆——几团柔光错开叠，边缘不齐才像「云薄的地方」，
// 半径和位置都收在画布内，避免被裁出硬直边。
function gapSprite(rgb, seed) {
  return mk(512, 512, (g, w, h) => {
    const rnd = rnd32(seed);
    for (let i = 0; i < 5; i++) {
      const px = (0.35 + 0.30 * (i / 4)) * w + (rnd() - 0.5) * 46;
      const py = h * (0.5 + (rnd() - 0.5) * 0.30);
      const r = (0.15 + rnd() * 0.09) * h;
      const rh = r * 1.45;
      const cx2 = Math.min(w - rh, Math.max(rh, px));   // 横向拉伸后瓣仍要完整落在画布内
      const cy2 = Math.min(h - r, Math.max(r, py));
      g.save();
      g.translate(cx2, cy2);
      g.scale(1.45, 1);
      const gr = g.createRadialGradient(0, 0, 0, 0, 0, r);
      gr.addColorStop(0.00, 'rgba(' + rgb + ',0.72)');
      gr.addColorStop(0.46, 'rgba(' + rgb + ',0.26)');
      gr.addColorStop(1.00, 'rgba(' + rgb + ',0)');
      g.fillStyle = gr;
      g.beginPath(); g.arc(0, 0, r, 0, TAU); g.fill();
      g.restore();
    }
  });
}

// 云团：多个椭圆瓣叠加，做出不规则轮廓（比圆形像云）。
// 画布留足余量并对瓣心做收口，避免椭圆被边界裁出硬直边。
function cloudLump(rgb, seed, lobes, spread, squash) {
  return mk(880, 360, (g, w, h) => {
    const rnd = rnd32(seed);
    for (let i = 0; i < lobes; i++) {
      const r = (0.22 + rnd() * 0.16) * h;
      const rh = r * squash;
      let px = (0.14 + spread * (i / (lobes - 1))) * w + (rnd() - 0.5) * 56;
      px = Math.min(w - rh, Math.max(rh, px));
      const py = h * (0.5 + (rnd() - 0.5) * 0.20);
      const a = 0.45 + rnd() * 0.55;
      g.save();
      g.translate(px, py);
      g.scale(squash, 1);
      const gr = g.createRadialGradient(0, 0, 0, 0, 0, r);
      gr.addColorStop(0, 'rgba(' + rgb + ',' + a + ')');
      gr.addColorStop(0.55, 'rgba(' + rgb + ',' + (a * 0.52).toFixed(3) + ')');
      gr.addColorStop(1, 'rgba(' + rgb + ',0)');
      g.fillStyle = gr;
      g.beginPath(); g.arc(0, 0, r, 0, TAU); g.fill();
      g.restore();
    }
  });
}

// 雾团：更扁更宽的一团奶白
function fogPuff(rgb, seed) {
  return mk(960, 420, (g, w, h) => {
    const rnd = rnd32(seed);
    for (let i = 0; i < 5; i++) {
      const r = (0.28 + rnd() * 0.14) * h;
      const rh = r * 1.45;
      let px = (0.18 + 0.66 * (i / 4)) * w + (rnd() - 0.5) * 40;
      px = Math.min(w - rh, Math.max(rh, px));
      const py = h * (0.5 + (rnd() - 0.5) * 0.26);
      g.save();
      g.translate(px, py);
      g.scale(1.45, 1);
      const gr = g.createRadialGradient(0, 0, 0, 0, 0, r);
      gr.addColorStop(0, 'rgba(' + rgb + ',0.75)');
      gr.addColorStop(0.5, 'rgba(' + rgb + ',0.34)');
      gr.addColorStop(1, 'rgba(' + rgb + ',0)');
      g.fillStyle = gr;
      g.beginPath(); g.arc(0, 0, r, 0, TAU); g.fill();
      g.restore();
    }
  });
}

// 霾的横向浑浊带：一条又扁又长、边缘不齐的暖褐带
function hazeBand(rgb, seed) {
  return mk(1800, 240, (g, w, h) => {
    const rnd = rnd32(seed);
    for (let i = 0; i < 9; i++) {
      const r = (0.20 + rnd() * 0.14) * h;
      const rh = r * 3.4;
      const px = (0.06 + 0.88 * (i / 8)) * w + (rnd() - 0.5) * 70;
      const py = h * (0.5 + (rnd() - 0.5) * 0.34);
      const cx2 = Math.min(w - rh, Math.max(rh, px));   // 3.4 倍横拉后瓣心收口，防裁边
      const cy2 = Math.min(h - r, Math.max(r, py));
      g.save();
      g.translate(cx2, cy2);
      g.scale(3.4, 1);
      const gr = g.createRadialGradient(0, 0, 0, 0, 0, r);
      gr.addColorStop(0, 'rgba(' + rgb + ',' + (0.34 + rnd() * 0.3).toFixed(3) + ')');
      gr.addColorStop(0.55, 'rgba(' + rgb + ',0.16)');
      gr.addColorStop(1, 'rgba(' + rgb + ',0)');
      g.fillStyle = gr;
      g.beginPath(); g.arc(0, 0, r, 0, TAU); g.fill();
      g.restore();
    }
  });
}

// 雨滴：一条带渐隐尾巴的竖线，画的时候按景深缩放
function rainSprite() {
  return mk(8, 64, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, 0, h);
    gr.addColorStop(0, 'rgba(200,224,255,0)');
    gr.addColorStop(0.45, 'rgba(214,232,255,0.95)');
    gr.addColorStop(1, 'rgba(180,210,255,0.1)');
    g.fillStyle = gr;
    g.fillRect(2.6, 0, 2.8, h);
  });
}

// 只烘焙当前天气要用的那几张：晴天不做云、雨天不做星芒，切天气时整组丢弃
// 多云（partly）就是「晴 + 阴」两张牌都留：太阳的整套光晕 + 阴天那几团云影，合成顺序见 renderPartly
function buildSprites(kind, lv) {
  const sp = {};

  if (kind === 'sun' || kind === 'partly') {
    sp.disc = sunDisc();
    sp.haloWarm = softDisc('255,224,170', 256, 0.26, 0.40);
    sp.haloAmber = softDisc('255,186,116', 256, 0.30, 0.30);
    sp.haloTeal = softDisc('150,190,220', 256, 0.34, 0.20);
    sp.bloom = softDisc('255,238,208', 256, 0.44, 0.18);   // 超宽柔光：让太阳「有空气感」
    sp.ringWarm = ringSprite('255,226,178');               // 光圈
    sp.ringCool = ringSprite('196,220,255');
    sp.streakBlue = streakSprite('188,206,255', 0.55);
    sp.streakWarm = streakSprite('255,226,178', 0.34);
    sp.ghostWarm = softDisc('255,196,128', 256, 0.30, 0.34);
    sp.ghostCyan = softDisc('140,208,255', 256, 0.32, 0.28);
    sp.star = flareStar('255,238,206');
    sp.beam = beamSprite('255,224,178');
    sp.bkRingW = bokehSprite('255,214,158', 0);
    sp.bkRingC = bokehSprite('168,214,255', 0);
    sp.bkHexW = bokehSprite('255,206,150', 6);
    sp.bkHexC = bokehSprite('176,220,255', 6);
    sp.flareDot = softDisc('255,250,238', 96, 0.16, 0.80);
  }

  if (kind === 'cloud' || kind === 'partly') {
    // 多云的云更薄更亮：云被太阳从背后照着，所以是偏蓝的浅灰，不是阴天那种压顶的深灰
    const lump = kind === 'partly' ? '168,180,198' : '66,76,94';
    const lump2 = kind === 'partly' ? '150,164,184' : '58,68,86';
    const lump3 = kind === 'partly' ? '182,192,208' : '74,84,102';
    sp.cloud = [
      cloudLump(lump, 11, 7, 0.70, 1.75),
      cloudLump(lump2, 27, 8, 0.72, 1.90),
      cloudLump(lump3, 43, 6, 0.66, 1.60)
    ];
    // 云缝：三团不同形状的透光亮斑（暖白 —— 阴天的天光是冷的，但缝隙里透出来的是暖的）
    sp.gap = [
      gapSprite('255,246,224', 3),
      gapSprite('244,248,255', 13),
      gapSprite('255,238,206', 23)
    ];
    sp.beam = beamSprite('255,224,178');
  }

  if (kind === 'fog') {
    sp.fog = [
      fogPuff('226,238,252', 7),
      fogPuff('236,245,255', 19),
      fogPuff('218,231,248', 31)
    ];
  }

  if (kind === 'haze') {
    sp.haze = [
      hazeBand('180,146,86', 5),
      hazeBand('196,164,104', 17),
      hazeBand('166,132,74', 29)
    ];
  }

  if (kind === 'rain') {
    sp.rain = rainSprite();
    sp.drop = softDisc('208,228,255', 64, 0.40, 0.30);
    // 雷阵雨先把天空压暗，靠的也是这套云团
    if (lv === 3) {
      sp.cloud = [
        cloudLump('66,76,94', 11, 7, 0.70, 1.75),
        cloudLump('58,68,86', 27, 8, 0.72, 1.90),
        cloudLump('74,84,102', 43, 6, 0.66, 1.60)
      ];
    }
  }

  if (kind === 'snow') {
    sp.flake = softDisc('255,255,255', 96, 0.26, 0.62);
    if (lv === 3) sp.rain = rainSprite();   // 雨夹雪 = 细雨 + 雪同行
  }

  return sp;
}

// 整屏渐变跟窗口尺寸绑定，尺寸不变就不再重建
function fxGradients() {
  const sp = fx.sprites;
  if (!sp) return;
  if (W === fx.gradW && H === fx.gradH && sp.grads) return;
  fx.gradW = W;
  fx.gradH = H;
  sp.grads = true;

  // 阴天压光：顶部压得狠、底部几乎不压 —— 光从地平线附近透上来。
  // 画布是透明的（壁纸在 DOM 层后面），multiply 在这里没有底可乘，
  // 所以用「冷暗色 + 渐变 alpha」等效实现「亮度按比例抽掉」。
  sp.ovCloud = ctx.createLinearGradient(0, 0, 0, H);
  sp.ovCloud.addColorStop(0.00, 'rgba(26,32,46,0.62)');
  sp.ovCloud.addColorStop(0.42, 'rgba(38,46,62,0.40)');
  sp.ovCloud.addColorStop(0.74, 'rgba(52,60,74,0.18)');
  sp.ovCloud.addColorStop(1.00, 'rgba(60,68,80,0.05)');

  // 多云的薄阴：只抽掉晴空那层「刺眼的通透」，不把画面压暗 —— 天还是亮的，太阳也还在
  sp.ovPartly = ctx.createLinearGradient(0, 0, 0, H);
  sp.ovPartly.addColorStop(0.00, 'rgba(58,66,86,0.30)');
  sp.ovPartly.addColorStop(0.40, 'rgba(64,72,94,0.19)');
  sp.ovPartly.addColorStop(0.75, 'rgba(70,78,100,0.08)');
  sp.ovPartly.addColorStop(1.00, 'rgba(76,84,106,0.02)');

  sp.bankFog = ctx.createLinearGradient(0, H * 0.55, 0, H);
  sp.bankFog.addColorStop(0, 'rgba(214,228,246,0)');
  sp.bankFog.addColorStop(1, 'rgba(214,228,246,0.22)');

  sp.tintHaze = ctx.createLinearGradient(0, 0, 0, H);
  sp.tintHaze.addColorStop(0, 'rgb(158,128,80)');
  sp.tintHaze.addColorStop(0.5, 'rgb(176,140,84)');
  sp.tintHaze.addColorStop(1, 'rgb(134,104,62)');

  // 雨天地面的水雾：越靠近地面越白
  sp.mistRain = ctx.createLinearGradient(0, H * 0.78, 0, H);
  sp.mistRain.addColorStop(0, 'rgba(206,222,244,0)');
  sp.mistRain.addColorStop(1, 'rgba(206,222,244,1)');
}

/* ============================================================
   雨 / 雪 分级 + 风
   ============================================================ */

// 分级参数按 WWO 天气码来，不是随机：小雨和暴雨本来就该长得不一样。
// n = 根数，len = 长度 px，v = 下落 px/s，w = 粗细，a = 透明度，smin = 够近才炸水花
const RAIN_LV = [
  { key: 'light', name: '小雨', n: 55, len: [8, 18], v: [260, 430], w: [0.8, 1.5], a: [0.12, 0.34], veil: 0.030, mist: 0.000, smin: 0.60 },
  { key: 'mid', name: '中雨', n: 180, len: [11, 25], v: [430, 680], w: [0.8, 1.8], a: [0.16, 0.44], veil: 0.050, mist: 0.035, smin: 0.48 },
  { key: 'heavy', name: '大雨', n: 330, len: [16, 38], v: [640, 1000], w: [1.0, 2.4], a: [0.20, 0.55], veil: 0.070, mist: 0.075, smin: 0.36 },
  { key: 'storm', name: '雷阵雨', n: 300, len: [18, 42], v: [720, 1080], w: [1.1, 2.6], a: [0.22, 0.58], veil: 0.085, mist: 0.090, smin: 0.30 }
];

const SNOW_LV = [
  { key: 'light', name: '小雪', n: 70, r: [1.1, 2.7], v: [16, 44], drift: [6, 14], a: [0.30, 0.70], veil: 0.020, near: 0 },
  { key: 'mid', name: '中雪', n: 200, r: [1.1, 2.9], v: [28, 70], drift: [9, 20], a: [0.35, 0.80], veil: 0.045, near: 0 },
  { key: 'heavy', name: '大雪', n: 340, r: [1.4, 4.0], v: [42, 100], drift: [14, 32], a: [0.40, 0.90], veil: 0.085, near: 10 },
  { key: 'sleet', name: '雨夹雪', n: 150, r: [0.9, 2.2], v: [22, 60], drift: [7, 16], a: [0.30, 0.75], veil: 0.040, near: 0 }
];

const GROUND = () => H - 2;

// 风速 / 来向（0=北）。数据来源：current_condition.windspeedKmph + winddirDegree
// 注意：winddirDegree 是风的「来向」，粒子流向要 +180°；windVec() 返回的已是流向单位向量
const WIND = { kmph: 8, fromDeg: 270 };

function windVec() {
  const rad = (WIND.fromDeg * Math.PI) / 180;
  // 北风（from 0°）吹向正南 = +y；东风（from 90°）吹向正西 = -x
  return { x: -Math.sin(rad), y: Math.cos(rad) };
}

// 阵风：所有图层共用的低频起伏，让整支风「活」起来（振幅 ±18%）
function windGust(t) {
  return 1 + 0.13 * Math.sin(t * 0.79) + 0.05 * Math.sin(t * 1.93 + 1.2);
}

// 图层对风的响应系数：越轻的东西越听话
// 云最有质量（最迟钝），雾其次，霾带几乎糊住不动，尘埃最轻（几乎 1:1 跟风）
const WIND_GAIN = { fog: 0.55, hazeBand: 0.22, dust: 0.95, motes: 0.45 };

// 各图层统一的风速换算：km/h → px/s
function windPush(t, gain) {
  const w = windVec();
  const eff = WIND.kmph < 2 ? 0 : WIND.kmph;
  const k = eff * 5 * gain * windGust(t);
  return { x: w.x * k, y: w.y * k };
}

// tan(倾角) = 水平风速 / 雨滴末速(≈28km/h)。静风时把方向权重压掉，避免莫名倾斜
function rainSlope(t) {
  const w = windVec();
  const eff = WIND.kmph < 2 ? 0 : WIND.kmph * windGust(t);
  return Math.atan(Math.max(-0.85, Math.min(0.85, (w.x * eff) / 28)));
}

/* ---------- 镜头光晕的光轴 ----------
   光轴的基准是「太阳 → 画面中心」。风把光斑往一个方向吹偏，
   于是「垂直于光轴的风」自然变成「整条光轴绕太阳旋转」——
   这是最无歧义的映射：风从左往右吹，光斑链就扫向右侧，反之亦然。
   沿光轴的风则表现为整条链被拉长/压短。 */
const FLARE = { ang: 0, init: false, along: 0 };

function flareTarget(sx, sy) {
  const base = Math.atan2(H * 0.5 - sy, W * 0.5 - sx);
  const w = windVec();
  const eff = WIND.kmph < 3 ? 0 : Math.min(1, WIND.kmph / 24);
  const perp = -w.x * Math.sin(base) + w.y * Math.cos(base);   // 垂直分量 → 转向
  const swing = Math.max(-0.62, Math.min(0.62, perp * 1.15 * eff));
  return { ang: base + swing, along: (w.x * Math.cos(base) + w.y * Math.sin(base)) * eff };
}

// 光斑链的配方：k = 沿光轴的距离（1 = 太阳到画面中心），off = 垂直偏移，r = 半径（×屏高）
// 疏密刻意不均，中间那三颗叠成一簇 —— 真实镜头的光晕从来不是等距排的。
const FLARE_CHAIN = [
  { k: 0.28, r: 0.009, a: 0.50, sp: 'flareDot', off: 0.004 },
  { k: 0.38, r: 0.024, a: 0.30, sp: 'ghostCyan', off: -0.008 },
  { k: 0.50, r: 0.008, a: 0.50, sp: 'flareDot', off: 0.006 },
  { k: 0.60, r: 0.033, a: 0.34, sp: 'bkRingW', off: 0.000 },
  { k: 0.72, r: 0.017, a: 0.38, sp: 'bkHexC', off: -0.010 },
  { k: 0.84, r: 0.044, a: 0.28, sp: 'ghostWarm', off: 0.012 },
  { k: 0.92, r: 0.030, a: 0.36, sp: 'bkRingC', off: -0.006 },
  { k: 1.04, r: 0.056, a: 0.24, sp: 'bkRingW', off: 0.016 },
  { k: 1.14, r: 0.010, a: 0.48, sp: 'flareDot', off: -0.004 },
  { k: 1.30, r: 0.021, a: 0.34, sp: 'bkHexW', off: 0.008 },
  { k: 1.46, r: 0.036, a: 0.24, sp: 'ghostCyan', off: -0.014 },
  { k: 1.64, r: 0.078, a: 0.22, sp: 'bkRingW', off: 0.004 },
  { k: 1.88, r: 0.012, a: 0.44, sp: 'flareDot', off: -0.006 },
  { k: 2.06, r: 0.031, a: 0.26, sp: 'ghostWarm', off: 0.010 }
];

/* ---------- 粒子 ---------- */
function buildParts(kind, lv) {
  const r = (a, b) => a + Math.random() * (b - a);
  const dens = batteryLimited ? 0.6 : 1;
  const P = { sun: [], cloud: [], gaps: [], fog: [], haze: [], rain: [], snow: [] };

  if (kind === 'sun' || kind === 'partly') {
    // 晴：浮尘，沿光轴上浮（14 颗，比堆满屏更像空气里的灰尘）；多云时少一半，云里看不见那么多灰
    const motes = kind === 'partly' ? 8 : 14;
    for (let i = 0; i < Math.round(motes * dens); i++) {
      P.sun.push({
        x: r(0, 1), y: r(0, 1),
        r: r(1.2, 3.2),
        vx: r(-4, 10), vy: r(-16, -5),
        ph: r(0, TAU), sp: r(0.5, 1.5),
        a: r(0.16, 0.48)
      });
    }
  }

  if (kind === 'cloud' || kind === 'partly') {
    // 云影分布：上重下轻。真实阴天也是头顶最厚、接近地平线处开始透光，
    // 所以上半屏用大块深云（w 大、s=2 最深的一层），越往下越小越淡。
    // 多云只留三团薄云、透明度砍到三分之一：大片晴空还在，云飘过太阳时才有明暗交替。
    const cloudPlan = kind === 'partly' ? [
      { y: 0.02, w: 1.72, v: 9, a: 0.30, s: 2 },
      { y: 0.26, w: 1.24, v: 15, a: 0.21, s: 1 },
      { y: 0.56, w: 0.82, v: 22, a: 0.11, s: 0 }
    ] : [
      { y: 0.00, w: 1.95, v: 11, a: 0.86, s: 2 },
      { y: 0.15, w: 1.68, v: 16, a: 0.74, s: 2 },
      { y: 0.30, w: 1.35, v: 24, a: 0.56, s: 1 },
      { y: 0.52, w: 1.00, v: 34, a: 0.30, s: 1 },
      { y: 0.76, w: 0.68, v: 44, a: 0.13, s: 0 }
    ];
    cloudPlan.forEach((c, i) => {
      P.cloud.push({ ...c, x: i / cloudPlan.length + r(-0.1, 0.1), ph: 0, pv: 0 });
    });

    // 云缝：三处透光，速度比同层云略慢（缝在更远的云层里），彼此错开
    const gapPlan = kind === 'partly' ? [
      { x: 0.44, y: 0.20, w: 0.60, v: 12, a: 0.30, s: 0 },
      { x: 0.14, y: 0.40, w: 0.44, v: 18, a: 0.18, s: 1 }
    ] : [
      { x: 0.30, y: 0.24, w: 0.80, v: 13, a: 0.62, s: 0 },
      { x: 0.58, y: 0.12, w: 0.54, v: 20, a: 0.46, s: 1 },
      { x: 0.22, y: 0.44, w: 0.92, v: 9, a: 0.38, s: 2 }
    ];
    gapPlan.forEach((g) => P.gaps.push({ ...g, ph: 0 }));
  }

  if (kind === 'fog') {
    // 雾：7 团，速度快慢交错
    for (let i = 0; i < Math.round(7 * dens); i++) {
      P.fog.push({
        x: r(-0.2, 1.1), y: r(0.18, 0.82),
        w: r(0.52, 0.95),
        v: r(9, 16) * (i % 3 === 0 ? -1 : 1),
        a: r(0.10, 0.20),
        s: i % 3,
        ph: r(0, TAU),
        ph2: null,
        pv: 0
      });
    }
  }

  if (kind === 'haze') {
    // 霾：3 条浑浊带 + 悬浮颗粒
    [
      { y: 0.16, w: 1.5, v: 4, a: 0.13, s: 0 },
      { y: 0.44, w: 1.7, v: -3, a: 0.17, s: 1 },
      { y: 0.68, w: 1.3, v: 5, a: 0.15, s: 2 }
    ].forEach((b, i) => {
      P.haze.push({ band: true, y: b.y, w: b.w, v: b.v, a: b.a, s: b.s, x: i * 0.31, ph2: null });
    });
    for (let i = 0; i < Math.round(26 * dens); i++) {
      P.haze.push({
        band: false,
        x: r(0, 1), y: r(0, 1),
        r: r(0.5, 1.6),
        vx: r(-6, 6), vy: r(-3, 3),
        ph: r(0, TAU), sp: r(0.6, 2.2),
        a: r(0.10, 0.32)
      });
    }
  }

  if (kind === 'rain' || (kind === 'snow' && lv === 3)) {
    // 雨夹雪的那半场雨永远是小雨级
    const cfg = kind === 'rain' ? RAIN_LV[lv] : RAIN_LV[0];
    const n = Math.round((kind === 'rain' ? cfg.n : 90) * dens);
    for (let i = 0; i < n; i++) {
      const z = Math.random();
      P.rain.push({
        lx: r(-0.3, 1.3) * W,
        ly: r(-1.2, 1.2) * H,
        z,
        len: lerp(cfg.len[0], cfg.len[1], z),
        v: lerp(cfg.v[0], cfg.v[1], z),
        w: lerp(cfg.w[0], cfg.w[1], z),
        a: lerp(cfg.a[0], cfg.a[1], z) * (kind === 'snow' ? 0.8 : 1),
        splashed: false
      });
    }
  }

  if (kind === 'snow') {
    const cfg = SNOW_LV[lv];
    const n = Math.round(cfg.n * dens);
    for (let i = 0; i < n; i++) {
      const z = Math.random();
      P.snow.push({
        lx: r(-0.2, 1.2) * W,
        ly: r(-1.2, 1.2) * H,
        z,
        r: lerp(cfg.r[0], cfg.r[1], z),
        v: lerp(cfg.v[0], cfg.v[1], z),
        drift: lerp(cfg.drift[0], cfg.drift[1], z),
        a: lerp(cfg.a[0], cfg.a[1], z),
        ph: r(0, TAU),
        sp: r(0.5, 1.4)
      });
    }
    // 大雪的景深：几片贴脸的大雪花，慢慢飘过
    for (let i = 0; i < cfg.near; i++) {
      P.snow.push({
        lx: r(0, 1) * W,
        ly: r(-0.6, 1) * H,
        z: 1,
        r: r(6, 10),
        v: r(110, 170),
        drift: r(10, 24),
        a: r(0.12, 0.22),
        ph: r(0, TAU),
        sp: r(0.4, 0.9)
      });
    }
  }

  return P;
}

export function fxBuild(spec) {
  const [kind, lvStr] = String(spec).split(':');
  const lv = Number(lvStr || 0);

  // 天气里的风：kmph + 来向角度。老缓存没有 windDir 就按西风兜底
  fxWind();

  fx.sprites = buildSprites(kind, lv);
  fx.parts = buildParts(kind, lv);
  fx.gradW = 0;
  fx.gradH = 0;
  fxGradients();

  fx.builtKind = spec;
  fx.flash = 0;
  fx.nextFlash = 6000 + Math.random() * 8000;
  fx.bolt = null;
  fx.splash = [];
  FLARE.init = false;
}

// 每一帧都读一次：用户改城市 / 天气刷新后，风和光轴立刻跟着变
function fxWind() {
  const w = state.data.settings.weather || {};
  const km = Number(w.wind);
  const dir = Number(w.windDir);
  WIND.kmph = Number.isFinite(km) ? Math.max(0, Math.min(45, km)) : 8;
  WIND.fromDeg = Number.isFinite(dir) ? ((dir % 360) + 360) % 360 : 270;
}

function dirName(deg) {
  if (!Number.isFinite(Number(deg))) return '风速';
  return `${DIR_NAMES[Math.round((((Number(deg) % 360) + 360) % 360) / 45) % 8]}风`;
}

/* ---------- 水花 ---------- */
function spawnSplash(x, y, z, cfg) {
  const extra = cfg.key === 'heavy' || cfg.key === 'storm' ? 1 : 0;
  const n = 1 + (Math.random() < 0.5 ? 1 : 0) + extra;
  const wvx = windVec().x * (WIND.kmph < 2 ? 0 : WIND.kmph) * 1.8;
  for (let i = 0; i < n; i++) {
    if (fx.splash.length >= MAX_SPLASH) return;
    // 水花溅起时被风推一把，风向明显时水花整体偏向一侧
    fx.splash.push({
      x, y,
      vx: (Math.random() - 0.5) * 120 * (0.4 + z) + wvx,
      vy: -(38 + Math.random() * 86) * (0.4 + z),
      life: 0.34 + Math.random() * 0.16,
      age: 0,
      r: 0.5 + Math.random() * 1.1,
      a: 0.16 + z * 0.42
    });
  }
}

function drawSplash() {
  if (!fx.splash.length) return;
  ctx.fillStyle = 'rgba(212,230,255,1)';
  for (let i = fx.splash.length - 1; i >= 0; i--) {
    const s = fx.splash[i];
    s.age += DT;
    if (s.age >= s.life) { fx.splash.splice(i, 1); continue; }
    s.vy += 640 * DT;
    s.x += s.vx * DT;
    s.y += s.vy * DT;
    if (s.y > H) { fx.splash.splice(i, 1); continue; }
    ctx.globalAlpha = s.a * (1 - s.age / s.life);
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/* ---------- 雨 ---------- */
function renderRain(t, cfg) {
  const cx = W / 2, cy = H / 2;
  const sp = fx.sprites;
  // 雷阵雨用阵风做风切变：倾角低频摆动，不是死角度
  const gust = cfg.key === 'storm' ? Math.sin(t * 0.72) * 0.030 + Math.sin(t * 1.9) * 0.012 : 0;
  const ang = rainSlope(t) + gust;
  const cos = Math.cos(ang), sin = Math.sin(ang);
  const M = Math.abs(sin) * H + 80;
  // 风的竖直分量：顺风加速下落、顶风减速
  const wv = windVec();
  const eff = WIND.kmph < 2 ? 0 : WIND.kmph;
  const fall = 1 + (wv.y * eff / 28) * 0.45;

  // 雷阵雨：先把天空压暗，才有"阵雨"的压迫感
  if (cfg.key === 'storm' && sp.cloud) {
    const dw = W * 1.3, dh = dw * 0.41;
    ctx.globalAlpha = 0.55;
    ctx.drawImage(sp.cloud[1], -W * 0.15 + Math.sin(t * 0.06) * W * 0.05, H * 0.04 - dh * 0.5, dw, dh);
    ctx.globalAlpha = 0.45;
    ctx.drawImage(sp.cloud[2], W * 0.12 + Math.cos(t * 0.05) * W * 0.06, H * 0.2 - dh * 0.4, dw * 0.8, dh * 0.8);
    ctx.globalAlpha = 1;
  }

  // 湿空气的那层纱
  if (cfg.veil > 0) {
    ctx.fillStyle = 'rgba(150,172,204,' + cfg.veil + ')';
    ctx.fillRect(0, 0, W, H);
  }

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(ang);
  ctx.translate(-cx, -cy);
  for (const p of fx.parts.rain) {
    p.ly += p.v * fall * DT;
    if (p.ly - M > H) {
      p.ly = -M - Math.random() * 110;
      p.lx = Math.random() * (W + 2 * M) - M;
      p.splashed = false;
    }
    // 把局部坐标换算回屏幕，判断是否触地
    const sy = cy + (p.lx - cx) * sin + (p.ly - cy) * cos;
    if (!p.splashed && sy + p.len * cos >= GROUND() && p.z > cfg.smin) {
      p.splashed = true;
      const sx = cx + (p.lx - cx) * cos - (p.ly - cy) * sin;
      spawnSplash(sx, GROUND(), p.z, cfg);
    }
    ctx.globalAlpha = p.a;
    ctx.drawImage(sp.rain, p.lx - p.w / 2, p.ly, p.w, p.len);
  }
  ctx.globalAlpha = 1;
  ctx.restore();

  // 地面水雾
  if (cfg.mist > 0 && sp.mistRain) {
    ctx.globalAlpha = cfg.mist;
    ctx.fillStyle = sp.mistRain;
    ctx.fillRect(0, H * 0.78, W, H * 0.22);
    ctx.globalAlpha = 1;
  }

  drawSplash();

  // 雷阵雨：闪电（先预亮云层，再压一层全屏白光）
  if (cfg.key === 'storm') {
    fx.nextFlash -= DT * 1000;
    if (fx.nextFlash <= 0) {
      fx.flash = 1;
      fx.nextFlash = 6000 + Math.random() * 8000;
      if (Math.random() < 0.6) fx.bolt = makeBolt();
    }
    if (fx.flash > 0) {
      ctx.fillStyle = 'rgba(168,194,255,' + (0.14 * fx.flash).toFixed(3) + ')';
      ctx.fillRect(0, 0, W, H * 0.55);
      ctx.fillStyle = 'rgba(223,234,255,' + (0.30 * fx.flash).toFixed(3) + ')';
      ctx.fillRect(0, 0, W, H);
      if (fx.bolt) {
        ctx.globalAlpha = Math.min(1, fx.flash * 1.4);
        ctx.strokeStyle = 'rgba(236,244,255,1)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        fx.bolt.forEach((pt, i) => (i ? ctx.lineTo(pt[0], pt[1]) : ctx.moveTo(pt[0], pt[1])));
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      fx.flash = Math.max(0, fx.flash - DT * 3.0);
      if (fx.flash === 0) fx.bolt = null;
    }
  }
}

function makeBolt() {
  const pts = [];
  let x = W * (0.25 + Math.random() * 0.5);
  let y = 0;
  const end = H * (0.42 + Math.random() * 0.25);
  while (y < end) {
    pts.push([x, y]);
    y += H * (0.045 + Math.random() * 0.05);
    x += (Math.random() - 0.5) * W * 0.06;
  }
  pts.push([x, y]);
  return pts;
}

/* ---------- 雪 ---------- */
function renderSnow(t, cfg, mixed) {
  const sp = fx.sprites;
  const w = windVec();
  const effW = WIND.kmph < 2 ? 0 : WIND.kmph * windGust(t);
  // 雪片末速只有 5km/h 左右，同样风速下横飘幅度远超雨；
  // 竖直分量也生效：北风（吹向屏幕下方）压着雪走，南风把雪托起来
  const pushX = w.x * effW * 3.2;
  const pushY = w.y * effW * 1.1;
  const swayK = 1 + effW * 0.05;   // 风越大摆动越急

  if (cfg.veil > 0) {
    ctx.fillStyle = 'rgba(228,238,252,' + cfg.veil + ')';
    ctx.fillRect(0, 0, W, H);
  }

  if (!sp.flake) return;
  for (const p of fx.parts.snow) {
    p.ph += DT * p.sp * swayK;
    p.ly += (p.v + pushY) * DT;
    p.lx += (Math.sin(p.ph) * p.drift + pushX) * DT;
    if (p.ly > H + p.r * 2) {
      p.ly = -p.r * 2;
      p.lx = Math.random() * W;
    }
    if (p.lx < -p.r * 2) p.lx = W + p.r;
    if (p.lx > W + p.r * 2) p.lx = -p.r;
    ctx.globalAlpha = p.a * (0.78 + 0.22 * Math.sin(p.ph * 0.8)) * (mixed ? 0.9 : 1);
    ctx.drawImage(sp.flake, p.lx - p.r, p.ly - p.r, p.r * 2, p.r * 2);
  }
  ctx.globalAlpha = 1;
}

/* ---------- 晴：太阳光晕 + 镜头光晕 ---------- */
// dim：整组光晕的亮度系数。多云时传 0.78 —— 太阳隔着一层薄云，亮但不再刺眼
// 晴天太阳的整体强度（1.1.0）：缩小 + 调暗。原来本体 + 四层光晕太抢眼，
// 壁纸反而成了背景板。所有尺寸都从 base 派生，这两个系数就是总开关。
const SUN_SIZE = 0.78;  // 尺寸：本体、光晕、星芒、光斑链一起缩
const SUN_GLOW = 0.70;  // 亮度：全部图层的 alpha 再乘这一档

function renderSun(t, dim = 1) {
  dim *= SUN_GLOW;
  const sp = fx.sprites;
  const base = Math.min(W, H) * SUN_SIZE;
  const cx = W * 0.5, cy = H * 0.5;
  // 太阳慢慢漂移，幅度小到不会让人分心
  const sx = W * 0.76 + Math.sin(t * 0.105) * W * 0.02;
  const sy = H * 0.17 + Math.cos(t * 0.088) * H * 0.012;
  const breathe = 1 + 0.055 * Math.sin(t * TAU / 6);

  // 光轴跟着风走：目标角由风向算出，再用一阶滤波慢慢靠过去，
  // 这样天气一变，整组光斑是「扫」过去的，不会瞬移
  const ft = flareTarget(sx, sy);
  if (!FLARE.init) { FLARE.ang = ft.ang; FLARE.init = true; }
  let dA = ft.ang - FLARE.ang;
  while (dA > Math.PI) dA -= TAU;
  while (dA < -Math.PI) dA += TAU;
  FLARE.ang += dA * Math.min(1, DT * 2.4);
  FLARE.along = ft.along;

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';

  // ① 四层大气光晕：越外越淡、越外越冷，最外一层铺到 1.05 倍屏高做「空气感」
  const halos = [
    { sp: sp.haloWarm, r: 0.20 * base * breathe, a: 0.46 },
    { sp: sp.haloAmber, r: 0.40 * base * breathe, a: 0.26 },
    { sp: sp.haloTeal, r: 0.74 * base * breathe, a: 0.15 },
    { sp: sp.bloom, r: 1.05 * base * breathe, a: 0.11 }
  ];
  for (const h of halos) {
    ctx.globalAlpha = h.a * dim;
    ctx.drawImage(h.sp, sx - h.r, sy - h.r, h.r * 2, h.r * 2);
  }

  // ①b 两道柔光圈：不是描边，是一圈慢慢散开的光，呼吸节奏比光晕慢一档
  const ringPulse = 1 + 0.03 * Math.sin(t * TAU / 11);
  const rings = [
    { sp: sp.ringWarm, r: 0.30 * base * ringPulse, a: 0.20 },
    { sp: sp.ringCool, r: 0.50 * base * (2 - ringPulse), a: 0.10 }
  ];
  for (const g of rings) {
    ctx.globalAlpha = g.a * dim;
    ctx.drawImage(g.sp, sx - g.r, sy - g.r, g.r * 2, g.r * 2);
  }

  // ② 本体：一颗能看见的点光源
  const dr = 0.115 * base * breathe;
  ctx.globalAlpha = 0.95 * dim;
  ctx.drawImage(sp.disc, sx - dr, sy - dr, dr * 2, dr * 2);

  // ③ 星芒：密而细的一圈柔光射线（原地旋转跟风）。
  //    整体铺到 1.56 倍屏高，最长的两根会一直伸到画面边缘之外。
  const spin = FLARE.ang + t * 0.012;
  const sr = 0.78 * base * (1 + 0.035 * Math.sin(t * TAU / 7));
  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate(spin);
  ctx.globalAlpha = 0.62 * dim * (0.92 + 0.08 * Math.sin(t * 0.7));
  ctx.drawImage(sp.star, -sr, -sr, sr * 2, sr * 2);
  ctx.restore();

  // ④ 光柱 + 光斑链：两者共用同一条光轴，风一吹整组一起扫过去
  const dist = Math.hypot(cx - sx, cy - sy);
  const ax = Math.cos(FLARE.ang), ay = Math.sin(FLARE.ang);
  const nx2 = -ay, ny2 = ax;
  const stretch = 1 + FLARE.along * 0.22;

  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate(FLARE.ang);
  ctx.globalAlpha = 0.30 * dim;
  ctx.drawImage(sp.beam, 0, -base * 0.16, dist * 2.3 * stretch, base * 0.32);
  ctx.restore();

  for (let i = 0; i < FLARE_CHAIN.length; i++) {
    const g = FLARE_CHAIN[i];
    // 每颗都带一点自己的呼吸和横摆，免得像贴纸一样死钉在轴上
    const ph = t * 0.7 + i * 1.37;
    const k = g.k * stretch * (1 + 0.012 * Math.sin(ph));
    const off = g.off + 0.006 * Math.sin(t * 0.33 + i);
    const gx = sx + ax * dist * k + nx2 * off * base;
    const gy = sy + ay * dist * k + ny2 * off * base;
    const rr = g.r * base * (1 + 0.05 * Math.sin(ph * 0.8));
    ctx.globalAlpha = g.a * dim * (0.82 + 0.18 * Math.sin(ph));
    ctx.drawImage(sp[g.sp], gx - rr, gy - rr, rr * 2, rr * 2);
  }

  // ⑤ 横向拉丝：一条蓝白 + 一条更淡的暖白
  ctx.globalAlpha = 0.30 * dim;
  ctx.drawImage(sp.streakBlue, sx - W * 0.29, sy - 3, W * 0.58, 6);
  ctx.globalAlpha = 0.14 * dim;
  ctx.drawImage(sp.streakWarm, sx - W * 0.20, sy - 2, W * 0.40, 4);

  // ⑥ 浮尘：靠近太阳更亮；轻飘飘的，风一吹就斜着走
  const motePush = windPush(t, WIND_GAIN.motes);
  for (const p of fx.parts.sun) {
    p.ph += DT * p.sp;
    p.x += (p.vx + motePush.x) * DT / W;
    p.y += (p.vy + motePush.y) * DT / H;
    if (p.y < -0.02) { p.y = 1.02; p.x = Math.random(); }
    if (p.x < -0.02) p.x = 1.01;
    if (p.x > 1.02) p.x = -0.01;
    const px = p.x * W, py = p.y * H;
    const dx = (px - sx) / W, dy = (py - sy) / H;
    const near = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) * 2.2);
    ctx.globalAlpha = p.a * dim * (0.35 + 0.65 * near) * (0.55 + 0.45 * Math.sin(p.ph));
    ctx.fillStyle = 'rgba(255,238,205,1)';
    ctx.beginPath();
    ctx.arc(px, py, p.r, 0, TAU);
    ctx.fill();
  }

  ctx.restore();
}

/* ---------- 云 / 阴 ---------- */
// 云层速度：方向完全由风的「流向」决定（不是固定往左飘），
// 快慢由各团自身的远近速度 + 风力决定；静风时只留一点极慢的漂移，画面不至于死掉。
function cloudFlow(t, base) {
  if (WIND.kmph < 3) return { x: -base * 0.30, y: 0 };
  const w = windVec();
  const mag = base * (0.70 + 0.50 * Math.min(1.6, WIND.kmph / 22)) * windGust(t);
  return { x: w.x * mag, y: w.y * mag * 0.5 };
}

// 云影：一团一团飘过。3 层速度 + 上重下轻，云是「压」在天空上的
function drawCloudShadow(t, mul = 1) {
  const sp = fx.sprites;
  if (!sp.cloud) return;
  for (const p of fx.parts.cloud) {
    const dw = W * p.w;
    const dh = dw * 0.41;   // 与雪碧图 880×360 的比例一致，不拉伸
    const travel = W + dw;
    const f = cloudFlow(t, p.v);
    p.ph += f.x * DT;
    // 垂直方向做「反射」而不是无限累加：云永远飘不出画面，也不会有回绕的突跳
    p.pv += f.y * DT;
    const lim = H * 0.14;
    if (p.pv > lim) p.pv = lim - (p.pv - lim);
    if (p.pv < -lim) p.pv = -lim + (-lim - p.pv);
    // x 落在 [-dw, W)：完全出画才回绕，不会在边缘突然闪现
    const x = ((p.x * travel + p.ph) % travel + travel) % travel - dw;
    ctx.globalAlpha = p.a * mul;
    ctx.drawImage(sp.cloud[p.s], x, p.y * H - dh * 0.5 + p.pv, dw, dh);
  }
  ctx.globalAlpha = 1;
}

// 云缝透光：亮斑 + 一道向下散的光柱。
// 用 lighter 叠在压光「之后」——光是加在已经压暗的画面上，
// 才像「光从云后面穿过来」；画在云之前会被一起压掉。
function drawGaps(t, mul = 1) {
  const sp = fx.sprites;
  if (!sp.gap) return;
  ctx.globalCompositeOperation = 'lighter';
  for (const p of fx.parts.gaps) {
    const dw = W * p.w;
    const dh = dw * 0.92;
    const travel = W + dw;
    // 云缝跟云层同一支风（略慢一档：缝在更远的云层里）
    p.ph += cloudFlow(t, p.v * 0.8).x * DT;
    const x = ((p.x * travel + p.ph) % travel + travel) % travel - dw;
    const y = p.y * H + Math.sin(t * 0.21 + p.s) * H * 0.012;
    // 呼吸：云在动，缝的宽窄也在变
    const br = 0.72 + 0.28 * Math.sin(t * 0.31 + p.s * 2.1);
    ctx.globalAlpha = p.a * mul * br;
    ctx.drawImage(sp.gap[p.s], x, y - dh * 0.5, dw, dh);

    // 光柱：从缝里往下斜着散开，角度随阵风轻微摆动
    ctx.save();
    ctx.translate(x + dw * 0.5, y);
    ctx.rotate(Math.PI / 2 + 0.18 * Math.sin(t * 0.19 + p.s));
    ctx.globalAlpha = p.a * mul * br * 0.55;
    ctx.drawImage(sp.beam, 0, -dh * 0.16, H * 0.46, dh * 0.32);
    ctx.restore();
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
}

/* ---------- 阴：压光 + 大云影 + 云缝透光 ---------- */
function renderCloud(t) {
  const sp = fx.sprites;

  // 整屏压光：上重下轻——顶部压得狠，接近地平线几乎不压，光从下面透上来。
  if (sp.ovCloud) {
    ctx.fillStyle = sp.ovCloud;
    ctx.fillRect(0, 0, W, H);
  }

  drawCloudShadow(t);
  drawGaps(t);
}

/* ---------- 多云：晴 + 阴 的叠法 ----------
   顺序是关键，叠错就变成「阴天贴了个太阳」：
     ① 薄阴压一层，比阴天轻一半以上，只抽掉晴空那份刺眼的通透
     ② 云影铺在太阳「后面」—— 薄云被太阳从背后照透，所以云在光晕下层
     ③ 太阳全套照旧，只是整体收一档亮度
     ④ 云缝光柱用 lighter 补在最上层
   这样云飘到太阳位置时明暗自然交替，不需要额外的遮罩动画。 */
function renderPartly(t) {
  const sp = fx.sprites;
  if (sp.ovPartly) {
    ctx.fillStyle = sp.ovPartly;
    ctx.fillRect(0, 0, W, H);
  }
  drawCloudShadow(t, 1);
  renderSun(t, 0.80);
  drawGaps(t, 0.90);
}

/* ---------- 雾 ---------- */
function renderFog(t) {
  const sp = fx.sprites;
  // 底部雾堤：越靠下越白，让雾有"落地"的感觉
  if (sp.bankFog) {
    ctx.fillStyle = sp.bankFog;
    ctx.fillRect(0, H * 0.55, W, H * 0.45);
  }

  const push = windPush(t, WIND_GAIN.fog);
  for (const p of fx.parts.fog) {
    const dw = W * p.w;
    const dh = dw * 0.58;
    const travel = W + dw;
    if (p.ph2 === null) p.ph2 = t * p.v;
    p.ph2 += (p.v + push.x) * DT;
    p.pv += push.y * 0.5 * DT;
    const x = ((p.x * travel + p.ph2) % travel + travel) % travel - dw;
    const y = p.y * H + Math.sin(t * 0.25 + p.ph) * H * 0.012 + p.pv;
    ctx.globalAlpha = p.a;
    ctx.drawImage(sp.fog[p.s], x, y - dh * 0.5, dw, dh);
  }
  ctx.globalAlpha = 1;
}

/* ---------- 霾 ---------- */
function renderHaze(t) {
  const sp = fx.sprites;
  const breathe = 0.86 + 0.14 * Math.sin(t * TAU / 18);

  // ① 全屏暖褐 tint：这是「霾」和「雾」最本质的差别，颜色不是白的
  if (sp.tintHaze) {
    ctx.globalAlpha = 0.30 * breathe;
    ctx.fillStyle = sp.tintHaze;
    ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 1;
  }

  // ② 三条横向浑浊带：跟着风极慢地挪（霾是「糊住」的，动得比雾慢得多）
  const push = windPush(t, WIND_GAIN.hazeBand);
  for (const p of fx.parts.haze) {
    if (!p.band) continue;
    const dw = W * p.w;
    const dh = dw * 0.20;
    const travel = W + dw;
    if (p.ph2 === null) p.ph2 = t * p.v;
    p.ph2 += (p.v + push.x) * DT;
    const x = ((p.x * travel + p.ph2) % travel + travel) % travel - dw;
    ctx.globalAlpha = p.a * breathe;
    ctx.drawImage(sp.haze[p.s], x, p.y * H - dh * 0.5, dw, dh);
  }

  // ③ 悬浮颗粒：霾的"脏"感主要来自这些闪烁的小点；最轻，几乎 1:1 跟着风走
  const dpush = windPush(t, WIND_GAIN.dust);
  ctx.fillStyle = 'rgba(226,198,146,1)';
  for (const p of fx.parts.haze) {
    if (p.band) continue;
    p.x += (p.vx + dpush.x) * DT / W;
    p.y += (p.vy + dpush.y * 0.6) * DT / H;
    if (p.x < 0) p.x = 1;
    if (p.x > 1) p.x = 0;
    if (p.y < 0) p.y = 1;
    if (p.y > 1) p.y = 0;
    ctx.globalAlpha = p.a * (0.35 + 0.65 * Math.abs(Math.sin(t * p.sp + p.ph)));
    ctx.beginPath();
    ctx.arc(p.x * W, p.y * H, p.r, 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/* ---------- 主循环：30fps ---------- */
function fxLoop(ts) {
  if (!fx.running) return;
  fx.raf = requestAnimationFrame(fxLoop);
  if (ts - fx.lastTs < fx.frameMs) return; // 锁帧：省下来的电是实打实的
  const dt = Math.min(0.06, (ts - fx.lastTs) / 1000 || 0.016);
  fx.lastTs = ts;
  fx.t += dt;
  fxDraw(dt);
}

function fxDraw(dt) {
  if (!ctx || !fx.parts) return;
  W = fx.w;
  H = fx.h;
  DT = dt;
  fxWind();

  ctx.clearRect(0, 0, W, H);

  const spec = fx.builtKind;
  const [kind, lvStr] = spec.split(':');
  const lv = Number(lvStr || 0);

  if (kind === 'sun') renderSun(fx.t);
  else if (kind === 'partly') renderPartly(fx.t);
  else if (kind === 'cloud') renderCloud(fx.t);
  else if (kind === 'fog') renderFog(fx.t);
  else if (kind === 'haze') renderHaze(fx.t);
  else if (kind === 'rain') renderRain(fx.t, RAIN_LV[lv]);
  else if (kind === 'snow') {
    if (lv === 3) {
      // 雨夹雪 = 细雨与雪同行
      renderRain(fx.t, RAIN_LV[0]);
      renderSnow(fx.t, SNOW_LV[3], true);
    } else {
      renderSnow(fx.t, SNOW_LV[lv], false);
    }
  }
}
