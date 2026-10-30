// Dock 栏：三种模式
// auto   = 智能：按点击统计自动收录 Top5，编辑模式下可屏蔽站点（不再自动收录）
// manual = 手动：编辑模式下从分组拖入置顶，支持 dock 内部拖拽排序
// off    = 关闭
import { state, persist } from '../core/state.js';
import { $, hostOf, faviconOf, paintLetter, clearDropMarks, toast } from '../core/utils.js';

/* ---------- 使用统计：智能 Dock 的数据源 ---------- */
// 卡片/ Dock 点击时调用；返回的 promise 与页面跳转赛跑（最多 80ms），尽量让计数落盘
export function trackSiteUse(siteId) {
  const stats = state.data.stats || (state.data.stats = {});
  const rec = stats[siteId] || (stats[siteId] = { n: 0, last: 0 });
  rec.n += 1;
  rec.last = Date.now();
  return Promise.race([persist(), new Promise((r) => setTimeout(r, 80))]);
}

function isAuto() {
  return (state.data.settings.dockMode || 'auto') === 'auto';
}

// 智能 Top5：总次数降序，同次数按最近使用；排除已屏蔽
function smartTop() {
  const blocked = new Set(state.data.settings.dockBlocked || []);
  const stats = state.data.stats || {};
  const all = [];
  for (const g of state.data.groups) {
    for (const s of g.sites) {
      if (blocked.has(`${g.id}:${s.id}`)) continue;
      const rec = stats[s.id];
      if (!rec || !rec.n) continue;
      all.push({ group: g, site: s, n: rec.n, last: rec.last });
    }
  }
  all.sort((a, b) => b.n - a.n || b.last - a.last);
  return all.slice(0, 5);
}

export function applyDockMode() {
  const mode = state.data.settings.dockMode || 'auto';
  document.body.classList.toggle('dock-off', mode === 'off');
  document.body.classList.toggle('dock-auto', mode === 'auto');
}

export function renderDock() {
  if (isAuto()) return renderAutoDock();
  return renderManualDock();
}

/* ---------- 共享：dock 图标元素（图标加载失败回退首字母） ---------- */
function makeDockIcon(site) {
  const el = document.createElement('a');
  el.className = 'dock-item';
  el.href = site.url;

  const ico = document.createElement('div');
  ico.className = 'ico';
  const customIcon = site.icon || '';
  const iconSrc = customIcon || faviconOf(site.url);
  if (iconSrc) {
    const img = document.createElement('img');
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.draggable = false;
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
  el.append(ico);
  return el;
}

/* ---------- 智能 Dock ---------- */
function renderAutoDock() {
  const dock = $('#dock');
  dock.textContent = '';
  const top = smartTop();
  if (!top.length) {
    dock.classList.add('empty');
    return;
  }
  dock.classList.remove('empty');

  top.forEach(({ group, site, n }) => {
    const el = makeDockIcon(site);
    el.title = `${site.title || hostOf(site.url)} · 使用 ${n} 次\n${site.url}`;

    // 编辑模式：✕ = 屏蔽该站点，不再自动收录
    const rm = document.createElement('button');
    rm.className = 'rm';
    rm.type = 'button';
    rm.textContent = '✕';
    rm.title = '不再自动收录该网站';
    rm.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const blocked = state.data.settings.dockBlocked || (state.data.settings.dockBlocked = []);
      blocked.push(`${group.id}:${site.id}`);
      persist();
      renderDock();
      toast(`已屏蔽「${site.title || hostOf(site.url)}」`);
    };
    el.append(rm);

    el.addEventListener('click', (e) => {
      if (state.editMode || e.target.closest('.rm')) {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      trackSiteUse(site.id).finally(() => {
        location.href = site.url;
      });
    });

    dock.append(el);
  });
}

/* ---------- 手动 Dock ---------- */
function renderManualDock() {
  const dock = $('#dock');
  dock.textContent = '';

  // 先做一次轻量清理：引用指向的 group 或 site 不存在就删掉
  const cleaned = state.data.dock.filter((d) => {
    const g = state.data.groups.find((g) => g.id === d.groupId);
    return g && g.sites.some((s) => s.id === d.siteId);
  });
  if (cleaned.length !== state.data.dock.length) {
    state.data.dock = cleaned;
    persist();
  }

  if (!state.data.dock.length) {
    dock.classList.add('empty');
    return;
  }
  dock.classList.remove('empty');

  state.data.dock.forEach((entry, index) => {
    const group = state.data.groups.find((g) => g.id === entry.groupId);
    const site = group?.sites.find((s) => s.id === entry.siteId);
    if (!site) return;

    const el = makeDockIcon(site);
    el.title = `${site.title || hostOf(site.url)}\n${site.url}`;
    el.draggable = state.editMode;
    el.dataset.index = String(index);

    // 编辑模式下显示移除按钮（只从 dock 移除，不删源站）
    const rm = document.createElement('button');
    rm.className = 'rm';
    rm.type = 'button';
    rm.textContent = '✕';
    rm.title = '从 Dock 移除';
    rm.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      state.data.dock.splice(index, 1);
      persist();
      renderDock();
    };
    el.append(rm);

    el.addEventListener('click', (e) => {
      if (state.editMode || e.target.closest('.rm')) {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      trackSiteUse(site.id).finally(() => {
        location.href = site.url;
      });
    });

    // 从 dock 拖出
    el.addEventListener('dragstart', (e) => {
      if (!state.editMode) return;
      state.dragDockIndex = index;
      state.dragSiteId = site.id;
      state.dragFromGroupId = group.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', site.id);
      el.classList.add('dragging');
    });

    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      state.dragDockIndex = null;
      state.dragSiteId = null;
      state.dragFromGroupId = null;
      dock.classList.remove('drag-over');
      clearDropMarks();
    });

    // dock 内部 reorder 指示线
    el.addEventListener('dragover', (e) => {
      if (state.dragDockIndex === null && !state.dragSiteId) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const after = e.clientX > rect.left + rect.width / 2;
      el.classList.toggle('drop-before', !after);
      el.classList.toggle('drop-after', after);
    });

    el.addEventListener('dragleave', () => {
      el.classList.remove('drop-before', 'drop-after');
    });

    el.addEventListener('drop', (e) => {
      if (state.dragDockIndex === null && !state.dragSiteId) return;
      e.preventDefault();
      e.stopPropagation();
      const rect = el.getBoundingClientRect();
      const after = e.clientX > rect.left + rect.width / 2;
      clearDropMarks();
      dock.classList.remove('drag-over');

      if (state.dragDockIndex !== null) {
        // dock 内部 reorder
        const from = state.dragDockIndex;
        let to = index + (after ? 1 : 0);
        if (from < to) to -= 1;
        if (from === to) {
          state.dragDockIndex = null;
          return;
        }
        const [entryD] = state.data.dock.splice(from, 1);
        state.data.dock.splice(to, 0, entryD);
        persist();
        renderDock();
      } else if (state.dragSiteId !== null) {
        // 从分组拖入 dock
        addToDock(state.dragFromGroupId, state.dragSiteId, index + (after ? 1 : 0));
      }
      state.dragDockIndex = null;
    });

    dock.append(el);
  });
}

export function addToDock(groupId, siteId, index) {
  // 去重：已存在则把它移到目标位置
  const existing = state.data.dock.findIndex(
    (d) => d.groupId === groupId && d.siteId === siteId
  );
  const entry = { groupId, siteId };
  if (existing >= 0) {
    const [old] = state.data.dock.splice(existing, 1);
    if (old.groupId !== groupId) old.groupId = groupId;
    let at = index;
    if (existing < at) at -= 1;
    state.data.dock.splice(Math.max(0, at), 0, old);
  } else {
    state.data.dock.splice(Math.max(0, Math.min(index ?? state.data.dock.length, state.data.dock.length)), 0, entry);
  }
  persist();
  renderDock();
}

export function bindDock() {
  // 智能模式下 dock 不可拖入/排序，以下手势只对手动模式生效
  $('#dock').addEventListener('dragover', (e) => {
    if (isAuto() || !state.dragSiteId) return;
    e.preventDefault();
    $('#dock').classList.add('drag-over');
  });
  $('#dock').addEventListener('dragleave', (e) => {
    if (e.target !== $('#dock')) return;
    $('#dock').classList.remove('drag-over');
  });
  $('#dock').addEventListener('drop', (e) => {
    if (isAuto() || !state.dragSiteId) return;
    e.preventDefault();
    $('#dock').classList.remove('drag-over');

    if (state.dragDockIndex !== null) {
      const from = state.dragDockIndex;
      const [entry] = state.data.dock.splice(from, 1);
      state.data.dock.push(entry);
      persist();
      renderDock();
    } else {
      addToDock(state.dragFromGroupId, state.dragSiteId, state.data.dock.length);
    }
    state.dragDockIndex = null;
  });

  $('#dock').addEventListener('click', (e) => {
    if (e.target === $('#dock')) e.preventDefault();
  });
}
