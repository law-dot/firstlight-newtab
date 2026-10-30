// 待办栏：圆形图标 / 常驻右侧 / 隐藏 三形态
import { state, persist } from '../core/state.js';
import { $ } from '../core/utils.js';
import { uid } from '../core/store.js';

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
  setTimeout(() => $('#todoInput').focus(), 60);
}

export function closeTodo() {
  document.body.classList.remove('todo-open');
  $('#todoFab').classList.remove('active');
}

export function renderTodo() {
  const list = $('#todoList');
  list.textContent = '';

  state.data.todos.forEach((todo) => {
    const li = document.createElement('li');
    if (todo.done) li.classList.add('done');

    const check = document.createElement('button');
    check.className = 'check';
    check.type = 'button';
    check.textContent = todo.done ? '✓' : '';
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

  const left = state.data.todos.filter((t) => !t.done).length;
  $('#todoLeft').textContent = state.data.todos.length
    ? left
      ? `${left} 项未完成`
      : '全部完成'
    : '';

  // 圆形图标上的未完成角标
  const badge = $('#todoBadge');
  badge.hidden = left === 0;
  badge.textContent = left > 99 ? '99+' : String(left);
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

  $('#todoForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#todoInput');
    const text = input.value.trim();
    if (!text) return;
    state.data.todos.push({ id: uid(), text, done: false });
    input.value = '';
    persist();
    renderTodo();
  });
}
