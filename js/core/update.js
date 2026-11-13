// 版本更新检测：问 GitHub Releases 要最新 tag，和本机 manifest 版本比。
//
// 几个刻意的选择：
// 1) 只查一次 / 12 小时，结果落本机缓存。GitHub 未认证 API 限流 60 次/小时/IP，
//    新标签页一天能开几十次，不缓存等于自找 403。
// 2) 任何失败都静默。离线、公司网墙、API 改版都不该让新标签页报错。
// 3) 不做自动更新 —— 这不是商店扩展，用户自己装的解压包。
//    能做的只有「告诉他有新版，给个链接」，剩下交给人。
// 4) 不参与同步：检测结果是「这台机器此刻的网络看到的」，跨设备同步只会误导。
const OWNER = 'law-dot';
const REPO = 'firstlight-newtab';
const API = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;
export const RELEASES_URL = `https://github.com/${OWNER}/${REPO}/releases`;
const CACHE_KEY = 'firstlight.update.v1';
const TTL = 12 * 60 * 60 * 1000;

/* ---------------- 版本号 ---------------- */

// 只认 x.y.z（可带 -beta 后缀）。认不出来的返回 null，由调用方当「未知」处理，
// 不做「啊那大概是旧版」的猜测 —— 猜错会让人以为该升级。
export function parseVer(v) {
  const m = String(v == null ? '' : v).trim().replace(/^v/i, '')
    .match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.\-]+))?$/);
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || '' };
}

// 1 = a 更新，-1 = b 更新，0 = 相同或无法比较
export function compareVer(a, b) {
  const A = parseVer(a);
  const B = parseVer(b);
  if (!A || !B) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (A.nums[i] !== B.nums[i]) return A.nums[i] > B.nums[i] ? 1 : -1;
  }
  // 1.4.0-beta 低于 1.4.0
  if (!A.pre && B.pre) return 1;
  if (A.pre && !B.pre) return -1;
  if (A.pre === B.pre) return 0;
  return A.pre > B.pre ? 1 : -1;
}

/* ---------------- 本地缓存 ---------------- */

function hasChromeLocal() {
  return typeof chrome !== 'undefined' && !!chrome.storage?.local;
}

async function readCache() {
  try {
    if (hasChromeLocal()) {
      const got = await chrome.storage.local.get(CACHE_KEY);
      return got?.[CACHE_KEY] || null;
    }
    return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
  } catch {
    return null;
  }
}

async function writeCache(v) {
  try {
    if (hasChromeLocal()) await chrome.storage.local.set({ [CACHE_KEY]: v });
    else localStorage.setItem(CACHE_KEY, JSON.stringify(v));
  } catch {
    /* 缓存写不进去不影响功能 */
  }
}

export async function getCached() {
  return readCache();
}

/* ---------------- 检测 ---------------- */

async function fetchLatest() {
  const res = await fetch(API, {
    headers: { Accept: 'application/vnd.github+json' },
    credentials: 'omit',
    cache: 'no-store'
  });
  if (!res.ok) throw new Error(`http ${res.status}`);
  const json = await res.json();
  const latest = String(json.tag_name || '').replace(/^v/i, '');
  if (!parseVer(latest)) throw new Error('badtag');
  return {
    ok: true,
    checkedAt: Date.now(),
    latest,
    url: json.html_url || RELEASES_URL,
    name: String(json.name || '').slice(0, 120),
    notes: String(json.body || '').slice(0, 1500),
    publishedAt: json.published_at || '',
    prerelease: !!json.prerelease
  };
}

/* 返回 { ok, latest, url, checkedAt, fromCache } 或 { ok:false, error }。
   force=true 跳过 TTL（用户手点「检查更新」时用）。 */
export async function checkForUpdate({ force = false } = {}) {
  const cache = await readCache();
  if (!force && cache?.checkedAt && Date.now() - cache.checkedAt < TTL) {
    return { ...cache, ok: true, fromCache: true };
  }
  try {
    const fresh = await fetchLatest();
    await writeCache(fresh);
    return fresh;
  } catch (err) {
    // 失败时保留上一次的成功结果，只是标记这次没查成
    return {
      ok: false,
      error: String(err?.message || 'network'),
      latest: cache?.latest || '',
      url: cache?.url || RELEASES_URL,
      checkedAt: cache?.checkedAt || 0,
      fromCache: !!cache
    };
  }
}

/* 把检测结果翻译成「相对本机版本」的状态。
   ahead 这一档是真实存在的：本地开发版常常比线上 release 更新。 */
export function judge(current, result) {
  if (!result?.ok || !result.latest) {
    return { status: result?.error === 'badtag' ? 'error' : 'error', current, latest: result?.latest || '', url: result?.url || RELEASES_URL };
  }
  const cmp = compareVer(result.latest, current);
  const status = cmp > 0 ? 'new' : cmp < 0 ? 'ahead' : 'current';
  return { status, current, latest: result.latest, url: result.url || RELEASES_URL, checkedAt: result.checkedAt || 0, fromCache: !!result.fromCache };
}

export function relTime(ts) {
  if (!ts) return '';
  const d = Date.now() - ts;
  if (d < 60000) return '刚刚';
  if (d < 3600000) return `${Math.floor(d / 60000)} 分钟前`;
  if (d < 86400000) return `${Math.floor(d / 3600000)} 小时前`;
  return `${Math.floor(d / 86400000)} 天前`;
}
