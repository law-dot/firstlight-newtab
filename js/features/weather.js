// 天气卡片 + 天气动效（雨雪雾晴多云 canvas 粒子）
import { state, persist } from '../core/state.js';
import { $, fetchWithTimeout, toast } from '../core/utils.js';

export const WEATHER_TTL = 2 * 60 * 60 * 1000;

// WWO 天气代码 → [中文描述, 图标类型]
const WX_CODES = {
  113: ['晴', 'sun'],
  116: ['多云', 'cloudSun'],
  119: ['阴', 'cloud'],
  122: ['阴', 'cloud'],
  143: ['薄雾', 'fog'],
  149: ['霾', 'fog'],
  248: ['雾', 'fog'],
  260: ['冻雾', 'fog'],
  176: ['局部有雨', 'rain'],
  263: ['毛毛雨', 'rain'],
  266: ['毛毛雨', 'rain'],
  293: ['小雨', 'rain'],
  296: ['小雨', 'rain'],
  299: ['中雨', 'rain'],
  302: ['中雨', 'rain'],
  305: ['大雨', 'rain'],
  308: ['大雨', 'rain'],
  353: ['小阵雨', 'rain'],
  356: ['阵雨', 'rain'],
  359: ['暴雨', 'rain'],
  179: ['局部雨夹雪', 'snow'],
  182: ['雨夹雪', 'snow'],
  185: ['冻毛毛雨', 'snow'],
  227: ['吹雪', 'snow'],
  230: ['暴风雪', 'snow'],
  311: ['冻雨', 'snow'],
  314: ['冻雨', 'snow'],
  317: ['雨夹雪', 'snow'],
  320: ['雨夹雪', 'snow'],
  323: ['小雪', 'snow'],
  326: ['小雪', 'snow'],
  329: ['中雪', 'snow'],
  332: ['中雪', 'snow'],
  335: ['大雪', 'snow'],
  338: ['大雪', 'snow'],
  350: ['冰粒', 'snow'],
  362: ['雨夹雪', 'snow'],
  365: ['雨夹雪', 'snow'],
  368: ['小阵雪', 'snow'],
  371: ['阵雪', 'snow'],
  374: ['冰粒', 'snow'],
  377: ['冰粒', 'snow'],
  200: ['雷阵雨', 'thunder'],
  386: ['雷阵雨', 'thunder'],
  389: ['雷雨', 'thunder'],
  392: ['雷雪', 'thunder'],
  395: ['雷雪', 'thunder']
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

export function bindWeather() {
  $('#weather').addEventListener('click', () => {
    toast('正在刷新天气…');
    refreshWeather(true);
  });

  $('#weatherCity').addEventListener('change', (e) => {
    state.data.settings.weatherCity = e.target.value.trim();
    state.data.settings.weather = null;
    persist();
    refreshWeather(true);
  });
}

export async function refreshWeather(force = false) {
  const cached = state.data.settings.weather;
  if (!force && cached?.fetchedAt && Date.now() - cached.fetchedAt < WEATHER_TTL) {
    renderWeather(cached, false);
    return;
  }

  const city = (state.data.settings.weatherCity || '').trim();
  const url = city
    ? `https://wttr.in/${encodeURIComponent(city)}?format=j1&lang=zh`
    : 'https://wttr.in/?format=j1&lang=zh';

  try {
    const res = await fetchWithTimeout(url, 12000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const cur = json.current_condition?.[0] || {};
    const area = json.nearest_area?.[0] || {};
    const today = json.weather?.[0] || {};
    const next = {
      fetchedAt: Date.now(),
      city: city || area.areaName?.[0]?.value || '本地',
      temp: Number(cur.temp_C),
      code: Number(cur.weatherCode),
      desc: cur.lang_zh?.[0]?.value || cur.weatherDesc?.[0]?.value || '',
      feels: Number(cur.FeelsLikeC),
      humidity: Number(cur.humidity),
      wind: Number(cur.windspeedKmph),
      high: Number(today.maxtempC),
      low: Number(today.mintempC)
    };
    state.data.settings.weather = next;
    persist();
    renderWeather(next, false);
  } catch (err) {
    console.warn('天气获取失败', err);
    if (cached) {
      renderWeather(cached, true);
    } else {
      $('#wxIcon').innerHTML = WX_ICONS.cloud;
      $('#wxTemp').textContent = '--°';
      $('#wxDesc').textContent = '获取失败';
      $('#wxCity').textContent = '点击重试';
      $('#wxRange').textContent = '';
      $('#weather').classList.remove('is-stale');
      $('#weather').title = '天气获取失败，点击重试';
    }
  }
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
  if (Number.isFinite(w.wind)) extra.push(`风速 ${Math.round(w.wind)} km/h`);
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

/* ================= 天气动效 ================= */
const FX_KINDS = {
  sun: 'sun',
  cloudSun: 'cloud',
  cloud: 'cloud',
  fog: 'fog',
  rain: 'rain',
  snow: 'snow',
  thunder: 'thunder'
};

export const fx = {
  canvas: null,
  ctx: null,
  raf: 0,
  running: false,
  kind: '',
  builtKind: '',
  w: 0,
  h: 0,
  parts: [],
  flash: 0,
  nextFlash: 0,
  last: 0
};

function fxActive() {
  const mode = state.data.settings.fxMode || 'idle';
  if (mode === 'off') return false;
  return mode === 'always' ? true : state.idleActive;
}

function fxKind() {
  const code = state.data.settings.weather?.code;
  if (code === undefined || code === null) return '';
  const mapped = WX_CODES[Number(code)];
  return FX_KINDS[mapped?.[1]] || '';
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
  fxSize();
  fx.running = true;
  fx.last = 0;
  fx.raf = requestAnimationFrame(fxLoop);
}

export function fxStop() {
  if (fx.raf) cancelAnimationFrame(fx.raf);
  fx.raf = 0;
  fx.running = false;
  fx.builtKind = '';
  fx.parts = [];
  if (fx.ctx) fx.ctx.clearRect(0, 0, fx.w, fx.h);
}

export function fxSize() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  fx.w = window.innerWidth;
  fx.h = window.innerHeight;
  fx.canvas.width = Math.round(fx.w * dpr);
  fx.canvas.height = Math.round(fx.h * dpr);
  fx.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

export function fxBuild(kind) {
  const rnd = (a, b) => a + Math.random() * (b - a);
  const scale = Math.max(0.6, Math.min(1.5, (fx.w * fx.h) / 1300000));
  const parts = [];

  if (kind === 'rain' || kind === 'thunder') {
    const n = Math.round(150 * scale);
    for (let i = 0; i < n; i++) {
      parts.push({
        x: rnd(-0.15, 1.15) * fx.w,
        y: rnd(-1, 1) * fx.h,
        len: rnd(16, 34),
        v: rnd(520, 880),
        a: rnd(0.22, 0.5)
      });
    }
  } else if (kind === 'snow') {
    const n = Math.round(105 * scale);
    for (let i = 0; i < n; i++) {
      parts.push({
        x: rnd(0, 1) * fx.w,
        y: rnd(-1, 1) * fx.h,
        r: rnd(1.8, 3.8),
        v: rnd(30, 60),
        drift: rnd(10, 26),
        ph: rnd(0, 6.28),
        a: rnd(0.55, 0.95)
      });
    }
  } else if (kind === 'fog') {
    // 雾 / 霾：缓慢横移的团状雾影
    for (let i = 0; i < 7; i++) {
      parts.push({
        x: rnd(-0.4, 1.1) * fx.w,
        y: rnd(0.04, 0.62) * fx.h,
        r: rnd(180, 360),
        v: rnd(4, 11) * (Math.random() < 0.5 ? -1 : 1),
        a: rnd(0.1, 0.18)
      });
    }
  } else if (kind === 'sun') {
    for (let i = 0; i < 34; i++) {
      parts.push({
        x: rnd(0, 1) * fx.w,
        y: rnd(0, 1) * fx.h,
        r: rnd(1.2, 3.2),
        vx: rnd(-6, 6),
        vy: rnd(-14, -4),
        ph: rnd(0, 6.28),
        a: rnd(0.3, 0.7)
      });
    }
  } else {
    // 多云 / 阴：不使用粒子，绘制阶段直接生成左右流动的半幅阴影
  }

  fx.parts = parts;
  fx.builtKind = kind;
  fx.flash = 0;
  fx.nextFlash = 4000 + Math.random() * 6000;
}

function fxLoop(ts) {
  if (!fx.running) return;
  const dt = fx.last ? Math.min(0.05, (ts - fx.last) / 1000) : 0.016;
  fx.last = ts;
  fxDraw(dt);
  fx.raf = requestAnimationFrame(fxLoop);
}

/* 晴天：摄影镜头耀斑（光晕 + 星芒 + 拉丝 + 六边形鬼影） */
function drawSunFlare(ctx, w, h, time) {
  const sx = w * 0.78;
  const sy = h * 0.15;
  const cx = w * 0.5;
  const cy = h * 0.5;
  const pulse = 0.86 + 0.14 * Math.sin(time * 0.6);

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';

  const core = ctx.createRadialGradient(sx, sy, 0, sx, sy, Math.max(w, h) * 0.42);
  core.addColorStop(0, `rgba(255, 238, 205, ${0.5 * pulse})`);
  core.addColorStop(0.12, `rgba(255, 206, 140, ${0.22 * pulse})`);
  core.addColorStop(0.4, 'rgba(255, 180, 110, 0.06)');
  core.addColorStop(1, 'rgba(255, 180, 110, 0)');
  ctx.fillStyle = core;
  ctx.fillRect(0, 0, w, h);

  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate(time * 0.02);
  for (let i = 0; i < 10; i++) {
    ctx.rotate((Math.PI * 2) / 10);
    const len =
      (i % 2 ? 0.26 : 0.42) *
      Math.min(w, h) *
      (0.9 + 0.1 * Math.sin(time * 1.3 + i));
    const ray = ctx.createLinearGradient(0, 0, len, 0);
    ray.addColorStop(0, `rgba(255, 238, 205, ${0.2 * pulse})`);
    ray.addColorStop(1, 'rgba(255, 238, 205, 0)');
    ctx.fillStyle = ray;
    ctx.beginPath();
    ctx.moveTo(0, -2.2);
    ctx.lineTo(len, 0);
    ctx.lineTo(0, 2.2);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();

  const streak = ctx.createLinearGradient(sx - w * 0.5, 0, sx + w * 0.5, 0);
  streak.addColorStop(0, 'rgba(255, 214, 160, 0)');
  streak.addColorStop(0.45, `rgba(255, 226, 180, ${0.16 * pulse})`);
  streak.addColorStop(0.55, `rgba(255, 226, 180, ${0.16 * pulse})`);
  streak.addColorStop(1, 'rgba(255, 214, 160, 0)');
  ctx.fillStyle = streak;
  ctx.fillRect(sx - w * 0.5, sy - 1.6, w, 3.2);

  const ghosts = [
    { k: 0.35, r: 26, c: '255, 190, 120', a: 0.1 },
    { k: 0.62, r: 54, c: '255, 210, 150', a: 0.08, hex: true },
    { k: 0.9, r: 18, c: '150, 220, 255', a: 0.09 },
    { k: 1.18, r: 96, c: '255, 180, 210', a: 0.05, hex: true },
    { k: 1.5, r: 34, c: '120, 210, 255', a: 0.07 },
    { k: 1.82, r: 130, c: '255, 225, 170', a: 0.035, hex: true },
    { k: 2.1, r: 22, c: '190, 235, 200', a: 0.05 }
  ];

  ghosts.forEach((g, i) => {
    const px = sx + (cx - sx) * g.k + Math.sin(time * 0.4 + i) * 3;
    const py = sy + (cy - sy) * g.k + Math.cos(time * 0.35 + i) * 3;
    const alpha = g.a * (0.75 + 0.25 * Math.sin(time * 0.9 + i * 1.7));
    const grad = ctx.createRadialGradient(px, py, 0, px, py, g.r);
    grad.addColorStop(0, `rgba(${g.c}, ${alpha})`);
    grad.addColorStop(0.7, `rgba(${g.c}, ${alpha * 0.35})`);
    grad.addColorStop(1, `rgba(${g.c}, 0)`);
    ctx.fillStyle = grad;

    if (g.hex) {
      ctx.beginPath();
      for (let j = 0; j < 6; j++) {
        const ang = (Math.PI / 3) * j + time * 0.05;
        const rr = g.r * 0.8;
        const x = px + Math.cos(ang) * rr;
        const y = py + Math.sin(ang) * rr;
        if (j === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = `rgba(${g.c}, ${alpha * 0.6})`;
      ctx.lineWidth = 1;
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(px, py, g.r, 0, Math.PI * 2);
      ctx.fill();
    }
  });

  ctx.restore();
}

function fxDraw(dt) {
  const ctx = fx.ctx;
  if (!ctx) return;
  ctx.clearRect(0, 0, fx.w, fx.h);
  const kind = fx.builtKind;

  if (kind === 'sun') {
    drawSunFlare(ctx, fx.w, fx.h, performance.now() / 1000);
    for (const p of fx.parts) {
      p.ph += dt * 0.8;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.y < -10) {
        p.y = fx.h + 10;
        p.x = Math.random() * fx.w;
      }
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, 226, 170, ${p.a * (0.6 + 0.4 * Math.sin(p.ph))})`;
      ctx.fill();
    }
    return;
  }

  if (kind === 'cloud') {
    const t = performance.now() / 1000;
    const bandWidth = fx.w * 0.55;
    const travel = fx.w + bandWidth * 2;
    const x = ((t * 26) % travel) - bandWidth;
    const dark = 'rgba(6, 10, 18, 0.34)';

    const band = ctx.createLinearGradient(x, 0, x + bandWidth, 0);
    band.addColorStop(0, 'rgba(6, 10, 18, 0)');
    band.addColorStop(0.22, dark);
    band.addColorStop(0.78, dark);
    band.addColorStop(1, 'rgba(6, 10, 18, 0)');
    ctx.fillStyle = band;
    ctx.fillRect(x, 0, bandWidth, fx.h);
    return;
  }

  if (kind === 'fog') {
    for (const p of fx.parts) {
      p.x += p.v * dt;
      if (p.x < -p.r * 2) p.x = fx.w + p.r;
      if (p.x > fx.w + p.r * 2) p.x = -p.r;
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
      g.addColorStop(0, `rgba(255, 255, 255, ${p.a})`);
      g.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
    return;
  }

  if (kind === 'snow') {
    for (const p of fx.parts) {
      p.ph += dt * 0.6;
      p.y += p.v * dt;
      p.x += Math.sin(p.ph) * p.drift * dt;
      if (p.y > fx.h + 6) {
        p.y = -6;
        p.x = Math.random() * fx.w;
      }
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, 255, 255, ${p.a})`;
      ctx.fill();
    }
    return;
  }

  if (kind === 'rain' || kind === 'thunder') {
    ctx.lineWidth = 1.4;
    ctx.lineCap = 'round';
    for (const p of fx.parts) {
      p.y += p.v * dt;
      p.x += p.v * 0.14 * dt;
      if (p.y > fx.h + 40) {
        p.y = -40;
        p.x = Math.random() * fx.w * 1.2;
      }
      ctx.strokeStyle = `rgba(196, 220, 255, ${p.a})`;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x - p.len * 0.14, p.y + p.len);
      ctx.stroke();
    }
    if (kind === 'thunder') {
      fx.nextFlash -= dt * 1000;
      if (fx.nextFlash <= 0) {
        fx.flash = 1;
        fx.nextFlash = 5000 + Math.random() * 8000;
      }
      if (fx.flash > 0) {
        ctx.fillStyle = `rgba(221, 232, 255, ${0.3 * fx.flash})`;
        ctx.fillRect(0, 0, fx.w, fx.h);
        fx.flash = Math.max(0, fx.flash - dt * 3.2);
      }
    }
  }
}
