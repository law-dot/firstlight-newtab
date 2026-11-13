// 入口：加载数据、编排各 feature 模块、时钟与待机调度
// 版本号直接读 manifest，避免和 manifest.json 漂移（预览环境无扩展 API 时回退）
export const VERSION =
  typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest
    ? chrome.runtime.getManifest().version
    : '1.0.0';
import { loadData, isRecentLocalWrite } from './core/store.js';
import { state, persist } from './core/state.js';
import { initSync, onSyncRemote, backgroundPull } from './core/sync.js';
import { drainPendingAdds, drainPendingReads, watchPendingAdds } from './core/pending.js';
import { $, $$, toast } from './core/utils.js';

import { renderEngines, bindSearch, hideSuggest } from './features/search.js';
import {
  refreshWeather, checkWeatherRefresh, bindWeather,
  fx, fxSync, fxStop, fxSize, watchMotionPref
} from './features/weather.js';
import { pomo, bindPomodoro } from './features/pomodoro.js';
import { bindCalendar } from './features/calendar.js';
import { renderTodo, applyTodoMode, closeTodo, bindTodo } from './features/todo.js';
import { setupFeedAlarm, syncAll as syncAllFeeds, listFeeds as listCalFeeds } from './features/calfeed.js';
import { updateIdleTicker } from './features/feed.js';
import { renderDock, applyDockMode, bindDock } from './features/dock.js';
import {
  buildSwatches, applyWallpaper, checkOnlineRefresh, bindWallpaper, restartOnlineInterval
} from './features/wallpaper.js';
import {
  renderTabs, renderGrid, applySideState, applySiteMode, applyLayout, applyViewMode,
  bindSidebar, bindSidePeek
} from './features/sidebar.js';
import {
  applyTheme, syncSettingsUI, openDrawer, closeDrawer,
  bindSettings, bindDrawerAutoClose, bindEdgeSettings,
  bindHelpDialog, openHelpDialog, bindFeedSettings, renderFeedList,
  bindAbout, checkUpdateOnStart
} from './features/settings.js';
import { startTour, shouldTour } from './features/onboarding.js';
import { renderReading, bindReading } from './features/reading.js';

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
  /* 其他设备推送更新时：重载数据并刷新界面。
     1.4.1：加一道内容比对 —— 同步引擎的回声、我们自己刚写上去的推送，
     都会走到这里。数据一模一样却重画一遍整页（连壁纸一起重设），
     多窗口/多设备下就是肉眼可见的闪屏。内容没变直接跳过。
     1.4.2：比对时把 wallpaper.online.fetchedAt 抹平 —— 它只是「这次抓图
     的时刻」，纯缓存时间戳，不影响任何显示；旧版标签页每渲染一次就把它
     写新一次，不抹平的话每次都判成「内容变了」，renderAll 一轮一轮空转
     （favicon 重建、设置下拉回填，看起来就是图标和选项在闪）。 */
  let dataSig = normSig(state.data);
  onSyncRemote(async () => {
    const next = await loadData();
    const sig = normSig(next);
    if (sig === dataSig) return; // 内容一模一样：连 state.data 都不换
    /* 壁纸按 wallpaperAt 比新旧（与同步合并同一条规则）：别的窗口/设备
       带着**旧壁纸**写上来时，不整份换掉 —— 否则「换完闪一下又变回去」。
       旧版标签页不认 wallpaperAt，但只要本页这份更新，我们就顶回去，
       旧版下一轮重载就会拿到正确的壁纸，两边收敛。 */
    const lw = state.data.settings?.wallpaper;
    const nw = next.settings?.wallpaper;
    let keepMine = false;
    if (lw && nw && (Number(nw.wallpaperAt) || 0) < (Number(lw.wallpaperAt) || 0)) {
      next.settings.wallpaper = lw;
      keepMine = true;
    }
    if (isRecentLocalWrite('monk.settings.v1')) {
      next.settings.wallpaper = state.data.settings.wallpaper;
      keepMine = true;
    }
    if (keepMine) {
      // 存储里那份已经被别人写成旧值了，把本页这份顶回去（带新时间戳）
      persist();
    }
    state.data = next;
    dataSig = normSig(next);
    renderAll();
    applyTheme();
    await applyWallpaper();
  });
  // 弹窗收藏的落地：newtab 开着时实时排空；没开着就等下次启动（上面启动路径兜底）
  watchPendingAdds(drainFromPopup);
  await drainFromPopup(true); // 启动排空：上次关着窗口时用弹窗存的东西不会丢

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

  // 窗口尺寸变了只需重设画布与整屏渐变：雪碧图是固定尺寸的，不必重烘
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    if (!fx.running) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (fx.running) fxSize();
    }, 160);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) fxStop();
    else {
      fxSync();
      backgroundPull(); // WebDAV 模式：切回前台顺手拉一次云端（内部 10 分钟节流），拉到更新走 onSyncRemote 同一条重渲染路径
    }
  });

  fxSync();
}

/* 弹窗收藏：取走队列 → 挂进分组 → persist（顺路走同步推送）→ 重渲染。
   startup=true 时不 toast——刚开新标签页就弹「已加入」是打扰。
   排到 0 条（含删除广播的空跑）时静默返回。 */
async function drainFromPopup(startup = false) {
  try {
    const nAdd = await drainPendingAdds(state);
    const nRead = await drainPendingReads(state);
    if (!nAdd && !nRead) return;
    await persist();
    renderAll();
    if (!startup) {
      if (nAdd) toast(`弹窗收藏：已加入 ${nAdd} 个网站`);
      if (nRead) toast(`已加入稍后读 ${nRead} 篇`);
    }
  } catch (err) {
    console.warn('drain pending adds failed', err);
  }
}

/* 一次性挂上所有模块的事件监听 */
function bind() {
  bindSearch();
  bindSidebar();
  bindDock();
  bindTodo();
  bindSettings();
  bindFeedSettings();
  bindHelpDialog(VERSION);
  bindAbout(VERSION);
  bindWallpaper();
  bindWeather();
  bindPomodoro();
  bindCalendar();
  bindGlobal();
  bindReading();
  // 系统「减少动态效果」变化 + 电池供电降频，只在这里接一次
  watchMotionPref();

  // 日历订阅定时同步（每天一次），有订阅源才启动
  setupFeedAlarm();
  if (listCalFeeds().length > 0) {
    syncAllFeeds(); // 首次打开新标签页尝试刷新一次（需要用户同意 optional_host_permissions）
  }

  // 首次使用：动画式分步引导（走完写 onboardedV，之后不再自动弹）。
  // 详细说明仍在设置右上角的问号里，随时可看。
  if (shouldTour(state.data.settings)) {
    setTimeout(() => startTour(VERSION), 700);
  }
  // 版本更新检查：等首屏稳定再发请求，失败静默（离线、被墙、限流都不打扰）
  setTimeout(() => checkUpdateOnStart(VERSION), 6000);
}

/* 编辑模式开关 + 全局快捷键 + 待机时长选择 */

/* 当前平台是否以 Cmd 作为命令键。navigator.platform 已废弃但仍是最可靠的同步取值，
   优先用 userAgentData.platform（Chromium 110+ 支持），两者都取不到时按非 mac 处理。 */
export const IS_MAC = (() => {
  try {
    const p =
      (navigator.userAgentData && navigator.userAgentData.platform) ||
      navigator.platform ||
      '';
    return /mac|iphone|ipad|ipod/i.test(p);
  } catch {
    return false;
  }
})();

export const MOD_LABEL = IS_MAC ? '⌘' : 'Ctrl';

/* 快捷键注册表：5 个动作，每个可绑多个快捷键（数组），空数组=禁用
   统一用 Mod 表示「当前平台的命令键」：mac 是 Cmd，Windows/Linux 是 Ctrl。
   写死 Meta 会导致 Windows 上三个快捷键全部失效（v1.0 的实际 bug）。 */
export const HOTKEY_DEFS = [
  { id: 'search', label: '聚焦搜索框', default: ['/', 'Mod+K'] },
  { id: 'edit',   label: '切换编辑模式', default: ['Mod+E'] },
  { id: 'view',   label: '切换极简视图', default: ['Mod+Shift+M'] },
  { id: 'drawer', label: '打开设置抽屉', default: ['Mod+,'] },
  { id: 'escape', label: '关闭抽屉/对话框', default: ['Escape'] }
];

// 旧版数据里存的 Meta+* 一律视为「命令键」：mac 上它就是 Cmd，Win 上是同步过来的历史值
export function canonHotkey(str) {
  return String(str || '').replace(/^Meta\+/, 'Mod+');
}

// 把 KeyboardEvent 规范化成标准字符串：Mod+K / Ctrl+Shift+/ / Escape
export function normalizeHotkey(e) {
  if (e.key === 'Control' || e.key === 'Shift' || e.key === 'Alt' || e.key === 'Meta') return null;
  const parts = [];
  if (IS_MAC) {
    if (e.metaKey) parts.push('Mod');   // Cmd
    if (e.ctrlKey) parts.push('Ctrl');  // mac 上 Ctrl 是另一个真实的键
  } else {
    if (e.ctrlKey) parts.push('Mod');   // Ctrl
    if (e.metaKey) parts.push('Meta');  // Win 键
  }
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let key = e.key;
  if (key === ' ') key = 'Space';
  else if (key.length === 1) key = key.toUpperCase();
  parts.push(key);
  return parts.join('+');
}

// 取当前动作的所有绑定（规范形式，用于匹配）
export function getHotkeys(actionId) {
  const defaults = HOTKEY_DEFS.find((d) => d.id === actionId)?.default || [];
  const user = state.data?.settings?.hotkeys?.[actionId];
  // 空数组 = 用户主动禁用
  if (Array.isArray(user)) return user.map(canonHotkey);
  return defaults.slice();
}

// 展示用：把 Mod 换成当前平台的键名（⌘ / Ctrl）
export function displayHotkey(str) {
  return String(str || '').replace(/\bMod\+/g, `${MOD_LABEL}+`);
}

export function getHotkeysDisplay(actionId) {
  return getHotkeys(actionId).map(displayHotkey);
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

/* 两档视图循环切换：standard ↔ minimal */
function toggleViewMode() {
  const s = state.data.settings;
  s.viewMode = s.viewMode === 'minimal' ? 'standard' : 'minimal';
  persist();
  applyViewMode();
  toast(s.viewMode === 'minimal' ? '极简视图：已隐藏收藏卡片' : '标准视图');
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

  $('#btnView').addEventListener('click', toggleViewMode);

  /* 快捷键分发：读 settings.hotkeys，每个动作可绑多个快捷键
     - 全项目**只有这一个**全局 keydown 监听器。
       v1.0 曾在 document 上又挂了一个，冒泡顺序 document 先于 window，
       导致下面这条优先级链从未生效，按一次 Esc 抽屉和弹窗会一起关。
     - 输入框里不拦截裸键（保留正常打字）
     - Escape 优先级：搜索建议 → 对话框(最上层) → 抽屉 → 编辑模式 */
  window.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    const inEditable =
      tag === 'input' || tag === 'textarea' || tag === 'select' ||
      e.target.isContentEditable || !!e.target.closest?.('[contenteditable]');
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
      // 1) 搜索建议优先关掉，避免连带关掉抽屉
      if (!$('#suggest').hidden) { hideSuggest(); return; }
      // 2) 只关最上层那个对话框（DOM 顺序里最后一个即最上层的 modal）
      const dialogs = $$('dialog[open]');
      if (dialogs.length) { dialogs[dialogs.length - 1].close(); return; }
      // 3) 再关抽屉
      if (document.body.classList.contains('drawer-open')) { closeDrawer(); return; }
      // 4) 最后退编辑模式
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
    if (matched === 'view') { toggleViewMode(); return; }
    if (matched === 'drawer') { openDrawer(); return; }
  });

  $('#idleSelect').addEventListener('change', (e) => {
    state.data.settings.idleMinutes = Number(e.target.value) || 0;
    persist();
    scheduleIdle();
    toast(`待机模式：${e.target.selectedOptions[0].textContent}`);
    e.target.blur();
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
/* 比对签名：抹掉纯缓存时间戳（不影响显示的字段），避免「没变的东西」
   被当成变化触发整页重绘。目前只有 wallpaper.online.fetchedAt。 */
function normSig(data) {
  try {
    const c = JSON.parse(JSON.stringify(data));
    if (c.settings?.wallpaper?.online) c.settings.wallpaper.online.fetchedAt = 0;
    return JSON.stringify(c);
  } catch {
    return JSON.stringify(data);
  }
}

/* renderAll 幂等守卫：数据和视图状态没变就整个跳过。
   每次重画都是清空重建（卡片、favicon <img>、设置下拉全部重新来），
   重复调用就是肉眼可见的闪 —— 1.4.2 报的「图标闪 / 选项闪」正源于此。 */
let renderSig = '';
export function renderAll() {
  const sig = JSON.stringify([state.data, state.activeGroupId, state.editMode]);
  if (sig === renderSig) return;
  renderSig = sig;
  if (!state.data.groups.some((g) => g.id === state.activeGroupId)) {
    state.activeGroupId = state.data.groups[0]?.id ?? null;
  }
  renderEngines();
  renderTabs();
  renderGrid();
  renderReading();
  renderTodo();
  renderDock();
  syncSettingsUI();
  applyTodoMode();
  applyDockMode();
  applySiteMode();
  applyLayout();
  applyViewMode();
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
  // 跑马灯只吃 RSS 源；日历订阅在同一数组里（kind: 'ics'），混进去会被当 RSS 解析而报错
  if (state.data.settings.idleTicker !== false) {
    updateIdleTicker((state.data.feeds || []).filter((f) => f && f.kind !== 'ics'));
  }
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
