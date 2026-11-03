// 待办栏：圆形图标 / 常驻右侧 / 隐藏 三形态
// v1.2 起面板改为「今日视图」：顶部撕页日历卡，中间今日日程时间轴，底部未完成待办（跨天累积，勾选才消失）
import { state, persist } from '../core/state.js';
import { $, $$, toast } from '../core/utils.js';
import { uid } from '../core/store.js';
import { todayIso, todayItems } from './agenda.js';
import { getLunar } from './lunar.js';

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
  renderTodo(); // 打开时刷新：跨天后时间轴和日期头要更新
}

export function closeTodo() {
  document.body.classList.remove('todo-open');
  $('#todoFab').classList.remove('active');
  hideAddForm();
}

const WEEKDAYS = '日一二三四五六';

// 撕页日历卡：年月 / 大日期 / 星期 / 农历，双休日红字（老挂历的规矩）
function renderCalCard() {
  const now = new Date();
  $('#todoCalYm').textContent = `${now.getFullYear()} 年 ${now.getMonth() + 1} 月`;
  $('#todoCalDay').textContent = String(now.getDate());
  $('#todoCalWk').textContent = `星期${WEEKDAYS[now.getDay()]}`;
  const weekend = now.getDay() === 0 || now.getDay() === 6;
  $('#todoCalDay').classList.toggle('weekend', weekend);
  const lunar = getLunar(now);
  const lunarEl = $('#todoCalLunar');
  if (lunar) {
    lunarEl.hidden = false;
    lunarEl.textContent = lunar.festival ? `${lunar.text} · ${lunar.festival}` : lunar.text;
  } else {
    lunarEl.hidden = true;
  }
}

export function renderTodo() {
  renderCalCard();

  // 时间轴：今日日程
  const items = todayItems();
  const events = items.events;
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

    const check = document.createElement('button');
    check.className = 'check';
    check.type = 'button';
    check.textContent = '';
    check.title = '完成';
    check.onclick = () => {
      todo.done = true;
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

  // 两者都空：只显示空态一句话
  $('#todoEmpty').hidden = events.length > 0 || todos.length > 0;

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
  $('#todoAddDate').value = todayIso();
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
    if (e.key === 'Escape') closeTodo();
  });

  $('#todoAddBtn').addEventListener('click', showAddForm);
  $('#todoAddCancel').addEventListener('click', hideAddForm);
  $('#todoAddSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-val]');
    if (btn) setAddMode(btn.dataset.val);
  });
  $('#todoAddForm').addEventListener('submit', submitAdd);
}
