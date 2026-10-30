// 搜索框 + 建议下拉（分组/收藏/历史/引擎）+ 简单计算 + 货币换算
import { state, persist } from '../core/state.js';
import {
  $, $$, hostOf, faviconOf, hashHue, fetchWithTimeout
} from '../core/utils.js';
import { syncSettingsUI } from './settings.js';

export const ENGINES = [
  { id: 'bing', name: 'Bing', url: 'https://www.bing.com/search?q=%s' },
  { id: 'baidu', name: '百度', url: 'https://www.baidu.com/s?wd=%s' },
  { id: 'google', name: 'Google', url: 'https://www.google.com/search?q=%s' },
  { id: 'sogou', name: '搜狗', url: 'https://www.sogou.com/web?query=%s' },
  { id: 'custom', name: '自定义', url: '' }
];

const SUGGEST_MAX = 8;       // 每个 section 最多显示数
const SUGGEST_FREQ = 0.6;    // 历史项里 visitCount 权重

export function renderEngines() {
  const options = ENGINES.map(
    (e) => `<option value="${e.id}">${e.name}</option>`
  ).join('');
  $('#engineSelect').innerHTML = options;
  $('#engineSetting').innerHTML = options;
  $('#engineSelect').value = state.data.settings.engine;
  $('#engineSetting').value = state.data.settings.engine;
}

export function buildEngineUrl(keyword) {
  const engine = ENGINES.find((e) => e.id === state.data.settings.engine) || ENGINES[0];
  const template =
    engine.id === 'custom'
      ? state.data.settings.customEngine || ENGINES[0].url
      : engine.url;
  return template.replace('%s', encodeURIComponent(keyword));
}

/* ================= 事件绑定 ================= */
export function bindSearch() {
  $('#searchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    // 如有选中的建议项
    if (state.suggestIndex >= 0 && state.suggestItems[state.suggestIndex]) {
      const item = state.suggestItems[state.suggestIndex];
      if (item.url) {
        openSuggestItem(item);
      }
      hideSuggest();
      return;
    }
    const raw = $('#q').value.trim();
    if (!raw) return;
    if (/^https?:\/\//i.test(raw)) {
      location.href = raw;
    } else if (/^[^\s]+\.[^\s]+$/.test(raw)) {
      location.href = 'https://' + raw;
    } else {
      location.href = buildEngineUrl(raw);
    }
  });

  $('#q').addEventListener('input', () => {
    const q = $('#q').value.trim();
    if (!q) {
      hideSuggest();
      return;
    }
    clearTimeout(state.suggestTimer);
    state.suggestTimer = setTimeout(() => runSuggest(q), 260);
  });

  $('#q').addEventListener('keydown', (e) => {
    if (!$('#suggest').hidden) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        suggestMove(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        suggestMove(-1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        hideSuggest();
      }
    } else if (e.key === 'ArrowDown') {
      // 没显示时也触发，方便第一次按 ↓ 就看到结果
      const q = $('#q').value.trim();
      if (q) {
        runSuggest(q).then(() => suggestMove(0));
      }
    }
  });

  // 点击空白关闭建议下拉
  document.addEventListener('click', (e) => {
    if (e.target.closest('#suggest') || e.target === $('#q')) return;
    hideSuggest();
  });

  $('#engineSelect').addEventListener('change', (e) => {
    state.data.settings.engine = e.target.value;
    persist();
    syncSettingsUI();
    $('#q').focus();
  });
}

/* ============= 计算：安全表达式解析 =============
 * 支持 + - * / ( ) 小数 科学计数 正负号
 * 用白名单 tokenizer + 递归下降解析，绝不用 eval
 */
function tryCalculate(input) {
  // 只允许数字、运算符、括号、空格、小数点、e/E
  const expr = input.trim();
  if (!expr) return null;
  if (!/^[\d\s+\-*/().eE^%]+$/.test(expr)) return null;
  // 至少要包含一个运算符才触发
  if (!/[+\-*/^%]/.test(expr)) return null;
  // 排除纯 URL 片段里的斜杠（如果同时含点号且不含空格就不触发）
  if (/^[\d.\/]+$/.test(expr) && !/[+\-*^%()]/.test(expr)) return null;

  try {
    // 替换 ^ 为 **（幂运算），但我们不鼓励幂，降级为乘法也可以——这里简单支持
    const tokens = tokenize(expr.replace(/\^/g, '**'));
    const parser = new CalcParser(tokens);
    const result = parser.parse();
    if (parser.pos < tokens.length) return null; // 有剩 token 说明语法不合法
    if (!isFinite(result)) return null;
    return {
      type: 'calc',
      title: formatNumber(result),
      url: null,
      badge: '计算结果',
      expr: expr,
      score: 200 // 最高优先级
    };
  } catch {
    return null;
  }
}

function tokenize(expr) {
  const tokens = [];
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    if ('+-*/()%'.includes(c)) {
      tokens.push(c);
      i++;
      if (c === '*' && expr[i] === '*') { tokens[tokens.length - 1] = '**'; i++; }
      continue;
    }
    // 数字：含小数 + 可选科学计数
    if (/[\d.]/.test(c)) {
      let num = '';
      while (i < expr.length && /[\d.]/.test(expr[i])) { num += expr[i]; i++; }
      if (expr[i] === 'e' || expr[i] === 'E') {
        num += expr[i++];
        if (expr[i] === '+' || expr[i] === '-') num += expr[i++];
        while (i < expr.length && /\d/.test(expr[i])) { num += expr[i]; i++; }
      }
      tokens.push(parseFloat(num));
      continue;
    }
    throw new Error('bad char');
  }
  return tokens;
}

class CalcParser {
  constructor(tokens) { this.t = tokens; this.pos = 0; }
  peek() { return this.t[this.pos]; }
  eat() { return this.t[this.pos++]; }
  parse() { return this.parseAddSub(); }

  parseAddSub() {
    let left = this.parseMulDiv();
    while (this.peek() === '+' || this.peek() === '-') {
      const op = this.eat();
      const right = this.parseMulDiv();
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }
  parseMulDiv() {
    let left = this.parsePercent();
    while (this.peek() === '*' || this.peek() === '/') {
      const op = this.eat();
      const right = this.parsePercent();
      left = op === '*' ? left * right : left / right;
    }
    return left;
  }
  parsePercent() {
    let left = this.parsePow();
    while (this.peek() === '%') {
      this.eat();
      left = left / 100;
    }
    return left;
  }
  parsePow() {
    let base = this.parseUnary();
    if (this.peek() === '**') {
      this.eat();
      base = Math.pow(base, this.parsePow()); // 右结合
    }
    return base;
  }
  parseUnary() {
    if (this.peek() === '-') { this.eat(); return -this.parseUnary(); }
    if (this.peek() === '+') { this.eat(); return this.parseUnary(); }
    return this.parsePrimary();
  }
  parsePrimary() {
    const t = this.peek();
    if (typeof t === 'number') { this.eat(); return t; }
    if (t === '(') {
      this.eat();
      const v = this.parseAddSub();
      if (this.peek() !== ')') throw new Error('missing )');
      this.eat();
      return v;
    }
    throw new Error('unexpected token');
  }
}

function formatNumber(n) {
  if (!isFinite(n)) return String(n);
  if (Math.abs(n) >= 1e16 || (n !== 0 && Math.abs(n) < 1e-6)) return n.toExponential(6);
  // 限制到合理的小数位，去掉尾巴 0
  const fixed = parseFloat(n.toFixed(10));
  return String(fixed);
}

/* ============= 货币换算 ============= */
const CURRENCY_ALIASES = {
  'USD': ['usd', '美元', '刀', '美刀', '$', 'us$'],
  'CNY': ['cny', '人民币', '元', '￥', '¥', 'rmb'],
  'EUR': ['eur', '欧元', '欧'],
  'JPY': ['jpy', '日元', '日圆', '円'],
  'GBP': ['gbp', '英镑', '英镑', '£'],
  'HKD': ['hkd', '港币', '港圆', 'hk$'],
  'KRW': ['krw', '韩元', '韩圆', '₩'],
  'AUD': ['aud', '澳元', '澳刀'],
  'CAD': ['cad', '加元', '加刀'],
  'SGD': ['sgd', '新加坡元'],
  'THB': ['thb', '泰铢'],
  'TWD': ['twd', '新台币'],
  'INR': ['inr', '印度卢比', '₹'],
  'CHF': ['chf', '瑞士法郎'],
  'NZD': ['nzd', '新西兰元']
};
const CURRENCY_CODES = Object.keys(CURRENCY_ALIASES);

function matchCurrencyAlias(s) {
  const low = s.toLowerCase().trim();
  for (const code of CURRENCY_CODES) {
    if (CURRENCY_ALIASES[code].includes(low)) return code;
  }
  return null;
}

// 识别货币输入，返回 { amount, from, to } 或 null
function parseCurrencyInput(raw) {
  const s = raw.trim();
  // 1) 显式 "100 USD to CNY" / "100 USD in CNY" / "100 USD = ? CNY"
  let m = s.match(/^([\d,.]+)\s*([a-zA-Z￥¥$£₩₹]+)\s*(?:to|in|->|→|=>|=|到|换|兑换)\s*([a-zA-Z￥¥$£₩₹]+)\s*$/i);
  if (m) {
    const amount = parseFloat(m[1].replace(/,/g, ''));
    const from = matchCurrencyAlias(m[2]);
    const to = matchCurrencyAlias(m[3]);
    if (amount > 0 && from && to) return { amount, from, to };
  }
  // 2) "￥500" / "$100" / "€50" — 自动换算成 CNY + USD
  m = s.match(/^([￥¥$€£₩₹])\s*([\d,.]+)\s*$/);
  if (m) {
    const codeMap = { '￥': 'CNY', '¥': 'CNY', '$': 'USD', '€': 'EUR', '£': 'GBP', '₩': 'KRW', '₹': 'INR' };
    const from = codeMap[m[1]];
    if (from) {
      const amount = parseFloat(m[2].replace(/,/g, ''));
      if (amount > 0) return { amount, from, defaultPair: true };
    }
  }
  // 3) "100 USD" — 自动换算成 CNY
  m = s.match(/^([\d,.]+)\s+([a-zA-Z]{3})\s*$/i);
  if (m) {
    const amount = parseFloat(m[1].replace(/,/g, ''));
    const from = matchCurrencyAlias(m[2]);
    if (amount > 0 && from) return { amount, from, defaultPair: true };
  }
  return null;
}

// 汇率本地缓存：{ from, rates: { USD: 7.25, ... }, fetchedAt }
const RATE_TTL = 24 * 60 * 60 * 1000;

async function fetchRates(base) {
  const cache = state.rateCache;
  if (cache && cache.from === base && Date.now() - cache.fetchedAt < RATE_TTL) {
    return cache.rates;
  }
  try {
    const res = await fetchWithTimeout(
      `https://api.frankfurter.dev/latest?from=${base}`,
      8000
    );
    if (!res.ok) return null;
    const json = await res.json();
    const rates = json.rates || null;
    if (rates) {
      state.rateCache = { from: base, rates, fetchedAt: Date.now() };
      return rates;
    }
  } catch { /* ignore */ }
  return null;
}

/* ============= runSuggest：计算/货币优先 ============= */
async function runSuggest(q) {
  const raw = q.trim();
  if (!raw) { hideSuggest(); return; }

  $('#suggest').hidden = false;
  $('#suggest').innerHTML = '<div class="suggest-loading">搜索中…</div>';

  const needle = raw.toLowerCase();
  const sections = [];

  // ====== 计算（最高优先级，同步） ======
  const calc = tryCalculate(raw);
  if (calc) {
    sections.push({
      label: '计算结果',
      items: [{
        type: 'calc',
        title: calc.title,
        url: null,
        badge: `= ${calc.expr}`,
        score: 200
      }]
    });
  }

  // ====== 货币换算（异步） ======
  const curMatch = parseCurrencyInput(raw);
  if (curMatch) {
    const convResults = await computeCurrency(curMatch);
    if (convResults.length) {
      sections.push({ label: '货币换算', items: convResults });
    }
  }

  // ====== 原有搜索建议逻辑 ======
  const fromGroups = [];
  state.data.groups.forEach((g) => {
    g.sites.forEach((s) => {
      const title = (s.title || '').toLowerCase();
      const url = (s.url || '').toLowerCase();
      if (!title && !url) return;
      if (title.includes(needle) || url.includes(needle)) {
        const exactTitle = (s.title || '').toLowerCase() === needle;
        fromGroups.push({
          type: 'group',
          title: s.title || hostOf(s.url),
          url: s.url,
          groupName: g.name,
          favicon: s.icon || faviconOf(s.url),
          exact: exactTitle,
          score: (exactTitle ? 100 : 60) + (title.includes(needle) ? 20 : 0)
        });
      }
    });
  });

  const fromBookmarks = await queryBookmarks(raw, needle);
  const fromHistory = await queryHistory(raw, needle);
  const fromEngine = await queryEngineSuggest(raw);

  const merged = new Map();
  [...fromGroups, ...fromBookmarks, ...fromHistory, ...fromEngine].forEach((item) => {
    const key = item.url ? item.url.toLowerCase() : item.title.toLowerCase();
    const prev = merged.get(key);
    if (!prev || (item.score || 0) > (prev.score || 0)) merged.set(key, item);
  });

  const gItems = Array.from(merged.values()).filter((i) => i.type === 'group').sort((a, b) => (b.score || 0) - (a.score || 0));
  const bItems = Array.from(merged.values()).filter((i) => i.type === 'bookmark').sort((a, b) => (b.score || 0) - (a.score || 0));
  const hItems = Array.from(merged.values()).filter((i) => i.type === 'history').sort((a, b) => (b.score || 0) - (a.score || 0));
  const eItems = Array.from(merged.values()).filter((i) => i.type === 'engine').sort((a, b) => (b.score || 0) - (a.score || 0));

  if (gItems.length) sections.push({ label: '扩展分组', items: gItems.slice(0, SUGGEST_MAX) });
  if (bItems.length) sections.push({ label: 'Edge 收藏夹', items: bItems.slice(0, SUGGEST_MAX) });
  if (hItems.length) sections.push({ label: '浏览历史', items: hItems.slice(0, SUGGEST_MAX) });
  if (eItems.length && !allTitlesStartWith(sections, eItems[0].title)) {
    sections.push({ label: '搜索建议', items: eItems.slice(0, 6) });
  }

  state.suggestSections = sections;
  state.suggestItems = sections.flatMap((s) => s.items);
  state.suggestIndex = -1;

  renderSuggest();
}

function allTitlesStartWith(sections, title) {
  const t = title.toLowerCase();
  return sections.some((s) =>
    s.items.some((i) => (i.title || '').toLowerCase() === t)
  );
}

async function computeCurrency({ amount, from, to, defaultPair }) {
  const targets = defaultPair ? (from === 'CNY' ? ['USD', 'EUR', 'JPY', 'HKD'] : ['CNY', 'USD']) : [to];
  const rates = await fetchRates(from);
  if (!rates) return [];
  const out = [];
  for (const t of targets) {
    if (t === from) continue;
    if (!rates[t]) continue;
    const result = amount * rates[t];
    out.push({
      type: 'currency',
      title: `${formatNumber(amount)} ${from} = ${formatNumber(result)} ${t}`,
      url: null,
      badge: `汇率 ${formatNumber(rates[t])}`,
      score: 150
    });
  }
  return out;
}

async function queryBookmarks(raw, needle) {
  if (!chrome?.bookmarks?.search) return [];
  try {
    const results = await chrome.bookmarks.search(raw);
    return results
      .filter((b) => b.url && /^https?:/.test(b.url))
      .map((b) => ({
        type: 'bookmark',
        title: b.title || hostOf(b.url),
        url: b.url,
        favicon: faviconOf(b.url),
        exact: (b.title || '').toLowerCase() === needle,
        score: (b.title || '').toLowerCase().includes(needle) ? 50 : 30
      }));
  } catch { return []; }
}

async function queryHistory(raw, needle) {
  if (!chrome?.history?.search) return [];
  try {
    const results = await chrome.history.search({ text: raw, maxResults: 8 });
    return results
      .filter((h) => h.url && /^https?:/.test(h.url))
      .map((h) => ({
        type: 'history',
        title: h.title || hostOf(h.url),
        url: h.url,
        favicon: faviconOf(h.url),
        visitCount: h.visitCount || 0,
        score: Math.max(20, 20 + Math.round((h.visitCount || 0) * SUGGEST_FREQ))
      }));
  } catch { return []; }
}

async function queryEngineSuggest(raw) {
  const engine = ENGINES.find((e) => e.id === state.data.settings.engine) || ENGINES[0];
  // 只对 Bing 调 suggest 接口（稳定且 host_permissions 已覆盖）
  if (engine.id !== 'bing') return [];
  try {
    const res = await fetch(`https://www.bing.com/osjson.aspx?query=${encodeURIComponent(raw)}`);
    if (!res.ok) return [];
    const json = await res.json();
    const words = Array.isArray(json[1]) ? json[1].slice(0, 6) : [];
    return words.map((w) => ({
      type: 'engine',
      title: w,
      url: buildEngineUrl(w),
      score: 10
    }));
  } catch { return []; }
}

function renderSuggest() {
  const box = $('#suggest');
  if (!state.suggestSections.length) {
    box.innerHTML = '<div class="suggest-empty">没有匹配的结果</div>';
    box.hidden = false;
    return;
  }
  box.hidden = false;
  box.textContent = '';

  state.suggestSections.forEach((sec) => {
    const g = document.createElement('div');
    g.className = 'suggest-group';
    const label = document.createElement('div');
    label.className = 'suggest-group-label';
    label.textContent = sec.label;
    g.append(label);
    sec.items.forEach((item) => g.append(makeSuggestRow(item)));
    box.append(g);
  });

  // 重新给每个 item 绑定 hover click（保持 DOM 引用）
  const allRows = $$('.suggest-item', box);
  allRows.forEach((row, idx) => {
    row.addEventListener('mousemove', () => (state.suggestIndex = idx));
    row.addEventListener('click', (e) => {
      e.preventDefault();
      openSuggestItem(state.suggestItems[idx]);
      hideSuggest();
    });
  });
  highlightSuggest();
}

function makeSuggestRow(item) {
  const row = document.createElement('div');
  row.className = 'suggest-item';
  row.dataset.type = item.type;
  // 计算/货币项不跳转，视觉上弱化 pointer
  if (!item.url) row.style.cursor = 'default';

  const ico = document.createElement('div');
  ico.className = 's-ico';
  if (item.type === 'calc') {
    ico.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"><path d="M5 9h14M5 15h14M10 4v16M14 4v16"/></svg>';
    ico.style.background = '#3b82f6';
  } else if (item.type === 'currency') {
    ico.textContent = '¥';
    ico.style.background = '#10b981';
  } else if (item.favicon) {
    const img = document.createElement('img');
    img.draggable = false;
    img.src = item.favicon;
    img.alt = '';
    img.onerror = () => {
      img.remove();
      ico.textContent = (item.title || '?').charAt(0).toUpperCase();
      ico.style.background = `hsl(${hashHue(item.url)} 62% 46%)`;
    };
    ico.append(img);
  } else {
    ico.textContent = (item.title || '?').charAt(0).toUpperCase();
    ico.style.background = `hsl(${hashHue(item.url || item.title || '?')} 62% 46%)`;
  }

  const body = document.createElement('div');
  body.className = 's-body';
  const titleSpan = document.createElement('div');
  titleSpan.className = 's-title';
  titleSpan.textContent = item.title;
  const urlSpan = document.createElement('div');
  urlSpan.className = 's-url';
  urlSpan.textContent = item.url || item.badge || '';
  body.append(titleSpan, urlSpan);

  row.append(ico, body);

  if (item.type === 'group' && item.groupName) {
    const badge = document.createElement('span');
    badge.className = 's-badge';
    badge.textContent = item.groupName;
    row.append(badge);
  } else if (item.type === 'engine') {
    const badge = document.createElement('span');
    badge.className = 's-badge';
    badge.textContent = '搜索';
    row.append(badge);
  } else if (item.type === 'history' && item.visitCount > 1) {
    const badge = document.createElement('span');
    badge.className = 's-badge';
    badge.textContent = `访问 ${item.visitCount} 次`;
    row.append(badge);
  } else if (item.badge && !item.url) {
    // 计算/货币：badge 是表达式或汇率，不重复显示（已经在 urlSpan 里了）
  }

  return row;
}

function suggestMove(delta) {
  if (!state.suggestItems.length) return;
  state.suggestIndex = Math.max(0, Math.min(state.suggestItems.length - 1, state.suggestIndex + delta));
  highlightSuggest();
}

function highlightSuggest() {
  const rows = $$('.suggest-item', $('#suggest'));
  rows.forEach((r, i) => r.classList.toggle('selected', i === state.suggestIndex));
  // 选中项滚进可视区
  if (state.suggestIndex >= 0 && rows[state.suggestIndex]) {
    rows[state.suggestIndex].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

function openSuggestItem(item) {
  if (!item || !item.url) return; // 计算/货币项无 url，不跳转
  location.href = item.url;
}

export function hideSuggest() {
  $('#suggest').hidden = true;
  $('#suggest').innerHTML = '';
  state.suggestItems = [];
  state.suggestSections = [];
  state.suggestIndex = -1;
}
