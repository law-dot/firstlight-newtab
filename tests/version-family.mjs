/* 同步的版本保护按「代」（主.次）判，不按完整版本判。
   背景：把内测的 1.4.3 归并进 1.4.0 发布后，若还按完整版本比，
   云端快照里的 appVer=1.4.3 会让本机 1.4.0 被判成「云端更新」→ 全体拒写。
   跑法：node tests/version-family.mjs */
import { compareVer, compareFamily, parseVer } from '../js/core/update.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name} ${extra}`); }
};

console.log('[1] 解析');
ok('1.4.0 → [1,4,0]', JSON.stringify(parseVer('1.4.0')?.nums) === '[1,4,0]');
ok('v 前缀可省', parseVer('v1.4.0')?.nums[1] === 4);
ok('预发布后缀', parseVer('1.4.0-beta.1')?.pre === 'beta.1');
ok('脏值返回 null', parseVer('abc') === null);

console.log('[2] 完整版本比较（更新检测用，保持原语义）');
ok('1.4.3 > 1.4.0', compareVer('1.4.3', '1.4.0') === 1);
ok('1.5.0 > 1.4.9', compareVer('1.5.0', '1.4.9') === 1);
ok('1.4.0-beta < 1.4.0', compareVer('1.4.0-beta', '1.4.0') === -1);
ok('无法比较返回 0', compareVer('abc', '1.4.0') === 0);

console.log('[3] 代际比较（同步保护用）');
ok('1.4.3 与 1.4.0 同一代', compareFamily('1.4.3', '1.4.0') === 0);
ok('云端 1.5.0 > 本机 1.4.0', compareFamily('1.5.0', '1.4.0') === 1);
ok('云端 1.4.0 < 本机 1.5.0', compareFamily('1.4.0', '1.5.0') === -1);
ok('主版本差异优先（2.0 vs 1.9）', compareFamily('2.0.0', '1.9.9') === 1);
ok('预发布后缀不影响代际', compareFamily('1.4.0-beta', '1.4.9') === 0);
ok('脏值不炸、不判更新', compareFamily('', '1.4.0') === 0);

console.log('[4] 回归：版本号归并后不会被判成「云端更新」');
const cloudAfterRename = '1.4.3'; // 旧内测版写进云端的标记
const localAfterRename = '1.4.0'; // 归并后的正式版本
ok('不再拒写（compareFamily 判 0）', !(compareFamily(cloudAfterRename, localAfterRename) > 0));
ok('但真升级仍能识别（1.5.0）', compareFamily('1.5.0', localAfterRename) > 0);

console.log(`\n结果：${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
