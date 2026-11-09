// 日程与待办的统一读取入口。
// 今日面板和大日历都从这里取数；ICS 订阅源也在这里汇入，渲染层零改动。
import { state } from '../core/state.js';
import { expandOccurrences } from './ics.js';

export function isoOf(d) {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${dd}`;
}

export function todayIso() { return isoOf(new Date()); }

function addDaysIso(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return isoOf(dt);
}

/* ---------- 订阅源 ---------- */

// RRULE 展开结果缓存：键是 item 对象本身，同步后 items 被整体替换，缓存自然失效
const occCache = new WeakMap();
const CACHE_BACK_DAYS = 730;   // 往前 2 年（覆盖大日历回顾）
const CACHE_FWD_DAYS = 1095;   // 往后 3 年

function occursOn(item, iso) {
  if (!item.rrule) return item.date === iso;
  let set = occCache.get(item);
  if (!set) {
    const today = todayIso();
    set = new Set(expandOccurrences(item, addDaysIso(today, -CACHE_BACK_DAYS), addDaysIso(today, CACHE_FWD_DAYS)));
    occCache.set(item, set);
  }
  if (set.has(iso)) return true;
  // 缓存窗口之外：只针对查询日现算，避免为远期日期重建整段
  return expandOccurrences(item, iso, iso).includes(iso);
}

// 订阅事件的内容在本机缓存里（state.data.calfeeds），配置在 state.data.feeds。
// 这里直接读 state 而不 import calfeed.js：calfeed → calendar → agenda 已经是一条链，
// 反向再 import 就成环了。
function feedItemsOf(iso) {
  const out = [];
  const runtime = state.data.calfeeds || {};
  for (const f of (state.data.feeds || [])) {
    if (!f || f.kind !== 'ics') continue;
    const items = runtime[f.id]?.items;
    if (!Array.isArray(items)) continue;
    for (const it of items) {
      if (!occursOn(it, iso)) continue;
      out.push({ ...it, kind: 'feed-event', feedId: f.id, feedName: f.title, color: f.color });
    }
  }
  return out;
}

/* ---------- 基础读取 ---------- */

// 本地日程（某日期）
function localEventsOf(iso) {
  return (state.data.events || [])
    .filter((e) => e.date === iso)
    .slice()
    .sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));
}

// 本地待办（某日期）
function localTodosOf(iso) {
  return (state.data.todos || []).filter((t) => t.date === iso);
}

// 面板规则：未完成待办跨天累积
function visibleTodos(today = todayIso()) {
  return (state.data.todos || [])
    .filter((t) => !t.done && (!t.date || t.date <= today))
    .slice()
    .sort((a, b) => (a.date || '0000-00-00').localeCompare(b.date || '0000-00-00'));
}

/* ---------- 对外导出 ---------- */

// 某天的所有「日程」（本地 + 订阅），按时间升序
export function eventsOf(iso) {
  const feeds = feedItemsOf(iso)
    .sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));
  return [...localEventsOf(iso), ...feeds];
}

// 某天安排了日期的待办
export function todosOf(iso) { return localTodosOf(iso); }

// 大日历侧栏
export function dayItems(iso) { return { events: eventsOf(iso), todos: todosOf(iso) }; }

// 今日面板
export function todayItems() { return { events: eventsOf(todayIso()), todos: visibleTodos() }; }
