// 待办栏：圆形图标 / 常驻右侧 / 隐藏 三形态
// v1.2 起面板改为单日视图：顶部撕页日历卡，中间那天日程时间轴，底部待办
// 1.3.1：日历卡加左右翻页，可查看前后任意一天；今天仍按「未完成跨天累积」，
//        翻到别的日子则看那天的日程与当天安排的待办（含已完成，可勾回未完成）
import { state, persist } from '../core/state.js';
import { $, $$, toast } from '../core/utils.js';
import { uid } from '../core/store.js';
import { todayIso, todayItems, dayItems } from './agenda.js';
import { getLunar } from './lunar.js';

/* ---------- 单日视图 ----------
   viewIso 为 null 时跟随「今天」；一旦翻页就钉在那个日期，
   点「回到今天」才回到跟随模式。时间轴、订阅边注、待办区都跟着看的那天走。 */
let viewIso = null;

function isoOfDate(d) {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${dd}`;
}

function shiftDay(n) {
  const [y, m, d] = (viewIso || todayIso()).split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  viewIso = isoOfDate(dt);
  renderTodo();
}

export function applyTodoMode() {
  const mode = state.data.settings.todoMode || 'fab';
  document.body.classList.toggle('todo-mode-docked', mode === 'docked');
  document.body.classList.toggle('todo-mode-hidden', mode === 'hidden');
  if (mode !== 'fab') closeTodo();

  // 面板挂到对应容器：常驻 → 内容区右侧；其余 → 搜索行内做下拉
  const todo = $('#todoPanel');
  const host = mode === 'docked' ? $('.content') : $('.search-row');
  if (todo.parentElement !== host) host.appendChild(todo);
}

function openTodo() {
  if ((state.data.settings.todoMode || 'fab') !== 'fab') return;
  document.body.classList.add('todo-open');
  $('#todoFab').classList.add('active');
  viewIso = null; // 重新打开先回今天，不把上次翻到的日期带进来
  renderTodo(); // 打开时刷新：跨天后时间轴和日期头要更新
}

export function closeTodo() {
  document.body.classList.remove('todo-open');
  $('#todoFab').classList.remove('active');
  hideAddForm();
}

const WEEKDAYS = '日一二三四五六';

// 撕页日历卡：年月 / 大日期 / 星期 / 农历，双休日红字（老挂历的规矩）
// 底部「订阅边注」：今日订阅事件最多列 2 条，超出显示 +N；点击跳到时间轴对应项
function renderCalCard(events = []) {
  const today = todayIso();
  const now = viewIso
    ? (() => { const [y, m, d] = viewIso.split('-').map(Number); return new Date(y, m - 1, d); })()
    : new Date();
  $('#todoCalYm').textContent = `${now.getFullYear()} 年 ${now.getMonth() + 1} 月`;
  $('#todoCalDay').textContent = String(now.getDate());
  $('#todoCalWk').textContent = `星期${WEEKDAYS[now.getDay()]}`;
  const weekend = now.getDay() === 0 || now.getDay() === 6;
  $('#todoCalDay').classList.toggle('weekend', weekend);
  $('#todoCalBack').hidden = isoOfDate(now) === today;
  const lunar = getLunar(now);
  const lunarEl = $('#todoCalLunar');
  if (lunar) {
    lunarEl.hidden = false;
    lunarEl.textContent = lunar.festival ? `${lunar.text} · ${lunar.festival}` : lunar.text;
  } else {
    lunarEl.hidden = true;
  }

  // 订阅边注：只做索引，完整信息（时间 / 标题 / 来源 / 地点）留在时间轴
  const MAX_NOTE = 2;
  const feeds = events.filter((e) => e.kind === 'feed-event');
  const box = $('#todoCalFeeds');
  const list = $('#todoCalFeedList');
  const more = $('#todoCalFeedMore');
  list.textContent = '';
  box.hidden = feeds.length === 0;
  if (!feeds.length) return;

  feeds.slice(0, MAX_NOTE).forEach((ev) => {
    const li = document.createElement('li');
    li.dataset.idx = String(events.indexOf(ev));
    li.title = [ev.feedName || '订阅', ev.time || '全天', ev.text, ev.location].filter(Boolean).join(' · ');

    const dot = document.createElement('i');
    dot.className = 'dot';
    dot.style.background = ev.color || '#888';

    const time = document.createElement('span');
    time.className = 't';
    time.textContent = ev.time || '全天';

    const name = document.createElement('span');
    name.className = 'n';
    name.textContent = ev.text;

    li.append(dot, time, name);
    li.onclick = () => jumpToTimeline(Number(li.dataset.idx));
    list.append(li);
  });

  const extra = feeds.length - MAX_NOTE;
  more.hidden = extra <= 0;
  if (extra > 0) {
    more.textContent = `+${extra} 条`;
    more.onclick = () => jumpToTimeline(events.indexOf(feeds[MAX_NOTE]));
  }
}

// 从日历卡跳到时间轴对应项并闪一下
function jumpToTimeline(idx) {
  const li = document.querySelectorAll('#todoTimeline li')[idx];
  if (!li) return;
  li.scrollIntoView({ block: 'center', behavior: 'smooth' });
  li.classList.add('flash');
  setTimeout(() => li.classList.remove('flash'), 1200);
}

export function renderTodo() {
  const today = todayIso();
  const iso = viewIso || today;
  const isToday = iso === today;
  // 今天走累积规则（未完成跨天顺延）；别的日子就看那天安排了什么的待办（含已完成）
  const items = isToday ? todayItems() : dayItems(iso);
  const events = items.events;
  renderCalCard(events);
  const timeline = $('#todoTimeline');
  timeline.textContent = '';
  timeline.hidden = events.length === 0;
  events.forEach((ev) => {
    const li = document.createElement('li');
    if (ev.kind === 'feed-event') li.classList.add('feed-item');

    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = ev.time || '全天';

    // 订阅事件：加色点 + 来源标签，不能删除
    if (ev.kind === 'feed-event') {
      const dot = document.createElement('i');
      dot.className = 'feed-dot';
      dot.style.background = ev.color || '#888';
      dot.title = ev.feedName || '订阅';
      const text = document.createElement('span');
      text.className = 'text';
      text.textContent = ev.text;
      const tag = document.createElement('span');
      tag.className = 'feed-tag';
      tag.textContent = ev.feedName || '订阅';
      li.append(time, dot, text, tag);
    } else {
      const text = document.createElement('span');
      text.className = 'text';
      text.textContent = ev.text;
      const rm = document.createElement('button');
      rm.className = 'del';
      rm.type = 'button';
      rm.textContent = '✕';
      rm.title = '删除日程';
      rm.onclick = () => {
        state.data.events = (state.data.events || []).filter((e) => e.id !== ev.id);
        persist();
        renderTodo();
      };
      li.append(time, text, rm);
    }

    timeline.append(li);
  });

  // 待办区：未完成（含跨天累积）
  const todos = items.todos;
  const section = $('#todoSection');
  const list = $('#todoList');
  list.textContent = '';
  section.hidden = todos.length === 0;
  todos.forEach((todo) => {
    const li = document.createElement('li');
    li.classList.toggle('done', !!todo.done);

    const check = document.createElement('button');
    check.className = 'check';
    check.type = 'button';
    check.textContent = todo.done ? '✓' : '';
    check.title = todo.done ? '标记为未完成' : '完成';
    check.onclick = () => {
      todo.done = !todo.done;
      persist();
      renderTodo();
    };

    const text = document.createElement('span');
    text.className = 'text';
    text.textContent = todo.text;

    const del = document.createElement('button');
    del.className = 'del';
    del.type = 'button';
    del.textContent = '✕';
    del.title = '删除';
    del.onclick = () => {
      state.data.todos = state.data.todos.filter((t) => t.id !== todo.id);
      persist();
      renderTodo();
    };

    li.append(check, text, del);
    list.append(li);
  });

  // 两者都空：只显示空态一句话（看哪天就说哪天）
  const empty = $('#todoEmpty');
  empty.textContent = isToday ? '今天没有安排' : '这一天没有安排';
  empty.hidden = events.length > 0 || todos.length > 0;

  const left = (state.data.todos || []).filter((t) => !t.done).length;
  $('#todoLeft').textContent = left ? `· ${left}` : '';

  // 圆形图标上的未完成角标
  const badge = $('#todoBadge');
  badge.hidden = left === 0;
  badge.textContent = left > 99 ? '99+' : String(left);
}

/* 添加表单：待办 / 日程 二选一，日程多一个时间输入 */
let addMode = 'todo';

function setAddMode(mode) {
  addMode = mode;
  $$('#todoAddSeg button').forEach((b) => b.classList.toggle('on', b.dataset.val === mode));
  $('#todoAddTimeRow').hidden = mode !== 'event';
}

function showAddForm() {
  $('#todoAddBtn').hidden = true;
  $('#todoAddForm').hidden = false;
  $('#todoAddDate').value = viewIso || todayIso();
  setAddMode('todo');
  setTimeout(() => $('#todoAddText').focus(), 60);
}

function hideAddForm() {
  const form = $('#todoAddForm');
  if (!form || form.hidden) return;
  form.hidden = true;
  form.reset();
  $('#todoAddBtn').hidden = false;
}

function submitAdd(e) {
  e.preventDefault();
  const text = $('#todoAddText').value.trim();
  if (!text) return;
  const date = $('#todoAddDate').value || '';

  if (addMode === 'event') {
    // 日程必须有日期：留空按今天算；要管理别的日期可以用大日历
    state.data.events = state.data.events || [];
    state.data.events.push({
      id: uid(),
      date: date || todayIso(),
      text,
      time: $('#todoAddTime').value || ''
    });
    toast('已添加日程');
  } else {
    state.data.todos.push({ id: uid(), text, done: false, date });
    toast('已添加待办');
  }
  persist();
  hideAddForm();
  renderTodo();
}

export function bindTodo() {
  $('#todoFab').addEventListener('click', () => {
    if (document.body.classList.contains('todo-open')) closeTodo();
    else openTodo();
  });
  document.addEventListener('click', (e) => {
    if (!document.body.classList.contains('todo-open')) return;
    if (e.target.closest('#todoPanel') || e.target.closest('#todoFab')) return;
    closeTodo();
  });
  document.addEventListener('keydown', (e) => {
    const open = document.body.classList.contains('todo-open') ||
      document.body.classList.contains('todo-mode-docked');
    if (!open) return;
    if (e.key === 'Escape') closeTodo();
    // 左右方向键翻单日：输入框里打字时不抢（target 可能是 document，没有 closest）
    if (e.target.closest?.('input, textarea, select')) return;
    if (e.key === 'ArrowLeft') shiftDay(-1);
    if (e.key === 'ArrowRight') shiftDay(1);
  });

  $('#todoCalPrev').addEventListener('click', () => shiftDay(-1));
  $('#todoCalNext').addEventListener('click', () => shiftDay(1));
  $('#todoCalBack').addEventListener('click', () => {
    viewIso = null;
    renderTodo();
  });

  $('#todoAddBtn').addEventListener('click', showAddForm);
  $('#todoAddCancel').addEventListener('click', hideAddForm);
  $('#todoAddSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-val]');
    if (btn) setAddMode(btn.dataset.val);
  });
  $('#todoAddForm').addEventListener('submit', submitAdd);
}
