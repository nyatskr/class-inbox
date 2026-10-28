/* core/reminder.js —— 晚间提醒的内容与去重规则
 *
 * 两条硬约束，都是产品上的：
 *
 * 1. 只查「今天」。历史欠账单独统计，绝不能混进晚间提醒，
 *    否则攒了三十节旧课就会每晚被轰炸三十条。
 *
 * 2. 通知里只有课程名 / 节次 / 地点，**不含任何转录正文或板书内容**。
 *    推送走第三方通道（Server酱 → 微信），内容会经过别人服务器。
 *
 * 去重键：同一用户 + 同一天 + 同一渠道，只发一次。云函数定时触发器
 * 可能重复触发，靠这个键在数据库层做唯一约束。
 */

const { subjectNameOf, timeTextOf, placeOf } = require('./snapshot');

/**
 * @param {string} date  'YYYY-MM-DD'
 * @param {Array}  pending  当天「待处理且没免记」的记录（调用方已筛好）
 * @param {Function} findEntry  (entryId) => entry|null，用于老数据兜底
 * @returns {null|{date,count,title,desp,courses}}
 */
function buildReminderPayload(date, pending, findEntry) {
  if (!pending || !pending.length) return null;

  const courses = pending.map(s => ({
    name: subjectNameOf(s, findEntry),
    time: timeTextOf(s, findEntry),
    location: placeOf(s, findEntry)
  }));

  const title = `还有 ${courses.length} 节课没归档`;
  const desp = [
    `**${date}** 还有 ${courses.length} 节课没上传转录稿：`,
    '',
    ...courses.map(c => `- ${c.name}　${c.time}${c.location ? '　' + c.location : ''}`),
    '',
    '补齐后今晚不会再提醒。本条只含课程名/节次/地点，不含任何转录正文或板书。'
  ].join('\n');

  return { date, count: courses.length, title, desp, courses };
}

/** 去重键：reminder_logs 集合的 _id，天然唯一 */
function reminderKey(userId, date, channel) {
  return `${userId}__${date}__${channel}`;
}

/** Server酱标题上限 32 字 */
function clampTitle(title) {
  return String(title || '').slice(0, 32);
}

module.exports = { buildReminderPayload, reminderKey, clampTitle };
