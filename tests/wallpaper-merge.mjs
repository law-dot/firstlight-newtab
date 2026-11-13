/* 壁纸不会被「整段设置 LWW」盖回：wallpaperAt 更大的一份赢
   跑法：node tests/wallpaper-merge.mjs */
import { keepNewerWallpaper } from '../js/core/sync.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name} ${extra}`); }
};

const online = { type: 'online', value: '', wallpaperAt: 1000, online: { fetchedAt: 1000, images: [] } };
const preset = { type: 'preset', value: 'dusk', wallpaperAt: 2000 };

console.log('[1] 本机刚换的壁纸赢过云端的旧壁纸');
const remoteV = { engine: 'bing', wallpaper: online };
const localV = { engine: 'google', wallpaper: preset };
const m1 = keepNewerWallpaper(remoteV, localV);
ok('壁纸取本机（preset）', m1.wallpaper === preset, JSON.stringify(m1.wallpaper));
ok('其他字段仍取云端（engine=bing）', m1.engine === 'bing', m1.engine);
ok('不改动传入对象', remoteV.wallpaper === online);

console.log('[2] 云端确实更新（wallpaperAt 更大）就接受');
const newer = { type: 'color', value: '#123456', wallpaperAt: 3000 };
const m2 = keepNewerWallpaper({ ...remoteV, wallpaper: newer }, localV);
ok('壁纸取云端', m2.wallpaper === newer);

console.log('[3] 老数据没有 wallpaperAt（=0）不抢');
const legacy = { type: 'online', value: '' };
const m3 = keepNewerWallpaper({ ...remoteV, wallpaper: legacy }, { wallpaper: preset });
ok('本机有时间戳就保住', m3.wallpaper === preset);

console.log('[4] 缺字段/异常输入');
ok('云端没有设置对象', keepNewerWallpaper(null, localV) === null);
ok('本机没有壁纸 → 直接用云端', keepNewerWallpaper(remoteV, {}) === remoteV);
ok('wallpaperAt 是脏值也不炸', keepNewerWallpaper({ wallpaper: { wallpaperAt: 'x' } }, { wallpaper: { wallpaperAt: 5 } }).wallpaper.wallpaperAt === 5);

console.log(`\n结果：${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
