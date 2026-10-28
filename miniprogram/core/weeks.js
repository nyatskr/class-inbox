/* core/weeks.js —— 周次匹配与显示
 *
 * 学校导出的课表有三种周次写法，都要支持：
 *   全学期            weekMode='all'
 *   第 3-16 周        weekMode='range', weekFrom/weekTo
 *   1-4周,7周,10-16周  weekRanges=[[1,4],[7,7],[10,16]]   ← 导入时展开成区间
 * 单/双周是叠加在区间之上的过滤条件。
 */

/** 这条课表安排在第 wk 周上不上 */
function weekMatches(e, wk) {
  if (Array.isArray(e.weekRanges) && e.weekRanges.length) {
    if (!e.weekRanges.some(r => wk >= r[0] && wk <= r[1])) return false;
    if (e.weekMode === 'odd') return wk % 2 === 1;
    if (e.weekMode === 'even') return wk % 2 === 0;
    return true;
  }
  const mode = e.weekMode || 'all';
  if (mode === 'all') return true;
  const from = Number(e.weekFrom) || 1;
  const to = Number(e.weekTo) || 20;
  if (wk < from || wk > to) return false;
  if (mode === 'odd') return wk % 2 === 1;
  if (mode === 'even') return wk % 2 === 0;
  return true;
}

/** 人话版周次：'1-4,7,10-16 周' */
function weekText(e) {
  const oddEven = e.weekMode === 'odd' ? '单周 ' : e.weekMode === 'even' ? '双周 ' : '';
  if (Array.isArray(e.weekRanges) && e.weekRanges.length) {
    const body = e.weekRanges.map(r => (r[0] === r[1] ? String(r[0]) : `${r[0]}-${r[1]}`)).join(',');
    return `${oddEven}${body} 周`;
  }
  const mode = e.weekMode || 'all';
  if (mode === 'all') return '全学期';
  const from = e.weekFrom || 1;
  const to = e.weekTo || 20;
  if (mode === 'range') return `第${from}-${to}周`;
  return `${mode === 'odd' ? '单' : '双'}周 ${from}-${to}`;
}

/** '1-4,7,10-16' → [[1,4],[7,7],[10,16]]；解析不出来返回 [] */
function parseWeekRanges(text) {
  const out = [];
  for (const part of String(text || '').split(/[,，、]/)) {
    const t = part.trim();
    if (!t) continue;
    const m = t.match(/^(\d{1,2})(?:\s*[-–~]\s*(\d{1,2}))?$/);
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a >= 1 && b >= a) out.push([a, b]);
  }
  return out.sort((x, y) => x[0] - y[0]);
}

module.exports = { weekMatches, weekText, parseWeekRanges };
