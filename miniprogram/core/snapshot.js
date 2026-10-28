/* core/snapshot.js —— 课堂快照
 *
 * 为什么需要：一节课的「学科名 / 节次 / 教室 / 教师」如果每次都回查当前课表，
 * 那么删掉一条课表、学期中途改教室、重新导入一次课表，**过去已经发生过的课**
 * 就会跟着变形（节次和地点凭空消失，或者显示成新教室）。
 *
 * 所以生成记录时把当时的样子抄一份存进 record.snap，之后一律读快照。
 * 规则：过去的不动，今天及以后的跟着课表走（由 refreshSnaps 负责）。
 */

/** 从课表条目 + 学科生成快照 */
function snapOfEntry(entry, subject) {
  return {
    subjectId: entry.subjectId,
    subjectName: subject ? subject.name : '未命名课程',
    color: subject ? subject.color : '#94a3b8',
    sections: entry.sections || '',
    startTime: entry.startTime || '',
    endTime: entry.endTime || '',
    location: entry.location || '',
    teacher: entry.teacher || ''
  };
}

/** 读一条记录的课堂信息：优先快照，老数据没有就现查课表兜底 */
function snapOf(record, findEntry) {
  if (record.snap) return record.snap;
  const e = findEntry ? findEntry(record.entryId) : null;
  if (!e) return null;
  return {
    subjectId: e.subjectId,
    subjectName: record.customName || '未命名课程',
    color: '#94a3b8',
    sections: record.customTime || e.sections || '',
    startTime: e.startTime || '',
    endTime: e.endTime || '',
    location: e.location || '',
    teacher: e.teacher || ''
  };
}

/** 学科名（历史记录里学科改名了也显示当时的名字） */
function subjectNameOf(record, findEntry) {
  const sn = snapOf(record, findEntry);
  return (sn && sn.subjectName) || record.customName || '未命名课程';
}

/** 节次优先，没有节次退回时间区间 */
function timeTextOf(record, findEntry) {
  if (record.customTime) return record.customTime;
  const sn = snapOf(record, findEntry);
  if (!sn) return '';
  if (sn.sections) return sn.sections;
  if (sn.startTime && sn.endTime) return `${sn.startTime}–${sn.endTime}`;
  return '';
}

function placeOf(record, findEntry) {
  const sn = snapOf(record, findEntry);
  return (sn && sn.location) || '';
}

/** 同一天里按上课时间排序 */
function sortKeyOf(record, findEntry) {
  if (record.customTime) return record.customTime;
  const sn = snapOf(record, findEntry);
  return String((sn && sn.startTime) || '99:99');
}

module.exports = { snapOfEntry, snapOf, subjectNameOf, timeTextOf, placeOf, sortKeyOf };
