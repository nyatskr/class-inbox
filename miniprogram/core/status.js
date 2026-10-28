/* core/status.js —— 一节课的「归档状态」
 *
 * 四个状态 + 一个正交的 exempt 标记：
 *   pending   待处理（默认）
 *   done      已上传转录稿
 *   none      无转录稿（老师没录 / 不需要）
 *   cancelled 课程取消
 *   exempt    本次免记（不是状态，是「这次不算欠账」的开关）
 *
 * 「待办」= pending 且没 exempt。晚间提醒、历史欠账、连续补录都只看这一个判定，
 * 所以它必须只有一处实现。
 */

const STATUS_MAP = {
  pending:   { label: '待处理',       cls: 'st-pending' },
  done:      { label: '已上传转录稿', cls: 'st-done' },
  none:      { label: '无转录稿',     cls: 'st-none' },
  cancelled: { label: '课程取消',     cls: 'st-cancel' }
};

/** 这节课还算不算「欠着」 */
function isPending(s) {
  return s.status === 'pending' && !s.exempt;
}

/** 有没有实际内容（转录稿文字或板书照片） */
function hasContent(s) {
  return s.status !== 'pending' || !!(s.transcriptText || '').trim() || !!(s.photos || []).length;
}

/** 归档过没有（含免记 / 无转录稿 / 取消），今日页「已处理」用这个 */
function isHandled(s) {
  return !isPending(s);
}

/** 状态 chip 的显示：pending + exempt 直接显示「已免记」，避免和「待处理」自相矛盾 */
function statusChip(s) {
  if (s.status === 'pending' && s.exempt) return { label: '已免记', cls: 'st-none' };
  return STATUS_MAP[s.status] || STATUS_MAP.pending;
}

/**
 * 内容变动后更新「上传日期」。
 * 上课日期（date）永不改，上传日期（uploadedAt）跟着内容走：
 * 有内容且还没记过 → 记为 now；内容清空了 → 置 null。
 * 返回新对象，不改原对象。
 */
function stampUploaded(s, now = Date.now()) {
  const next = { ...s };
  if (hasContent(next)) {
    if (!next.uploadedAt) next.uploadedAt = now;
  } else {
    next.uploadedAt = null;
  }
  next.updatedAt = now;
  return next;
}

module.exports = { STATUS_MAP, isPending, hasContent, isHandled, statusChip, stampUploaded };
