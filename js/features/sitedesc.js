// 网站说明（详情模式）：手动填写的 desc 优先展示；缺失时自动抓取站点
// meta description / og:description 缓存到 autoDesc。
// 自动抓取需要全站访问权限（manifest 的 optional_host_permissions），
// 未授权或预览环境（无 chrome.permissions）自动跳过，只显示手动说明。
import { state, persist } from '../core/state.js';
import { fetchWithTimeout } from '../core/utils.js';
import { renderAll } from '../app.js';

const inFlight = new Set(); // 正在抓取的 site.id，防重入

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

// 从 HTML 头部提取简介，兼容 name/property 与 content 属性顺序
export function parseDescription(html) {
  const head = html.slice(0, 60000);
  const metas = head.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of metas) {
    if (!/(?:name|property)\s*=\s*["'](?:description|og:description)["']/i.test(tag)) {
      continue;
    }
    const m = tag.match(/content\s*=\s*["']([^"']*)["']/i);
    if (m && m[1].trim()) return decodeEntities(m[1].trim()).slice(0, 120);
  }
  return '';
}

export async function hasFetchAccess() {
  if (typeof chrome === 'undefined' || !chrome.permissions?.contains) return false;
  try {
    return await chrome.permissions.contains({ origins: ['https://*/*'] });
  } catch {
    return false;
  }
}

// 只能在用户手势里调用：授权弹窗必须有手势，否则会被浏览器拒绝
export async function requestFetchAccess() {
  if (await hasFetchAccess()) return true;
  if (typeof chrome === 'undefined' || !chrome.permissions?.request) return false;
  try {
    return await chrome.permissions.request({ origins: ['https://*/*'] });
  } catch {
    return false;
  }
}

async function fetchOne(site) {
  if (inFlight.has(site.id)) return false;
  inFlight.add(site.id);
  try {
    const res = await fetchWithTimeout(site.url, 6000);
    if (!res.ok) return false;
    const desc = parseDescription(await res.text());
    if (!desc) return false;
    site.autoDesc = desc;
    return true;
  } catch {
    return false;
  } finally {
    inFlight.delete(site.id);
  }
}

// 为分组补齐缺失的说明（并发 2，全部完成后一次性 persist + 重渲染）
export async function ensureDescriptions(group) {
  if (!group || state.data?.settings.siteMode !== 'detail') return;
  if (!(await hasFetchAccess())) return;
  const targets = group.sites.filter(
    (s) => !s.desc && !s.autoDesc && !inFlight.has(s.id) && /^https?:/.test(s.url)
  );
  if (!targets.length) return;

  let changed = false;
  const queue = [...targets];
  async function worker() {
    let site;
    while ((site = queue.shift())) {
      if (await fetchOne(site)) changed = true;
    }
  }
  await Promise.all([worker(), worker()]);

  if (changed && state.data.settings.siteMode === 'detail') {
    persist();
    renderAll();
  }
}
