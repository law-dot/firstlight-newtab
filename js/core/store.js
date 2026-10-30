// 数据持久化：扩展内用 chrome.storage.local，普通网页预览时退回 localStorage
// v1.4.2 起按分段存储：settings/groups/todos/dock/events 各一条记录、各带 updatedAt，
// 为将来接入同步（chrome.storage.sync / WebDAV）预留数据通路。
const LEGACY_KEY = 'monk.data.v1'; // v1.4.1 及之前的单 blob，首次启动自动迁移
const DB_NAME = 'monk';
const DB_STORE = 'files';

export const SECTIONS = ['settings', 'groups', 'todos', 'dock', 'events', 'feeds', 'stats'];
const sectionKey = (s) => `monk.${s}.v1`;
const SYNC_CONF_KEY = 'monk.syncconf.v1'; // 同步配置只存本机，永不参与同步

const hasExt = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;

export function uid() {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

export function makeDefault() {
  return {
    version: 1,
    groups: [
      {
        id: uid(),
        name: '常用',
        sites: [
          { id: uid(), title: '飞书', url: 'https://www.feishu.cn', icon: '' },
          { id: uid(), title: '知乎', url: 'https://www.zhihu.com', icon: '' },
          { id: uid(), title: '哔哩哔哩', url: 'https://www.bilibili.com', icon: '' },
          { id: uid(), title: '微信读书', url: 'https://weread.qq.com', icon: '' }
        ]
      },
      {
        id: uid(),
        name: '工作',
        sites: [
          { id: uid(), title: '语雀', url: 'https://www.yuque.com', icon: '' },
          { id: uid(), title: 'GitHub', url: 'https://github.com', icon: '' }
        ]
      },
      {
        id: uid(),
        name: '娱乐',
        sites: [
          { id: uid(), title: '豆瓣', url: 'https://www.douban.com', icon: '' }
        ]
      }
    ],
    settings: {
      engine: 'baidu',
      customEngine: '',
      theme: 'auto',
      wallpaper: { type: 'online', value: '', dim: 30 },
      onlineMode: 'daily',
      onlineInterval: 30,
      onlineSource: 'auto',
      customWallpaperUrl: '',
      weatherCity: '',
      weather: null,
      idleMinutes: 10,
      idleTicker: true,
      fxMode: 'idle',
      todoMode: 'fab',
      edgeSettings: true,
      sideCollapsed: true,
      dockMode: 'auto',
      dockBlocked: [],
      showOnboarding: true,
      hotkeys: {},
      siteMode: 'standard',
      layout: 'standard',
      pomodoro: {
        work: 25,
        shortBreak: 5,
        longBreak: 15,
        longBreakEvery: 4,
        autoNext: true,
        soundOn: true
      }
    },
    todos: [],
    dock: [],
    events: [],
    feeds: [],
    stats: {}
  };
}

export function normalize(raw) {
  const base = makeDefault();
  if (!raw || typeof raw !== 'object') return base;

  const groups = Array.isArray(raw.groups)
    ? raw.groups
        .filter((g) => g && typeof g === 'object')
        .map((g) => ({
          id: g.id || uid(),
          name: String(g.name || '未命名'),
          sites: Array.isArray(g.sites)
            ? g.sites
                .filter((s) => s && s.url)
                .map((s) => ({
                  id: s.id || uid(),
                  title: String(s.title || ''),
                  url: String(s.url),
                  icon: String(s.icon || ''),
                  // desc：手动填写的说明（优先展示）；autoDesc：自动抓取的站点简介缓存
                  desc: String(s.desc || '').slice(0, 120),
                  autoDesc: String(s.autoDesc || '').slice(0, 120)
                }))
            : []
        }))
    : [];

  const todos = Array.isArray(raw.todos)
    ? raw.todos
        .filter((t) => t && t.text)
        .map((t) => ({ id: t.id || uid(), text: String(t.text), done: !!t.done }))
    : [];

  const settings = { ...base.settings, ...(raw.settings || {}) };
  // 兼容旧版：showTodo 开关 → todoMode 三态
  if (!['fab', 'docked', 'hidden'].includes(settings.todoMode)) {
    settings.todoMode = settings.showTodo === false ? 'hidden' : 'fab';
  }
  delete settings.showTodo;
  const wallpaper = { ...base.settings.wallpaper, ...(settings.wallpaper || {}) };
  // 兼容旧版：Bing 壁纸改名为「在线壁纸」
  if (wallpaper.type === 'bing') {
    wallpaper.type = 'online';
    wallpaper.online = wallpaper.bing;
    delete wallpaper.bing;
  }
  settings.wallpaper = wallpaper;
  if (!['auto', 'bing', 'custom'].includes(settings.onlineSource)) settings.onlineSource = 'auto';
  if (!['daily', 'rotate', 'interval'].includes(settings.onlineMode)) settings.onlineMode = 'daily';
  settings.onlineInterval = [10, 30, 60].includes(Number(settings.onlineInterval)) ? Number(settings.onlineInterval) : 30;
  // Dock 三态：智能(自动收录 Top5) / 手动 / 关闭；旧版 'on' 迁移为手动
  if (settings.dockMode === 'on') settings.dockMode = 'manual';
  if (!['auto', 'manual', 'off'].includes(settings.dockMode)) settings.dockMode = 'auto';
  settings.dockBlocked = Array.isArray(settings.dockBlocked)
    ? settings.dockBlocked.map(String).slice(0, 200)
    : [];
  if (!['minimal', 'standard', 'detail'].includes(settings.siteMode)) settings.siteMode = 'standard';
  if (!['compact', 'standard', 'comfortable'].includes(settings.layout)) settings.layout = 'standard';

  // pomodoro：补默认值 + 范围约束
  const defPom = base.settings.pomodoro;
  const pom = { ...defPom, ...(settings.pomodoro || {}) };
  pom.work = clamp(pom.work, 1, 180);
  pom.shortBreak = clamp(pom.shortBreak, 1, 60);
  pom.longBreak = clamp(pom.longBreak, 1, 60);
  pom.longBreakEvery = clamp(pom.longBreakEvery, 1, 12);
  pom.autoNext = !!pom.autoNext;
  pom.soundOn = !!pom.soundOn;
  settings.pomodoro = pom;

  // dock：只保留指向真实存在的 groupId + siteId 条目
  const dock = Array.isArray(raw.dock)
    ? raw.dock
        .filter((d) => d && d.groupId && d.siteId)
        .map((d) => ({ groupId: String(d.groupId), siteId: String(d.siteId) }))
    : [];
  const validDock = dock.filter((d) => {
    const g = groups.find((g) => g.id === d.groupId);
    return g && g.sites.some((s) => s.id === d.siteId);
  });

  // events：日历日程，按 ISO 日期字符串分组 { date: 'YYYY-MM-DD', id, text, time? }
  const events = Array.isArray(raw.events)
    ? raw.events
        .filter((e) => e && e.date && e.text)
        .map((e) => ({
          id: e.id || uid(),
          date: String(e.date),
          text: String(e.text).slice(0, 120),
          time: e.time ? String(e.time).slice(0, 5) : ''
        }))
    : [];

  // feeds：RSS 订阅源，标题可留空（首次抓取后自动回填）
  const feeds = Array.isArray(raw.feeds)
    ? raw.feeds
        .filter((f) => f && f.url)
        .map((f) => ({
          id: f.id || uid(),
          title: String(f.title || '').slice(0, 40),
          url: String(f.url)
        }))
    : [];

  // stats：站点点击统计 { siteId: { n, last } }，智能 Dock 的数据源
  const stats = {};
  if (raw.stats && typeof raw.stats === 'object') {
    for (const [k, v] of Object.entries(raw.stats)) {
      const n = Math.floor(Number(v?.n));
      if (n > 0) stats[k] = { n, last: Number(v.last) || 0 };
    }
  }

  return {
    version: 1,
    groups: groups.length ? groups : base.groups,
    settings,
    todos,
    dock: validDock,
    events,
    feeds,
    stats
  };
}

function clamp(v, min, max) {
  const n = Number(v);
  if (!isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

/* ---------- 底层键值读写（扩展 / 预览双通道） ---------- */
async function kvGet(keys) {
  if (hasExt) return chrome.storage.local.get(keys);
  const out = {};
  for (const k of keys) {
    try {
      out[k] = JSON.parse(localStorage.getItem(k) || 'null');
    } catch {
      out[k] = null;
    }
  }
  return out;
}

async function kvSet(obj) {
  if (hasExt) {
    await chrome.storage.local.set(obj);
    return;
  }
  for (const [k, v] of Object.entries(obj)) localStorage.setItem(k, JSON.stringify(v));
}

async function kvRemove(keys) {
  if (hasExt) {
    await chrome.storage.local.remove(keys);
    return;
  }
  for (const k of keys) localStorage.removeItem(k);
}

/* ---------- 分段读写：同步引擎的数据通路 ---------- */
// 每段最近一次落盘的 JSON，用于变更检测：没变的段不写、updatedAt 不动
const lastJSON = {};

function remember(data) {
  for (const s of SECTIONS) lastJSON[s] = JSON.stringify(data[s]);
}

// 读全部分段原始记录 { settings: { v, updatedAt } | null, ... }，同步引擎用
export async function loadSections() {
  const res = await kvGet(SECTIONS.map(sectionKey));
  const out = {};
  for (const s of SECTIONS) out[s] = res[sectionKey(s)] || null;
  return out;
}

// 写单个分段（同步拉回远端数据时直接落盘），updatedAt 默认取当前时间
export async function saveSection(name, value, updatedAt = Date.now()) {
  const rec = { v: value, updatedAt };
  await kvSet({ [sectionKey(name)]: rec });
  lastJSON[name] = JSON.stringify(value);
  return rec;
}

export async function loadData() {
  const sections = await loadSections();
  const hasSplit = SECTIONS.some((s) => sections[s]);

  if (!hasSplit) {
    // 旧版单 blob → 迁移为分段存储；全新安装也要立刻落盘：
    // 固定默认分组的随机 id，stats/dock 等引用依赖 id 跨会话稳定
    const legacy = (await kvGet([LEGACY_KEY]))[LEGACY_KEY];
    const data = normalize(legacy);
    await saveData(data);
    if (legacy) await kvRemove([LEGACY_KEY]);
    remember(data);
    return data;
  }

  const raw = {};
  for (const s of SECTIONS) raw[s] = sections[s] ? sections[s].v : undefined;
  const data = normalize(raw);
  remember(data);
  return data;
}

export async function saveData(data) {
  const writes = {};
  const changed = [];
  for (const s of SECTIONS) {
    const json = JSON.stringify(data[s]);
    if (json === lastJSON[s]) continue; // 没变就不写，保持原 updatedAt
    lastJSON[s] = json;
    changed.push(s);
    writes[sectionKey(s)] = { v: data[s], updatedAt: Date.now() };
  }
  if (Object.keys(writes).length) await kvSet(writes);
  return changed; // 变更的分段名，同步引擎据此决定推送范围
}

/* ---------- 同步配置：只存本机，永不参与同步 ---------- */
export async function loadSyncConf() {
  const raw = (await kvGet([SYNC_CONF_KEY]))[SYNC_CONF_KEY];
  const conf = { mode: 'off', webdav: null, lastSyncAt: 0, ...(raw || {}) };
  if (!['off', 'browser', 'webdav'].includes(conf.mode)) conf.mode = 'off';
  return conf;
}

export async function saveSyncConf(conf) {
  await kvSet({ [SYNC_CONF_KEY]: conf });
}

/* ---------- RSS 条目缓存：只存本机，不参与浏览器同步 ---------- */
const FEED_CACHE_KEY = 'monk.feedcache.v1';

export async function loadFeedCache() {
  const raw = (await kvGet([FEED_CACHE_KEY]))[FEED_CACHE_KEY];
  return raw && typeof raw === 'object' ? raw : {};
}

export async function saveFeedCache(cache) {
  await kvSet({ [FEED_CACHE_KEY]: cache });
}

/* ---------- 壁纸二进制存 IndexedDB ---------- */
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function putBlob(key, blob) {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put(blob, key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function getBlob(key) {
  const db = await openDB();
  const blob = await new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readonly');
    const req = tx.objectStore(DB_STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return blob;
}

export async function deleteBlob(key) {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).delete(key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export const putWallpaper = (blob) => putBlob('wallpaper', blob);
export const getWallpaper = () => getBlob('wallpaper');
export const clearWallpaper = () => deleteBlob('wallpaper');

export async function listBlobKeys() {
  const db = await openDB();
  const keys = await new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readonly');
    const req = tx.objectStore(DB_STORE).getAllKeys();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return keys;
}
