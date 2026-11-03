// 日程与待办的统一读取入口。
// 今日面板和大日历都从这里取数；ICS 订阅源也在这里汇入，渲染层零改动。
import { state } from '../core/state.js';

export function isoOf(d) {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${dd}`;
}

export function todayIso() { return isoOf(new Date()); }

/* ---------- 订阅源 ---------- */

function listFeedItems() {
  const all = [];
  for (const f of (state.data.feeds || [])) {
    if (!f || !Array.isArray(f.items)) continue;
    for (const it of f.items) {
      all.push({ ...it, kind: 'feed-event', feedId: f.id, feedName: f.name, color: f.color });
    }
  }
  return all;
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
  const feeds = listFeedItems()
    .filter((i) => i.date === iso)
    .sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));
  return [...localEventsOf(iso), ...feeds];
}

// 某天安排了日期的待办
export function todosOf(iso) { return localTodosOf(iso); }

// 大日历侧栏
export function dayItems(iso) { return { events: eventsOf(iso), todos: todosOf(iso) }; }

// 今日面板
export function todayItems() { return { events: eventsOf(todayIso()), todos: visibleTodos() }; }
