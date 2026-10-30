// 入口：加载数据、编排各 feature 模块、时钟与待机调度
// 版本号直接读 manifest，避免和 manifest.json 漂移（预览环境无扩展 API 时回退）
export const VERSION =
  typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest
    ? chrome.runtime.getManifest().version
    : '1.0.0';
import { loadData } from './core/store.js';
import { state, persist } from './core/state.js';
import { initSync, onSyncRemote } from './core/sync.js';
import { $, $$, toast } from './core/utils.js';

import { renderEngines, bindSearch, hideSuggest } from './features/search.js';
import {
  refreshWeather, checkWeatherRefresh, bindWeather,
  fx, fxSync, fxStop, fxSize, fxBuild
} from './features/weather.js';
import { pomo, bindPomodoro } from './features/pomodoro.js';
import { bindCalendar } from './features/calendar.js';
import { renderTodo, applyTodoMode, closeTodo, bindTodo } from './features/todo.js';
import { updateIdleTicker } from './features/feed.js';
import { renderDock, applyDockMode, bindDock } from './features/dock.js';
import {
  buildSwatches, applyWallpaper, checkOnlineRefresh, bindWallpaper, restartOnlineInterval
} from './features/wallpaper.js';
import {
  renderTabs, renderGrid, applySideState, applySiteMode, applyLayout,
  bindSidebar, bindSidePeek
} from './features/sidebar.js';
import {
  applyTheme, syncSettingsUI, openDrawer, closeDrawer,
  bindSettings, bindDrawerAutoClose, bindEdgeSettings,
  bindHelpDialog, openHelpDialog
} from './features/settings.js';

/* ================= 启动 ================= */
init().catch((err) => {
  console.error(err);
  toast('初始化失败，请重新加载页面');
});

async function init() {
  state.data = await loadData();
  state.activeGroupId = state.data.groups[0]?.id ?? null;
  // 同步开启时，启动合并可能从远端拉回更新的数据
  if (await initSync()) {
    state.data = await loadData();
    state.activeGroupId = state.data.groups[0]?.id ?? null;
  }
  // 其他设备推送更新时：重载数据并刷新界面
  onSyncRemote(async () => {
    state.data = await loadData();
    renderAll();
    applyTheme();
    await applyWallpaper();
  });
  applyTheme();
  applySideState();
  buildSwatches();
  bind();
  renderAll();
  await applyWallpaper({
    advanceOnline: state.data.settings.onlineMode === 'rotate'
  });
  tickClock();
  setInterval(tickClock, 1000);
  // 在线壁纸后台检查（源列表 TTL，3 小时检查一次是否过期）
  setInterval(checkOnlineRefresh, 30 * 60 * 1000);
  // 定时轮播（间隔模式才会真正 setInterval，其他模式是空跑）
  restartOnlineInterval();
  refreshWeather();
  setInterval(checkWeatherRefresh, 5 * 60 * 1000);
  $('#q').focus();
  bindIdle();
  bindSidePeek();
  bindEdgeSettings();
  bindDrawerAutoClose();
  scheduleIdle();

  window.addEventListener('resize', () => {
    if (!fx.running) return;
    fxSize();
    fxBuild(fx.kind);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) fxStop();
    else fxSync();
  });

  fxSync();
}

/* 一次性挂上所有模块的事件监听 */
function bind() {
  bindSearch();
  bindSidebar();
  bindDock();
  bindTodo();
  bindSettings();
  bindHelpDialog(VERSION);
  bindWallpaper();
  bindWeather();
  bindPomodoro();
  bindCalendar();
  bindGlobal();

  // 首次使用自动弹出说明（showOnboarding 默认 true，关掉后不再弹）
  if (state.data.settings.showOnboarding) {
    setTimeout(() => openHelpDialog(VERSION), 600);
  }
}

/* 编辑模式开关 + 全局快捷键 + 待机时长选择 */

/* 快捷键注册表：4 个动作，每个可绑多个快捷键（数组），空数组=禁用 */
export const HOTKEY_DEFS = [
  { id: 'search', label: '聚焦搜索框', default: ['/', 'Meta+K'] },
  { id: 'edit',   label: '切换编辑模式', default: ['Meta+E'] },
  { id: 'drawer', label: '打开设置抽屉', default: ['Meta+,'] },
  { id: 'escape', label: '关闭抽屉/对话框', default: ['Escape'] }
];

// 把 KeyboardEvent 规范化成标准字符串：Meta+K / Ctrl+Shift+/ / Escape
export function normalizeHotkey(e) {
  if (e.key === 'Control' || e.key === 'Shift' || e.key === 'Alt' || e.key === 'Meta') return null;
  const parts = [];
  if (e.metaKey) parts.push('Meta');
  else if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let key = e.key;
  if (key === ' ') key = 'Space';
  else if (key.length === 1) key = key.toUpperCase();
  parts.push(key);
  return parts.join('+');
}

// 取当前动作的所有绑定（已合并默认值，不存在的自动补）
export function getHotkeys(actionId) {
  const defaults = HOTKEY_DEFS.find((d) => d.id === actionId)?.default || [];
  const user = state.data?.settings?.hotkeys?.[actionId];
  if (user === undefined) return defaults.slice();
  // 空数组 = 用户主动禁用
  if (Array.isArray(user)) return user.slice();
  return defaults.slice();
}

// 检查冲突：某个快捷键字符串是否已被其他动作占用
export function findHotkeyConflict(actionId, keyStr) {
  for (const def of HOTKEY_DEFS) {
    if (def.id === actionId) continue;
    const keys = getHotkeys(def.id);
    if (keys.includes(keyStr)) return def.id;
  }
  return null;
}

export function setHotkey(actionId, hotkeyStr) {
  const s = state.data.settings;
  if (!s.hotkeys) s.hotkeys = {};
  // 每个动作当前只存一个快捷键（克制），用户想加多个后续再说
  s.hotkeys[actionId] = hotkeyStr ? [hotkeyStr] : [];
}

export function resetHotkey(actionId) {
  const s = state.data.settings;
  if (!s.hotkeys) s.hotkeys = {};
  const def = HOTKEY_DEFS.find((d) => d.id === actionId);
  s.hotkeys[actionId] = def ? def.default.slice() : [];
}

function bindGlobal() {
  $('#btnEdit').addEventListener('click', () => {
    state.editMode = !state.editMode;
    document.body.classList.toggle('editing', state.editMode);
    $('#btnEdit').classList.toggle('active', state.editMode);
    renderTabs();
    renderGrid();
    renderDock();
    toast(state.editMode ? '编辑模式：可拖拽排序、增删网站与分组' : '已退出编辑模式');
  });

  /* 快捷键分发：读 settings.hotkeys，每个动作可绑多个快捷键
     - 输入框里不拦截修饰键组合（保留浏览器默认）
     - Escape 优先级：对话框 → 抽屉 → 编辑模式 */
  window.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    const inEditable =
      tag === 'input' || tag === 'textarea' ||
      e.target.isContentEditable || e.target.closest('[contenteditable]');
    const keyStr = normalizeHotkey(e);
    if (!keyStr) return; // 单独修饰键，忽略

    // 先找匹配的动作
    let matched = null;
    for (const def of HOTKEY_DEFS) {
      if (getHotkeys(def.id).includes(keyStr)) { matched = def.id; break; }
    }
    if (!matched) return;

    // 裸键（无修饰键）在输入框里不拦截（允许正常输入）
    const hasMod = e.metaKey || e.ctrlKey || e.altKey;
    if (!hasMod && inEditable && e.key !== 'Escape') return;

    e.preventDefault();

    if (matched === 'escape') {
      const dialog = document.querySelector('dialog[open]');
      if (dialog) { dialog.close(); return; }
      if (document.body.classList.contains('drawer-open')) { closeDrawer(); return; }
      if (state.editMode) {
        state.editMode = false;
        document.body.classList.remove('editing');
        $('#btnEdit').classList.remove('active');
        renderTabs(); renderGrid(); renderDock();
        toast('已退出编辑模式');
      }
      return;
    }
    if (matched === 'search') { $('#q').focus(); return; }
    if (matched === 'edit') {
      $('#btnEdit').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return;
    }
    if (matched === 'drawer') { openDrawer(); return; }
  });

  $('#idleSelect').addEventListener('change', (e) => {
    state.data.settings.idleMinutes = Number(e.target.value) || 0;
    persist();
    scheduleIdle();
    toast(`待机模式：${e.target.selectedOptions[0].textContent}`);
    e.target.blur();
  });

  document.addEventListener('keydown', (e) => {
    const tag = document.activeElement?.tagName || '';
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(tag);
    if (e.key === '/' && !typing) {
      e.preventDefault();
      $('#q').focus();
    }
    if (e.key === 'Escape') {
      closeDrawer();
      $$('dialog[open]').forEach((d) => d.close());
    }
  });
}

/* ================= 时间 ================= */
export function tickClock() {
  // 番茄钟运行中：时钟显示剩余时间
  if (pomo.state.running || pomo.state.paused) {
    const secs = pomo.state.remaining;
    if (secs != null) {
      const m = Math.floor(secs / 60);
      const s = secs % 60;
      $('#time').textContent =
        String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
      // 每秒更新一次弹窗和 chip
      if (pomo.dialog?.open) {
        $('#pomoDisplay').textContent = $('#time').textContent;
      }
      $('#pomoChip').hidden = false;
      const phaseLabel = pomo.phaseLabel();
      $('#pomoChip').textContent = `${phaseLabel} · ${secs}s`;
      const chip = $('#pomoChip');
      chip.classList.remove('running', 'short', 'long', 'paused');
      chip.classList.add(pomo.state.paused ? 'paused' : pomo.state.phase);
      document.body.classList.add('pomo-active', 'pomo-' + pomo.state.phase);
      document.title = `${phaseLabel} ${$('#time').textContent} · 初见`;
    }
    // 运行中每秒 tick 倒计时
    if (pomo.state.running && pomo.state.endsAt) {
      const left = Math.max(0, Math.round((pomo.state.endsAt - Date.now()) / 1000));
      if (left !== pomo.state.remaining) {
        pomo.state.remaining = left;
      }
      if (left <= 0) {
        pomo.finishPhase();
      }
    }
  } else {
    // 正常时钟
    const now = new Date();
    $('#time').textContent =
      String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
    $('#date').textContent = now.toLocaleDateString('zh-CN', {
      month: 'long',
      day: 'numeric',
      weekday: 'long'
    });
    $('#greet').textContent = greetOf(now.getHours());
    $('#pomoChip').hidden = true;
    document.body.classList.remove('pomo-active', 'pomo-work', 'pomo-short', 'pomo-long');
    document.title = '初见';
  }
}

function greetOf(h) {
  if (h < 5) return '凌晨好';
  if (h < 9) return '早上好';
  if (h < 12) return '上午好';
  if (h < 14) return '中午好';
  if (h < 18) return '下午好';
  return '晚上好';
}

/* ================= 渲染 ================= */
export function renderAll() {
  if (!state.data.groups.some((g) => g.id === state.activeGroupId)) {
    state.activeGroupId = state.data.groups[0]?.id ?? null;
  }
  renderEngines();
  renderTabs();
  renderGrid();
  renderTodo();
  renderDock();
  syncSettingsUI();
  applyTodoMode();
  applyDockMode();
  applySiteMode();
  applyLayout();
}

/* ================= 待机 ================= */
const IDLE_EVENTS = ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart', 'input', 'focus'];

function bindIdle() {
  const onActivity = () => {
    const now = Date.now();
    if (!state.idleActive && now - state.lastActivityAt < 800) return;
    state.lastActivityAt = now;
    if (state.idleActive) {
      state.idleActive = false;
      state.lastWakeAt = now;
      document.body.classList.remove('idle-mode');
      fxSync();
    }
    scheduleIdle();
  };
  IDLE_EVENTS.forEach((name) => window.addEventListener(name, onActivity, { passive: true }));
}

function scheduleIdle() {
  clearTimeout(state.idleTimer);
  const minutes = Number(state.data.settings.idleMinutes) || 0;
  if (!minutes) return;
  // -1 = 常开：停止操作 5 秒后自动回到待机
  const delay = minutes < 0 ? 5 * 1000 : minutes * 60 * 1000;
  state.idleTimer = setTimeout(enterIdle, delay);
}

function enterIdle() {
  if (state.idleActive) return;
  state.idleActive = true;
  document.body.classList.add('idle-mode');
  if (state.data.settings.idleTicker !== false) updateIdleTicker(state.data.feeds);
  closeDrawer();
  closeTodo();
  hideSuggest();
  if (state.editMode) {
    state.editMode = false;
    document.body.classList.remove('editing');
    $('#btnEdit').classList.remove('active');
  }
  refreshWeather(!state.data.settings.weather?.fetchedAt || Date.now() - state.data.settings.weather.fetchedAt > 5 * 60 * 1000);
  fxSync();
}
