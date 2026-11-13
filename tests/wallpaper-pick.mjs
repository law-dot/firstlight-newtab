/* 在线壁纸「换一张」回归：起点索引不能再被重渲染刷回 0
   跑法：node tests/wallpaper-pick.mjs */
import { startIndex } from '../js/features/wallpaper.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name} ${extra}`); }
};

console.log('[1] 每日模式：记住「换一张」选中的那张');
ok('pick=3 重渲染仍是第 3 张（不再回 0）', startIndex({ pick: 3, len: 10 }) === 3);
ok('没有 pick 字段的老数据 → 0', startIndex({ len: 10 }) === 0);
ok('pick 越界（列表变短）按长度回绕', startIndex({ pick: 12, len: 10 }) === 2);
ok('pick 为负数也不炸', startIndex({ pick: -1, len: 10 }) === 9);

console.log('[2] 「换一张」= 往后挪一张');
ok('pick=3 + advance → 4', startIndex({ pick: 3, len: 10, advance: true }) === 4);
ok('pick=9 + advance 回到 0', startIndex({ pick: 9, len: 10, advance: true }) === 0);
ok('没有 pick + advance → 1', startIndex({ len: 10, advance: true }) === 1);

console.log('[3] 列表是新抓的（跨天/换源）：回到最新那张');
ok('freshList 且不 advance → 0', startIndex({ pick: 5, len: 10, freshList: true }) === 0);

console.log('[4] 轮播模式仍按 cursor');
ok('rotate 用 cursor', startIndex({ cursor: 6, pick: 2, len: 10, rotate: true }) === 6);
ok('rotate 的 cursor 越界回绕', startIndex({ cursor: 11, pick: 2, len: 10, rotate: true }) === 1);
ok('rotate 时 advance 不改变起点', startIndex({ cursor: 6, len: 10, rotate: true, advance: true }) === 6);

console.log('[5] 边界');
ok('空列表不炸', startIndex({ len: 0 }) === 0);
ok('单元素列表 advance 仍是 0', startIndex({ len: 1, advance: true }) === 0);

console.log(`\n结果：${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
