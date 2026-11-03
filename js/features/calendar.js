// 日历：点击日期触发，月历渲染 + 日程/待办增删（存 data.events / data.todos，v1.2 起合并管理）
import { state, persist } from '../core/state.js';
import { $, $$, toast } from '../core/utils.js';
import { uid } from '../core/store.js';
import { isoOf, eventsOf, todosOf } from './agenda.js';

export const cal = {
  dialog: null,
  viewYear: new Date().getFullYear(),
  viewMonth: new Date().getMonth(),
  selectedDate: null, // ISO 'YYYY-MM-DD'
  open() {
    if (!this.dialog) return;
    const now = new Date();
    if (!this.selectedDate) {
      this.viewYear = now.getFullYear();
      this.viewMonth = now.getMonth();
      this.selectedDate = isoOf(now);
    }
    this.dialog.showModal();
    this.render();
  },
  close() {
    if (this.dialog) this.dialog.close();
  },
  gotoPrev() {
    this.viewMonth--;
    if (this.viewMonth < 0) { this.viewMonth = 11; this.viewYear--; }
    this.render();
  },
  gotoNext() {
    this.viewMonth++;
    if (this.viewMonth > 11) { this.viewMonth = 0; this.viewYear++; }
    this.render();
  },
  gotoToday() {
    const now = new Date();
    this.viewYear = now.getFullYear();
    this.viewMonth = now.getMonth();
    this.selectedDate = isoOf(now);
    this.render();
  },
  selectDate(iso) {
    this.selectedDate = iso;
    $('#calAddForm').hidden = true;
    this.render();
  },
  eventsOf,
  todosOf,
  toggleTodo(id) {
    const todo = (state.data.todos || []).find((t) => t.id === id);
    if (!todo) return;
    todo.done = !todo.done;
    persist();
    this.render();
  },
  render() {
    // 标题
    $('#calTitle').textContent = `${this.viewYear} 年 ${this.viewMonth + 1} 月`;

    // 网格
    const grid = $('#calGrid');
    grid.innerHTML = '';
    const first = new Date(this.viewYear, this.viewMonth, 1);
    // 周一作为第一天：first.getDay() 0=周日 → 6；1=周一 → 0
    const offset = (first.getDay() + 6) % 7;
    const startDate = new Date(this.viewYear, this.viewMonth, 1 - offset);
    const todayIso = isoOf(new Date());

    for (let i = 0; i < 42; i++) {
      const d = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + i);
      const iso = isoOf(d);
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'cal-cell';
      cell.textContent = d.getDate();
      if (d.getMonth() !== this.viewMonth) cell.classList.add('other');
      if (iso === todayIso) cell.classList.add('today');
      if (iso === this.selectedDate) cell.classList.add('selected');
      if (this.eventsOf(iso).length || this.todosOf(iso).length) {
        const dot = document.createElement('span');
        dot.className = 'dot';
        cell.append(dot);
      }
      cell.addEventListener('click', () => this.selectDate(iso));
      grid.append(cell);
    }

    // 侧边：选中日的日程
    const sideDate = new Date(this.selectedDate + 'T00:00:00');
    $('#calSideDate').textContent = sideDate.toLocaleDateString('zh-CN', {
      month: 'long', day: 'numeric', weekday: 'long'
    });

    const list = $('#calEvents');
    list.innerHTML = '';
    const events = this.eventsOf(this.selectedDate)
      .slice()
      .sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));
    const todos = this.todosOf(this.selectedDate);
    $('#calEmpty').style.display = events.length || todos.length ? 'none' : '';
    events.forEach((ev) => {
      const li = document.createElement('li');
      if (ev.kind === 'feed-event') li.classList.add('feed-item');

      const time = document.createElement('span');
      time.className = 'time';
      time.textContent = ev.time || '全天';

      if (ev.kind === 'feed-event') {
        // 订阅事件：色点 + 文本 + 来源标签，无删除按钮
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
        rm.type = 'button';
        rm.className = 'rm';
        rm.textContent = '×';
        rm.title = '删除';
        rm.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.removeEvent(ev.id);
        });
        li.append(time, text, rm);
      }
      list.append(li);
    });
    // 待办排在日程后面：○ 复选框可直接勾选完成，完成的划线仍可见（大日历是管理视图）
    todos.forEach((todo) => {
      const li = document.createElement('li');
      li.className = 'cal-todo';
      if (todo.done) li.classList.add('done');
      const check = document.createElement('button');
      check.type = 'button';
      check.className = 'check';
      check.textContent = todo.done ? '✓' : '';
      check.title = todo.done ? '取消完成' : '完成';
      check.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.toggleTodo(todo.id);
      });
      const text = document.createElement('span');
      text.className = 'text';
      text.textContent = todo.text;
      li.append(check, text);
      list.append(li);
    });
  },
  addEvent(text, time) {
    if (!this.selectedDate || !text.trim()) return;
    state.data.events = state.data.events || [];
    state.data.events.push({
      id: uid(),
      date: this.selectedDate,
      text: text.trim(),
      time: time || ''
    });
    persist();
    $('#calAddForm').hidden = true;
    $('#calAddText').value = '';
    $('#calAddTime').value = '';
    this.render();
    toast('已添加日程');
  },
  addTodo(text) {
    if (!this.selectedDate || !text.trim()) return;
    state.data.todos = state.data.todos || [];
    state.data.todos.push({
      id: uid(),
      date: this.selectedDate,
      text: text.trim(),
      done: false
    });
    persist();
    $('#calAddForm').hidden = true;
    $('#calAddText').value = '';
    this.render();
    toast('已添加待办');
  },
  removeEvent(id) {
    state.data.events = (state.data.events || []).filter((e) => e.id !== id);
    persist();
    this.render();
  }
};

export function bindCalendar() {
  cal.dialog = $('#calDialog');
  $('#dateBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    cal.open();
  });
  $('#calPrev').addEventListener('click', () => cal.gotoPrev());
  $('#calNext').addEventListener('click', () => cal.gotoNext());
  $('#calToday').addEventListener('click', () => cal.gotoToday());
  $('#calAddBtn').addEventListener('click', () => {
    $('#calAddForm').hidden = false;
    $('#calAddText').focus();
  });
  $('#calAddCancel').addEventListener('click', () => {
    $('#calAddForm').hidden = true;
  });
  $('#calAddSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-val]');
    if (!btn) return;
    $$('#calAddSeg button').forEach((b) => b.classList.toggle('on', b === btn));
    $('#calAddTimeRow').hidden = btn.dataset.val !== 'event';
  });
  $('#calAddForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const mode = $('#calAddSeg button.on')?.dataset.val || 'event';
    const text = $('#calAddText').value;
    if (mode === 'todo') cal.addTodo(text);
    else cal.addEvent(text, $('#calAddTime').value);
  });
}
