// 设置抽屉：主题/引擎/待办/Dock/待机/动效开关 + 数据同步 + 数据导入导出 + 边缘交互
import { state, persist } from '../core/state.js';
import { $, $$, toast } from '../core/utils.js';
import {
  normalize, makeDefault, clearWallpaper,
  loadData, loadSyncConf, saveSyncConf
} from '../core/store.js';
import { initSync, isSyncAvailable } from '../core/sync.js';
import { renderWeather, WEATHER_TTL, fxSync } from './weather.js';
import { applyWallpaper } from './wallpaper.js';
import { applyTodoMode } from './todo.js';
import { applyDockMode, renderDock } from './dock.js';
import { applySiteMode, applyLayout, renderGrid, currentGroup } from './sidebar.js';
import { ensureDescriptions, requestFetchAccess } from './sitedesc.js';
import { renderAll, HOTKEY_DEFS, normalizeHotkey, getHotkeys, findHotkeyConflict, setHotkey, resetHotkey } from '../app.js';

export function applyTheme() {
  const theme = state.data.settings.theme;
  const dark =
    theme === 'dark' ||
    (theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

export function syncSettingsUI() {
  const s = state.data.settings;
  const dim = s.wallpaper.dim ?? 30;

  $$('#themeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.val === s.theme));
  $('#engineSelect').value = s.engine;
  $('#engineSetting').value = s.engine;
  $('#customEngine').value = s.customEngine || '';
  $('#customEngine').style.display = s.engine === 'custom' ? '' : 'none';
  $('#dimRange').value = String(dim);
  $('#dimVal').textContent = `${dim}%`;
  $$('#todoSeg button').forEach((b) => b.classList.toggle('on', b.dataset.val === (s.todoMode || 'fab')));
  $$('#dockSeg button').forEach((b) => b.classList.toggle('on', b.dataset.val === (s.dockMode || 'auto')));
  $$('#siteSeg button').forEach((b) => b.classList.toggle('on', b.dataset.val === (s.siteMode || 'standard')));
  $$('#layoutSeg button').forEach((b) => b.classList.toggle('on', b.dataset.val === (s.layout || 'standard')));
  $('#edgeToggle').checked = !!s.edgeSettings;
  $('#tickerToggle').checked = s.idleTicker !== false;
  const blockedN = (s.dockBlocked || []).length;
  $('#dockUnblock').hidden = !blockedN;
  if (blockedN) $('#dockUnblock').textContent = `已屏蔽 ${blockedN} 个网站 · 恢复`;
  $('#idleSelect').value = String(s.idleMinutes || 0);
  $$('#fxSeg button').forEach((b) =>
    b.classList.toggle('on', b.dataset.val === (s.fxMode || 'idle'))
  );
  $('#colorWallpaper').value = s.wallpaper.type === 'color' ? s.wallpaper.value : '#1b2735';
  if (document.activeElement !== $('#weatherCity')) {
    $('#weatherCity').value = s.weatherCity || '';
  }
  if (s.weather) {
    renderWeather(s.weather, Date.now() - (s.weather.fetchedAt || 0) >= WEATHER_TTL);
  }

  $$('.swatch').forEach((el) => {
    el.classList.toggle('on', s.wallpaper.type === 'preset' && s.wallpaper.value === el.dataset.id);
  });

  $('#btnOnline').classList.toggle('on', s.wallpaper.type === 'online');
  $$('#onlineMode button').forEach((b) => {
    b.classList.toggle('on', b.dataset.val === (s.onlineMode || 'daily'));
  });
  $('#onlineInterval').hidden = (s.onlineMode || 'daily') !== 'interval';
  $$('#onlineInterval button').forEach((b) => {
    b.classList.toggle('on', Number(b.dataset.val) === Number(s.onlineInterval || 30));
  });
  const src = s.onlineSource || 'auto';
  $$('#onlineSource button').forEach((b) => b.classList.toggle('on', b.dataset.val === src));
  $('#customWallpaper').style.display = src === 'custom' ? '' : 'none';
  if (document.activeElement !== $('#customWallpaper')) {
    $('#customWallpaper').value = s.customWallpaperUrl || '';
  }
  const online = s.wallpaper.online || {};
  const prefOk =
    src === 'auto' ||
    online.source === src ||
    (src === 'bing' && ['bing', 'mirror'].includes(online.source));
  $('#onlineStatus').textContent =
    s.wallpaper.type === 'online'
      ? online.sourceName
        ? `当前来源：${online.sourceName}${prefOk ? '' : '（所选来源不可用，已回退）'}`
        : '尚未获取到图片'
      : '';

  paintSyncUI();
}

/* ================= 数据同步 ================= */
// 同步配置缓存在本模块（异步读取，bindSettings 时加载），syncSettingsUI 直接用它渲染
let syncConf = null;

function paintSyncUI() {
  if (!syncConf) return;
  $$('#syncSeg button').forEach((b) =>
    b.classList.toggle('on', b.dataset.val === syncConf.mode)
  );
  const hint = $('#syncHint');
  if (syncConf.mode === 'browser') {
    const last = syncConf.lastSyncAt
      ? `上次同步：${new Date(syncConf.lastSyncAt).toLocaleString('zh-CN', {
          month: 'numeric',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        })}。`
      : '';
    hint.textContent = `经浏览器账号（Edge/Chrome）同步，数据会经过微软/谷歌服务器。${last}`;
  } else {
    hint.textContent = '数据只保存在本机，不上传任何服务器。';
  }
}

async function setSyncMode(mode) {
  if (!syncConf || mode === syncConf.mode) return;
  if (mode === 'browser' && !isSyncAvailable()) {
    toast('当前预览环境不支持浏览器同步');
    return;
  }
  syncConf = { ...syncConf, mode };
  await saveSyncConf(syncConf);
  const pulled = await initSync();
  if (pulled) {
    // 远端数据更新：重载并刷新界面
    state.data = await loadData();
    renderAll();
    applyTheme();
    await applyWallpaper();
  }
  syncConf = await loadSyncConf(); // initSync 可能更新了 lastSyncAt
  paintSyncUI();
  toast(mode === 'browser' ? '已开启浏览器账号同步' : '已关闭同步');
}

/* ================= 抽屉开关 ================= */
export function openDrawer() {
  document.body.classList.add('drawer-open');
  $('#drawer').setAttribute('aria-hidden', 'false');
}

export function closeDrawer() {
  document.body.classList.remove('drawer-open');
  $('#drawer').setAttribute('aria-hidden', 'true');
  state.drawerHovered = false;
  clearTimeout(state.drawerLeaveTimer);
  state.drawerLeaveTimer = null;
}

/* ================= 数据：导入 / 导出 / 恢复默认 ================= */
function exportData() {
  const blob = new Blob([JSON.stringify(state.data, null, 2)], {
    type: 'application/json'
  });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `firstlight-backup-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 3000);
  toast('已导出备份文件');
}

async function importData(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;

  try {
    state.data = normalize(JSON.parse(await file.text()));
    state.activeGroupId = state.data.groups[0].id;
    persist();
    renderAll();
    await applyWallpaper();
    toast('已导入备份（壁纸图片不包含在备份里）');
  } catch (err) {
    console.error(err);
    toast('文件解析失败');
  }
}

async function resetAll() {
  if (!confirm('恢复默认？当前分组、待办与壁纸都会被清空。')) return;
  state.data = makeDefault();
  state.activeGroupId = state.data.groups[0].id;
  await clearWallpaper();
  persist();
  renderAll();
  await applyWallpaper();
  toast('已恢复默认');
}

/* ================= 事件绑定 ================= */
export function bindSettings() {
  $('#btnSettings').addEventListener('click', openDrawer);
  $('#btnCloseDrawer').addEventListener('click', closeDrawer);

  $('#btnTheme').addEventListener('click', () => {
    const dark =
      document.documentElement.dataset.theme === 'dark';
    state.data.settings.theme = dark ? 'light' : 'dark';
    applyTheme();
    persist();
    syncSettingsUI();
  });

  $$('#themeSeg button').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.data.settings.theme = btn.dataset.val;
      applyTheme();
      persist();
      syncSettingsUI();
    });
  });

  $('#engineSetting').addEventListener('change', (e) => {
    state.data.settings.engine = e.target.value;
    persist();
    syncSettingsUI();
  });

  $('#customEngine').addEventListener('change', (e) => {
    state.data.settings.customEngine = e.target.value.trim();
    persist();
    toast('自定义搜索已保存');
  });

  $$('#fxSeg button').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.data.settings.fxMode = btn.dataset.val;
      persist();
      syncSettingsUI();
      fxSync();
    });
  });

  $$('#todoSeg button').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.data.settings.todoMode = btn.dataset.val;
      persist();
      syncSettingsUI();
      applyTodoMode();
    });
  });

  $$('#dockSeg button').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.data.settings.dockMode = btn.dataset.val;
      persist();
      syncSettingsUI();
      applyDockMode();
      renderDock();
    });
  });

  $('#dockUnblock').addEventListener('click', () => {
    state.data.settings.dockBlocked = [];
    persist();
    syncSettingsUI();
    renderDock();
    toast('已恢复全部屏蔽的网站');
  });

  $$('#siteSeg button').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const mode = btn.dataset.val;
      if (mode === state.data.settings.siteMode) return;
      state.data.settings.siteMode = mode;
      persist();
      syncSettingsUI();
      applySiteMode();
      renderGrid();
      // 详情模式需要抓站点简介：趁机申请全站访问权限（授权弹窗需要用户手势）
      if (mode === 'detail') {
        const ok = await requestFetchAccess();
        if (ok) {
          ensureDescriptions(currentGroup());
        } else {
          toast('未授权访问网站，详情模式只显示手动填写的说明');
        }
      }
    });
  });

  $$('#layoutSeg button').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.val === state.data.settings.layout) return;
      state.data.settings.layout = btn.dataset.val;
      persist();
      syncSettingsUI();
      applyLayout();
    });
  });

  $('#edgeToggle').addEventListener('change', (e) => {
    state.data.settings.edgeSettings = e.target.checked;
    persist();
    toast(e.target.checked ? '鼠标靠右边缘可打开设置' : '已关闭边缘打开设置');
  });

  $('#tickerToggle').addEventListener('change', (e) => {
    state.data.settings.idleTicker = e.target.checked;
    persist();
    toast(e.target.checked ? '待机时显示 RSS 跑马灯' : '已关闭待机跑马灯');
  });

  loadSyncConf().then((c) => {
    syncConf = c;
    paintSyncUI();
  });
  $$('#syncSeg button').forEach((btn) => {
    btn.addEventListener('click', () => setSyncMode(btn.dataset.val));
  });

  $('#btnExport').addEventListener('click', exportData);
  $('#btnImport').addEventListener('click', () => $('#fileImport').click());
  $('#fileImport').addEventListener('change', importData);
  $('#btnReset').addEventListener('click', resetAll);

  $$('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => btn.closest('dialog').close());
  });

  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (state.data.settings.theme === 'auto') applyTheme();
  });

  renderHotkeys();
  bindHotkeys();
}

/* ================= 快捷键录制 ================= */

let recordingActionId = null; // 当前处于录制状态的动作 id

function renderHotkeys() {
  const list = $('#hotkeyList');
  if (!list) return;
  list.textContent = '';
  for (const def of HOTKEY_DEFS) {
    const row = document.createElement('div');
    row.className = 'hotkey-row';

    const label = document.createElement('span');
    label.className = 'hotkey-label';
    label.textContent = def.label;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'hotkey-btn';
    const keys = getHotkeys(def.id);
    btn.textContent = keys.length ? keys.join(' 或 ') : '（未绑定）';
    btn.dataset.actionId = def.id;
    btn.dataset.defaultKeys = def.default.join(',');

    btn.addEventListener('click', () => startRecording(def.id, btn));

    row.append(label, btn);
    list.append(row);
  }
}

function startRecording(actionId, btn) {
  // 如果已经在录制另一个，先取消
  if (recordingActionId && recordingActionId !== actionId) {
    // 恢复之前那个按钮显示
    const oldBtn = $(`#hotkeyList .hotkey-btn[data-action-id="${recordingActionId}"]`);
    if (oldBtn) {
      const def = HOTKEY_DEFS.find((d) => d.id === recordingActionId);
      const keys = getHotkeys(recordingActionId);
      oldBtn.textContent = keys.length ? keys.join(' 或 ') : '（未绑定）';
    }
  }
  recordingActionId = actionId;
  btn.textContent = '请按下新快捷键…';
  btn.classList.add('recording');
  // capture 阶段监听，避免被页面其他 keydown 拦截
  document.addEventListener('keydown', onRecordKey, { capture: true, once: true });
}

function onRecordKey(e) {
  if (!recordingActionId) return;

  // Esc 取消录制
  if (e.key === 'Escape') {
    e.preventDefault(); e.stopPropagation();
    const btn = $(`#hotkeyList .hotkey-btn[data-action-id="${recordingActionId}"]`);
    if (btn) {
      const keys = getHotkeys(recordingActionId);
      btn.textContent = keys.length ? keys.join(' 或 ') : '（未绑定）';
      btn.classList.remove('recording');
    }
    recordingActionId = null;
    return;
  }

  // Backspace / Delete → 清除（禁用）
  if (e.key === 'Backspace' || e.key === 'Delete') {
    e.preventDefault(); e.stopPropagation();
    setHotkey(recordingActionId, null);
    persist();
    const btn = $(`#hotkeyList .hotkey-btn[data-action-id="${recordingActionId}"]`);
    if (btn) { btn.textContent = '（未绑定）'; btn.classList.remove('recording'); }
    toast('已清除快捷键');
    recordingActionId = null;
    return;
  }

  const keyStr = normalizeHotkey(e);
  if (!keyStr) {
    // 单独修饰键，重新等下一个按键
    document.addEventListener('keydown', onRecordKey, { capture: true, once: true });
    return;
  }

  e.preventDefault(); e.stopPropagation();

  // 冲突检测
  const conflict = findHotkeyConflict(recordingActionId, keyStr);
  if (conflict) {
    const confDef = HOTKEY_DEFS.find((d) => d.id === conflict);
    toast(`冲突：该快捷键已用于「${confDef?.label || conflict}」`);
    const btn = $(`#hotkeyList .hotkey-btn[data-action-id="${recordingActionId}"]`);
    if (btn) {
      const keys = getHotkeys(recordingActionId);
      btn.textContent = keys.length ? keys.join(' 或 ') : '（未绑定）';
      btn.classList.remove('recording');
    }
    recordingActionId = null;
    return;
  }

  // 保存
  setHotkey(recordingActionId, keyStr);
  persist();
  const btn = $(`#hotkeyList .hotkey-btn[data-action-id="${recordingActionId}"]`);
  if (btn) { btn.textContent = keyStr; btn.classList.remove('recording'); }
  toast(`已设置为 ${keyStr}`);
  recordingActionId = null;
}

function bindHotkeys() {
  // 抽屉打开时重新渲染（可能数据有变化）
  document.addEventListener('drawer:open', renderHotkeys);
}

/* ================= 使用说明弹窗 ================= */

export function renderHelpDialog(version) {
  const helpVer = $('#helpVer');
  if (helpVer) helpVer.textContent = `v${version}`;

  const helpBody = $('#hotkeysHelp');
  if (!helpBody) return;
  helpBody.textContent = '';
  for (const def of HOTKEY_DEFS) {
    const keys = getHotkeys(def.id);
    const row = document.createElement('div');
    row.className = 'hk-help-row';
    row.innerHTML = `<span class="hk-help-label">${def.label}</span><span class="hk-help-keys">${keys.length ? keys.join(' / ') : '（未绑定）'}</span>`;
    helpBody.append(row);
  }
}

export function openHelpDialog(version) {
  renderHelpDialog(version);
  const dlg = $('#helpDialog');
  if (dlg) dlg.showModal();
}

export function bindHelpDialog(version) {
  $('#btnHelp')?.addEventListener('click', () => openHelpDialog(version));
  $('#btnHelpClose')?.addEventListener('click', () => {
    const dlg = $('#helpDialog');
    dlg?.close();
    // 用户手动关掉说明后，不再自动弹出
    if (state.data.settings.showOnboarding) {
      state.data.settings.showOnboarding = false;
      persist();
    }
  });
  // dialog 点击遮罩关闭：检测点击事件 target 是否是 dialog 本身
  document.addEventListener('click', (e) => {
    if (e.target.id === 'helpDialog') {
      e.target.close();
      if (state.data.settings.showOnboarding) {
        state.data.settings.showOnboarding = false;
        persist();
      }
    }
  });
}

/* ================= 抽屉自动收起 ================= */
const DRAWER_LEAVE_DELAY = 400;

export function bindDrawerAutoClose() {
  const drawer = $('#drawer');

  document.addEventListener('mousemove', (e) => {
    if (!document.body.classList.contains('drawer-open')) return;

    const rect = drawer.getBoundingClientRect();
    const inside =
      e.clientX >= rect.left &&
      e.clientX <= rect.right &&
      e.clientY >= rect.top &&
      e.clientY <= rect.bottom;

    if (inside) {
      state.drawerHovered = true;
      clearTimeout(state.drawerLeaveTimer);
      state.drawerLeaveTimer = null;
      return;
    }

    // 只有真正进入过抽屉才自动收起，避免从工具栏按钮打开后立刻关闭
    if (!state.drawerHovered) return;
    if (document.querySelector('dialog[open]')) return;
    const active = document.activeElement;
    if (active && active.tagName === 'SELECT' && drawer.contains(active)) return;
    if (state.drawerLeaveTimer) return;

    state.drawerLeaveTimer = setTimeout(() => {
      state.drawerLeaveTimer = null;
      if (document.body.classList.contains('drawer-open')) closeDrawer();
    }, DRAWER_LEAVE_DELAY);
  });
}

/* ================= 右边缘打开设置 ================= */
const EDGE_ZONE = 10;
const EDGE_DELAY = 200;

export function bindEdgeSettings() {
  document.addEventListener('mousemove', (e) => {
    const skipped =
      !state.data.settings.edgeSettings || state.idleActive || Date.now() - state.lastWakeAt < 600;
    if (skipped || window.innerWidth - e.clientX > EDGE_ZONE) {
      clearTimeout(state.edgeTimer);
      state.edgeTimer = null;
      return;
    }
    if (state.edgeTimer || document.body.classList.contains('drawer-open')) return;
    state.edgeTimer = setTimeout(() => {
      state.edgeTimer = null;
      openDrawer();
    }, EDGE_DELAY);
  });
}
