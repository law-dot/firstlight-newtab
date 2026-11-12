// 数据持久化：扩展内用 chrome.storage.local，普通网页预览时退回 localStorage
// v1.4.2 起按分段存储：settings/groups/todos/dock/events 各一条记录、各带 updatedAt，
// 为将来接入同步（chrome.storage.sync / WebDAV）预留数据通路。
const LEGACY_KEY = 'monk.data.v1'; // v1.4.1 及之前的单 blob，首次启动自动迁移
const DB_NAME = 'monk';
const DB_STORE = 'files';

// 逻辑段：数据模型层的划分，内存里仍是 data.settings / data.groups / ...
export const SECTIONS = ['settings', 'groups', 'todos', 'dock', 'events', 'feeds', 'calfeeds', 'stats'];
// 「一段一条记录」的简单段。groups 例外：它按分组拆成多条记录，见下
// feeds = 订阅的「配置」（地址/名称/颜色，要跨设备同步）
// calfeeds = 订阅的「内容」（抓到的日历事件，只存本机，永不参与同步）
//   两者必须分开：几百个事件的 ICS 塞进 monk.feeds.v1 会撞 8KB 单项上限，
//   整个 feeds 段一起不同步（与 1.1.0 分组超限同款问题）。
export const SIMPLE_SECTIONS = ['settings', 'todos', 'dock', 'events', 'feeds', 'calfeeds', 'stats'];

const sectionKey = (s) => `monk.${s}.v1`;
const SYNC_CONF_KEY = 'monk.syncconf.v1'; // 同步配置只存本机，永不参与同步

/* ---------- 分组分片 ----------
   1.1.0.1 及之前：全部分组挤在 monk.groups.v1 一条记录里。
   一个站点约 138 字节，约 49 个站点就撞上 storage.sync 的 8KB 单项上限，
   一超限就是六个分组一起不同步，用户还看不出原因。现在按分组拆记录：
     monk.groupidx.v1    分组 id 的有序列表（成员与顺序的权威来源）
     monk.group.<id>.v1  单条分组 { id, name, sites }
   删除分组 = 从索引里去掉 id + 删掉那条记录。 */
export const GROUP_INDEX_KEY = 'monk.groupidx.v1';
export const GROUP_PREFIX = 'monk.group.';
const groupKey = (id) => `${GROUP_PREFIX}${id}.v1`;
// 卡片墓碑：{ siteId: 删除时间 }。独立一条记录，不塞进分组 ——
// 塞进去会被整组 LWW 覆盖冲掉，删掉的卡就复活了（1.3.8）。
export const SITE_TOMBS_KEY = 'monk.sitetombs.v1';
const idFromGroupKey = (k) => k.slice(GROUP_PREFIX.length).replace(/\.v1$/, '');
const LEGACY_GROUPS_KEY = 'monk.groups.v1'; // 迁移前的旧记录，迁完即删
const MIGRATE_BACKUP_KEY = 'monk.migrate.backup.v1'; // 迁移前的原始备份，方便人工回捞

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
      accent: '',   // 界面强调色，'' = 用默认紫 #7c6cf6；设置里可换预设或自定义
      // blur：壁纸模糊半径（px）。1.2.3 起取代旧的 dim（整层压暗/压亮的遮罩），
      // 遮罩退成一层固定的极轻底色，见 css 里 .bg-dim
      wallpaper: { type: 'online', value: '', blur: 12 },
      onlineMode: 'daily',
      onlineInterval: 30,
      onlineSource: 'auto',
      // 在线壁纸的题材：nature = 只要自然风光（默认），any = 不限。
      // Bing 每日图没有题材参数，只能在返回的文案上分类，规则见 wallpaper.js
      wallpaperScene: 'nature',
      customWallpaperUrl: '',
      weatherCity: '',              // 留空 = 不取天气（1.2.0 起不再按 IP 自动定位）
      weatherSource: 'open-meteo',  // wttr | open-meteo | custom
      customWeatherUrl: '',         // 用户填的自定义 URL（支持 {city} 占位）
      weather: null,
      noCityHint: false,            // 「城市留空所以没天气」的提示是否已弹过
      idleMinutes: 10,
      idleTicker: true,
      // 默认常驻播放：新用户装上就能看到动效，不用等 10 分钟待机也不用进设置（1.1.0.6）
      fxMode: 'always',
      todoMode: 'fab',
      edgeSettings: true,
      sideCollapsed: true,
      dockMode: 'auto',
      dockBlocked: [],
      showOnboarding: true,
      hotkeys: {},
      siteMode: 'detail',
      viewMode: 'standard', // 标准 / 极简：极简只隐藏收藏卡片区 #grid
      descPromptOff: false, // 用户在卡片区关掉「自动填写简介」的入口后不再打扰
      showImportCta: true,   // 卡片区显示「导入收藏夹」入口，导入过一次就收起
      importNoteDone: false, // 首启动那条「这些是示例网站」的提示条，点过「先用示例」就不再弹
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
    calfeeds: {},
    stats: {}
  };
}

/* ---------- 订阅内容（只存本机，永不参与同步） ----------
   calfeeds[id] = { items: [{ date, time, text, rrule }], lastSync, error }
   单个源最多留 MAX_CAL_ITEMS 条：日历订阅常是「每天一条」的长期日程，
   不设上限本机存储会无限长。500 条够覆盖一年多的每日事件。 */
const MAX_CAL_ITEMS = 500;

function normalizeCalFeed(raw) {
  const items = Array.isArray(raw?.items)
    ? raw.items
        .filter((it) => it && it.date)
        .slice(0, MAX_CAL_ITEMS)
        .map((it) => ({
          date: String(it.date).slice(0, 10),
          time: it.time ? String(it.time).slice(0, 5) : '',
          text: String(it.text || '').slice(0, 120),
          rrule: it.rrule ? String(it.rrule).slice(0, 255) : ''
        }))
    : [];
  return {
    items,
    lastSync: Number(raw?.lastSync) || 0,
    error: String(raw?.error || '').slice(0, 80)
  };
}

function normalizeCalFeeds(raw) {
  const out = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [id, v] of Object.entries(raw)) {
      if (!id || !v || typeof v !== 'object') continue;
      out[id] = normalizeCalFeed(v);
    }
  }
  return out;
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
        // date：ISO 'YYYY-MM-DD'，'' 表示未安排日期。未完成的待办跨天累积显示，勾选完成才消失
        .map((t) => ({ id: t.id || uid(), text: String(t.text), done: !!t.done, date: String(t.date || '') }))
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
  // 1.2.3：dim（整层压暗/压亮）退役 → blur（壁纸模糊）。
  // 旧用户的 dim 直接丢弃：遮罩现在固定 12%，模糊给默认值，读起来不会突然变成一张全锐利的壁纸。
  if (raw.settings?.wallpaper?.blur == null) wallpaper.blur = 12;
  const blurNum = Number(wallpaper.blur);
  wallpaper.blur = Number.isFinite(blurNum) ? Math.min(40, Math.max(0, Math.round(blurNum))) : 12;
  delete wallpaper.dim;
  if (!['auto', 'bing', 'custom'].includes(settings.onlineSource)) settings.onlineSource = 'auto';
  if (!['nature', 'any'].includes(settings.wallpaperScene)) settings.wallpaperScene = 'nature';
  if (!['daily', 'rotate', 'interval'].includes(settings.onlineMode)) settings.onlineMode = 'daily';
  settings.onlineInterval = [10, 30, 60].includes(Number(settings.onlineInterval)) ? Number(settings.onlineInterval) : 30;
  // Dock 三态：智能(自动收录 Top5) / 手动 / 关闭；旧版 'on' 迁移为手动
  if (settings.dockMode === 'on') settings.dockMode = 'manual';
  if (!['auto', 'manual', 'off'].includes(settings.dockMode)) settings.dockMode = 'auto';
  settings.dockBlocked = Array.isArray(settings.dockBlocked)
    ? settings.dockBlocked.map(String).slice(0, 200)
    : [];
  // 详情模式是默认：图标 + 标题 + 一句简介，忘掉名字也认得出是哪个网站。
  // 旧的 'minimal' 一并归到 detail——简洁模式已在 v1.1 砍掉。
  if (!['standard', 'detail'].includes(settings.siteMode)) settings.siteMode = 'detail';
  if (!['standard', 'minimal'].includes(settings.viewMode)) settings.viewMode = 'standard';
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

  // feeds：订阅的**配置**，只放跨设备需要一致的东西（地址/名称/颜色）。
  // 抓到的内容一律不进这里——见下方 calfeeds。
  // 标题可留空（RSS 首次抓取后自动回填）
  const calfeeds = normalizeCalFeeds(raw.calfeeds);
  const feeds = Array.isArray(raw.feeds)
    ? raw.feeds
        .filter((f) => f && f.url)
        .map((f) => {
          const id = f.id || uid();
          // 1.2.0 早期版本把 items 直接写在 feed 里（会跟着同步走）。
          // 老数据读到就地迁进本机缓存，之后 feeds 记录不再带内容。
          if (Array.isArray(f.items) && !calfeeds[id]) {
            calfeeds[id] = normalizeCalFeed(f);
          }
          return {
            id,
            kind: f.kind === 'ics' ? 'ics' : 'rss',
            url: String(f.url),
            // title 是唯一名字字段；name 是 1.2.0 早期日历订阅用的旧字段，读进来兼容
            title: String(f.title || f.name || '').slice(0, 40),
            color: String(f.color || '').slice(0, 20)
          };
        })
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
    calfeeds,
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

/* ---------- 存储记录层：同步引擎的数据通路 ----------
   一条「记录」= 一个带 updatedAt 的键，是同步合并的最小单位。
   简单段一段一条；groups 一个分组一条 + 一条索引。 */
// 每条记录最近一次落盘的 JSON，用于变更检测：没变的不写、updatedAt 不动
const lastJSON = {};       // sectionName → JSON
const lastGroupJSON = {};  // groupId → JSON
let lastGroupIdxJSON = null;

// 分组墓碑 { id: 删除时间 }。没有它，「A 机删掉的分组」在 B 机上会永远复活；
// 有了它，合并索引时可以确定「这个 id 是真被删了」而不是「对面还没收到」。
let groupTombs = {};
// 卡片墓碑 { siteId: 删除时间 }。语义与分组墓碑相同，粒度到单张卡片。
let siteTombs = {};
let lastSiteTombsJSON = null;

const TOMB_MAX = 60;              // 墓碑上限，超出丢最旧的（删 60 个分组的人都少见）
const SITE_TOMB_MAX = 100;        // 卡片墓碑上限。100 条 ≈ 5KB，给浏览器同步 8KB 单条限额留余量
const TOMB_TTL = 90 * 86400000;   // 90 天前的墓碑没有意义了

function prunedTombs(tombs, max = TOMB_MAX) {
  const now = Date.now();
  const list = Object.entries(tombs || {})
    .map(([id, ts]) => [id, Number(ts) || 0])
    .filter(([, ts]) => now - ts < TOMB_TTL)
    .sort((a, b) => b[1] - a[1])
    .slice(0, max);
  return Object.fromEntries(list);
}

function remember(data) {
  for (const s of SIMPLE_SECTIONS) lastJSON[s] = JSON.stringify(data[s]);
  for (const id of Object.keys(lastGroupJSON)) delete lastGroupJSON[id];
  const ids = [];
  for (const g of data.groups || []) {
    ids.push(g.id);
    lastGroupJSON[g.id] = JSON.stringify(g);
    delete groupTombs[g.id]; // 这个 id 还活着，墓碑作废
  }
  lastGroupIdxJSON = indexSignature(ids);
}

const indexSignature = (ids, tombs = groupTombs) =>
  JSON.stringify({ v: ids, d: prunedTombs(tombs) });

// 单条记录的缓存同步（同步拉回远端数据时用，避免下次保存又整段重写）
function cacheUnit(key, value) {
  if (key === GROUP_INDEX_KEY) {
    groupTombs = prunedTombs(value?.d || {});
    lastGroupIdxJSON = indexSignature((value?.v || []).map(String));
    return;
  }
  if (key === SITE_TOMBS_KEY) {
    siteTombs = prunedTombs(value?.v || {}, SITE_TOMB_MAX);
    lastSiteTombsJSON = JSON.stringify(siteTombs);
    return;
  }
  if (key.startsWith(GROUP_PREFIX)) {
    lastGroupJSON[idFromGroupKey(key)] = JSON.stringify(value);
    return;
  }
  const s = SIMPLE_SECTIONS.find((name) => sectionKey(name) === key);
  if (s) lastJSON[s] = JSON.stringify(value);
}

async function kvAll() {
  if (hasExt) return chrome.storage.local.get(null);
  const out = {};
  for (let i = 0; i < localStorage.length; i += 1) {
    const k = localStorage.key(i);
    try {
      out[k] = JSON.parse(localStorage.getItem(k));
    } catch {
      out[k] = null;
    }
  }
  return out;
}

// 索引键丢失时的兜底：扫描前缀还原分组 id 列表，避免索引损坏直接丢全部分组
async function scanGroupIds() {
  const all = await kvAll();
  return Object.keys(all)
    .filter((k) => k.startsWith(GROUP_PREFIX) && k.endsWith('.v1'))
    .map(idFromGroupKey);
}

// 读全部本地记录 { 'monk.settings.v1': {v,updatedAt}, 'monk.group.<id>.v1': {...}, ... }
export async function loadUnits() {
  const got = await kvGet([...SIMPLE_SECTIONS.map(sectionKey), GROUP_INDEX_KEY, SITE_TOMBS_KEY]);
  const units = {};
  for (const s of SIMPLE_SECTIONS) {
    const rec = got[sectionKey(s)];
    if (rec) units[sectionKey(s)] = rec;
  }

  let ids = Array.isArray(got[GROUP_INDEX_KEY]?.v) ? got[GROUP_INDEX_KEY].v.map(String) : null;
  if (!ids) {
    // 索引丢了但分组记录还在：扫前缀还原，顺手把索引补回去，避免下次又扫一遍
    ids = await scanGroupIds();
    if (ids.length) await kvSet({ [GROUP_INDEX_KEY]: { v: ids, d: {}, updatedAt: 0 } });
  }
  if (ids.length) {
    const recs = await kvGet(ids.map(groupKey));
    for (const id of ids) {
      const rec = recs[groupKey(id)];
      if (rec) units[groupKey(id)] = rec;
    }
  }
  if (got[GROUP_INDEX_KEY]) units[GROUP_INDEX_KEY] = got[GROUP_INDEX_KEY];
  else if (ids.length) units[GROUP_INDEX_KEY] = { v: ids, updatedAt: 0 }; // 自愈：重建索引
  if (got[SITE_TOMBS_KEY]) units[SITE_TOMBS_KEY] = got[SITE_TOMBS_KEY];
  return units;
}

export function unitKeyOf(section) {
  return sectionKey(section);
}

export function isGroupUnit(key) {
  return key.startsWith(GROUP_PREFIX) || key === GROUP_INDEX_KEY;
}

// 写单条记录（同步拉回远端数据时直接落盘）
export async function saveUnit(key, rec) {
  if (!key || !rec) return;
  await kvSet({ [key]: rec });
  cacheUnit(key, rec.v);
}

// 删除单条记录（索引裁掉分组后清理残留）
export async function removeUnit(key) {
  await kvRemove([key]);
  if (key.startsWith(GROUP_PREFIX)) delete lastGroupJSON[idFromGroupKey(key)];
  if (key === GROUP_INDEX_KEY) lastGroupIdxJSON = null;
}

// 批量删除（墓碑清理用，一次 kvRemove 而不是 N 次）
export async function removeUnits(keys) {
  const list = (keys || []).filter(Boolean);
  if (!list.length) return 0;
  await kvRemove(list);
  for (const key of list) {
    if (key.startsWith(GROUP_PREFIX)) delete lastGroupJSON[idFromGroupKey(key)];
  }
  return list.length;
}

function groupsFromUnits(units) {
  const idx = units[GROUP_INDEX_KEY];
  const ids = Array.isArray(idx?.v) ? idx.v.map(String) : [];
  // 卡片墓碑在读取时过滤：被删的卡即使从云端拉回旧分组也不显示。
  // 存储里的原始记录不动（同步合并需要原样），只在渲染视图这一层挡住。
  const tombs = siteTombs && Object.keys(siteTombs).length ? siteTombs : null;
  const strip = (g) => {
    if (!tombs || !Array.isArray(g?.sites)) return g;
    const sites = g.sites.filter((s) => s && s.id && !tombs[String(s.id)]);
    return sites.length === g.sites.length ? g : { ...g, sites };
  };
  const out = [];
  const seen = new Set();
  for (const id of ids) {
    const rec = units[groupKey(id)];
    if (rec?.v) {
      out.push(strip(rec.v));
      seen.add(id);
    }
  }
  // 索引外还有记录（索引半途损坏）：补进来，宁可多显示也不能丢
  for (const [k, rec] of Object.entries(units)) {
    if (!k.startsWith(GROUP_PREFIX) || rec?.v == null) continue;
    const id = idFromGroupKey(k);
    if (!seen.has(id)) out.push(strip(rec.v));
  }
  return out;
}

// 读全部分段（逻辑视图）{ settings: {v,updatedAt}|null, groups: {v:[...],updatedAt}|null, ... }
export async function loadSections() {
  const units = await loadUnits();
  groupTombs = prunedTombs(units[GROUP_INDEX_KEY]?.d || {});
  siteTombs = prunedTombs(units[SITE_TOMBS_KEY]?.v || {}, SITE_TOMB_MAX);
  lastSiteTombsJSON = JSON.stringify(siteTombs);
  const out = {};
  for (const s of SIMPLE_SECTIONS) out[s] = units[sectionKey(s)] || null;

  const groups = groupsFromUnits(units);
  if (!groups.length) {
    out.groups = null;
    return out;
  }
  let stamp = units[GROUP_INDEX_KEY]?.updatedAt || 0;
  for (const [k, rec] of Object.entries(units)) {
    if (k.startsWith(GROUP_PREFIX)) stamp = Math.max(stamp, rec?.updatedAt || 0);
  }
  out.groups = { v: groups, updatedAt: stamp };
  return out;
}

function countGroups(groups) {
  return {
    g: (groups || []).length,
    s: (groups || []).reduce((n, g) => n + (Array.isArray(g?.sites) ? g.sites.length : 0), 0)
  };
}

/* ---------- 迁移：旧单记录 → 分组分片 ---------- */
// 只写分组分片，不动其他段——迁移不该顺手改掉 settings/todos 的 updatedAt
async function writeGroupShards(groups, stamp) {
  const writes = {};
  const ids = [];
  for (const g of groups || []) {
    ids.push(g.id);
    writes[groupKey(g.id)] = { v: g, updatedAt: stamp };
    lastGroupJSON[g.id] = JSON.stringify(g);
  }
  writes[GROUP_INDEX_KEY] = { v: ids, d: prunedTombs(groupTombs), updatedAt: stamp };
  lastGroupIdxJSON = indexSignature(ids);
  await kvSet(writes);
}

async function migrateGroups(legacyRec, data) {
  // 1) 先备份：万一边写边崩，用户还能从备份里手工回捞
  await kvSet({
    [MIGRATE_BACKUP_KEY]: { at: Date.now(), source: LEGACY_GROUPS_KEY, data: legacyRec }
  });

  // 2) 自检基线
  const expect = countGroups(data.groups);

  // 3) 写入分片（时间戳沿用旧记录的，保持跨设备合并顺序不变）
  await writeGroupShards(data.groups, legacyRec?.updatedAt || Date.now());

  // 4) 读回来核对条目数
  const got = countGroups(groupsFromUnits(await loadUnits()));
  if (got.g !== expect.g || got.s !== expect.s) {
    console.error('分组分片迁移自检失败，已回滚', { expect, got });
    // 回滚：旧记录放回去，删掉这次写的分片
    await kvSet({ [LEGACY_GROUPS_KEY]: legacyRec });
    await kvRemove([GROUP_INDEX_KEY, ...(data.groups || []).map((g) => groupKey(g.id))]);
    // 磁盘回滚了，写缓存必须一起回滚：writeGroupShards 已经把 lastGroupJSON 填好，
    // 不清掉的话 saveData 会认为「这些分组没变化」而跳过写入，分组只活在内存里
    for (const g of data.groups || []) delete lastGroupJSON[g.id];
    lastGroupIdxJSON = null;
    return false;
  }

  // 5) 成功才删旧记录
  await kvRemove([LEGACY_GROUPS_KEY]);
  return true;
}

export async function loadData() {
  const units = await loadUnits();
  groupTombs = prunedTombs(units[GROUP_INDEX_KEY]?.d || {});
  siteTombs = prunedTombs(units[SITE_TOMBS_KEY]?.v || {}, SITE_TOMB_MAX);
  lastSiteTombsJSON = JSON.stringify(siteTombs);
  const legacy = await kvGet([LEGACY_GROUPS_KEY, LEGACY_KEY]);
  const legacyGroups = legacy[LEGACY_GROUPS_KEY];
  const legacyBlob = legacy[LEGACY_KEY];
  const hasShards = Object.keys(units).length > 0;

  if (!hasShards && !legacyGroups && !legacyBlob) {
    // 全新安装也要立刻落盘：固定默认分组的随机 id，stats/dock 等引用依赖 id 跨会话稳定。
    // 时间戳必须为 0：否则这份「空默认值」会比另一台设备上的真实数据更新，
    // 同步合并时会反过来把真实数据覆盖掉。
    const data = normalize(null);
    await saveData(data, 0);
    remember(data);
    return data;
  }

  // 汇总现状：分片优先，旧记录兜底，单 blob 只补缺失的段
  const raw = {};
  for (const s of SIMPLE_SECTIONS) {
    if (units[sectionKey(s)]) raw[s] = units[sectionKey(s)].v;
  }
  const shardGroups = groupsFromUnits(units);
  if (shardGroups.length) raw.groups = shardGroups;
  else if (Array.isArray(legacyGroups?.v)) raw.groups = legacyGroups.v;

  if (legacyBlob && typeof legacyBlob === 'object' && !Array.isArray(legacyBlob)) {
    for (const [k, v] of Object.entries(legacyBlob)) {
      if (raw[k] === undefined) raw[k] = v;
    }
  }

  const data = normalize(raw);

  if (legacyGroups && !shardGroups.length) {
    // 旧结构 → 分片
    await migrateGroups(legacyGroups, data);
  } else if (!shardGroups.length) {
    // 只有单 blob 或只有简单段：补齐分组分片
    await writeGroupShards(data.groups, legacyBlob ? Date.now() : 0);
    if (legacyBlob) await kvRemove([LEGACY_KEY]);
  }

  remember(data);
  return data;
}

// stamp：本次落盘使用的时间戳。默认取当前时间；首次安装传 0，
// 让远端已有数据在合并时永远胜出（见 loadData 的注释）。
// 返回变更的**存储键**（可能是 monk.settings.v1，也可能是某条分组分片）。
export async function saveData(data, stamp = Date.now()) {
  const writes = {};
  const removes = [];
  const changed = [];

  for (const s of SIMPLE_SECTIONS) {
    const json = JSON.stringify(data[s]);
    if (json === lastJSON[s]) continue; // 没变就不写，保持原 updatedAt
    lastJSON[s] = json;
    const key = sectionKey(s);
    writes[key] = { v: data[s], updatedAt: stamp };
    changed.push(key);
  }

  // 分组：逐条比对，只有变了的那个分组才写
  const ids = [];
  const prevGroupJSON = { ...lastGroupJSON }; // 旧内容快照，卡片墓碑靠它找出「被删的卡」
  for (const g of data.groups || []) {
    ids.push(g.id);
    const json = JSON.stringify(g);
    if (lastGroupJSON[g.id] === json) continue;
    lastGroupJSON[g.id] = json;
    const key = groupKey(g.id);
    writes[key] = { v: g, updatedAt: stamp };
    changed.push(key);
  }
  for (const id of Object.keys(lastGroupJSON)) {
    if (ids.includes(id)) continue;
    delete lastGroupJSON[id];
    removes.push(groupKey(id));
    groupTombs[id] = stamp; // 立个墓碑：别的设备拉到新索引时才知道这是「删了」而不是「还没同步」
  }

  /* 卡片墓碑：id 消失了才算删，且要过两道排除 ——
     ① 拖到别的分组：id 在新数据的任何分组里还在 → 是移动，不是删除；
     ② 跟着分组一起没了：那条路走分组墓碑，不再重复立卡片墓碑。
     墓碑只能由真实的删除动作产生，绝不能由「记录缺失」推导，
     否则一台空设备就能给云端开出满屏墓碑，把所有数据「合法地」删掉。 */
  const alive = new Set();
  for (const g of data.groups || []) {
    for (const s of g.sites || []) if (s && s.id) alive.add(String(s.id));
  }
  const gone = [];
  for (const [gid, json] of Object.entries(prevGroupJSON)) {
    if (!ids.includes(gid)) continue;
    let old;
    try {
      old = JSON.parse(json);
    } catch {
      continue;
    }
    for (const s of old?.sites || []) {
      const sid = s && s.id ? String(s.id) : '';
      if (sid && !alive.has(sid) && !gone.includes(sid)) gone.push(sid);
    }
  }
  if (gone.length) {
    for (const sid of gone) siteTombs[sid] = Math.max(siteTombs[sid] || 0, stamp);
    const tj = JSON.stringify(prunedTombs(siteTombs, SITE_TOMB_MAX));
    if (tj !== lastSiteTombsJSON) {
      lastSiteTombsJSON = tj;
      siteTombs = JSON.parse(tj);
      writes[SITE_TOMBS_KEY] = { v: siteTombs, updatedAt: stamp };
      changed.push(SITE_TOMBS_KEY);
    }
  }
  const idxJSON = indexSignature(ids);
  if (lastGroupIdxJSON !== idxJSON) {
    lastGroupIdxJSON = idxJSON;
    writes[GROUP_INDEX_KEY] = { v: ids, d: prunedTombs(groupTombs), updatedAt: stamp };
    changed.push(GROUP_INDEX_KEY);
  }

  if (Object.keys(writes).length) await kvSet(writes);
  if (removes.length) await kvRemove(removes);
  return changed; // 变更的存储键，同步引擎据此决定推送范围
}

/* ---------- 同步配置：只存本机，永不参与同步 ---------- */
export async function loadSyncConf() {
  const raw = (await kvGet([SYNC_CONF_KEY]))[SYNC_CONF_KEY];
  const conf = { mode: 'off', webdav: null, lastSyncAt: 0, mergedOnce: false, ...(raw || {}) };
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
// 连接缓存成单例：壁纸切换频繁时，每次开关一次 IndexedDB 连接是纯浪费
let dbPromise = null;
function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch((err) => {
      dbPromise = null; // 打开失败不要缓存失败的 promise，下次重试
      throw err;
    });
  }
  return dbPromise;
}

export async function putBlob(key, blob) {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put(blob, key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

export async function getBlob(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readonly');
    const req = tx.objectStore(DB_STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteBlob(key) {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).delete(key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

export const putWallpaper = (blob) => putBlob('wallpaper', blob);
export const getWallpaper = () => getBlob('wallpaper');
export const clearWallpaper = () => deleteBlob('wallpaper');

export async function listBlobKeys() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readonly');
    const req = tx.objectStore(DB_STORE).getAllKeys();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
