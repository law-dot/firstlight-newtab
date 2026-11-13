/* 回归用例：换壁纸后不能被同步「拉回旧值」
   跑法：node tests/wallpaper-revert.mjs   （无需依赖，Node 18+）

   背景（1.4.1 修的 bug）：在线壁纸在 1.4.0 里每次渲染都无条件 persist，
   而 fetchedAt 每次都取 Date.now()。于是另一个开着新标签页的机器/窗口
   手里永远握着「旧壁纸 + 更新的时间戳」，每轮同步都合法地把用户刚换的
   壁纸盖回去 —— 表现是「闪一下又变回原来那张」。
   修法：本页刚写过的记录有 10 秒保护窗，窗口内不接受远端覆盖。 */

const store = new Map();
const listeners = [];
let NOW = 1794000000000;
Date.now = () => NOW;

globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        const out = {};
        if (keys == null) {
          for (const [k, v] of store) out[k] = v;
          return out;
        }
        for (const k of Array.isArray(keys) ? keys : [keys]) if (store.has(k)) out[k] = store.get(k);
        return out;
      },
      async set(obj) {
        const ch = {};
        for (const [k, v] of Object.entries(obj)) {
          ch[k] = { oldValue: store.get(k), newValue: v };
          store.set(k, v);
        }
        for (const fn of listeners) fn(structuredClone(ch), 'local');
      },
      async remove(keys) {
        const ch = {};
        for (const k of Array.isArray(keys) ? keys : [keys]) {
          if (store.has(k)) { ch[k] = { oldValue: store.get(k) }; store.delete(k); }
        }
        if (Object.keys(ch).length) for (const fn of listeners) fn(structuredClone(ch), 'local');
      }
    },
    sync: { async get() { return {}; }, async set() {}, async remove() {} },
    onChanged: { addListener: (fn) => listeners.push(fn), removeListener: () => {} }
  },
  permissions: { async contains() { return false; }, async request() { return false; } },
  runtime: { getManifest: () => ({ version: '1.4.1' }), id: 'test', lastError: null }
};

const mem = new Map();
globalThis.localStorage = {
  get length() { return mem.size; },
  key: (i) => [...mem.keys()][i],
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v))
};

const S = await import('../js/core/store.js');
const SY = await import('../js/core/sync.js');

const KEY = 'monk.settings.v1';
const mk = (preset) => ({
  settings: { engine: 'bing', theme: 'dark', wallpaper: { type: 'preset', value: preset, blur: 12 }, hotkeys: {} },
  groups: [{ id: 'g1', name: '常用', sites: [{ id: 's1', url: 'https://a.com', title: 'a' }] }],
  todos: [], dock: [], events: [], feeds: [], calfeeds: [], stats: {}
});

const results = [];
const ok = (name, cond, extra = '') => {
  results.push(!!cond);
  console.log(`${cond ? '✓' : '✗'} ${name}${extra ? `  ${extra}` : ''}`);
};

// ① 用户在本页换壁纸：dusk → midnight
await S.saveData(mk('dusk'));
await S.saveData(mk('midnight'));
let rec = (await S.loadUnits())[KEY];
ok('写入后本机是 midnight', rec.v.wallpaper.value === 'midnight');
ok('刚写完判为「刚改过」', S.isRecentLocalWrite(KEY) === true);

// ② 另一端推来「旧壁纸 + 时间戳新 5 秒」的记录（1.4.0 的典型形态）
NOW += 1000;
const remoteOld = mk('aurora');
const r1 = await SY.pullMerge({ [KEY]: { v: remoteOld.settings, updatedAt: NOW + 5000 } });
rec = (await S.loadUnits())[KEY];
ok('保护期内不被远端覆盖', rec.v.wallpaper.value === 'midnight', `pulled=${r1.pulled}`);
ok('保护期内 pulled 为 false', r1.pulled === false);

// ③ 过了保护窗：同一条远端记录应当正常合并进来
NOW += 12 * 1000;
await SY.pullMerge({ [KEY]: { v: remoteOld.settings, updatedAt: NOW + 5000 } });
rec = (await S.loadUnits())[KEY];
ok('保护窗过期后按时间戳接受远端', rec.v.wallpaper.value === 'aurora');

const pass = results.filter(Boolean).length;
console.log(`\n${pass}/${results.length} 通过`);
process.exit(pass === results.length ? 0 : 1);
