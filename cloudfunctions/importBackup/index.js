/* cloudfunctions/importBackup —— 导入网页版的「全量备份 ZIP」
 *
 * 备份包的形状（网页版 v1.0 导出）：
 *   data.json               subjects / entries / sessions / files(元数据) / settings
 *   files/<id>.bin          每个课程文件的原始字节
 *
 * 迁移路径就是靠它：网页导出 → 发到微信文件传输助手 → 小程序选这个 ZIP。
 *
 * 这里做三件事：
 *   1. 解 ZIP，读 data.json
 *   2. 每个 files/<id>.bin 上传到云存储，拿 fileID（库里只存 fileID，不存字节）
 *   3. 写集合。同 _id 覆盖，所以重复导入是幂等的
 *
 * 注意：网页版的 sha256 和这里的 md5 不是一套算法。导入时不再去重，
 * 因为备份本来就是「同一份数据的搬运」，去重反而会把版本历史压平。
 */

const cloud = require('wx-server-sdk');
const AdmZip = require('adm-zip');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const COLLECTION = {
  subjects: 'subjects',
  entries: 'schedule_entries',
  sessions: 'class_sessions',
  files: 'course_files'
};

/** 分批写，云函数单次请求有并发和时长限制 */
async function bulkWrite(colName, docs, openid) {
  let n = 0;
  for (const d of docs) {
    const id = d._id || d.id;
    if (!id) continue;
    const data = { ...d, _openid: openid };
    delete data._id;
    delete data.data;          // 老备份里可能内联了字节，丢掉
    await db.collection(colName).doc(String(id)).set({ data });
    n++;
  }
  return n;
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  if (!event.fileID) return { ok: false, error: '缺少 fileID' };

  let zip;
  try {
    const r = await cloud.downloadFile({ fileID: event.fileID });
    zip = new AdmZip(r.fileContent);
  } catch (err) {
    return { ok: false, error: '打不开这个 ZIP：' + String(err.message || err) };
  }

  const entry = zip.getEntry('data.json');
  if (!entry) return { ok: false, error: '这个 ZIP 里没有 data.json，不像网页版导出的备份' };

  let data;
  try {
    data = JSON.parse(zip.readAsText(entry));
  } catch (err) {
    return { ok: false, error: 'data.json 解析失败：' + String(err.message || err) };
  }

  /* ---------- 1. 课程文件：字节 → 云存储 ---------- */
  let uploaded = 0;
  let missing = 0;
  const fileDocs = [];

  for (const meta of (data.files || [])) {
    const id = meta._id || meta.id;
    const bin = zip.getEntry(`files/${id}.bin`);
    let fileID = meta.fileID || '';

    if (bin) {
      try {
        const up = await cloud.uploadFile({
          cloudPath: `files/${meta.subjectId || 'misc'}/${id}${meta.ext ? '.' + meta.ext : ''}`,
          fileContent: bin.getData()
        });
        fileID = up.fileID;
        uploaded++;
      } catch (err) {
        console.error('[importBackup] 上传失败', id, err);
        missing++;
      }
    } else if (!fileID) {
      missing++;
    }

    fileDocs.push({ ...meta, fileID });
  }

  /* ---------- 2. 写库 ---------- */
  const counts = {};
  counts.subjects = await bulkWrite(COLLECTION.subjects, data.subjects || [], OPENID);
  counts.entries = await bulkWrite(COLLECTION.entries, data.entries || [], OPENID);
  counts.sessions = await bulkWrite(COLLECTION.sessions, data.sessions || [], OPENID);
  counts.files = await bulkWrite(COLLECTION.files, fileDocs, OPENID);

  if (data.settings) {
    const s = { ...data.settings, _openid: OPENID };
    delete s._id;
    await db.collection('user_settings').doc('main').set({ data: s }).catch(() => null);
  }

  return {
    ok: true,
    sessions: counts.sessions,
    files: counts.files,
    subjects: counts.subjects,
    entries: counts.entries,
    uploaded,
    missing
  };
};
