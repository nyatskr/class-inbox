/* core/files.js —— 学科资料库的文件元信息
 *
 * 两层结构：
 *   课堂记录（转录稿/板书/备注）  属于一节课
 *   学科资料库（PPT/PDF/Word/实验报告）  属于整个学科，可以关联到一节或多节课
 *
 * 文件字节不进数据库（小程序里是云存储 fileID），这里只管元信息和分类。
 */

const FILE_KINDS = {
  ppt:        { label: 'PPT / 讲义', dir: 'PPT',      color: '#c2410c' },
  doc:        { label: 'Word 文档',  dir: 'Word',     color: '#1d4ed8' },
  pdf:        { label: 'PDF',        dir: 'PDF',      color: '#b91c1c' },
  experiment: { label: '实验报告',    dir: '实验报告', color: '#0e7490' },
  homework:   { label: '作业',        dir: '作业',     color: '#7c3aed' },
  other:      { label: '其他',        dir: '其他',     color: '#64748b' }
};
const KIND_ORDER = ['ppt', 'pdf', 'doc', 'experiment', 'homework', 'other'];

/** 小程序 chooseMessageFile 能选的类型（从微信会话里挑老师发的文件） */
const FILE_ACCEPT = '.ppt,.pptx,.pps,.ppsx,.doc,.docx,.pdf,.wps,.odt,.odp,.key,.rtf,.txt,.md,.csv,.xls,.xlsx,.zip,.png,.jpg,.jpeg';

function extOf(name) {
  const m = String(name || '').match(/\.([A-Za-z0-9]{1,8})$/);
  return m ? m[1].toLowerCase() : '';
}

/** 去掉路径非法字符，保留扩展名，主名截到 70 字 */
function safeFile(name) {
  const n = String(name || 'file').replace(/[\\/:*?"<>|\r\n\t]/g, '_').trim();
  const ext = extOf(n);
  const base = ext ? n.slice(0, -(ext.length + 1)) : n;
  const keep = base.slice(0, 70) || 'file';
  return ext ? `${keep}.${ext}` : keep;
}

/** 按扩展名和文件名猜类型，猜不准就是 other，用户可以在资料库改 */
function guessKind(name) {
  const ext = extOf(name);
  const base = String(name || '').replace(/\.[^.]+$/, '');
  const office = /^(doc|docx|wps|odt|rtf|pdf)$/.test(ext);
  if (office && /实验|报告/.test(base)) return 'experiment';
  if (office && /作业|习题|练习|homework/i.test(base)) return 'homework';
  if (/^(ppt|pptx|pps|ppsx|odp|key)$/.test(ext)) return 'ppt';
  if (ext === 'pdf') return 'pdf';
  if (/^(doc|docx|wps|odt|rtf)$/.test(ext)) return 'doc';
  return 'other';
}

function kindOf(file) {
  return FILE_KINDS[file.kind] || FILE_KINDS.other;
}

/**
 * 关联关系记在文件上（file.links = [{ sid, note }]），sessions 里不存 fileIds。
 * 单一真源，不会出现「课上删了、库里还在」。
 */
function isLinkedTo(file, sessionId) {
  return (file.links || []).some(l => l.sid === sessionId);
}

function linkTo(file, sessionId, note = '') {
  if (isLinkedTo(file, sessionId)) return file;
  return { ...file, links: [...(file.links || []), { sid: sessionId, note }] };
}

function unlinkFrom(file, sessionId) {
  return { ...file, links: (file.links || []).filter(l => l.sid !== sessionId) };
}

/** 同一版本族里「当前版本」= 没有被 supersededBy 指过的那个 */
function currentOf(files) {
  return (files || []).find(f => !f.supersededBy) || null;
}

module.exports = {
  FILE_KINDS,
  KIND_ORDER,
  FILE_ACCEPT,
  extOf,
  safeFile,
  guessKind,
  kindOf,
  isLinkedTo,
  linkTo,
  unlinkFrom,
  currentOf
};
