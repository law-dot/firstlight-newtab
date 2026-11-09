// 城市名 → 经纬度。只做这一件事，不做任何「自动猜用户在哪儿」。
//
// 为什么不全交给 Open-Meteo 的 geocoding：
//   它对中国城市的匹配并不可靠（实测「长沙」匹配到重庆某地、「青岛」匹配到辽宁、
//   「厦门」「娄底」直接查不到）。中文城市名走内置坐标表是离线、确定、免费的。
//
// 顺序：中文城市表 → Open-Meteo geocoding（兜底，照顾国外城市）
// 城市留空时调用方根本不会走到这里 —— 不猜、不按 IP 定位、不发任何请求。

import { CN_CITIES } from '../data/cities-cn.js';
import { fetchWithTimeout } from '../core/utils.js';

const DEFAULT_TZ = 'Asia/Shanghai';
const KEYS = Object.keys(CN_CITIES);

/* 在内置表里找城市。支持这几种写法（都是实测过的）：
     长沙     → 长沙 28.23,112.95（不带「市」也认，中文习惯不加后缀）
     长沙市   → 长沙（表里存的是哪个就返回哪个）
     浦东     → 浦东新区 31.23,121.55（前缀命中取最短的；等长时「市」优先，
                所以「长沙」不会落到「长沙县」）
     海南     → 海南省（省名也在表里）
   注意歧义地名认的是表里的同名项：「朝阳」是辽宁朝阳市，不是北京朝阳区。 */
export function lookupCN(raw) {
  const q = String(raw || '').trim().replace(/\s+/g, '');
  if (!q) return null;

  if (CN_CITIES[q]) return pack(q, CN_CITIES[q]);
  if (CN_CITIES[q + '市']) return pack(q + '市', CN_CITIES[q + '市']);
  // 反过来：用户打了「长沙市」，表里只有「长沙」（不会发生，但防御一下）
  if (q.endsWith('市') && CN_CITIES[q.slice(0, -1)]) {
    return pack(q.slice(0, -1), CN_CITIES[q.slice(0, -1)]);
  }

  // 前缀命中：'长沙' → '长沙市'(3) 优先于 '长沙县'(3)，等长时「市」优先
  const hits = KEYS.filter((k) => k.startsWith(q));
  if (hits.length) {
    hits.sort((a, b) => a.length - b.length || (b.endsWith('市') ? 1 : 0) - (a.endsWith('市') ? 1 : 0));
    return pack(hits[0], CN_CITIES[hits[0]]);
  }
  return null;
}

function pack(name, xy) {
  return { lat: xy[0], lon: xy[1], name: name.replace(/市$/, '') || name, tz: DEFAULT_TZ };
}

/* 解析一个城市名：内置表优先，查不到再问 Open-Meteo（国外城市走这条路）
   入参来自设置里的输入框，留空调用方已拦掉；这里再防一层，返回 null。 */
export async function locateCity(raw) {
  const hit = lookupCN(raw);
  if (hit) return hit;

  const q = String(raw || '').trim();
  if (!q) return null;
  const url = 'https://geocoding-api.open-meteo.com/v1/search'
    + `?name=${encodeURIComponent(q)}&count=5&language=zh&format=json`;
  const res = await fetchWithTimeout(url, 8000);
  if (!res.ok) throw new Error(`geocoding HTTP ${res.status}`);
  const json = await res.json();
  const list = json.results || [];
  if (!list.length) return null;
  // 同名地点取人口最多的那个（Open-Meteo 的排序不可靠）
  const best = list.reduce((a, b) => ((b.population || 0) > (a.population || 0) ? b : a), list[0]);
  return {
    lat: best.latitude,
    lon: best.longitude,
    name: best.name,
    tz: best.timezone || DEFAULT_TZ
  };
}
