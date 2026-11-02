// 全站访问权限（manifest 的 optional_host_permissions: https://*/*）
// 唯一用途：自动抓取网站简介 / 读取 RSS。默认不申请，绝不在首屏弹。
// 只能声明 manifest 里列出的 origins，否则 contains/request 会直接抛错。

const OPTIONAL_ORIGINS = ['https://*/*'];

let cached = null; // 本页内缓存结果，避免每张卡片都问一次扩展 API

export async function hasFetchAccess() {
  if (typeof chrome === 'undefined' || !chrome.permissions?.contains) return false;
  if (cached !== null) return cached;
  try {
    cached = !!(await chrome.permissions.contains({ origins: OPTIONAL_ORIGINS }));
  } catch {
    cached = false;
  }
  return cached;
}

// 只能在用户手势里调用（点击），否则浏览器直接拒绝
export async function requestFetchAccess() {
  if (typeof chrome === 'undefined' || !chrome.permissions?.request) return false;
  try {
    cached = !!(await chrome.permissions.request({ origins: OPTIONAL_ORIGINS }));
  } catch {
    cached = false;
  }
  return cached;
}

// 用户在浏览器设置里撤销授权时，缓存要跟着失效
export function forgetFetchAccess() {
  cached = null;
}
