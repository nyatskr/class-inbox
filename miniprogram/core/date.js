/* core/date.js —— 日期与周次换算（纯函数，无 DOM / 无 wx API）
 *
 * 这几个函数是整个应用的地基：课表按「第几周 + 星期几」索引，
 * 一旦算错，今日清单和晚间提醒全都会错位。所以单独抽出来，配单元测试。
 */

const WEEK_LABEL = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const DAY_MS = 86400000;
const WEEK_MS = 7 * DAY_MS;

const pad2 = n => String(n).padStart(2, '0');

/** Date → 'YYYY-MM-DD'（本地时区，不用 toISOString，避免时区偏移把日期推错一天） */
function dateStr(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 'YYYY-MM-DD' → Date（本地零点） */
function parseDate(s) {
  return new Date(s + 'T00:00:00');
}

/** 'YYYY-MM-DD' → 1..7（周一=1，周日=7） */
function weekdayOf(s) {
  return (parseDate(s).getDay() + 6) % 7 + 1;
}

/** 所在周的周一（Date） */
function mondayOf(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

/** 'YYYY-MM-DD' 是学期第几周（学期开始那周为第 1 周，可能 ≤ 0） */
function weekNoOf(ds, semesterStart) {
  const a = mondayOf(parseDate(semesterStart));
  const b = mondayOf(parseDate(ds));
  return Math.floor((b - a) / WEEK_MS) + 1;
}

/** 'YYYY-MM-DD' → '9月3日 周三' */
function fmtDateCN(ds) {
  const d = parseDate(ds);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${WEEK_LABEL[weekdayOf(ds) - 1]}`;
}

/** 从 endDs 往前数 n 天，返回从早到晚的日期字符串数组（含 endDs） */
function recentDates(n, endDs) {
  const out = [];
  const end = parseDate(endDs);
  for (let i = n - 1; i >= 0; i--) {
    out.push(dateStr(new Date(end.getTime() - i * DAY_MS)));
  }
  return out;
}

/** 上一个周一（不含本周）——「清账截止日」的默认值。
 *  注意不是「本周一」：10-28（周三）→ 10-19，周一当天也返回上一个周一。 */
function lastMondayStr(fromDs = dateStr()) {
  const m = mondayOf(parseDate(fromDs));
  m.setDate(m.getDate() - 7);
  return dateStr(m);
}

/** 加减天数 */
function addDays(ds, n) {
  return dateStr(new Date(parseDate(ds).getTime() + n * DAY_MS));
}

module.exports = {
  WEEK_LABEL,
  pad2,
  dateStr,
  parseDate,
  weekdayOf,
  mondayOf,
  weekNoOf,
  fmtDateCN,
  recentDates,
  lastMondayStr,
  addDays
};
