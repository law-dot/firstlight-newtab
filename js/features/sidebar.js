// 左侧分组抽屉 + 网站卡片网格 + 分组/网站对话框 + 站点拖拽排序
import { state, persist } from '../core/state.js';
import {
  $, toast, normalizeUrl, hostOf, faviconOf, paintLetter, clearDropMarks
} from '../core/utils.js';
import { uid } from '../core/store.js';
import { renderDock, trackSiteUse } from './dock.js';
import { ensureDescriptions } from './sitedesc.js';
import { renderAll } from '../app.js';

export function renderTabs() {
  const tabs = $('#tabs');
  tabs.textContent = '';

  state.data.groups.forEach((group) => {
    const el = document.createElement('div');
    el.className = 'tab' + (group.id === state.activeGroupId ? ' active' : '');
    el.dataset.id = group.id;

    const name = document.createElement('span');
    name.className = 'tab-name';
    name.textContent = group.name;

    const count = document.createElement('span');
    count.className = 'tab-count';
    count.textContent = String(group.sites.length);

    el.append(name, count);

    if (state.editMode) {
      const rename = document.createElement('button');
      rename.className = 'tab-act';
      rename.type = 'button';
      rename.textContent = '✎';
      rename.title = '重命名分组';
      rename.onclick = (e) => {
        e.stopPropagation();
        openGroupDialog(group);
      };

      const del = document.createElement('button');
      del.className = 'tab-act';
      del.type = 'button';
      del.textContent = '✕';
      del.title = '删除分组';
      del.onclick = (e) => {
        e.stopPropagation();
        removeGroup(group.id);
      };

      el.append(rename, del);
    }

    el.onclick = (e) => {
      if (e.target.closest('.tab-act')) return;
      state.activeGroupId = group.id;
      renderTabs();
      renderGrid();
    };

    el.addEventListener('dragover', (e) => {
      if (!state.dragSiteId) return;
      e.preventDefault();
      el.classList.add('drop-over');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-over'));
    el.addEventListener('drop', (e) => {
      if (!state.dragSiteId) return;
      e.preventDefault();
      el.classList.remove('drop-over');
      moveSite(state.dragFromGroupId, state.dragSiteId, group.id, group.sites.length);
    });

    tabs.append(el);
  });

  const add = document.createElement('button');
  add.className = 'tab-add';
  add.type = 'button';
  add.textContent = '+';
  add.title = '新建分组';
  add.onclick = () => openGroupDialog(null);
  tabs.append(add);
}

export function currentGroup() {
  return state.data.groups.find((g) => g.id === state.activeGroupId) || state.data.groups[0];
}

/* 网站卡片显示模式：minimal 简洁 / standard 标准 / detail 详情，宽度递增 */
export function applySiteMode() {
  const mode = state.data.settings.siteMode || 'standard';
  document.body.classList.toggle('site-minimal', mode === 'minimal');
  document.body.classList.toggle('site-detail', mode === 'detail');
}

/* 布局密度：compact 紧凑 / standard 标准 / comfortable 宽松，影响卡片间距与高度 */
export function applyLayout() {
  const layout = state.data.settings.layout || 'standard';
  document.body.classList.toggle('layout-compact', layout === 'compact');
  document.body.classList.toggle('layout-comfortable', layout === 'comfortable');
}

export function renderGrid() {
  const grid = $('#grid');
  grid.textContent = '';
  const group = currentGroup();
  if (!group) return;

  group.sites.forEach((site) => grid.append(makeCard(site, group)));
  grid.append(makeAddTile(group));

  // 详情模式：懒抓缺失的站点简介（内部做权限与去重判断）
  ensureDescriptions(group);
}

function makeCard(site, group) {
  const card = document.createElement('a');
  card.className = 'card';
  card.href = site.url;
  card.draggable = state.editMode;
  card.dataset.id = site.id;
  card.title = `${site.title}\n${site.url}`;

  const ico = document.createElement('div');
  ico.className = 'ico';

  const customIcon = site.icon || '';
  const iconSrc = customIcon || faviconOf(site.url);

  if (iconSrc) {
    const img = document.createElement('img');
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.draggable = false;
    img.style.pointerEvents = 'none';
    if (!customIcon) img.className = 'fav';
    img.onerror = () => {
      img.remove();
      paintLetter(ico, site);
    };
    img.src = iconSrc;
    ico.append(img);
  } else {
    paintLetter(ico, site);
  }

  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = site.title || hostOf(site.url);

  // 详情模式：手动说明优先，其次自动抓取的简介
  let desc = null;
  if (state.data.settings.siteMode === 'detail') {
    const text = site.desc || site.autoDesc;
    if (text) {
      desc = document.createElement('div');
      desc.className = 'desc';
      desc.textContent = text;
    }
  }

  const acts = document.createElement('div');
  acts.className = 'acts';

  const edit = document.createElement('button');
  edit.className = 'mini';
  edit.type = 'button';
  edit.textContent = '✎';
  edit.title = '编辑';
  edit.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    openSiteDialog(group.id, site);
  };

  const del = document.createElement('button');
  del.className = 'mini';
  del.type = 'button';
  del.textContent = '✕';
  del.title = '删除';
  del.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    removeSite(group.id, site.id, site.title);
  };

  acts.append(edit, del);
  card.append(ico, name, ...(desc ? [desc] : []), acts);

  card.addEventListener('click', (e) => {
    if (state.editMode || e.target.closest('.acts')) {
      e.preventDefault();
      return;
    }
    // 点击统计（智能 Dock 数据源）：等计数落盘后跳转，最多等 80ms
    e.preventDefault();
    trackSiteUse(site.id).finally(() => {
      location.href = site.url;
    });
  });

  card.addEventListener('dragstart', (e) => {
    if (!state.editMode) return;
    state.dragSiteId = site.id;
    state.dragFromGroupId = group.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', site.id);
    card.classList.add('dragging');
    if (document.body.classList.contains('side-collapsed')) {
      state.sideAutoOpened = true;
      document.body.classList.remove('side-collapsed');
    }
  });

  card.addEventListener('dragend', () => {
    card.classList.remove('dragging');
    state.dragSiteId = null;
    state.dragFromGroupId = null;
    clearDropMarks();
    if (state.sideAutoOpened) {
      state.sideAutoOpened = false;
      document.body.classList.add('side-collapsed');
    }
  });

  card.addEventListener('dragover', (e) => {
    if (!state.dragSiteId) return;
    e.preventDefault();
    const rect = card.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    card.classList.toggle('drop-before', !after);
    card.classList.toggle('drop-after', after);
  });

  card.addEventListener('dragleave', () => {
    card.classList.remove('drop-before', 'drop-after');
  });

  card.addEventListener('drop', (e) => {
    if (!state.dragSiteId) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = card.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    const index = group.sites.findIndex((s) => s.id === site.id);
    clearDropMarks();
    moveSite(state.dragFromGroupId, state.dragSiteId, group.id, index + (after ? 1 : 0));
  });

  return card;
}

function makeAddTile(group) {
  const btn = document.createElement('button');
  btn.className = 'card add';
  btn.type = 'button';
  btn.textContent = '+';
  btn.title = '添加网站';
  btn.onclick = () => openSiteDialog(group.id, null);
  return btn;
}

/* ================= 分组抽屉状态 ================= */
export function applySideState() {
  document.body.classList.toggle('side-collapsed', !!state.data.settings.sideCollapsed);
}

export function setSideCollapsed(collapsed) {
  state.data.settings.sideCollapsed = collapsed;
  persist();
  applySideState();
}

/* ================= 网站 / 分组对话框 ================= */
function openSiteDialog(groupId, site) {
  state.siteCtx.groupId = groupId;
  state.siteCtx.siteId = site ? site.id : null;
  $('#siteDlgTitle').textContent = site ? '编辑网站' : '添加网站';
  $('#siteTitle').value = site ? site.title : '';
  $('#siteUrl').value = site ? site.url : '';
  $('#siteIcon').value = site ? site.icon : '';
  $('#siteDesc').value = site ? site.desc || '' : '';
  $('#siteDialog').showModal();
  setTimeout(() => $('#siteUrl').focus(), 40);
}

function saveSite(e) {
  e.preventDefault();
  const title = $('#siteTitle').value.trim();
  const url = normalizeUrl($('#siteUrl').value.trim());
  const icon = $('#siteIcon').value.trim();
  const desc = $('#siteDesc').value.trim().slice(0, 120);

  if (!url) {
    toast('网址格式不正确');
    return;
  }

  const group =
    state.data.groups.find((g) => g.id === state.siteCtx.groupId) || currentGroup();

  if (state.siteCtx.siteId) {
    const site = group?.sites.find((s) => s.id === state.siteCtx.siteId);
    if (site) {
      // 网址变了：之前抓的简介失效，清空后重新抓取
      if (site.url !== url) site.autoDesc = '';
      site.title = title || hostOf(url);
      site.url = url;
      site.icon = icon;
      site.desc = desc;
    }
  } else if (group) {
    group.sites.push({
      id: uid(),
      title: title || hostOf(url),
      url,
      icon,
      desc,
      autoDesc: ''
    });
  }

  $('#siteDialog').close();
  persist();
  renderTabs();
  renderGrid(); // 详情模式下 renderGrid 内部会自动补抓缺失的简介
  renderDock();
  toast('已保存');
}

function removeSite(groupId, siteId, title) {
  if (!confirm(`删除「${title || '该网站'}」？`)) return;
  const group = state.data.groups.find((g) => g.id === groupId);
  if (!group) return;
  group.sites = group.sites.filter((s) => s.id !== siteId);
  persist();
  renderTabs();
  renderGrid();
  renderDock();
}

function openGroupDialog(group) {
  state.groupCtx.groupId = group ? group.id : null;
  $('#groupDlgTitle').textContent = group ? '重命名分组' : '新建分组';
  $('#groupName').value = group ? group.name : '';
  $('#groupDialog').showModal();
  setTimeout(() => $('#groupName').focus(), 40);
}

function saveGroup(e) {
  e.preventDefault();
  const name = $('#groupName').value.trim();
  if (!name) return;

  if (state.groupCtx.groupId) {
    const group = state.data.groups.find((g) => g.id === state.groupCtx.groupId);
    if (group) group.name = name;
  } else {
    const group = { id: uid(), name, sites: [] };
    state.data.groups.push(group);
    state.activeGroupId = group.id;
  }

  $('#groupDialog').close();
  persist();
  renderTabs();
  renderGrid();
  renderDock();
}

function removeGroup(groupId) {
  if (state.data.groups.length <= 1) {
    toast('至少保留一个分组');
    return;
  }
  const group = state.data.groups.find((g) => g.id === groupId);
  if (!group) return;
  if (!confirm(`删除分组「${group.name}」及其中 ${group.sites.length} 个网站？`)) return;
  state.data.groups = state.data.groups.filter((g) => g.id !== groupId);
  if (state.activeGroupId === groupId) state.activeGroupId = state.data.groups[0].id;
  persist();
  renderAll();
}

/* ================= 拖拽排序 ================= */
function moveSite(fromGroupId, siteId, toGroupId, index) {
  const from = state.data.groups.find((g) => g.id === fromGroupId);
  const to = state.data.groups.find((g) => g.id === toGroupId);
  if (!from || !to) return;

  const i = from.sites.findIndex((s) => s.id === siteId);
  if (i < 0) return;

  const [site] = from.sites.splice(i, 1);
  let at = index;
  if (from === to && i < at) at -= 1;
  at = Math.max(0, Math.min(at, to.sites.length));
  to.sites.splice(at, 0, site);

  // 如果 site 从 group A 移到 group B，dock 引用里的 groupId 同步更新
  if (fromGroupId !== toGroupId) {
    state.data.dock.forEach((d) => {
      if (d.groupId === fromGroupId && d.siteId === siteId) d.groupId = toGroupId;
    });
  }

  state.activeGroupId = to.id;
  state.dragSiteId = null;
  state.dragFromGroupId = null;
  persist();
  renderTabs();
  renderGrid();
  renderDock();
}

/* ================= 事件绑定 ================= */
export function bindSidebar() {
  $('#btnCollapseSide').addEventListener('click', () => setSideCollapsed(true));
  $('#btnOpenSide').addEventListener('click', () => setSideCollapsed(false));

  $('#siteForm').addEventListener('submit', saveSite);
  $('#groupForm').addEventListener('submit', saveGroup);

  $('#grid').addEventListener('dragover', (e) => {
    if (!state.dragSiteId) return;
    e.preventDefault();
  });
  $('#grid').addEventListener('drop', (e) => {
    if (!state.dragSiteId) return;
    if (e.target.closest('.card')) return;
    e.preventDefault();
    const group = currentGroup();
    moveSite(state.dragFromGroupId, state.dragSiteId, group.id, group.sites.length);
  });
}

/* ================= 鼠标靠左自动展开分组抽屉 ================= */
export function bindSidePeek() {
  const ZONE = 18;
  const LEAVE_DELAY = 320;
  let closeTimer = 0;

  const close = () => {
    closeTimer = 0;
    document.body.classList.remove('side-peek');
  };

  document.addEventListener('mousemove', (e) => {
    if (state.idleActive) {
      document.body.classList.remove('side-peek');
      return;
    }
    // 只在「已收起」状态下提供自动展开，手动展开视为用户要固定显示
    if (!state.data.settings.sideCollapsed) {
      clearTimeout(closeTimer);
      closeTimer = 0;
      document.body.classList.remove('side-peek');
      return;
    }

    if (e.clientX <= ZONE) {
      clearTimeout(closeTimer);
      closeTimer = 0;
      document.body.classList.add('side-peek');
      return;
    }

    if (!document.body.classList.contains('side-peek')) return;
    const width = document.querySelector('.side')?.getBoundingClientRect().width || 224;
    if (e.clientX <= width + 10) {
      clearTimeout(closeTimer);
      closeTimer = 0;
      return;
    }
    if (!closeTimer) closeTimer = setTimeout(close, LEAVE_DELAY);
  });

  document.addEventListener('mouseleave', () => {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(close, LEAVE_DELAY);
  });

  // 收起后左上角那个小圆钮本身就是「展开」入口，悬停它也算靠边
  document.querySelector('.side-rail')?.addEventListener('mouseenter', () => {
    if (state.idleActive || !state.data.settings.sideCollapsed) return;
    clearTimeout(closeTimer);
    closeTimer = 0;
    document.body.classList.add('side-peek');
  });
}
