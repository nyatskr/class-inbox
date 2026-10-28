/* services/storage.js —— 云存储（课程文件 / 板书照片）
 *
 * 关键差异（对比网页版）：
 *   网页版把文件字节塞进 IndexedDB，启动时不能全量读进内存，否则几百 MB 就卡死。
 *   小程序里文件根本不该进数据库：上传到云存储，库里只留 fileID。
 *
 * 上传入口有两个：
 *   chooseFileFromChat()  从微信会话选老师发的 PPT / Word（小程序比手机网页方便的地方）
 *   chooseImage()         拍照或相册，用于板书
 */

const db = require('./db');

/** 云存储路径：files/<subjectId>/<fileId>.<ext>，按学科分目录，导出时好拼 */
function cloudPath(subjectId, fileId, ext) {
  return `files/${subjectId || 'misc'}/${fileId}${ext ? '.' + ext : ''}`;
}

/** 从微信会话里选文件（Excel 课表、PPT、Word、备份 ZIP 都走这里） */
function chooseFileFromChat(count = 1) {
  return new Promise((resolve, reject) => {
    wx.chooseMessageFile({
      count,
      type: 'all',
      success: r => resolve(r.tempFiles),
      fail: e => (e.errMsg && /cancel/.test(e.errMsg) ? resolve([]) : reject(e))
    });
  });
}

/** 拍照 / 相册，返回临时路径数组 */
function chooseImage(count = 9) {
  return new Promise((resolve, reject) => {
    wx.chooseMedia({
      count,
      mediaType: ['image'],
      sourceType: ['camera', 'album'],
      sizeType: ['compressed'],
      success: r => resolve(r.tempFiles.map(f => f.tempFilePath)),
      fail: e => (e.errMsg && /cancel/.test(e.errMsg) ? resolve([]) : reject(e))
    });
  });
}

/**
 * 上传一个本地临时文件到云存储，返回 fileID。
 * @param {string} tempPath  wx 临时路径
 * @param {string} subjectId 归到哪个学科目录
 * @param {string} fileId    自己生成的稳定 id（用于拼路径 + 去重）
 * @param {string} ext       扩展名（不带点）
 */
async function uploadFile(tempPath, subjectId, fileId, ext) {
  if (!db.usingCloud()) {
    // 本地降级：直接返回临时路径，界面还能预览，重启失效
    console.warn('[storage] 未配置云环境，文件只留在临时路径');
    return tempPath;
  }
  const r = await wx.cloud.uploadFile({
    cloudPath: cloudPath(subjectId, fileId, ext),
    filePath: tempPath
  });
  return r.fileID;
}

/** fileID → 可用的临时 https 链接（<image> / 下载都要它） */
async function tempUrl(fileID) {
  if (!fileID || /^(wxfile|http:\/\/tmp|\/)/.test(fileID)) return fileID;
  const r = await wx.cloud.getTempFileURL({ fileList: [fileID] });
  return (r.fileList[0] && r.fileList[0].tempFileURL) || '';
}

async function removeFile(fileID) {
  if (!db.usingCloud() || !fileID) return;
  try { await wx.cloud.deleteFile({ fileList: [fileID] }); } catch (_) { /* 已经不在了就算了 */ }
}

/**
 * 文件指纹。小程序端没有 crypto.subtle，用 wx.getFileInfo 拿 md5。
 * 想要和网页版一致的 sha256，就在云函数里算（importBackup 已经这么做）。
 */
function fingerprint(tempPath) {
  return new Promise((resolve, reject) => {
    if (!wx.getFileInfo) { resolve(''); return; }
    wx.getFileInfo({
      filePath: tempPath,
      digestAlgorithm: 'md5',
      success: r => resolve('md5:' + r.digest),
      fail: () => resolve('')      // 算不出来就退化，不阻塞上传
    });
  });
}

module.exports = {
  cloudPath,
  chooseFileFromChat,
  chooseImage,
  uploadFile,
  tempUrl,
  removeFile,
  fingerprint
};
