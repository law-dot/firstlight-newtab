// 从浏览器收藏夹导入（Edge / Chrome 通用）
// 只做**一次性拷贝**，不做双向同步：书签是书签，初见是初见，
// 免得和浏览器自带的书签管理器抢地盘。但导入是幂等的——按网址去重，
// 再点一次只会补新增的，不会产生重复卡片。
import { state, persist } from '../core/state.js';
import { $, $$, toast, toastAction, normalizeUrl, hostOf } from '../core/utils.js';
import { uid, makeDefault } from '../core/store.js';
import { renderAll } from '../app.js';

const MAX_TITLE = 20;
const MAX_GROUP_NAME = 12;
// 单个分组能安全同步的上限：storage.sync 单条 8KB ≈ 49 个站点，
// 超了整组不同步（见 sync.js pushRecords）。导入时按 40 个一组拆开留余量。
const SAFE_GROUP_SITES = 40;

let lastImport = null; // 上一次导入的结果，撤销用

export function bookmarksAvailable() {
  return typeof chrome !== 'undefined' && !!(chrome.bookmarks && chrome.bookmarks.getTree);
}

/* ---------- 首启动引导条 ---------- */
// 出厂自带的是「示例网站」，对小白毫无意义。第一次打开就在卡片区上方说明一句，
// 顺手给出唯一有价值的动作。关掉之后不再打扰，卡片区还留着安静的入口。
export function syncImportNote() {
  const el = $('#importNote');
  if (!el) return false;
  const show = state.data.settings.showImportCta !== false
    && !state.data.settings.importNoteDone
    && bookmarksAvailable();
  el.hidden = !show;
  return show;
}

function dismissImportNote() {
  state.data.settings.importNoteDone = true;
  persist();
  renderAll(); // 引导条换成卡片区那个安静的「导入收藏夹」格子
}

/* ---------- 读树 → 计划 ---------- */
function collect(node, items) {
  for (const child of node.children || []) {
    if (child.url) items.push({ title: child.title || '', url: child.url });
    else if (child.children) collect(child, items);
  }
}

// 顶层文件夹 → 一个分组；文件夹里再深的内容拍平并入父组；
// 直接挂在「书签栏 / 收藏夹栏」下的散书签统一进一个「收藏夹」分组。
export function planFromTree(tree) {
  const plan = [];
  const loose = [];
  const roots = Array.isArray(tree) ? tree : [];
  for (const root of roots) {
    for (const container of root.children || []) {
      for (const child of container.children || []) {
        if (child.url) {
          loose.push({ title: child.title || '', url: child.url });
          continue;
        }
        if (!child.children) continue;
        const items = [];
        collect(child, items);
        if (items.length) {
          plan.push({
            key: child.id,
            name: child.title || '未命名',
            from: container.title || '',
            items
          });
        }
      }
    }
  }
  if (loose.length) {
    plan.push({ key: 'loose', name: '收藏夹', from: '', items: loose, loose: true });
  }
  return plan;
}

/* ---------- 网址与标题清洗 ---------- */
function cleanUrl(raw) {
  const u = normalizeUrl(raw);
  if (!u || !/^https?:/i.test(u)) return '';
  return u;
}

// 去重键：协议 + 主机 + 路径（去掉末尾 / 和 #hash），保留 query
export function urlKey(raw) {
  try {
    const u = new URL(raw);
    const path = u.pathname.replace(/\/+$/, '');
    return `${u.protocol}//${u.host}${path}${u.search}`.toLowerCase();
  } catch {
    return String(raw || '').toLowerCase();
  }
}

/* ---------- 大文件夹智能拆分 ----------
   收藏夹全堆在默认文件夹里是常态，一个组塞几百个站点既看不过来，
   也撞同步单条上限。拆法：同域名的排一起（大头域名在前，长尾按字母序），
   再按 SAFE_GROUP_SITES 切块——切块边界尽量落在域名交界，同一批里
   站点尽量是「一家」的。首组沿用原文件夹名，后续加序号。 */
function splitSites(sites, baseName) {
  if (sites.length <= SAFE_GROUP_SITES) return [{ name: baseName, sites }];
  const byHost = new Map();
  for (const s of sites) {
    let h = '';
    try {
      h = new URL(s.url).host.replace(/^www\./, '');
    } catch {
      /* 拿不到 host 的归入长尾 */
    }
    if (!byHost.has(h)) byHost.set(h, []);
    byHost.get(h).push(s);
  }
  const clusters = [...byHost.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([, list]) => list);
  const chunks = [];
  let cur = [];
  for (const cluster of clusters) {
    if (cluster.length > SAFE_GROUP_SITES) {
      // 单个域名自己就超了，只能硬切
      if (cur.length) {
        chunks.push(cur);
        cur = [];
      }
      for (let i = 0; i < cluster.length; i += SAFE_GROUP_SITES) {
        chunks.push(cluster.slice(i, i + SAFE_GROUP_SITES));
      }
      continue;
    }
    if (cur.length + cluster.length > SAFE_GROUP_SITES) {
      chunks.push(cur);
      cur = [];
    }
    cur = cur.concat(cluster);
  }
  if (cur.length) chunks.push(cur);
  return chunks.map((chunk, i) => ({
    name: i === 0 ? baseName : `${baseName} ${i + 1}`,
    sites: chunk
  }));
}

function titleOf(raw, url) {
  const t = String(raw || '').replace(/\s+/g, ' ').trim();
  return (t || hostOf(url)).slice(0, MAX_TITLE);
}

function uniqueName(base, used) {
  const name = String(base || '收藏夹').trim().slice(0, MAX_GROUP_NAME) || '收藏夹';
  if (!used.has(name)) return name;
  for (let i = 2; i < 100; i += 1) {
    const suffix = ` ${i}`;
    const candidate = name.slice(0, MAX_GROUP_NAME - suffix.length) + suffix;
    if (!used.has(candidate)) return candidate;
  }
  return name;
}

/* ---------- 预览对话框 ---------- */
export async function openImportDialog() {
  if (!bookmarksAvailable()) {
    toast('当前环境读不到浏览器收藏夹');
    return;
  }
  let tree;
  try {
    tree = await chrome.bookmarks.getTree();
  } catch {
    toast('读取收藏夹失败，请确认扩展有「读取收藏夹」权限');
    return;
  }
  const plan = planFromTree(tree);
  const usable = plan.filter((p) => p.items.some((it) => cleanUrl(it.url)));
  if (!usable.length) {
    toast('收藏夹里没有可导入的网站');
    return;
  }

  const list = $('#importList');
  list.textContent = '';
  const total = usable.reduce((n, p) => n + p.items.length, 0);
  const nGroups = state.data.groups.length;
  $('#importSummary').textContent =
    `找到 ${usable.length} 个文件夹、${total} 个书签。勾选的文件夹会各建一个分组，已有的网站不会重复添加。` +
    `超过 ${SAFE_GROUP_SITES} 个的文件夹会按同域名就近自动拆成多个分组，保证每组都能正常同步。`;
  $('#importHint').textContent = nGroups
    ? `当前已有 ${nGroups} 个分组，导入的分组会排在后面。`
    : '';

  usable.forEach((folder) => {
    const row = document.createElement('label');
    row.className = 'import-row';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.dataset.key = String(folder.key);

    const name = document.createElement('span');
    name.className = 'import-name';
    name.textContent = folder.name + (folder.loose ? '（书签栏上散着的）' : '');

    const count = document.createElement('span');
    count.className = 'import-count';
    const parts = Math.ceil(folder.items.length / SAFE_GROUP_SITES);
    count.textContent = `${folder.items.length} 个${parts > 1 ? ` · 约拆 ${parts} 组` : ''}`;

    row.append(cb, name, count);
    list.append(row);
  });

  // 完整数据挂在模块变量上，不塞进 DOM 属性
  pendingPlan = usable;
  $('#importDialog').showModal();
}

let pendingPlan = [];

/* ---------- 真正导入 ---------- */
export function importSelected() {
  const picked = new Set(
    $$('#importList input[type="checkbox"]')
      .filter((cb) => cb.checked)
      .map((cb) => cb.dataset.key)
  );
  const folders = pendingPlan.filter((p) => picked.has(String(p.key)));
  if (!folders.length) {
    toast('没有勾选任何文件夹');
    return null;
  }

  const seen = new Set();
  for (const g of state.data.groups) for (const s of g.sites) seen.add(urlKey(s.url));
  const usedNames = new Set(state.data.groups.map((g) => g.name));

  const created = [];
  let added = 0;
  let skipped = 0;

  for (const folder of folders) {
    const sites = [];
    for (const item of folder.items) {
      const url = cleanUrl(item.url);
      if (!url) {
        skipped += 1;
        continue;
      }
      const key = urlKey(url);
      if (seen.has(key)) {
        skipped += 1;
        continue;
      }
      seen.add(key);
      sites.push({ id: uid(), title: titleOf(item.title, url), url, icon: '', desc: '', autoDesc: '' });
    }
    if (!sites.length) continue;
    // 超过安全上限的文件夹自动拆成多个分组
    for (const part of splitSites(sites, folder.name)) {
      const group = { id: uid(), name: uniqueName(part.name, usedNames), sites: part.sites };
      usedNames.add(group.name);
      state.data.groups.push(group);
      created.push(group);
      added += part.sites.length;
    }
  }

  if (!added) {
    toast('这些书签都已经在里面了');
    return null;
  }

  state.data.settings.showImportCta = false;
  state.activeGroupId = created[0].id;
  persist();
  renderAll();

  lastImport = created.map((g) => g.id); // 撤销范围：本次新建的分组
  return { added, skipped, groups: created.length };
}

export function undoLastImport() {
  if (!lastImport || !lastImport.length) {
    toast('没有可撤销的导入');
    return;
  }
  const ids = new Set(lastImport);
  const before = state.data.groups.length;
  state.data.groups = state.data.groups.filter((g) => !ids.has(g.id));
  if (!state.data.groups.length) state.data.groups = makeDefault().groups;
  lastImport = null;
  state.activeGroupId = state.data.groups[0].id;
  persist();
  renderAll();
  toast(`已撤销导入，移除了 ${before - state.data.groups.length} 个分组`);
}

/* ---------- 事件绑定 ---------- */
export function bindBookmarkImport() {
  $('#btnImportBm')?.addEventListener('click', openImportDialog);
  $('#importNoteGo')?.addEventListener('click', openImportDialog);
  $('#importNoteSkip')?.addEventListener('click', dismissImportNote);
  $('#importConfirm')?.addEventListener('click', () => {
    const res = importSelected();
    $('#importDialog')?.close();
    if (!res) return;
    toastAction(
      `已导入 ${res.added} 个网站${res.skipped ? `，跳过 ${res.skipped} 个重复/无效项` : ''}`,
      '撤销',
      undoLastImport
    );
  });
}
