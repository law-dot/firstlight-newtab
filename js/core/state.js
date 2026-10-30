// 全局共享状态：所有 feature 模块读写同一个 state，避免层层传参
import { saveData } from './store.js';
import { notifyChanged } from './sync.js';
import { toast } from './utils.js';

export const state = {
  data: null,               // loadData() 后的完整数据（groups/settings/todos/dock/events）
  activeGroupId: null,
  editMode: false,
  dragSiteId: null,
  dragFromGroupId: null,
  dragDockIndex: null,      // 非 null 表示从 dock 拖出来的
  bgUrl: null,              // 当前壁纸的 objectURL
  currentCredit: '',
  onlineFailNotified: false,
  manualIndex: 0,
  idleTimer: null,
  idleActive: false,
  lastActivityAt: Date.now(),
  lastWakeAt: 0,
  edgeTimer: null,
  drawerLeaveTimer: null,
  drawerHovered: false,
  sideAutoOpened: false,
  /* 搜索建议 */
  suggestTimer: null,
  suggestItems: [],         // 扁平列表，每项带 { type, title, url, badge?, favicon? }
  suggestSections: [],      // [{ label, items }] 分组视图
  suggestIndex: -1,         // 键盘选中项在 suggestItems 里的 index
  /* 货币汇率缓存 */
  rateCache: null,
  /* 对话框上下文 */
  siteCtx: { groupId: null, siteId: null },
  groupCtx: { groupId: null }
};

export function persist() {
  return saveData(state.data)
    .then((changed) => notifyChanged(changed))
    .catch(() => toast('保存失败'));
}
