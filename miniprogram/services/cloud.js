/* services/cloud.js —— 云函数调用
 *
 * 为什么这些事要放云函数，而不是小程序端直接做：
 *
 *   nightlyReminder  要定时触发，只能云函数；而且 Server酱 的 SendKey 绝不能出现在
 *                    小程序源码里（包会被解包，key 就泄了）
 *   importTimetable  .xls/.xlsx 解析 + ZIP 解包在手机上很吃内存，放云端更快更稳
 *   importBackup     恢复要写几百条文档，客户端一条条写会慢到超时
 *   exportSubject    打包 ZIP 要把所有文件读进内存，放云端，返回下载链接
 *
 * 所有函数都从 cloud.getWXContext() 拿 OPENID 做数据隔离，不信客户端传上来的 id。
 */

const FUNCTIONS = {
  nightlyReminder: 'nightlyReminder',
  sendTestReminder: 'sendTestReminder',
  importTimetable: 'importTimetable',
  importBackup: 'importBackup',
  exportSubject: 'exportSubject'
};

/**
 * @param {string} name  FUNCTIONS 里的键
 * @param {object} data  参数
 * @returns {Promise<any>} 云函数 result
 */
async function call(name, data = {}) {
  if (!wx.cloud) throw new Error('当前环境没有云开发能力');
  const r = await wx.cloud.callFunction({ name: FUNCTIONS[name] || name, data });
  const res = r.result || {};
  if (res.ok === false) throw new Error(res.error || '云函数返回失败');
  return res;
}

/** 手动试推一次提醒（不占用当天「已推送」标记） */
function sendTestReminder() {
  return call('sendTestReminder');
}

/** 立刻检查今晚该不该推（调试用，会写去重记录） */
function runNightlyNow() {
  return call('nightlyReminder', { force: false });
}

/** 上传一份课表文件（fileID）让云端解析，返回预览草稿，不写库 */
function parseTimetable(fileID, fileName) {
  return call('importTimetable', { fileID, fileName, dryRun: true });
}

/** 确认导入 */
function applyTimetable(drafts, opts = {}) {
  return call('importTimetable', { drafts, mode: opts.mode || 'merge', semesterStart: opts.semesterStart || '' });
}

/** 导入网页版导出的全量备份 ZIP */
function importBackup(fileID) {
  return call('importBackup', { fileID });
}

/** 打包一个学科，返回临时下载链接 */
function exportSubject(subjectId) {
  return call('exportSubject', { subjectId });
}

module.exports = {
  FUNCTIONS,
  call,
  sendTestReminder,
  runNightlyNow,
  parseTimetable,
  applyTimetable,
  importBackup,
  exportSubject
};
