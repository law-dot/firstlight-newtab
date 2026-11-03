// ICS 轻量解析器：只读 VEVENT 块的 DTSTART / DTEND / SUMMARY / LOCATION / RRULE
// RFC 5545 完整度 <30%，但覆盖日历订阅最常见的事件场景
// 设计目标：扩展环境能直接跑，无第三方依赖，约 150 行

// 逐行解析：处理 CONTINUATION LINE（长属性跨行）
function unfold(raw) {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  for (const line of lines) {
    if (!line) continue;
    if (line[0] === ' ' || line[0] === '\t') {
      // 上一行的续行
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

// 按分块切：BEGIN:XXX / END:XXX，嵌套扁平处理（ICS 里 VEVENT 通常不深嵌套）
function splitBlocks(lines) {
  const blocks = [];
  let cur = null;
  for (const line of lines) {
    if (line.startsWith('BEGIN:')) {
      const type = line.slice(6).trim();
      cur = { type, props: [] };
      blocks.push(cur);
    } else if (line.startsWith('END:')) {
      cur = null;
    } else if (cur) {
      cur.props.push(line);
    }
  }
  return blocks;
}

// 解析单条属性：KEY[;PARAM=VAL]:VALUE
function parseProp(line) {
  const colon = line.indexOf(':');
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = decodeValue(line.slice(colon + 1));
  const parts = head.split(';');
  const key = parts[0].toUpperCase();
  const params = {};
  for (let i = 1; i < parts.length; i++) {
    const eq = parts[i].indexOf('=');
    if (eq > 0) params[parts[i].slice(0, eq).toUpperCase()] = parts[i].slice(eq + 1);
  }
  return { key, params, value };
}

// ICS VALUE 编码：\n \, \\
function decodeValue(s) {
  return s.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\\\/g, '\\');
}

/* 解析日期时间值
   - VALUE=DATE → 全天事件
   - 结尾 Z → UTC，转本地
   - 纯 YYYYMMDDTHHMMSS → 本地时间
   - TZID=xxx → 尝试按时区解析，失败回退本地
   返回 { date: 'YYYY-MM-DD', time: 'HH:MM', allDay: boolean }
*/
function parseDateTime(prop) {
  const raw = prop.value.trim();
  const { TZID, VALUE } = prop.params;

  // VALUE=DATE → 全天
  if (VALUE === 'DATE' || /^\d{8}$/.test(raw)) {
    const d = new Date(`${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T00:00:00`);
    return { date: isoOf(d), time: '', allDay: true };
  }

  // UTC 结尾 Z
  if (/^\d{8}T\d{6}Z$/.test(raw)) {
    const y = +raw.slice(0, 4), mo = +raw.slice(4, 6) - 1, d = +raw.slice(6, 8);
    const hh = +raw.slice(9, 11), mm = +raw.slice(11, 13);
    const dt = new Date(Date.UTC(y, mo, d, hh, mm));
    return { date: isoOf(dt), time: hm(dt), allDay: false };
  }

  // 本地时间（无 Z，无 TZID 或 TZID 解析失败）
  if (/^\d{8}T\d{6}$/.test(raw)) {
    const y = raw.slice(0, 4), mo = raw.slice(4, 6), d = raw.slice(6, 8);
    const hh = raw.slice(9, 11), mm = raw.slice(11, 13);
    const dt = new Date(`${y}-${mo}-${d}T${hh}:${mm}:00`);
    return { date: isoOf(dt), time: `${hh}:${mm}`, allDay: false };
  }

  // 带 TZID（简化：先用 Intl 尝试解析）
  if (TZID && /^\d{8}T\d{6}$/.test(raw)) {
    try {
      const parts = Intl.DateTimeFormat('en-US', {
        timeZone: TZID,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false
      }).formatToParts(new Date(0));
      // 构造一个 UTC 时间戳然后用 TZID 偏移？简化：直接当本地时间处理，标注 TZID
      // 其实更正确的做法是：把 TZID 里的日期时间当成那个时区的本地时间，转成 UTC 戳
      // 这里用 Date + TZID 字符串的 trick：
      const asUTC = new Date(`${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T${raw.slice(9, 11)}:${raw.slice(11, 13)}:00Z`);
      // 简化处理：当作本地时间忽略 TZID（绝大多数订阅源在同一时区）
      const dt = new Date(`${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T${raw.slice(9, 11)}:${raw.slice(11, 13)}:00`);
      void asUTC; // 暂不使用
      return { date: isoOf(dt), time: `${raw.slice(9, 11)}:${raw.slice(11, 13)}`, allDay: false, tzid: TZID };
    } catch {
      // fallback 本地时间
    }
  }

  // 兜底：无法解析
  return null;
}

function isoOf(d) {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${dd}`;
}

function hm(d) {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/* 主入口：ICS 文本 → [{ date, time, allDay, text, location, rrule }] */
export function parseICS(raw) {
  const lines = unfold(raw);
  const blocks = splitBlocks(lines);
  const events = [];

  for (const blk of blocks) {
    if (blk.type !== 'VEVENT') continue;
    const e = {};
    for (const propLine of blk.props) {
      const p = parseProp(propLine);
      if (!p) continue;
      switch (p.key) {
        case 'DTSTART': e.start = parseDateTime(p); break;
        case 'DTEND': e.end = parseDateTime(p); break;
        case 'SUMMARY': e.summary = p.value.trim(); break;
        case 'LOCATION': e.location = p.value.trim(); break;
        case 'RRULE': e.rrule = p.value; break;
        case 'UID': e.uid = p.value.trim(); break;
      }
    }
    if (!e.start || !e.summary) continue;
    events.push({
      date: e.start.date,
      time: e.start.allDay ? '' : e.start.time,
      allDay: e.start.allDay,
      text: e.summary,
      location: e.location || '',
      uid: e.uid || cryptoRandomId(),
      rrule: e.rrule || ''
    });
  }
  return events;
}

function cryptoRandomId() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/* 校验 ICS 文本基本可解析：BEGIN:VCALENDAR + 至少一个 VEVENT */
export function looksLikeICS(raw) {
  if (!raw || typeof raw !== 'string') return false;
  return /BEGIN:VCALENDAR/i.test(raw) && /BEGIN:VEVENT/i.test(raw);
}

/* ==================== RRULE 展开 ====================
   只覆盖订阅日历里常见的组合：FREQ(DAILY/WEEKLY/MONTHLY/YEARLY) + INTERVAL +
   COUNT/UNTIL + BYDAY（含 3MO、-1MO、4TH 这类序数）+ BYMONTHDAY + BYMONTH。
   EXDATE / RDATE / BYSETPOS 暂不支持。
*/

const WEEKDAY_CODE = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const MAX_ITER = 5000;

function parseRRule(str) {
  const r = {};
  String(str).split(';').forEach((kv) => {
    const eq = kv.indexOf('=');
    if (eq > 0) r[kv.slice(0, eq).trim().toUpperCase()] = kv.slice(eq + 1).trim().toUpperCase();
  });
  return r;
}

function dateOfIso(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function daysInMonth(y, m) {
  return new Date(y, m + 1, 0).getDate();
}

// BYDAY 单项：'3MO' / '-1MO' / '4TH' / 'MO' → { ord, wd }
function parseByDay(token) {
  const m = /^([+-]?\d+)?([A-Z]{2})$/.exec(token);
  if (!m) return null;
  const wd = WEEKDAY_CODE[m[2]];
  if (wd === undefined) return null;
  return { ord: m[1] ? Number(m[1]) : null, wd };
}

// UNTIL：20291112 或 20291112T000000Z → 'YYYY-MM-DD'
function untilIso(raw) {
  const s = raw.replace(/[^0-9T]/g, '');
  if (s.length < 8) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

// 某月第 n 个星期几（n 为负表示倒数），越界返回 null
function nthWeekdayOfMonth(y, m, n, wd) {
  const dim = daysInMonth(y, m);
  if (n > 0) {
    const delta = (wd - new Date(y, m, 1).getDay() + 7) % 7;
    const day = 1 + delta + (n - 1) * 7;
    return day <= dim ? new Date(y, m, day) : null;
  }
  const delta = (new Date(y, m, dim).getDay() - wd + 7) % 7;
  const day = dim - delta - (Math.abs(n) - 1) * 7;
  return day >= 1 ? new Date(y, m, day) : null;
}

/* 展开单条事件在 [fromIso, toIso] 区间内的所有日期（含首次）
   无 rrule 时只返回原始日期（落在区间内才算） */
export function expandOccurrences(item, fromIso, toIso) {
  const base = item.date;
  const rule = item.rrule ? parseRRule(item.rrule) : null;
  if (!base) return [];
  if (!rule || !['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(rule.FREQ)) {
    return base >= fromIso && base <= toIso ? [base] : [];
  }

  const freq = rule.FREQ;
  const interval = Math.max(1, Number(rule.INTERVAL || 1));
  const count = rule.COUNT ? Number(rule.COUNT) : null;
  const until = rule.UNTIL ? untilIso(rule.UNTIL) : null;
  const byday = rule.BYDAY ? rule.BYDAY.split(',').map(parseByDay).filter(Boolean) : null;
  const bymd = rule.BYMONTHDAY ? rule.BYMONTHDAY.split(',').map(Number) : null;
  const bymonth = rule.BYMONTH ? rule.BYMONTH.split(',').map(Number) : null;

  const start = dateOfIso(base);
  const out = [];
  let emitted = 0;
  let iterations = 0;

  // 去重 + 升序（BYDAY 多值时生成顺序可能乱）
  const finish = () => out.filter((iso, i) => out.indexOf(iso) === i).sort();

  // 返回 false 表示可以停止（已越过 UNTIL 或 COUNT 用尽）
  const emit = (d) => {
    if (!d) return true;
    const iso = isoOf(d);
    if (iso < base) return true;
    if (until && iso > until) return false;
    if (count && emitted >= count) return false;
    emitted += 1;
    if (iso >= fromIso && iso <= toIso) out.push(iso);
    return true;
  };

  if (freq === 'DAILY') {
    for (let i = 0; iterations < MAX_ITER; i += 1) {
      const d = addDays(start, i * interval);
      if (isoOf(d) > toIso) break;
      iterations += 1;
      if (!emit(d)) break;
    }
  } else if (freq === 'WEEKLY') {
    // 以本周一为锚，BYDAY 用周一~周日偏移（WKST 默认 MO）
    const anchor = addDays(start, -((start.getDay() + 6) % 7));
    for (let w = 0; iterations < MAX_ITER; w += 1) {
      const weekStart = addDays(anchor, w * 7 * interval);
      if (isoOf(weekStart) > toIso) break;
      const days = byday && byday.length
        ? byday.map((bd) => addDays(weekStart, (bd.wd + 6) % 7))
        : [addDays(weekStart, (start.getDay() + 6) % 7)];
      for (const d of days) {
        iterations += 1;
        if (!emit(d)) return finish();
      }
    }
  } else if (freq === 'MONTHLY') {
    const y0 = start.getFullYear();
    const m0 = start.getMonth();
    for (let i = 0; iterations < MAX_ITER; i += 1) {
      const dt = new Date(y0, m0 + i * interval, 1);
      if (isoOf(dt) > toIso) break;
      const y = dt.getFullYear();
      const m = dt.getMonth();
      const days = [];
      if (bymd) {
        for (const day of bymd) {
          const real = day > 0 ? day : daysInMonth(y, m) + day + 1;
          if (real >= 1 && real <= daysInMonth(y, m)) days.push(new Date(y, m, real));
        }
      } else if (byday) {
        for (const bd of byday) days.push(nthWeekdayOfMonth(y, m, bd.ord || 1, bd.wd));
      } else {
        const day = start.getDate();
        if (day <= daysInMonth(y, m)) days.push(new Date(y, m, day));
      }
      for (const d of days) {
        iterations += 1;
        if (!emit(d)) return finish();
      }
    }
  } else {
    const months = (bymonth || [start.getMonth() + 1]).slice().sort((a, b) => a - b);
    const y0 = start.getFullYear();
    for (let i = 0; iterations < MAX_ITER; i += 1) {
      const y = y0 + i * interval;
      if (isoOf(new Date(y, 0, 1)) > toIso) break;
      const days = [];
      for (const mNum of months) {
        const m = mNum - 1;
        if (m < 0 || m > 11) continue;
        if (byday && byday.length) {
          for (const bd of byday) days.push(nthWeekdayOfMonth(y, m, bd.ord || 1, bd.wd));
        } else if (bymd) {
          for (const day of bymd) {
            const real = day > 0 ? day : daysInMonth(y, m) + day + 1;
            if (real >= 1 && real <= daysInMonth(y, m)) days.push(new Date(y, m, real));
          }
        } else {
          const day = start.getDate();
          if (day <= daysInMonth(y, m)) days.push(new Date(y, m, day));
        }
      }
      for (const d of days) {
        iterations += 1;
        if (!emit(d)) return finish();
      }
    }
  }

  return finish();
}
