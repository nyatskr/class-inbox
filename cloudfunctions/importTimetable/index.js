/* cloudfunctions/importTimetable —— 课表导入
 *
 * 两个动作，同一个函数：
 *   { fileID, fileName, dryRun:true }  → 解析，返回草稿，不写库
 *   { drafts, mode, semesterStart }    → 写库（mode: merge | sync）
 *
 * 为什么放云端：.xls 是 OLE2 + BIFF8，.xlsx 是 ZIP + XML，解析要几百行代码，
 * 在手机上跑又慢又吃内存。云端几十毫秒就完事，还能顺便把 ZIP 解包。
 *
 * ⚠️ 解析器还没搬过来。
 *    网页版 app.js 里已经有一份跑通的实现，直接抄这几个函数到 lib/parse.js：
 *      parseTimetableFile(file)      入口，返回 { drafts, semesterStart, notes }
 *      parseXls(buf)                 OLE2/CFB + BIFF8
 *      parseXlsx(buf)                ZIP + sharedStrings + sheet1
 *      parseHtmlTable(html)          有些学校导出的「xls」其实是 HTML 表格
 *      splitCellBlocks(text)         一个单元格里塞多门课的情况
 *      parseCourseLine(line)         「课程/周次/地点/教师/教学班/…」斜杠格式
 *    搬完把 lib/parse.js 里的 throw 换成真实实现即可，下面的写库逻辑不用改。
 */

const cloud = require('wx-server-sdk');
const parse = require('./lib/parse');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

/** 同一条课表安排的唯一键：学科 + 星期 + 节次 + 周次 */
function keyOf(draft) {
  const wk = Array.isArray(draft.weeks) ? draft.weeks.join(',') : String(draft.weeks || '');
  return `${draft.name}|${draft.weekday}|${draft.sectionsKey || ''}|${wk}`;
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();

  /* ---------- 解析（dry run） ---------- */
  if (event.fileID) {
    try {
      const r = await cloud.downloadFile({ fileID: event.fileID });
      const parsed = await parse.parseTimetableFile(r.fileContent, event.fileName || '');
      return {
        ok: true,
        drafts: parsed.drafts,
        semesterStart: parsed.semesterStart || '',
        notes: parsed.notes || []
      };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  }

  /* ---------- 写库 ---------- */
  const drafts = (event.drafts || []).filter(d => d.keep !== false && d.name);
  if (!drafts.length) return { ok: false, error: '没有勾选任何课程' };

  if (event.semesterStart) {
    await db.collection('user_settings').doc('main').set({
      data: { _openid: OPENID, semesterStart: event.semesterStart, updatedAt: Date.now() }
    }).catch(() => null);
  }

  // 现有课表，按唯一键建索引
  const existing = [];
  const PAGE = 20;
  for (let skip = 0; ; skip += PAGE) {
    const r = await db.collection('schedule_entries').where({ _openid: OPENID }).skip(skip).limit(PAGE).get();
    existing.push(...r.data);
    if (r.data.length < PAGE) break;
  }
  const byKey = new Map();
  for (const e of existing) {
    byKey.set(`${e.subjectName}|${e.weekday}|${e.sectionsKey || ''}|${e.weeksKey || ''}`, e);
  }

  let added = 0;
  let updated = 0;

  for (const d of drafts) {
    const k = keyOf(d);
    const hit = byKey.get(k);
    const doc = {
      _openid: OPENID,
      subjectName: d.name,
      weekday: d.weekday,
      sectionsKey: d.sectionsKey || '',
      sections: d.sections || '',
      startTime: d.startTime || '',
      endTime: d.endTime || '',
      location: d.location || '',
      teacher: d.teacher || '',
      weekRanges: d.weekRanges || [],
      weekMode: d.weekMode || 'all',
      weekFrom: d.weekFrom || 1,
      weekTo: d.weekTo || 20,
      weeksKey: Array.isArray(d.weeks) ? d.weeks.join(',') : String(d.weeks || ''),
      updatedAt: Date.now()
    };

    if (hit) {
      await db.collection('schedule_entries').doc(hit._id).update({ data: doc });
      updated++;
    } else {
      await db.collection('schedule_entries').add({ data: { ...doc, createdAt: Date.now() } });
      added++;
    }
  }

  /* ---------- sync：文件里没出现的旧课，移除 ---------- */
  let removed = 0;
  if (event.mode === 'sync') {
    const inFile = new Set(drafts.map(d => d.name));
    const keep = new Set(drafts.map(keyOf));
    for (const e of existing) {
      // 只动「这次文件里提到的学科」，手动加的课不碰
      if (!inFile.has(e.subjectName)) continue;
      const k = `${e.subjectName}|${e.weekday}|${e.sectionsKey || ''}|${e.weeksKey || ''}`;
      if (keep.has(k)) continue;
      await db.collection('schedule_entries').doc(e._id).remove();
      removed++;
    }
  }

  return { ok: true, added, updated, removed };
};
