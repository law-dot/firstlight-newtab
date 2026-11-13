// 弹窗收藏的落地层（1.4.0）：消费 monk.pendingadds.v1 队列。
// 分层刻意拆开：
//   planAdds          —— 纯函数，不碰任何存储，自检页可以直接测；
//   drainPendingAdds  —— IO 层，取队列 → planAdds → 改 state.data（由调用方 persist）；
//   watchPendingAdds  —— 监听弹窗的写入（storage.onChanged），newtab 开着就实时排空。
// 注意：本模块**不 import state.js / sync.js**（那会绕出 chrome 依赖圈），
// state 由 app.js 作为参数传入，persist 也由 app.js 自己调。
import {
  PENDING_ADDS_KEY, PENDING_READS_KEY,
  takePendingAdds, takePendingReads, uid, pruneReading
} from './store.js';

/* 查重用的网址规范化：只去掉末尾斜杠和锚点。
   故意不做更多——「http vs https」「带不带 www」算不同网址，
   宁可偶尔重复收藏，也不能把用户真正想分开存的两个页面当成同一个。 */
export function normUrl(u) {
  return String(u || '').trim().replace(/#.*$/, '').replace(/\/+$/, '');
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/* 计划：队列条目 → 要落的站点。返回 { adds, skipped }。
   规则（宁缺毋滥）：
   - 非http/https 的网址（chrome:// 等）不收——弹窗本来就拦了一道，这里是双保险；
   - 网址已存在于任何分组 → 跳过（弹窗会提示「已在收藏中」）；
   - 指定的分组已不存在（比如被删了）→ 落进第一个分组，绝不静默丢弃；
   - 同一批队列里的重复网址只收第一条；
   - 标题空了用域名兜底，简介截到 120 字（normalize 的同一上限）。 */
export function planAdds(items, groups) {
  const list = Array.isArray(groups) ? groups : [];
  const seen = new Set();
  for (const g of list) {
    for (const s of g.sites || []) {
      if (s?.url) seen.add(normUrl(s.url));
    }
  }
  const adds = [];
  const skipped = [];
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || !/^https?:\/\//i.test(it.url || '')) {
      skipped.push({ item: it, why: 'badurl' });
      continue;
    }
    if (seen.has(normUrl(it.url))) {
      skipped.push({ item: it, why: 'dup' });
      continue;
    }
    const g = list.find((x) => x.id === it.groupId) || list[0];
    if (!g) {
      skipped.push({ item: it, why: 'nogroup' });
      continue;
    }
    const url = String(it.url);
    adds.push({
      groupId: g.id,
      site: {
        id: uid(),
        title: String(it.title || hostOf(url) || url).slice(0, 60),
        url,
        icon: '',
        desc: String(it.desc || '').slice(0, 120)
      }
    });
    seen.add(normUrl(it.url));
  }
  return { adds, skipped };
}

/* 排空队列并把站点挂进 state.data.groups。返回成功加入的条数，0 = 没活干。
   只改内存，不落盘——persist 由 app.js 统一调（顺便走同步推送链路）。 */
export async function drainPendingAdds(state) {
  const items = await takePendingAdds();
  if (!items.length) return 0;
  const { adds } = planAdds(items, state.data.groups);
  for (const a of adds) {
    const g = state.data.groups.find((x) => x.id === a.groupId);
    if (!g) continue; // planAdds 不可能给出空分组，这里纯粹防手滑
    g.sites.push(a.site);
  }
  return adds.length;
}

/* 监听弹窗写入。收到的第一次触发（含我们自己排空后的删除广播）
   都会调 onDrained——里面取到空队列就自然返回 0，不渲染不落盘，
   所以「删除广播」只会白跑一趟，不会成环。
   1.5.0 起同一条监听兼顾两个队列：收藏（pendingadds）与稍后读（pendingreads）。 */
export function watchPendingAdds(onDrained) {
  if (typeof chrome === 'undefined' || !chrome.storage?.onChanged) return;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (!changes[PENDING_ADDS_KEY] && !changes[PENDING_READS_KEY]) return;
    onDrained();
  });
}

/* ---------- 稍后读（1.5.0） ---------- */
/* 计划：队列条目 → 要收进稍后读的条目。规则与 planAdds 同源：
   - 只收 http/https；
   - 已经在列表里的网址跳过（重复加入不会刷出第二条）；
   - 同一批里的重复只收第一条；
   - 标题空了用域名兜底。 */
export function planReads(items, existing) {
  const seen = new Set(
    (Array.isArray(existing) ? existing : []).map((r) => normUrl(r?.url))
  );
  const adds = [];
  const skipped = [];
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || !/^https?:\/\//i.test(it.url || '')) {
      skipped.push({ item: it, why: 'badurl' });
      continue;
    }
    const key = normUrl(it.url);
    if (seen.has(key)) {
      skipped.push({ item: it, why: 'dup' });
      continue;
    }
    const url = String(it.url);
    adds.push({
      id: uid(),
      url,
      title: String(it.title || '').slice(0, 140) || hostOf(url),
      host: hostOf(url),
      addedAt: Number(it.ts) || Date.now(),
      readAt: 0
    });
    seen.add(key);
  }
  return { adds, skipped };
}

/* 排空稍后读队列。只改内存，落盘仍由 app.js 的 persist 统一负责。
   新条目按加入时间插到最前，超上限走 store.js 的 pruneReading（先丢已读）。 */
export async function drainPendingReads(state) {
  const items = await takePendingReads();
  if (!items.length) return 0;
  if (!Array.isArray(state.data.reading)) state.data.reading = [];
  const list = state.data.reading;
  const { adds } = planReads(items, list);
  if (!adds.length) return 0;
  list.push(...adds);
  list.sort((a, b) => b.addedAt - a.addedAt);
  state.data.reading = pruneReading(list);
  return adds.length;
}
