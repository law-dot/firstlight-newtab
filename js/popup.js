// 弹窗收藏（1.4.0）：点插件图标 → 弹出这个小窗 → 选分组 → 完成收藏。
// 职责刻意保持极薄：拿当前页信息、填表单、往 monk.pendingadds.v1 队列里追加一条。
// **不碰分组数据本体**——落盘由 newtab 侧的 pending.js 统一做，
// 否则 popup 和 newtab 两个运行环境并发改数据，LWW 合并会被打穿。
// 权限模型：activeTab——点图标这个动作本身就是授权，
// 只对当前这一个页面临时生效，不申请任何常驻 host 权限。
import {
  appendPendingAdd, loadGroupList, loadPopupConf, savePopupConf
} from './core/store.js';

const $ = (id) => document.getElementById(id);

/* ---------- 当前页信息 ---------- */
async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

/* activeTab 授权只在「点图标」瞬间生效，popup 打开即拿到当前页的 url/title。
   executeScript 直接在页面里读 meta description——比重新 fetch 整页快得多，
   也不需要 host 权限；失败（受限页、CSP、页面还没加载完）就静默走标题兜底。 */
async function grabDesc(tabId) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const m = document.querySelector(
          'meta[name="description"], meta[property="og:description"]'
        );
        return (m?.content || '').trim();
      }
    });
    return String(res?.result || '').slice(0, 120);
  } catch {
    return '';
  }
}

// 页面里读不到简介时的兜底：从标题里截出人话（与 sitedesc.js 同一套思路，这里独立一份，
// popup 不 import sitedesc——那会拖上整个状态模块）
function descFromTitle(title) {
  const parts = String(title || '')
    .split(/[|｜\-–—_·•/]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length < 2) return '';
  const zh = parts.filter((p) => /[\u4e00-\u9fa5]/.test(p)).sort((a, b) => b.length - a.length);
  const pick = zh[0] || '';
  return pick.length >= 4 ? pick.slice(0, 60) : '';
}

function setStatus(msg, cls = '') {
  const el = $('status');
  el.textContent = msg;
  el.className = cls;
}

function blockPage(why) {
  $('form').hidden = true;
  $('blocked').hidden = false;
  if (why) $('blockedWhy').textContent = why;
}

/* ---------- 已收藏查重：整页变成「已在收藏中」的提示 ---------- */
function findExisting(url, groups) {
  const norm = (u) => String(u || '').trim().replace(/#.*$/, '').replace(/\/+$/, '');
  const target = norm(url);
  for (const g of groups) {
    for (const s of g.sites || []) {
      if (norm(s.url) === target) return g;
    }
  }
  return null;
}

/* ---------- 主流程 ---------- */
init().catch((err) => {
  console.error('popup init failed', err);
  blockPage('弹窗初始化失败，请重试。');
});

async function init() {
  const tab = await currentTab();
  const url = tab?.url || '';
  if (!/^https?:\/\//i.test(url)) {
    blockPage();
    return;
  }

  // favicon 走扩展自带的 _favicon 通道（manifest 已有 favicon 权限）
  try {
    $('fav').src = chrome.runtime.getURL(
      `/_favicon/?pageUrl=${encodeURIComponent(url)}&size=32`
    );
    $('fav').hidden = false;
  } catch {
    /* 没有图标就不显示，不影响流程 */
  }
  $('host').textContent = new URL(url).hostname;

  // 表单先填上，简介异步补：抓取慢一点不应该让人干等
  $('title').value = String(tab.title || '').slice(0, 60);

  const groups = await loadGroupList();
  if (!groups.length) {
    blockPage('还没有任何分组，先在新标签页里建一个。');
    return;
  }
  for (const g of groups) {
    const opt = document.createElement('option');
    opt.value = g.id;
    opt.textContent = `${g.name}（${(g.sites || []).length}）`;
    $('group').appendChild(opt);
  }
  // 默认选中上次用的分组；没记录就选第一个
  const conf = await loadPopupConf();
  const last = groups.find((g) => g.id === conf.lastGroupId);
  if (last) $('group').value = last.id;

  const existing = findExisting(url, groups);
  if (existing) {
    $('btnSave').disabled = true;
    setStatus(`已在收藏中（${existing.name}）`);
    return;
  }

  const desc = await grabDesc(tab.id) || descFromTitle(tab.title);
  if (desc) $('desc').value = desc;

  $('btnSave').addEventListener('click', () => save(url, tab));
}

async function save(url, tab) {
  const groupId = $('group').value;
  if (!groupId) return;
  $('btnSave').disabled = true;
  try {
    await appendPendingAdd({
      url,
      title: $('title').value.trim().slice(0, 60) || String(tab.title || '').slice(0, 60),
      desc: $('desc').value.trim().slice(0, 120),
      groupId
    });
    await savePopupConf({ lastGroupId: groupId });
    setStatus('已收藏，切到新标签页就能看到', 'ok');
    setTimeout(() => window.close(), 700);
  } catch (err) {
    console.error('save failed', err);
    setStatus('收藏失败，请重试', 'err');
    $('btnSave').disabled = false;
  }
}
