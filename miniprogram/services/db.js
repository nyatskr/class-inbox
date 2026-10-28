/* services/db.js —— 云数据库封装
 *
 * 和网页版 IndexedDB 的对应关系：
 *   subjects / entries / sessions / files / settings  → 同名集合
 *   blobs（文件字节）                                  → 不再有，改存云存储 fileID
 *
 * 每个集合都带 _openid，靠云开发的安全规则按用户隔离，不需要自己写 where。
 * 本地调试时（没有云环境）退化成内存 Map，方便在开发者工具里先跑界面。
 */

const ENV = '';                 // TODO: 填你的云开发环境 ID，例如 'class-inbox-3gxxxx'
const COLLECTIONS = ['subjects', 'entries', 'sessions', 'files', 'settings', 'reminder_logs'];

let _db = null;
let _mem = null;                // 本地降级：{ [col]: Map<id, doc> }

function usingCloud() {
  return !!ENV && !!wx.cloud;
}

function init() {
  if (usingCloud()) {
    wx.cloud.init({ env: ENV, traceUser: true });
    _db = wx.cloud.database();
  } else {
    console.warn('[db] 未配置云环境，使用内存存储（关掉小程序就没了）');
    _mem = {};
    for (const c of COLLECTIONS) _mem[c] = new Map();
  }
}

function memOf(col) {
  if (!_mem[col]) _mem[col] = new Map();
  return _mem[col];
}

/** 取某集合全部文档（云开发单次上限 20 条，这里自动翻页） */
async function all(col) {
  if (!usingCloud()) return Array.from(memOf(col).values());
  const out = [];
  const PAGE = 20;
  for (let skip = 0; ; skip += PAGE) {
    const r = await _db.collection(col).skip(skip).limit(PAGE).get();
    out.push(...r.data);
    if (r.data.length < PAGE) break;
  }
  return out;
}

async function get(col, id) {
  if (!usingCloud()) return memOf(col).get(id) || null;
  try {
    const r = await _db.collection(col).doc(id).get();
    return r.data;
  } catch (_) {
    return null;
  }
}

/** 有 _id 就是更新，没有就是新增 */
async function put(col, doc) {
  if (!usingCloud()) {
    const id = doc.id || doc._id;
    memOf(col).set(id, { ...doc, _id: id });
    return doc;
  }
  const id = doc._id || doc.id;
  const data = { ...doc };
  delete data._id;
  if (id) {
    await _db.collection(col).doc(id).set({ data });
    return { ...data, _id: id };
  }
  const r = await _db.collection(col).add({ data });
  return { ...data, _id: r._id };
}

async function del(col, id) {
  if (!usingCloud()) { memOf(col).delete(id); return; }
  await _db.collection(col).doc(id).remove();
}

async function clear(col) {
  if (!usingCloud()) { memOf(col).clear(); return; }
  // 云开发没有 truncate，只能分页删
  for (;;) {
    const r = await _db.collection(col).limit(20).get();
    if (!r.data.length) break;
    await Promise.all(r.data.map(d => _db.collection(col).doc(d._id).remove()));
  }
}

module.exports = { ENV, COLLECTIONS, init, usingCloud, all, get, put, del, clear };
