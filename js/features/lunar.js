// 农历换算：直接用 Intl 的中华农历日历（Chromium 内置），无对照表、无网络请求
const lunarFmt = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', { month: 'long', day: 'numeric' });

const DAY_NAME = [
  '初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
  '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十'
];
// 主要传统节日：key = 月名-日
const FESTIVAL = {
  '正月-1': '春节', '正月-15': '元宵节', '五月-5': '端午节',
  '七月-7': '七夕', '八月-15': '中秋节', '九月-9': '重阳节', '腊月-8': '腊八节'
};

function lunarParts(date) {
  const parts = lunarFmt.formatToParts(date);
  const month = parts.find((p) => p.type === 'month').value; // '正月' '闰二月' 等
  const day = Number(parts.find((p) => p.type === 'day').value); // 1-30
  return { month, day };
}

/* 公历 Date → { text: '九月十三', festival: '中秋节' | '' } */
export function getLunar(date) {
  const { month, day } = lunarParts(date);
  if (day < 1 || day > 30) return null;

  let festival = FESTIVAL[`${month}-${day}`] || '';
  // 除夕：明天的农历是正月初一，今天就是除夕（兼容腊月大小月）
  if (!festival) {
    const next = new Date(date);
    next.setDate(next.getDate() + 1);
    const n = lunarParts(next);
    if (n.month === '正月' && n.day === 1) festival = '除夕';
  }

  return { text: `${month}${DAY_NAME[day - 1]}`, festival };
}
