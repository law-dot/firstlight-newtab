// 设置抽屉：主题/引擎/待办/Dock/待机/动效开关 + 数据同步 + 数据导入导出 + 边缘交互
import { state, persist } from '../core/state.js';
import { $, $$, toast } from '../core/utils.js';
import {
  normalize, makeDefault, clearWallpaper,
  loadData, loadSyncConf, saveSyncConf
} from '../core/store.js';
import {
  initSync, isSyncAvailable, overwriteLocalFromRemote,
  syncNow, getSyncStatus, testWebdav, davErrText
} from '../core/sync.js';
import { renderWeather, WEATHER_TTL, fxSync } from './weather.js';
import { applyWallpaper } from './wallpaper.js';
import { applyTodoMode } from './todo.js';
import { applyDockMode, renderDock } from './dock.js';
import { applySiteMode, applyLayout, renderGrid } from './sidebar.js';
import { enableDescriptionsNow, bindDescNote } from './sitedesc.js';
import { bindBookmarkImport } from './bookmarkimport.js';
import {
  addFeed, removeFeed, syncFeed, listFeeds, feedRuntime, defaultFeedName, ensureFeedPermission
} from './calfeed.js';
import { renderAll, HOTKEY_DEFS, normalizeHotkey, getHotkeys, displayHotkey, findHotkeyConflict, setHotkey, resetHotkey } from '../app.js';

// 壁纸模糊的常规说明；壁纸是纯色/渐变时会被换成「拖了也没用」的提示
const BLUR_HINT = '把壁纸整体揉虚一层，前景的文字和卡片会更突出；纯色、渐变壁纸本来就没什么细节，拖了也看不出差别。';

export function applyTheme() {
  const theme = state.data.settings.theme;
  const dark =
    theme === 'dark' ||
    (theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  applyAccent();
}

/* ================= 强调色 ================= */
// 用户可自选界面强调色：本质是用内联样式覆盖 :root 上的 4 个 CSS 变量。
// --accent-soft / --glow / --glow-strong 只是同一 RGB 的不同透明度，
// 明暗两套主题的透明度不同，所以跟在 applyTheme 后面一起重算。
const ACCENT_DEFAULT = '#7c6cf6';
const ACCENT_PRESETS = [
  ACCENT_DEFAULT, // 紫（默认）
  '#3d7ff2',      // 蓝
  '#2fb6c9',      // 青
  '#38a169',      // 绿
  '#d99a3d',      // 琥珀
  '#e06a3f',      // 橙
  '#d9538c',      // 玫红
  '#8a93a3'       // 石墨
];

function hexRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return [124, 108, 246];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function applyAccent() {
  const hex = state.data.settings.accent || ACCENT_DEFAULT;
  const [r, g, b] = hexRgb(hex);
  const theme = state.data.settings.theme;
  const dark =
    theme === 'dark' ||
    (theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  const root = document.documentElement;
  root.style.setProperty('--accent', hex);
  root.style.setProperty('--accent-soft', `rgba(${r}, ${g}, ${b}, ${dark ? 0.28 : 0.18})`);
  root.style.setProperty('--glow', `rgba(${r}, ${g}, ${b}, ${dark ? 0.5 : 0.34})`);
  root.style.setProperty('--glow-strong', `rgba(${r}, ${g}, ${b}, ${dark ? 0.72 : 0.5})`);
}

function setAccent(hex) {
  state.data.settings.accent = hex;
  persist();
  applyAccent();
  renderAccentUI();
}

function renderAccentUI() {
  const box = $('#accentSwatches');
  if (!box) return;
  const cur = (state.data.settings.accent || ACCENT_DEFAULT).toLowerCase();
  box.textContent = '';
  for (const hex of ACCENT_PRESETS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch' + (hex.toLowerCase() === cur ? ' on' : '');
    b.style.background = hex;
    b.title = hex;
    b.addEventListener('click', () => setAccent(hex));
    box.appendChild(b);
  }
  $('#accentPicker').value = cur;
}

export function syncSettingsUI() {
  const s = state.data.settings;
  // 壁纸模糊：只有图片 / 在线壁纸有细节可虚化，纯色和渐变拖了也看不出，直接置灰
  const blur = s.wallpaper.blur ?? 12;
  const canBlur = s.wallpaper.type === 'image' || s.wallpaper.type === 'online';

  $$('#themeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.val === s.theme));
  renderAccentUI();
  $('#engineSelect').value = s.engine;
  $('#engineSetting').value = s.engine;
  $('#customEngine').value = s.customEngine || '';
  $('#customEngine').style.display = s.engine === 'custom' ? '' : 'none';
  $('#blurRange').value = String(blur);
  $('#blurRange').disabled = !canBlur;
  $('#blurVal').textContent = `${blur}px`;
  $('#blurHint').textContent = canBlur
    ? BLUR_HINT
    : '当前是纯色 / 渐变壁纸，模糊看不出效果；换成图片或在线壁纸才生效。';
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
    b.classList.toggle('on', b.dataset.val === (s.fxMode || 'always'))
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
  const scene = s.wallpaperScene || 'nature';
  $$('#onlineScene button').forEach((b) => b.classList.toggle('on', b.dataset.val === scene));
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
  const pullBtn = $('#btnSyncPull');
  const davForm = $('#webdavForm');
  const actions = $('#syncActions');
  const status = $('#syncStatus');
  if (pullBtn) pullBtn.hidden = syncConf.mode !== 'browser';
  if (davForm) davForm.hidden = syncConf.mode !== 'webdav';
  if (actions) actions.hidden = syncConf.mode === 'off';
  if (status) {
    status.hidden = true;
    status.textContent = '';
  }
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
  } else if (syncConf.mode === 'webdav') {
    hint.textContent = '经你自己的 WebDAV 网盘同步全量快照；打开新标签页时自动同步，也可点「立即同步」。';
  } else {
    hint.textContent = '数据只保存在本机，不上传任何服务器。';
  }
  if (syncConf.mode === 'webdav' && davForm && document.activeElement?.id !== 'davUrl') {
    const d = syncConf.webdav || {};
    $('#davUrl').value = d.url || '';
    $('#davUser').value = d.username || '';
    $('#davPass').value = d.password || '';
  }
}

/* ---- 同步状态面板：把「云端到底有没有数据」摆到明面上 ---- */
function fmtBytes(n) {
  return n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`;
}

function fmtSide(tag, s) {
  if (!s) return `${tag}：（空）`;
  return `${tag}：${s.records} 条记录 · ${s.groups} 个分组 / ${s.sites} 个站点 · 待办 ${s.todos} · 日程 ${s.events} · 订阅源 ${s.feeds} · 约 ${fmtBytes(s.bytes)}`;
}

function formatSyncStatus(st) {
  const lines = [];
  const t = (ts) => (ts ? new Date(ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '从未');
  if (st.mode === 'browser') {
    lines.push(`模式：浏览器账号同步`, `扩展 ID：${st.extId || '（预览环境）'}`, `上次同步：${t(st.lastSyncAt)}`);
    lines.push('');
    lines.push(fmtSide('本机', st.local));
    lines.push(fmtSide('云端', st.remote));
    lines.push('');
    if (st.error) lines.push('⚠ 云端读取失败（未登录账号？）');
    else if (!st.remote || !st.remote.records) {
      lines.push('⚠ 云端是空的：另一台设备要先在初见设置里开启同步并推送过，这里才有数据。');
      lines.push('  两台设备的扩展 ID 必须一致（都是商店安装或都是本地加载）。');
    } else if (st.remote.records !== st.local.records || st.remote.sites !== st.local.sites) {
      lines.push('ℹ 两边数量不一致：点「立即同步」做一次双向合并即可。');
    } else {
      lines.push('✓ 两边一致。');
    }
  } else if (st.mode === 'webdav') {
    lines.push(`模式：WebDAV`, `服务器：${st.url}`, `上次同步：${t(st.lastSyncAt)}`);
    lines.push('');
    lines.push(fmtSide('本机', st.local));
    lines.push(fmtSide('云端', st.remote));
    lines.push('');
    if (st.error) lines.push(`⚠ 云端读取失败：${davErrText(st.error)}`);
    else if (!st.remote) lines.push('云端还没有快照，保存并连接后会自动推上去。');
    else {
      lines.push(`快照时间：${t(st.remoteSavedAt)} · 来自设备 ${st.remoteDeviceId || '?'}`);
      if (st.remoteDeviceId && st.remoteDeviceId !== st.deviceId) lines.push('（云端比本机新过的部分会在同步时并进来）');
    }
  } else {
    lines.push('模式：未开启同步');
  }
  return lines.join('\n');
}

async function refreshSyncStatus() {
  const el = $('#syncStatus');
  el.hidden = false;
  el.textContent = '正在读取…';
  try {
    const st = await getSyncStatus();
    syncConf = await loadSyncConf();
    paintSyncUI();          // 会按新模式重排表单（并清空 status 文本）
    el.textContent = formatSyncStatus(st);
    el.hidden = false;
  } catch (err) {
    el.textContent = `读取失败：${err?.message || err}`;
  }
}

async function doSyncNow() {
  toast('正在同步…');
  const r = await syncNow();
  if (!r.ok) {
    toast(`同步失败：${davErrText(r.reason)}`);
    return;
  }
  if (r.pulled) {
    state.data = await loadData();
    renderAll();
    applyTheme();
    await applyWallpaper();
  }
  syncConf = await loadSyncConf();
  paintSyncUI();
  toast(r.pulled ? '同步完成，本机已按云端更新' : '同步完成');
}

/* ---- WebDAV 配置 ---- */
async function requestDavOrigin(url) {
  if (typeof chrome === 'undefined' || !chrome.permissions?.request) return true; // 预览环境直接放行
  const origin = `${new URL(url).origin}/*`;
  return chrome.permissions.request({ origins: [origin] });
}

async function saveWebdav() {
  const url = $('#davUrl').value.trim();
  const username = $('#davUser').value.trim();
  const password = $('#davPass').value;
  if (!/^https?:\/\//i.test(url)) {
    toast('地址要以 http(s):// 开头，且指向一个目录');
    return;
  }
  if (!(await requestDavOrigin(url))) {
    toast('没有该域名的网络权限，无法连接');
    return;
  }
  syncConf = { ...syncConf, mode: 'webdav', webdav: { url, username, password } };
  await saveSyncConf(syncConf);
  toast('正在连接并推送第一份快照…');
  const r = await syncNow();
  if (!r.ok) {
    toast(`已保存配置，但同步失败：${davErrText(r.reason)}`, 4000);
  } else {
    toast(r.pulled ? '已连接，云端数据并入了本机' : '已连接，快照已推送到网盘');
  }
  syncConf = await loadSyncConf();
  paintSyncUI();
}

async function testDav() {
  const url = $('#davUrl').value.trim();
  if (!/^https?:\/\//i.test(url)) {
    toast('地址要以 http(s):// 开头');
    return;
  }
  if (!(await requestDavOrigin(url))) {
    toast('没有该域名的网络权限');
    return;
  }
  toast('正在测试连接…');
  const r = await testWebdav({
    url,
    username: $('#davUser').value.trim(),
    password: $('#davPass').value
  });
  if (!r.ok) toast(`连接失败：${davErrText(r.reason)}`, 4000);
  else if (r.hasSnapshot) toast('连接成功，云端已有本插件的快照', 4000);
  else toast('连接成功（云端还没有快照，保存后会推上去）', 4000);
}

async function setSyncMode(mode) {
  if (!syncConf || mode === syncConf.mode) return;
  if (mode === 'browser' && !isSyncAvailable()) {
    toast('当前预览环境不支持浏览器同步');
    return;
  }
  // 还没填过 WebDAV 配置：先只切界面，填好「保存并连接」后再真正开同步
  if (mode === 'webdav' && !syncConf.webdav) {
    syncConf = { ...syncConf, mode: 'webdav' };
    await saveSyncConf(syncConf);
    paintSyncUI();
    toast('填好地址和账号后，点「保存并连接」');
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
  toast(
    mode === 'browser' ? '已开启浏览器账号同步'
      : mode === 'webdav' ? '已开启 WebDAV 同步'
      : '已关闭同步'
  );
}

// 手动「以云端为准」：覆盖前先确认，避免误点丢数据
async function pullFromRemote() {
  const yes = window.confirm(
    '这会用云端的数据覆盖本机的分组、待办、订阅源等全部内容，且无法撤销。\n\n确定继续吗？'
  );
  if (!yes) return;
  const res = await overwriteLocalFromRemote();
  if (!res.ok) {
    toast(res.reason === 'off' ? '请先开启浏览器账号同步' : '云端没有可拉取的数据');
    return;
  }
  state.data = await loadData();
  renderAll();
  applyTheme();
  await applyWallpaper();
  syncConf = await loadSyncConf();
  paintSyncUI();
  toast(`已从云端恢复 ${res.count} 项数据`);
}

/* ================= 抽屉开关 ================= */
export function openDrawer() {
  document.body.classList.add('drawer-open');
  $('#drawer').setAttribute('aria-hidden', 'false');
  renderFeedList(); // 每次打开抽屉刷新订阅列表状态
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
      // 切到详情模式：这次点击本身就是用户手势，可以顺势申请权限
      if (mode === 'detail') {
        const ok = await enableDescriptionsNow();
        if (!ok) toast('没拿到网站访问权限，简介会先用标题和域名兜底');
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
  $('#btnSyncPull')?.addEventListener('click', pullFromRemote);
  $('#btnSyncNow')?.addEventListener('click', doSyncNow);
  $('#btnSyncStatus')?.addEventListener('click', refreshSyncStatus);
  $('#btnDavSave')?.addEventListener('click', saveWebdav);
  $('#btnDavTest')?.addEventListener('click', testDav);

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

  // 强调色：预设色块在 renderAccentUI 里逐个挂事件；这里只挂自定义取色器。
  // 用 change 不用 input：拖动取色器会连发几十次，每次都写 storage 太浪费。
  $('#accentPicker').addEventListener('change', (e) => setAccent(e.target.value));

  bindDescNote();
  bindBookmarkImport();
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
    btn.textContent = keys.length ? keys.map(displayHotkey).join(' 或 ') : '（未绑定）';
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
      oldBtn.textContent = keys.length ? keys.map(displayHotkey).join(' 或 ') : '（未绑定）';
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
      btn.textContent = keys.length ? keys.map(displayHotkey).join(' 或 ') : '（未绑定）';
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
      btn.textContent = keys.length ? keys.map(displayHotkey).join(' 或 ') : '（未绑定）';
      btn.classList.remove('recording');
    }
    recordingActionId = null;
    return;
  }

  // 保存
  setHotkey(recordingActionId, keyStr);
  persist();
  const btn = $(`#hotkeyList .hotkey-btn[data-action-id="${recordingActionId}"]`);
  if (btn) { btn.textContent = displayHotkey(keyStr); btn.classList.remove('recording'); }
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
    row.innerHTML = `<span class="hk-help-label">${def.label}</span><span class="hk-help-keys">${keys.length ? keys.map(displayHotkey).join(' / ') : '（未绑定）'}</span>`;
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

/* ================= 日历订阅 ================= */

export function renderFeedList() {
  const list = $('#feedList');
  if (!list) return;
  list.textContent = '';
  const feeds = listFeeds();
  if (feeds.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'feed-empty';
    empty.textContent = '暂无订阅';
    list.append(empty);
    return;
  }
  for (const f of feeds) {
    const li = document.createElement('li');
    li.className = 'feed-item';

    const rt = feedRuntime(f.id); // 同步时间 / 失败原因只存在本机，不在 feeds 里

    const dot = document.createElement('i');
    dot.className = 'feed-color';
    dot.style.background = f.color || '#888';

    const info = document.createElement('div');
    info.className = 'feed-info';
    const name = document.createElement('div');
    name.className = 'feed-name';
    name.textContent = f.title || defaultFeedName(f.url);
    const url = document.createElement('div');
    url.className = 'feed-url';
    url.textContent = f.url;
    const status = document.createElement('div');
    status.className = 'feed-status';
    if (rt.error) status.textContent = `❌ ${rt.error}`;
    else if (rt.lastSync) status.textContent = `✓ ${new Date(rt.lastSync).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
    else status.textContent = '未同步';
    info.append(name, url, status);

    const syncBtn = document.createElement('button');
    syncBtn.className = 'btn small';
    syncBtn.type = 'button';
    syncBtn.textContent = '刷新';
    syncBtn.onclick = async () => {
      toast('同步中…');
      await syncFeed(f.id);
      renderFeedList();
      toast(feedRuntime(f.id).error ? '同步失败' : '已同步');
    };

    const delBtn = document.createElement('button');
    delBtn.className = 'btn danger small';
    delBtn.type = 'button';
    delBtn.textContent = '删除';
    delBtn.onclick = () => {
      if (confirm(`删除订阅「${f.title || defaultFeedName(f.url)}」？`)) {
        removeFeed(f.id);
        renderFeedList();
      }
    };

    li.append(dot, info, syncBtn, delBtn);
    list.append(li);
  }
}

export function bindFeedSettings() {
  $('#btnAddFeed').addEventListener('click', async () => {
    const url = $('#feedUrl').value.trim();
    const name = $('#feedName').value.trim();
    if (!url) { toast('请输入 ICS 地址'); return; }
    // 先请求目标域名的访问权限（扩展环境；Web 预览直接过）
    const ok = await ensureFeedPermission(url);
    if (!ok) { toast('未授权访问该域名'); return; }
    const result = addFeed({ url, name });
    if (!result.ok) { toast(result.error); return; }
    $('#feedUrl').value = '';
    $('#feedName').value = '';
    toast('已添加，正在同步…');
    renderFeedList();
  });
  $('#feedUrl').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#btnAddFeed').click();
  });
}
