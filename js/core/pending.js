// 弹窗收藏的落地层（1.4.0）：消费 monk.pendingadds.v1 队列。
// 分层刻意拆开：
//   planAdds          —— 纯函数，不碰任何存储，自检页可以直接测；
//   drainPendingAdds  —— IO 层，取队列 → planAdds → 改 state.data（由调用方 persist）；
//   watchPendingAdds  —— 监听弹窗的写入（storage.onChanged），newtab 开着就实时排空。
// 注意：本模块**不 import state.js / sync.js**（那会绕出 chrome 依赖圈），
// state 由 app.js 作为参数传入，persist 也由 app.js 自己调。
import { PENDING_ADDS_KEY, takePendingAdds, uid } from './store.js';

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
   所以「删除广播」只会白跑一趟，不会成环。 */
export function watchPendingAdds(onDrained) {
  if (typeof chrome === 'undefined' || !chrome.storage?.onChanged) return;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[PENDING_ADDS_KEY]) return;
    onDrained();
  });
}
