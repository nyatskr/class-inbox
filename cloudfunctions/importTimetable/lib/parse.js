/* lib/parse.js —— 课表解析（待搬）
 *
 * 这里现在只有契约，没有实现。要让它真正工作，把网页版 app.js 里这几个函数
 * 原样复制进来，然后删掉下面的 throw：
 *
 *   parseTimetableFile(file, fileName)  → { drafts, semesterStart, notes }
 *   parseXls(buf)                       OLE2/CFB + BIFF8（学校导出的 .xls）
 *   parseXlsx(buf)                      ZIP + sharedStrings + sheet1（通用 .xlsx）
 *   parseHtmlTable(html)                有些「.xls」其实是 HTML 表格，扩展名骗人
 *   splitCellBlocks(text)               一个单元格里塞了多门课
 *   parseCourseLine(line)               「课程/周次/地点/教师/教学班/…」斜杠格式
 *
 * drafts[] 的每一项要有这些字段（和网页版一致，写库逻辑依赖它）：
 *   { name, weekday, sections, sectionsKey, startTime, endTime,
 *     location, teacher, weekRanges, weekMode, weekFrom, weekTo, weeks, keep }
 *
 * 搬的时候注意两件当年踩过的坑：
 *   1. 多段周次「2-4周,7周,10-16周」要先吃掉匹配到的区间再扫单周，否则第 7 周会丢。
 *   2. 同一个单元格里两门课的「名称/教室」会串行，切块时要把末尾那行教室一起吞掉。
 */

function notPorted(what) {
  return new Error(
    `${what} 还没搬到云端。网页版 class-inbox/app.js 里有跑通的实现，` +
    '按 cloudfunctions/importTimetable/lib/parse.js 顶部的说明复制过来即可。'
  );
}

async function parseTimetableFile() {
  throw notPorted('课表解析器');
}

module.exports = { parseTimetableFile, notPorted };
