/* 课堂资料收件箱 · 本地原型 v1.0
 * 以课表为索引，管理每节课的资料完整性：转录稿 / 板书照片 / 备注 / 状态
 * 另有一层「学科资料库」：PPT / PDF / Word / 实验报告只存一份，可关联到多节课
 * 可以设一个「清账截止日」：那天之前的欠账一律免记，不再提醒
 * 每条记录带「课堂快照」：课表怎么改，过去的课都不会变形
 * 数据全部存在本机 IndexedDB，不上传任何服务器
 */
'use strict';

/* ==================== 常量 ==================== */
const PALETTE = ['#3b5bfd', '#f2994a', '#0ea472', '#9b51e0', '#eb5757', '#2d9cdb', '#d4a017', '#14b8a6'];
const WEEK_LABEL = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const STATUS_MAP = {
  pending:   { label: '待处理',       cls: 'st-pending' },
  done:      { label: '已上传转录稿', cls: 'st-done' },
  none:      { label: '无转录稿',     cls: 'st-none' },
  cancelled: { label: '课程取消',     cls: 'st-cancel' }
};
const WEEK_MODE = { all: '全学期', range: '指定周次', odd: '单周', even: '双周' };

/* 学科资料库的文件类型。dir 是导出时在「课程资料/」下用的文件夹名 */
const FILE_KINDS = {
  ppt:        { label: 'PPT / 讲义', dir: 'PPT',      color: '#c2410c' },
  doc:        { label: 'Word 文档',  dir: 'Word',     color: '#1d4ed8' },
  pdf:        { label: 'PDF',        dir: 'PDF',      color: '#b91c1c' },
  experiment: { label: '实验报告',    dir: '实验报告', color: '#0e7490' },
  homework:   { label: '作业',        dir: '作业',     color: '#7c3aed' },
  other:      { label: '其他',        dir: '其他',     color: '#64748b' }
};
const KIND_ORDER = ['ppt', 'pdf', 'doc', 'experiment', 'homework', 'other'];

/* 单个课程文件上限。IndexedDB 本身能存更大，但导出时要把字节读进内存，30MB 是个稳妥的线 */
const MAX_FILE_BYTES = 30 * 1024 * 1024;
const FILE_ACCEPT = '.ppt,.pptx,.pps,.ppsx,.doc,.docx,.pdf,.wps,.odt,.odp,.key,.rtf,.txt,.md,.csv,.xls,.xlsx,.zip,.png,.jpg,.jpeg';

/* 默认作息表（节次 → 时间）。实际生效的是 settings.periods，这里只是出厂值和「恢复默认」用。
   数据结构：periods[N-1] = { start:'08:00', end:'08:45' } 即第 N 节 */
const DEFAULT_PERIODS = [
  ['08:00', '08:45'], ['08:55', '09:40'], ['10:00', '10:45'], ['10:55', '11:40'],
  ['14:00', '14:45'], ['14:55', '15:40'], ['16:00', '16:45'], ['16:55', '17:40'],
  ['19:00', '19:45'], ['19:55', '20:40'], ['20:50', '21:35'], ['21:45', '22:30']
].map(([start, end]) => ({ start, end }));

/* ==================== 工具 ==================== */
const $ = (s, r = document) => r.querySelector(s);
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
const pad2 = n => String(n).padStart(2, '0');
const dateStr = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const parseDate = s => new Date(s + 'T00:00:00');
const weekdayOf = s => (parseDate(s).getDay() + 6) % 7 + 1;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function mondayOf(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}
function weekNoOf(ds, semesterStart) {
  const a = mondayOf(parseDate(semesterStart));
  const b = mondayOf(parseDate(ds));
  return Math.floor((b - a) / 604800000) + 1;
}
function fmtDateCN(ds) {
  const d = parseDate(ds);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${WEEK_LABEL[weekdayOf(ds) - 1]}`;
}
function safeName(s) {
  return String(s || '未命名').replace(/[\\/:*?"<>|\r\n]/g, '_').trim().slice(0, 40) || '未命名';
}
let _toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
}

/* ==================== IndexedDB ==================== */
const DB_NAME = 'class-inbox';
const DB_VER = 3;   // v2 新增 files（学科资料库）；v3 把文件字节挪进 blobs，启动不再全量读进内存
let _db = null;

function db() {
  if (_db) return Promise.resolve(_db);
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      ['subjects', 'entries', 'sessions', 'files'].forEach(n => {
        if (!d.objectStoreNames.contains(n)) d.createObjectStore(n, { keyPath: 'id' });
      });
      if (!d.objectStoreNames.contains('settings')) d.createObjectStore('settings', { keyPath: 'key' });
      // v3：字节和元数据分家。files 只留名称/大小/指纹/关联，几十 MB 的 PPT 不再躺在启动路径上
      if (!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs', { keyPath: 'id' });
      if (e.oldVersion < 3) {
        const t = e.target.transaction;
        const fs = t.objectStore('files');
        const bs = t.objectStore('blobs');
        fs.openCursor().onsuccess = ev => {
          const cur = ev.target.result;
          if (!cur) return;
          const rec = cur.value;
          if (rec && rec.data) {
            bs.put({ id: rec.id, data: rec.data });
            const meta = { ...rec };
            delete meta.data;
            cur.update(meta);
          }
          cur.continue();
        };
      }
    };
    req.onsuccess = () => {
      _db = req.result;
      // 另一个标签页要升级数据库时先让路，否则那边会一直卡住
      _db.onversionchange = () => { _db.close(); _db = null; };
      res(_db);
    };
    req.onerror = () => rej(req.error);
  });
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const r = fn(t.objectStore(store));
    let out;
    if (r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}
const dbAll = s => tx(s, 'readonly', st => st.getAll());
const dbGet = (s, id) => tx(s, 'readonly', st => st.get(id));
const dbPut = (s, o) => tx(s, 'readwrite', st => st.put(o));
const dbDel = (s, id) => tx(s, 'readwrite', st => st.delete(id));
const dbClear = s => tx(s, 'readwrite', st => st.clear());

/* ==================== 状态 ==================== */
const state = {
  tab: 'today',
  today: dateStr(),
  subjects: [],
  entries: [],
  sessions: [],
  files: [],              // 学科资料库（只有元数据，字节在 blobs 里按需取）
  settings: {
    semesterStart: '', reminderTime: '20:30',
    notifEnabled: false, lastNotified: '',
    scEnabled: false, scKey: '',            // Server酱（微信）
    hookEnabled: false, hookUrl: '',        // 通用 Webhook
    pushSent: {},                           // { sc: '2026-10-28', hook: '...' } 当天去重
    ignoreBefore: ''                        // 清账截止日：这天之前的欠账一律免记
  },
  openIds: new Set(),
  libSubject: 'all',      // 历史页的学科筛选
  fileSubject: 'all',     // 资料页的学科筛选
  libQuery: '',
  // 历史记录页筛选
  histFrom: '',
  histTo: '',
  histStatus: 'all',
  histPhoto: 'all',
  // 连续补录
  contDays: 30,
  contSel: new Set()
};

async function loadAll() {
  const [subjects, entries, sessions, settingsArr, files] = await Promise.all([
    dbAll('subjects'), dbAll('entries'), dbAll('sessions'), dbAll('settings'), dbAll('files')
  ]);
  state.subjects = subjects.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  state.entries = entries;
  state.sessions = sessions;
  state.files = files.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const s = settingsArr.find(x => x.key === 'main');
  if (s) Object.assign(state.settings, s);
  if (!state.settings.semesterStart) {
    state.settings.semesterStart = dateStr(mondayOf(new Date()));
    await saveSettings();
  }
  // v0.7 迁移：取消了「记录要求」，清掉历史数据里的 level 字段（只跑一次）
  const stale = state.entries.filter(e => 'level' in e);
  for (const e of stale) {
    delete e.level;
    await dbPut('entries', e);
  }
  // v1.0 迁移：老记录没有课堂快照，用「现在」的课表补一份（已经是能拿到的最好版本）
  for (const s of state.sessions) {
    if (s.snap) continue;
    const e = entryOf(s);
    if (!e) continue;
    s.snap = snapOfEntry(e);
    await dbPut('sessions', s);
  }
}
async function saveSettings() {
  await dbPut('settings', { key: 'main', ...state.settings });
}

/* ==================== 作息表 ==================== */
/** 当前生效的作息表；没配过就用默认 */
function periodsOf() {
  const p = state.settings.periods;
  if (Array.isArray(p) && p.length) {
    return p.map(x => ({ start: x.start || '08:00', end: x.end || '08:45' }));
  }
  return DEFAULT_PERIODS.map(x => ({ ...x }));
}
/** 第 a 节上课 → 第 b 节下课，换算成具体时间 */
function slotsToTime(sec) {
  if (!sec) return { startTime: '', endTime: '' };
  const P = periodsOf();
  const a = Math.min(Math.max(sec[0], 1), P.length);
  const b = Math.min(Math.max(sec[1], 1), P.length);
  return { startTime: P[a - 1].start, endTime: P[b - 1].end };
}
/** 节次的展示文案：第5节 / 第3-4节 */
function sectionLabel(a, b) {
  return a === b ? `第${a}节` : `第${a}-${b}节`;
}
function addMinutes(hhmm, n) {
  const [h, m] = String(hhmm || '08:00').split(':').map(Number);
  const t = (h * 60 + m + n + 1440) % 1440;
  return `${pad2(Math.floor(t / 60))}:${pad2(t % 60)}`;
}

/**
 * 改了作息表之后重算所有课程的时间。
 * 只动「以节次为准」的课（有 sectionsKey），用户手填过自定义时间的课（timeMode='custom'）保持原样。
 */
async function recalcEntryTimes() {
  let n = 0;
  for (const e of state.entries) {
    if (e.timeMode === 'custom') continue;
    if (!e.sectionsKey) continue;
    const [a, b] = String(e.sectionsKey).split('-').map(Number);
    if (!a || !b) continue;
    // 作息表节数被改少了，超出范围的课保持原样，不要被硬夹到最后一节
    if (a > periodsOf().length || b > periodsOf().length) continue;
    const t = slotsToTime([a, b]);
    if (!t.startTime) continue;
    const label = sectionLabel(a, b);
    if (e.startTime === t.startTime && e.endTime === t.endTime && e.sections === label) continue;
    e.startTime = t.startTime;
    e.endTime = t.endTime;
    e.sections = label;
    await dbPut('entries', e);
    n++;
  }
  return n;
}

/* ==================== 课表逻辑 ==================== */
function weekMatches(e, wk) {
  // 导入的课表可能是「1-4周,7-17周」这种多段周次
  if (Array.isArray(e.weekRanges) && e.weekRanges.length) {
    if (!e.weekRanges.some(r => wk >= r[0] && wk <= r[1])) return false;
    if (e.weekMode === 'odd') return wk % 2 === 1;
    if (e.weekMode === 'even') return wk % 2 === 0;
    return true;
  }
  const mode = e.weekMode || 'all';
  if (mode === 'all') return true;
  const from = Number(e.weekFrom) || 1;
  const to = Number(e.weekTo) || 20;
  if (wk < from || wk > to) return false;
  if (mode === 'odd') return wk % 2 === 1;
  if (mode === 'even') return wk % 2 === 0;
  return true;
}
function weekText(e) {
  const oddEven = e.weekMode === 'odd' ? '单周 ' : e.weekMode === 'even' ? '双周 ' : '';
  if (Array.isArray(e.weekRanges) && e.weekRanges.length) {
    return oddEven + e.weekRanges.map(r => r[0] === r[1] ? r[0] : `${r[0]}-${r[1]}`).join(',') + ' 周';
  }
  const mode = e.weekMode || 'all';
  if (mode === 'all') return '全学期';
  const from = e.weekFrom || 1, to = e.weekTo || 20;
  if (mode === 'range') return `第${from}-${to}周`;
  return `${mode === 'odd' ? '单' : '双'}周 ${from}-${to}`;
}
/* ---- 课堂快照 ----
   历史记录不能靠「现在的课表」反推：删了一条课表、改了教室、重新导入一次，
   过去的课就会跟着变形（节次和地点凭空消失，或者显示成新教室）。
   所以生成记录时把当时的样子抄一份存进 snap，以后一律读快照：
     snap = { subjectId, subjectName, color, sections, startTime, endTime, location, teacher }
   课表改动能影响到的只有「今天及以后」的记录（由 refreshSnaps 负责）。 */
function snapOfEntry(e) {
  const sub = state.subjects.find(x => x.id === e.subjectId);
  return {
    subjectId: e.subjectId,
    subjectName: sub ? sub.name : '未命名课程',
    color: sub ? sub.color : '#94a3b8',
    sections: e.sections || '',
    startTime: e.startTime || '',
    endTime: e.endTime || '',
    location: e.location || '',
    teacher: e.teacher || ''
  };
}
/** 记录的课堂信息：优先快照，老数据没有就现查课表 */
function snapOf(s) {
  if (s.snap) return s.snap;
  const e = entryOf(s);
  return e ? snapOfEntry(e) : null;
}
/** 课表改了以后，把「今天及以后」的记录快照同步一下；过去的不动 */
async function refreshSnaps(entryIds) {
  const ids = new Set(entryIds);
  let n = 0;
  for (const s of state.sessions) {
    if (!ids.has(s.entryId) || s.date < state.today) continue;
    const e = state.entries.find(x => x.id === s.entryId);
    if (!e) continue;
    s.snap = snapOfEntry(e);
    await dbPut('sessions', s);
    n++;
  }
  return n;
}

function subjectOf(s) {
  if (s.snap) return { id: s.snap.subjectId, name: s.snap.subjectName, color: s.snap.color || '#94a3b8' };
  return state.subjects.find(x => x.id === s.subjectId) ||
    { id: 'unknown', name: s.customName || '未命名课程', color: '#94a3b8' };
}
function entryOf(s) {
  return state.entries.find(x => x.id === s.entryId) || null;
}
function timeText(s) {
  if (s.customTime) return s.customTime;
  const sn = s.snap;
  if (sn) {
    // 导入的课表有节次就显示节次（比猜出来的时间准），手动加的课显示时间
    if (sn.sections) return sn.sections;
    if (sn.startTime) return `${sn.startTime}–${sn.endTime}`;
    return '';
  }
  const e = entryOf(s);
  if (!e) return '';
  if (e.sections) return e.sections;
  return `${e.startTime}–${e.endTime}`;
}
/** 教室（快照优先） */
function placeOf(s) {
  const sn = snapOf(s);
  return (sn && sn.location) || '';
}
function sortKeyOf(s) {
  if (s.customTime) return String(s.customTime);
  const sn = snapOf(s);
  return String((sn && sn.startTime) || '99:99');
}
function sessionsOf(ds) {
  return state.sessions
    .filter(s => s.date === ds)
    .sort((a, b) => sortKeyOf(a).localeCompare(sortKeyOf(b)));
}

/* ---- 待办判定 ----
   课表里的每一门课都是要追踪的课（不想要的课直接删），所以只看「待处理 + 未豁免」 */
function isPending(s) {
  return s.status === 'pending' && !s.exempt;
}
function pendingKeyOf(ds) {
  return sessionsOf(ds).filter(isPending);
}

/* ---- 上课日期 vs 上传日期 ----
   date      = 上课日期（这份资料属于哪一天），创建后永不改
   uploadedAt= 上传/归档时间（你什么时候把它补进系统），可以清空
   导出按 date 排序；晚间提醒只查 date === 今天，历史欠账不进提醒 */
function hasContent(s) {
  return s.status !== 'pending' || !!(s.transcriptText || '').trim() || !!(s.photos || []).length;
}
function stampUploaded(s) {
  if (hasContent(s)) { if (!s.uploadedAt) s.uploadedAt = Date.now(); }
  else s.uploadedAt = null;
  s.updatedAt = Date.now();
  return s;
}

/** 过去某天之前、仍待处理的课——只统计已存在的记录，不偷偷生成 */
function pastPendingKey(beforeDs) {
  return state.sessions
    .filter(s => s.date < beforeDs && isPending(s))
    .sort((a, b) => b.date.localeCompare(a.date));
}

/* ---- 清账：把某个日期之前的欠账一次性免记 ----
   不是删记录，只是打上 exempt。课还在历史里，随时能单独恢复 */
function lastMondayStr(ds = state.today) {
  const m = mondayOf(parseDate(ds));
  m.setDate(m.getDate() - 7);
  return dateStr(m);
}
function defaultDebtBefore() {
  return state.settings.ignoreBefore || lastMondayStr();
}
function debtCountBefore(ds) {
  if (!ds) return 0;
  return state.sessions.filter(s => s.date < ds && isPending(s)).length;
}
function debtHintText(ds) {
  if (!ds) return '先选一个日期。';
  const n = debtCountBefore(ds);
  if (!n) return `比 ${ds} 更早的课已经全部处理过了。`;
  return `比 ${ds} 更早的课里还有 <b>${n}</b> 节待处理；点了之后它们退出待办和历史欠账，记录本身保留。`;
}
async function ignoreBefore(ds) {
  if (!ds) { toast('先选一个日期'); return; }
  const list = state.sessions.filter(s => s.date < ds && isPending(s));
  if (!list.length) { toast('这天之前没有待处理的课了'); return; }
  if (!confirm(
    `把比 ${ds} 更早的 ${list.length} 节待处理课全部标记为「免记」？\n\n` +
    `· 不再进待办，不再算历史欠账，晚间提醒也不会提\n` +
    `· 记录本身保留，在「历史」里筛「已免记」还能看到，点一下就能单独恢复\n` +
    `· 已经归档、标记过无转录稿、取消的课不受影响`
  )) return;

  for (const s of list) {
    s.exempt = true;
    s.updatedAt = Date.now();
    await dbPut('sessions', s);
  }
  state.settings.ignoreBefore = ds;
  await saveSettings();
  state.contSel.clear();
  await continuousModal();
  toast(`已忽略 ${list.length} 节 · 从 ${ds} 起正常记`);
}

/** 往前数 n 天（含今天）的日期数组，从早到晚 */
function recentDates(n, endDs = state.today) {
  const out = [];
  const base = parseDate(endDs);
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() - i);
    out.push(dateStr(d));
  }
  return out;
}

/** 为一段日期补齐课表记录（补录前必须先有记录可填） */
async function backfillRange(fromDs, toDs) {
  const dates = [];
  const a = parseDate(fromDs), b = parseDate(toDs);
  for (let d = new Date(a); d <= b; d.setDate(d.getDate() + 1)) dates.push(dateStr(new Date(d)));
  let n = 0;
  for (const ds of dates) n += await ensureSessionsFor(ds);
  return n;
}

/** 按课表补齐某一天应存在的课程记录 */
async function ensureSessionsFor(ds) {
  const wk = weekNoOf(ds, state.settings.semesterStart);
  const wd = weekdayOf(ds);
  const exist = new Set(state.sessions.filter(s => s.date === ds).map(s => s.id));
  // 清账截止日之前的课，新建时就带上免记——否则清了账、下次补录又冒出来
  const cutoff = state.settings.ignoreBefore || '';
  const old = !!cutoff && ds < cutoff;
  let created = 0;
  for (const e of state.entries) {
    if (e.weekday !== wd || !weekMatches(e, wk)) continue;
    const id = `${ds}__${e.id}`;
    if (exist.has(id)) continue;
    const ns = {
      id, date: ds, entryId: e.id, subjectId: e.subjectId,
      status: 'pending', transcriptText: '', photos: [], note: '', exempt: old,
      snap: snapOfEntry(e),
      uploadedAt: null,
      createdAt: Date.now(), updatedAt: Date.now()
    };
    await dbPut('sessions', ns);
    created++;
  }
  if (created) state.sessions = await dbAll('sessions');
  return created;
}

/* ==================== 渲染：通用 ==================== */
const view = $('#view');

/* ==================== 学科资料库 ====================
   资料分两层：
     1. 课堂记录 —— 转录稿 / 板书 / 备注，挂在某一节课上（sessions）
     2. 学科资料库 —— PPT / PDF / Word / 实验报告，归属于整个学科（files）
   文件只存一份字节，用 links 关联到一节或多节课：
     files[i] = { id, subjectId, name, ext, size, kind, sha256, rootId, version,
                  links:[{ sid, note }], data:ArrayBuffer, createdAt, supersededBy? }
*/

const toBuf = u8 => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
const kindRank = k => { const i = KIND_ORDER.indexOf(k); return i < 0 ? KIND_ORDER.length : i; };
const kindOf = f => FILE_KINDS[f.kind] || FILE_KINDS.other;

function fileOf(id) { return state.files.find(f => f.id === id); }
/** 当前版本的文件（历史版本不在列表里出现，但导出时会带上） */
function activeFiles() { return state.files.filter(f => !f.supersededBy); }
function filesOfSubject(subjectId) { return activeFiles().filter(f => f.subjectId === subjectId); }
function filesOfSession(sessionId) {
  return activeFiles()
    .filter(f => (f.links || []).some(l => l.sid === sessionId))
    .sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || (a.createdAt || 0) - (b.createdAt || 0));
}
function sessionsOfFile(f) {
  const ids = (f.links || []).map(l => l.sid);
  return state.sessions.filter(s => ids.includes(s.id))
    .sort((a, b) => a.date.localeCompare(b.date) || sortKeyOf(a).localeCompare(sortKeyOf(b)));
}

function fmtSize(n) {
  n = Number(n) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(1)} GB`;
}
function extOf(name) {
  const m = String(name || '').match(/\.([A-Za-z0-9]{1,8})$/);
  return m ? m[1].toLowerCase() : '';
}
/** 去掉路径非法字符，保留扩展名 */
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

/** 内容指纹：优先 SHA-256，环境不支持时退化成 FNV-1a（带 w: 前缀以示区分） */
async function sha256Hex(bytes) {
  try {
    if (typeof crypto !== 'undefined' && crypto.subtle && crypto.subtle.digest) {
      const h = await crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, '0')).join('');
    }
  } catch (_) { /* file:// 或旧浏览器可能没有 subtle，走兜底 */ }
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193) >>> 0; }
  return `w:${h.toString(16).padStart(8, '0')}:${bytes.length}`;
}

/** 按需取文件字节：只有下载 / 导出 / 备份时才碰 blobs，启动路径上不读 */
async function fileBytes(id) {
  const rec = await dbGet('blobs', id);
  return rec && rec.data ? new Uint8Array(rec.data) : null;
}

async function saveFileRecord({ name, buf, kind, subjectId, links = [], rootId = '', version = 1 }) {
  const bytes = new Uint8Array(buf);
  const rec = {
    id: uid(),
    subjectId,
    name: safeFile(name),
    ext: extOf(name),
    size: bytes.length,
    kind: FILE_KINDS[kind] ? kind : 'other',
    sha256: await sha256Hex(bytes),
    rootId: rootId || '',
    version: version || 1,
    links: links.map(l => ({ ...l })),
    createdAt: Date.now()
  };
  if (!rec.rootId) rec.rootId = rec.id;
  try {
    await dbPut('blobs', { id: rec.id, data: toBuf(bytes) });
    await dbPut('files', rec);
  } catch (err) {
    if (err && (err.name === 'QuotaExceededError' || /quota/i.test(String(err.message || '')))) {
      throw new Error('浏览器本地空间不够了，先「导出备份」再删掉一些旧文件');
    }
    throw err;
  }
  state.files.push(rec);
  return rec;
}

async function linkFile(fileId, sessionId, note = '') {
  const f = fileOf(fileId);
  if (!f) return false;
  f.links = f.links || [];
  if (f.links.some(l => l.sid === sessionId)) return false;
  f.links.push({ sid: sessionId, note: String(note || '') });
  await dbPut('files', f);
  return true;
}
async function unlinkFile(fileId, sessionId) {
  const f = fileOf(fileId);
  if (!f) return false;
  const before = (f.links || []).length;
  f.links = (f.links || []).filter(l => l.sid !== sessionId);
  if (f.links.length === before) return false;
  await dbPut('files', f);
  return true;
}
/** 删掉一节课时，把它从所有文件的关联里摘掉 */
async function purgeSessionLinks(sessionId) {
  let n = 0;
  for (const f of state.files) {
    if (!(f.links || []).some(l => l.sid === sessionId)) continue;
    f.links = f.links.filter(l => l.sid !== sessionId);
    await dbPut('files', f);
    n++;
  }
  return n;
}

async function downloadFile(fileId) {
  const f = fileOf(fileId);
  if (!f) { toast('找不到这个文件'); return; }
  const bytes = await fileBytes(f.id);
  if (!bytes) { toast('这个文件的数据不见了，试试从备份恢复'); return; }
  download(new Blob([bytes], { type: f.mime || 'application/octet-stream' }), f.name);
}

/** 同一份文件的所有版本（含当前版本），按版本号从新到旧 */
function versionsOf(f) {
  const root = f.rootId || f.id;
  return state.files.filter(x => (x.rootId || x.id) === root)
    .sort((a, b) => (b.version || 1) - (a.version || 1) || (b.createdAt || 0) - (a.createdAt || 0));
}

async function setCurrentVersion(fileId) {
  const f = fileOf(fileId);
  if (!f) return;
  const vs = versionsOf(f);
  for (const v of vs) {
    if (v.id === f.id) delete v.supersededBy;
    else v.supersededBy = f.id;
    await dbPut('files', v);
  }
}

function versionsModal(fileId) {
  const f = fileOf(fileId);
  if (!f) return;
  const vs = versionsOf(f);
  openModal(`
    <h3>版本历史</h3>
    <p class="sub">同一份文件的 ${vs.length} 个版本。当前版本才会出现在课堂里，也会被导出到「课程资料」。</p>
    ${vs.map(v => {
      const cur = !v.supersededBy;
      return `<div class="ver-row ${cur ? 'cur' : ''}">
        <div class="grow">
          <b>v${v.version || 1}${cur ? ' · 当前' : ''}</b>
          <span class="meta">${fmtSize(v.size)} · ${dateStr(new Date(v.createdAt || Date.now()))}</span>
        </div>
        <div class="ops">
          <button class="btn sm ghost" data-act="dlfile" data-fid="${v.id}">下载</button>
          ${cur ? '' : `<button class="btn sm" data-act="setver" data-fid="${v.id}">设为当前</button>`}
        </div>
      </div>`;
    }).join('')}
    <div class="modal-actions"><button class="btn ghost" data-act="closemodal">关闭</button></div>`);
}

/* ---- 通用「等用户点一下」的弹窗 ---- */
let dlgCtx = null;
function openDialog(html) {
  return new Promise(resolve => {
    if (dlgCtx) { const r = dlgCtx; dlgCtx = null; r('cancel'); }
    dlgCtx = resolve;
    openModal(html);
  });
}

/* ---- 上传 ---- */
/** 重复文件检测：先看内容指纹，再看文件名 */
async function askDedupe({ name, existing, sameContent, canLink }) {
  const ex = existing;
  const K = kindOf(ex);
  const nLink = (ex.links || []).length;
  const recV = sameContent ? (canLink ? 'link' : 'cancel') : 'version';
  const opt = (v, title, desc) => `
    <button class="opt ${recV === v ? 'rec' : ''}" data-act="dlg" data-v="${v}">
      <b>${title}</b><span>${desc}</span>
    </button>`;

  const v = await openDialog(`
    <h3>${sameContent ? '这个文件已经在资料库里了' : '同名文件已存在'}</h3>
    <p class="sub">${sameContent
      ? '内容和已有的那份完全一致（按内容指纹比对，不是只看文件名）。'
      : '文件名一样，但内容不一样，多半是改过的新版本。'}</p>

    <div class="dupe">
      <div class="fname">这次上传：${esc(name)}</div>
      <div style="margin-top:7px">资料库已有：<b>${esc(ex.name)}</b></div>
      <div>${K.label} · ${fmtSize(ex.size)}${(ex.version || 1) > 1 ? ` · v${ex.version}` : ''} · 已关联 ${nLink} 节课</div>
    </div>

    ${sameContent && canLink ? opt('link', '关联已有文件到本节课', '不重复占空间，资料库里还是只有一份。') : ''}
    ${opt('version', `保存为新版本（v${(ex.version || 1) + 1}）`, '旧版留在资料库里标成历史版本，导出时放进「历史版本」文件夹。')}
    ${opt('separate', '仍然上传为另一份文件', '两份都保留、互不影响。适合「同一门课不同章节的 PPT」。')}

    <div class="modal-actions">
      <button class="btn ${recV === 'cancel' ? 'primary' : 'ghost'}" data-act="dlg" data-v="cancel">
        ${sameContent && !canLink ? '不用重复上传' : '跳过这个文件'}
      </button>
    </div>`);
  return v || 'cancel';
}

async function importOneFile(f, ctx) {
  const { sessionId, subjectId, stat } = ctx;
  if (f.size > MAX_FILE_BYTES) {
    toast(`${f.name} 有 ${fmtSize(f.size)}，超过 ${fmtSize(MAX_FILE_BYTES)} 上限`);
    stat.skipped++;
    return;
  }
  let buf;
  try { buf = await f.arrayBuffer(); }
  catch (_) { toast(`${f.name} 读不出来`); stat.skipped++; return; }

  const bytes = new Uint8Array(buf);
  const hash = await sha256Hex(bytes);
  const safe = safeFile(f.name);
  const sameContent = state.files.find(x =>
    x.subjectId === subjectId && !x.supersededBy && x.sha256 === hash && x.size === bytes.length);
  const sameName = state.files.find(x =>
    x.subjectId === subjectId && !x.supersededBy && x.name === safe);

  let rec = null;
  const ex = sameContent || sameName;
  if (ex) {
    const choice = await askDedupe({
      name: f.name, existing: ex, sameContent: !!sameContent, canLink: !!sessionId
    });
    if (choice === 'link') {
      if (sessionId && await linkFile(ex.id, sessionId)) stat.linked++;
      else stat.skipped++;
      return;
    }
    if (choice === 'cancel') { stat.skipped++; return; }
    if (choice === 'version') {
      rec = await saveFileRecord({
        name: f.name, buf, kind: ex.kind, subjectId,
        links: (ex.links || []).map(l => ({ ...l })),
        rootId: ex.rootId || ex.id,
        version: (ex.version || 1) + 1
      });
      ex.supersededBy = rec.id;
      await dbPut('files', ex);
    } else {
      rec = await saveFileRecord({ name: f.name, buf, kind: guessKind(f.name), subjectId, version: 1 });
    }
  } else {
    rec = await saveFileRecord({ name: f.name, buf, kind: guessKind(f.name), subjectId, version: 1 });
  }

  if (rec) {
    stat.added++;
    if (rec.kind === 'other') stat.others.push(rec.name);
    if (sessionId && await linkFile(rec.id, sessionId)) stat.linked++;
  }
}

async function importFiles(fileList, opts = {}) {
  const sess = opts.sessionId ? state.sessions.find(x => x.id === opts.sessionId) : null;
  const subjectId = sess ? sess.subjectId : opts.subjectId;
  if (!subjectId) { toast('先选一个学科'); return; }
  const arr = Array.from(fileList || []);
  if (!arr.length) return;

  const stat = { added: 0, linked: 0, skipped: 0, others: [], error: '' };
  const heavy = arr.length > 1 || arr.some(f => f.size > 4 * 1024 * 1024);
  if (heavy) toast(`正在读取 ${arr.length} 个文件…`);
  for (const f of arr) {
    try { await importOneFile(f, { sessionId: opts.sessionId || '', subjectId, stat }); }
    catch (err) { stat.error = err.message || String(err); }
  }
  await render();

  const bits = [];
  if (stat.added) bits.push(`新增 ${stat.added} 个文件`);
  if (stat.linked) bits.push(`关联到本节课 ${stat.linked} 个`);
  if (stat.skipped) bits.push(`跳过 ${stat.skipped} 个`);
  if (stat.others.length) bits.push(`${stat.others.length} 个归到「其他」，可在资料库改类型`);
  toast(stat.error || bits.join(' · ') || '没有变化');
}

/* ---- 从本学科资料库挑文件，挂到这节课 ---- */
let pickFileCtx = null;
function pickFilesModal(sessionId) {
  const s = state.sessions.find(x => x.id === sessionId);
  if (!s) return;
  const all = filesOfSubject(s.subjectId);
  if (!all.length) {
    toast('这个学科的资料库还是空的，先「上传新文件」');
    return;
  }
  const linked = new Set(filesOfSession(sessionId).map(f => f.id));
  pickFileCtx = { sessionId, sel: new Set(), linked };
  renderPickFiles();
}
function renderPickFiles() {
  const ctx = pickFileCtx;
  const s = state.sessions.find(x => x.id === ctx.sessionId);
  const all = filesOfSubject(s.subjectId);
  const n = ctx.sel.size;
  const free = all.filter(f => !ctx.linked.has(f.id)).length;
  openModal(`
    <h3>从「${esc(subjectOf(s).name)}」资料库选择</h3>
    <p class="sub">文件本来就属于整个学科，这里只是把它和 ${fmtDateCN(s.date)} 这节课关联起来。</p>
    ${free ? '' : `<div class="banner soft" style="margin-bottom:12px">
      <span class="ic">✓</span>
      <div>这个学科资料库里的文件，已经全部关联到这节课了。</div>
    </div>`}
    <div class="pick-list">
      ${all.map(f => {
        const K = kindOf(f);
        const on = ctx.sel.has(f.id);
        const done = ctx.linked.has(f.id);
        return `<button class="pick-row ${done ? 'done' : ''} ${on ? 'on' : ''}"
          data-act="pftoggle" data-fid="${f.id}" ${done ? 'disabled' : ''}>
          <span class="ckmark">${done ? '✓' : (on ? '●' : '')}</span>
          <span class="grow">
            <b>${esc(f.name)}</b>
            <span class="meta">${K.label} · ${fmtSize(f.size)}${(f.version || 1) > 1 ? ` · v${f.version}` : ''}${done ? ' · 已关联' : ''}</span>
          </span>
        </button>`;
      }).join('')}
    </div>
    <div class="modal-actions">
      <button class="btn ghost" data-act="closemodal">取消</button>
      <button class="btn primary" data-act="pfok" ${n ? '' : 'disabled'}>关联选中的 ${n} 个</button>
    </div>`);
}

/* ---- 反过来：把一个文件挂到多节课上 ---- */
let pickSessCtx = null;
function pickSessionsModal(fileId) {
  const f = fileOf(fileId);
  if (!f) return;
  const list = state.sessions.filter(s => s.subjectId === f.subjectId)
    .sort((a, b) => b.date.localeCompare(a.date));
  if (!list.length) { toast('这个学科还没有课堂记录'); return; }
  const linked = new Set((f.links || []).map(l => l.sid));
  pickSessCtx = { fileId, sel: new Set(linked), linked };
  renderPickSessions();
}
function renderPickSessions() {
  const ctx = pickSessCtx;
  const f = fileOf(ctx.fileId);
  const list = state.sessions.filter(s => s.subjectId === f.subjectId)
    .sort((a, b) => b.date.localeCompare(a.date));
  const n = ctx.sel.size;
  openModal(`
    <h3>关联到哪几节课</h3>
    <p class="sub">${esc(f.name)} · 勾上的课都会在「相关课程资料」里看到这份文件。</p>
    <div class="pick-list">
      ${list.map(s => {
        const on = ctx.sel.has(s.id);
        return `<button class="pick-row ${on ? 'on' : ''}" data-act="pstoggle" data-id="${s.id}">
          <span class="ckmark">${on ? '●' : ''}</span>
          <span class="grow">
            <b>${fmtDateCN(s.date)}</b>
            <span class="meta">${esc(timeText(s))}</span>
          </span>
        </button>`;
      }).join('')}
    </div>
    <div class="modal-actions">
      <button class="btn ghost" data-act="closemodal">取消</button>
      <button class="btn primary" data-act="psok">保存（已选 ${n} 节）</button>
    </div>`);
}

/* ---- 改文件类型 ---- */
function kindModal(fileId) {
  const f = fileOf(fileId);
  if (!f) return;
  openModal(`
    <h3>这份文件属于哪一类</h3>
    <p class="sub">只影响资料库里的归类和导出时的文件夹，不影响文件本身。</p>
    ${KIND_ORDER.map(k => `
      <button class="opt ${f.kind === k ? 'rec' : ''}" data-act="setkind" data-fid="${f.id}" data-v="${k}">
        <b>${FILE_KINDS[k].label}${f.kind === k ? ' · 当前' : ''}</b>
        <span>导出到「课程资料/${FILE_KINDS[k].dir}/」</span>
      </button>`).join('')}
    <div class="modal-actions"><button class="btn ghost" data-act="closemodal">取消</button></div>`);
}

/** 上传到哪个学科：只有一个就直接用，多个让用户点一下 */
async function askSubject(title = '上传到哪个学科？') {
  if (!state.subjects.length) { toast('先在课表里加一门课'); return ''; }
  if (state.subjects.length === 1) return state.subjects[0].id;
  const v = await openDialog(`
    <h3>${esc(title)}</h3>
    <p class="sub">课程文件归属于整个学科，之后可以关联到一节或多节课。</p>
    ${state.subjects.map(s => `
      <button class="opt" data-act="dlg" data-v="${s.id}">
        <b><span class="dot" style="display:inline-block;background:${s.color};margin-right:7px"></span>${esc(s.name)}</b>
        <span>资料库里已有 ${activeFiles().filter(f => f.subjectId === s.id).length} 个文件</span>
      </button>`).join('')}
    <div class="modal-actions"><button class="btn ghost" data-act="dlg" data-v="cancel">取消</button></div>`);
  return v === 'cancel' ? '' : v;
}

/** 弹文件选择框（用真实的 input，才能带 multiple） */
function pickLocalFiles(onPicked) {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.multiple = true;
  inp.accept = FILE_ACCEPT;
  inp.onchange = () => {
    const files = Array.from(inp.files || []);
    if (files.length) onPicked(files);
  };
  inp.click();
}

/* ---- 渲染：资料库页 ---- */
async function renderLibrary() {
  const act = activeFiles();
  const bytes = act.reduce((n, f) => n + (f.size || 0), 0);
  const orphan = act.filter(f => !(f.links || []).length).length;
  const cur = state.fileSubject;
  const list = cur === 'all' ? act : act.filter(f => f.subjectId === cur);

  setHeader('资料', act.length
    ? `${act.length} 个文件 · ${fmtSize(bytes)}${orphan ? ` · ${orphan} 个未关联课堂` : ''}`
    : 'PPT / PDF / Word / 实验报告，只存一份', '');

  const chips = [`<button class="c ${cur === 'all' ? 'on' : ''}" data-act="filefilter" data-id="all">全部</button>`]
    .concat(state.subjects.map(s => {
      const n = act.filter(f => f.subjectId === s.id).length;
      return `<button class="c ${cur === s.id ? 'on' : ''}" data-act="filefilter" data-id="${s.id}">${esc(s.name)}${n ? ` ${n}` : ''}</button>`;
    })).join('');

  if (!act.length) {
    view.innerHTML = `<div class="chips">${chips}</div>
      <div class="empty">
        <div class="big">▧</div>
        <p>资料库还是空的。<br>PPT、PDF、Word、实验报告传到这里，<b>只存一份</b>，可以关联到一节课，也可以关联到很多节课。</p>
        <button class="btn primary" data-act="uploadlib">＋ 上传课程文件</button>
      </div>`;
    return;
  }

  if (!list.length) {
    view.innerHTML = `<div class="chips">${chips}</div>
      <div class="empty"><div class="big">▧</div><p>这个学科还没有上传过文件。</p>
      <button class="btn primary" data-act="uploadlib">＋ 上传课程文件</button></div>`;
    return;
  }

  const sorted = list.slice().sort((a, b) =>
    kindRank(a.kind) - kindRank(b.kind) || a.name.localeCompare(b.name, 'zh'));

  let html = `<div class="chips">${chips}</div>
    <div class="btn-row" style="margin:0 0 12px">
      <button class="btn sm primary" data-act="uploadlib">＋ 上传课程文件</button>
      ${cur !== 'all' ? `<button class="btn sm" data-act="exportsubject" data-id="${cur}">导出该学科 ZIP</button>` : ''}
    </div>`;

  let lastKind = null;
  for (const f of sorted) {
    if (f.kind !== lastKind) {
      lastKind = f.kind;
      const K = FILE_KINDS[f.kind] || FILE_KINDS.other;
      const n = sorted.filter(x => x.kind === f.kind).length;
      html += `<div class="lib-head"><b>${K.label}</b><span class="cnt">${n} 个</span></div>`;
    }
    html += libItemHtml(f, cur === 'all');
  }
  view.innerHTML = html;
}

function libItemHtml(f, showSubject) {
  const K = kindOf(f);
  const sub = state.subjects.find(s => s.id === f.subjectId);
  const ss = sessionsOfFile(f);
  const vs = versionsOf(f);
  const pills = ss.slice(0, 6).map(s => `<span class="linkpill">${s.date.slice(5)}</span>`).join('');
  const more = ss.length > 6 ? `<span class="linkpill">+${ss.length - 6}</span>` : '';
  return `
  <div class="lib-item">
    <div class="top">
      <span class="fi fkind-${f.kind || 'other'}">${esc((f.ext || 'file').toUpperCase().slice(0, 4))}</span>
      <div class="grow">
        <div class="name">${esc(f.name)}</div>
        <div class="meta">
          ${showSubject && sub ? `<span style="color:${sub.color};font-weight:600">${esc(sub.name)}</span> · ` : ''}
          ${K.label} · ${fmtSize(f.size)}${(f.version || 1) > 1 ? ` · v${f.version}` : ''}
          · ${ss.length ? `关联 ${ss.length} 节课` : '<span class="orphan">还没关联任何课堂</span>'}
        </div>
      </div>
    </div>
    ${ss.length ? `<div class="links">${pills}${more}</div>` : ''}
    <div class="ops">
      <button class="btn sm ghost" data-act="dlfile" data-fid="${f.id}">下载</button>
      <button class="btn sm ghost" data-act="picksess" data-fid="${f.id}">关联课堂</button>
      ${vs.length > 1 ? `<button class="btn sm ghost" data-act="versions" data-fid="${f.id}">版本 ${vs.length}</button>` : ''}
      <button class="btn sm ghost" data-act="rekind" data-fid="${f.id}">改类型</button>
      <button class="btn sm ghost danger" data-act="delfile" data-fid="${f.id}">删除</button>
    </div>
  </div>`;
}

function setHeader(title, sub, rightHTML = '') {
  $('#pageTitle').textContent = title;
  $('#pageSub').textContent = sub || '';
  $('#tbRight').innerHTML = rightHTML;
}

function sessionCard(s, opts = {}) {
  const sub = subjectOf(s);
  const open = state.openIds.has(s.id);
  // 「待处理 + 免记」是最容易读岔的组合（清账后一大堆），直接把 chip 换成已免记
  const isExempt = s.exempt && s.status === 'pending';
  const st = isExempt ? { label: '已免记', cls: 'st-none' } : (STATUS_MAP[s.status] || STATUS_MAP.pending);
  const place = placeOf(s) ? ` · ${esc(placeOf(s))}` : '';
  const photoN = (s.photos || []).length;
  const textN = (s.transcriptText || '').trim().length;
  const fileN = filesOfSession(s.id).length;
  const dateTag = opts.showDate ? `<span class="tag">${fmtDateCN(s.date)}</span>` : '';
  // 补录的记录：标一下上传日期，和上课日期区分开
  const upTag = (s.uploadedAt && dateStr(new Date(s.uploadedAt)) !== s.date)
    ? `<span class="tag tag-up">补录 ${dateStr(new Date(s.uploadedAt)).slice(5)}</span>` : '';
  const exemptTag = (s.exempt && !isExempt) ? '<span class="tag tag-ex">本次免记</span>' : '';
  return `
  <article class="card${open ? ' open' : ''}" data-card="${s.id}">
    <div class="card-main" data-act="toggle" data-id="${s.id}">
      <span class="bar" style="background:${sub.color}"></span>
      <div class="grow">
        <div class="row1"><b>${esc(sub.name)}</b><span class="chip ${st.cls}">${st.label}</span></div>
        <div class="meta">${esc(timeText(s))}${place}</div>
        <div class="tags">
          ${dateTag}${upTag}${exemptTag}
          ${textN ? `<span class="tag">转录稿 ${textN} 字</span>` : ''}
          ${photoN ? `<span class="tag">板书 ${photoN} 张</span>` : ''}
          ${fileN ? `<span class="tag">资料 ${fileN}</span>` : ''}
          ${(s.note || '').trim() ? '<span class="tag">有备注</span>' : ''}
        </div>
      </div>
    </div>
    ${open ? sessionDetail(s) : ''}
  </article>`;
}

function sessionDetail(s) {
  const photos = s.photos || [];
  const linked = filesOfSession(s.id);
  return `
  <div class="detail">
    <div class="status-row">
      ${Object.entries(STATUS_MAP).map(([k, v]) => `
        <button class="stbtn ${s.status === k ? 'on ' + v.cls : ''}"
          data-act="status" data-id="${s.id}" data-status="${k}">${v.label}</button>`).join('')}
    </div>

    <div class="exempt-row">
      <span>这一次不需要记录？</span>
      <button class="btn sm ${s.exempt ? 'primary' : 'ghost'}" data-act="toggleexempt" data-id="${s.id}">
        ${s.exempt ? '已免记 · 点此恢复' : '本次免记'}
      </button>
    </div>

    <label class="field-label">转录稿正文（从豆包复制全文粘进来）</label>
    <textarea class="ta" data-act="text" data-id="${s.id}" rows="4"
      placeholder="粘贴转录文字，或从下方导入 txt / md 文件">${esc(s.transcriptText || '')}</textarea>
    <div class="btn-row">
      <button class="btn sm" data-act="clip" data-id="${s.id}">读取剪贴板</button>
      <label class="btn sm file">导入 txt / md
        <input type="file" accept=".txt,.md,.markdown,.csv,.json,text/*" data-act="file" data-id="${s.id}" hidden>
      </label>
    </div>

    <label class="field-label">板书照片${photos.length ? `（${photos.length} 张）` : ''}</label>
    <div class="photo-grid">
      ${photos.map((p, i) => `
        <div class="ph">
          <img src="${p}" alt="板书 ${i + 1}">
          <button class="x" data-act="delphoto" data-id="${s.id}" data-idx="${i}">×</button>
        </div>`).join('')}
      <label class="ph add">＋
        <input type="file" accept="image/*" multiple data-act="photos" data-id="${s.id}" hidden>
      </label>
    </div>

    <label class="field-label">备注</label>
    <input class="inp" type="text" data-act="note" data-id="${s.id}"
      value="${esc(s.note || '')}" placeholder="比如：老师补充了第三章重点，下节课带习题册">

    <div class="file-box">
      <div class="fhead">
        <span class="field-label" style="margin:0">相关课程资料${linked.length ? `（${linked.length}）` : ''}</span>
        <span class="fhint">文件存在学科资料库里，只占一份</span>
      </div>
      ${linked.map(f => fileRowHtml(f, { sessionId: s.id })).join('')}
      <div class="btn-row">
        <button class="btn sm" data-act="upfiles" data-id="${s.id}">＋ 上传新文件</button>
        <button class="btn sm ghost" data-act="pickfiles" data-id="${s.id}">＋ 从本学科资料库选择</button>
      </div>
    </div>

    <div class="btn-row end">
      <button class="btn ghost sm danger" data-act="delsession" data-id="${s.id}">删除这节课记录</button>
    </div>
  </div>`;
}

/** 详情区里的一行课程文件 */
function fileRowHtml(f, opts = {}) {
  const K = kindOf(f);
  const n = (f.links || []).length;
  return `
  <div class="frow-item">
    <span class="fi fkind-${f.kind || 'other'}">${esc((f.ext || 'file').toUpperCase().slice(0, 4))}</span>
    <div class="grow">
      <b title="${esc(f.name)}">${esc(f.name)}</b>
      <div class="meta">${K.label} · ${fmtSize(f.size)}${(f.version || 1) > 1 ? ` · v${f.version}` : ''}${opts.showLinks && n ? ` · 关联 ${n} 节` : ''}</div>
    </div>
    <div class="ops">
      <button class="icon-btn" data-act="dlfile" data-fid="${f.id}" title="下载">⤓</button>
      ${opts.sessionId ? `<button class="icon-btn" data-act="unlinkfile" data-fid="${f.id}" data-id="${opts.sessionId}" title="只解除关联，不删文件">×</button>` : ''}
    </div>
  </div>`;
}

/* ==================== 渲染：今日 ==================== */
async function renderToday() {
  await ensureSessionsFor(state.today);
  const list = sessionsOf(state.today);
  const wk = weekNoOf(state.today, state.settings.semesterStart);
  const pending = pendingKeyOf(state.today);
  // 已处理 = 归档过 / 标了无转录稿 / 取消 / 免记，都算「这节课不用再管了」
  const handledN = list.filter(s => !isPending(s)).length;
  const exemptN = list.filter(s => s.exempt && s.status === 'pending').length;

  setHeader('今日', `${fmtDateCN(state.today)} · 第${wk}周`, `
    <button class="btn sm ghost" data-act="addmanual">＋ 临时加课</button>`);

  if (!list.length) {
    const histN0 = pastPendingKey(state.today).length;
    view.innerHTML = `
      <div class="empty">
        <div class="big">▦</div>
        <p>今天课表里没有课。</p>
        <button class="btn primary" data-act="go" data-tab="schedule">去看看课表</button>
        <div style="height:10px"></div>
        <button class="btn" data-act="backfill">＋ 补录往期记录${histN0 ? `（历史 ${histN0} 节待处理）` : ''}</button>
        ${histN0 ? `<button class="past-hint" data-act="continuous">历史还有 <b>${histN0}</b> 节没归档 · 连续补录 / 清账 ›</button>` : ''}
      </div>`;
    return;
  }

  const due = isReminderDue();
  const banner = (due && pending.length) ? `
    <div class="banner">
      <span class="ic">⏰</span>
      <div>
        <b>今天还有 ${pending.length} 节课没归档</b><br>
        ${pending.map(s => esc(subjectOf(s).name)).join('、')} —— 补上转录稿，或标记「无转录稿 / 课程取消」。
      </div>
    </div>` : '';

  const progress = list.length ? Math.round(handledN / list.length * 100) : 0;
  // 历史欠账只做提示，绝不进今晚的提醒
  const histN = pastPendingKey(state.today).length;

  view.innerHTML = `
    ${banner}
    <div class="stat${exemptN ? ' four' : ''}">
      <div class="s"><b>${list.length}</b><span>今天几节</span></div>
      <div class="s"><b style="color:var(--done)">${handledN}</b><span>已处理</span></div>
      ${exemptN ? `<div class="s"><b style="color:var(--muted)">${exemptN}</b><span>免记</span></div>` : ''}
      <div class="s"><b style="color:${pending.length ? 'var(--pending)' : 'var(--done)'}">${pending.length}</b><span>待处理</span></div>
    </div>
    <div style="height:6px;background:#e7e9ef;border-radius:6px;margin:0 2px 16px;overflow:hidden">
      <div style="height:100%;width:${progress}%;background:var(--done);border-radius:6px;transition:width .3s"></div>
    </div>
    ${list.map(s => sessionCard(s)).join('')}
    <div class="past-box">
      <button class="btn wide" data-act="backfill">＋ 补录往期记录</button>
      ${histN ? `<button class="past-hint" data-act="continuous">历史还有 <b>${histN}</b> 节没归档 · 连续补录 / 清账 ›</button>` : ''}
    </div>
  `;
}

/* ==================== 渲染：课表 ==================== */
async function renderSchedule() {
  const wk = weekNoOf(state.today, state.settings.semesterStart);
  const subjectsN = new Set(state.entries.map(e => e.subjectId)).size;
  setHeader('课表', `第${wk}周 · ${state.entries.length} 节 · ${subjectsN} 门课`, `
    <button class="btn sm ghost" data-act="importxlsx">导入课表</button>
    <button class="btn sm primary" data-act="addentry">＋ 添加</button>`);

  if (!state.entries.length) {
    view.innerHTML = `
      <div class="empty">
        <div class="big">▤</div>
        <p>还没有课表。<br>从学校系统导出的 Excel 直接导入最快，也可以手动加一门。</p>
        <button class="btn primary" data-act="importxlsx">导入 Excel 课表</button>
        <div style="height:10px"></div>
        <button class="btn" data-act="addentry">手动添加一门课</button>
      </div>`;
    return;
  }

  let html = '';
  for (let wd = 1; wd <= 7; wd++) {
    const items = state.entries
      .filter(e => e.weekday === wd)
      .sort((a, b) => (a.startTime || '99').localeCompare(b.startTime || '99'));
    if (!items.length) continue;
    html += `<div class="day-block">
      <div class="day-head"><b>${WEEK_LABEL[wd - 1]}</b><span>${items.length} 节</span></div>
      ${items.map(e => {
        const sub = state.subjects.find(x => x.id === e.subjectId) || { name: '未命名', color: '#94a3b8' };
        return `<div class="entry">
          <span class="bar" style="width:3px;align-self:stretch;border-radius:3px;background:${sub.color}"></span>
          <div class="e-body">
            <div class="e-top"><b>${esc(sub.name)}</b></div>
            <div class="e-meta">${esc(e.sections || `${e.startTime}–${e.endTime}`)} · ${weekText(e)}${e.location ? ' · ' + esc(e.location) : ''}</div>
          </div>
          <div class="e-ops">
            <button class="icon-btn" data-act="editentry" data-id="${e.id}" title="编辑">✎</button>
            <button class="icon-btn" data-act="delentry" data-id="${e.id}" title="删除">🗑</button>
          </div>
        </div>`;
      }).join('')}
    </div>`;
  }
  view.innerHTML = html;
}

/* ==================== 渲染：历史记录 ==================== */
function histFiltered() {
  let list = state.sessions.slice();
  if (state.libSubject !== 'all') list = list.filter(s => s.subjectId === state.libSubject);
  if (state.histFrom) list = list.filter(s => s.date >= state.histFrom);
  if (state.histTo) list = list.filter(s => s.date <= state.histTo);
  if (state.histStatus === 'exempt') list = list.filter(s => s.exempt);
  else if (state.histStatus === 'pending') list = list.filter(s => s.status === 'pending' && !s.exempt);
  else if (state.histStatus !== 'all') list = list.filter(s => s.status === state.histStatus);
  if (state.histPhoto === 'has') list = list.filter(s => (s.photos || []).length);
  if (state.histPhoto === 'none') list = list.filter(s => !(s.photos || []).length);
  const q = state.libQuery.trim().toLowerCase();
  if (q) {
    list = list.filter(s => {
      const sub = subjectOf(s).name.toLowerCase();
      return sub.includes(q) ||
        (s.transcriptText || '').toLowerCase().includes(q) ||
        (s.note || '').toLowerCase().includes(q) ||
        s.date.includes(q);
    });
  }
  return list.sort((a, b) => b.date.localeCompare(a.date) || sortKeyOf(a).localeCompare(sortKeyOf(b)));
}

async function renderHistory() {
  const all = histFiltered();
  const activeFilter = state.histStatus !== 'all' || state.histPhoto !== 'all' ||
    !!state.histFrom || !!state.histTo;
  setHeader('历史记录', activeFilter ? `筛出 ${all.length} / ${state.sessions.length} 条` : `共 ${state.sessions.length} 条记录`, '');

  const chips = [`<button class="c ${state.libSubject === 'all' ? 'on' : ''}" data-act="libfilter" data-id="all">全部</button>`]
    .concat(state.subjects.map(s => {
      const n = state.sessions.filter(x => x.subjectId === s.id).length;
      return `<button class="c ${state.libSubject === s.id ? 'on' : ''}" data-act="libfilter" data-id="${s.id}">${esc(s.name)} ${n}</button>`;
    })).join('');

  const stChip = (k, label) =>
    `<button class="c sm ${state.histStatus === k ? 'on' : ''}" data-act="histstatus" data-v="${k}">${label}</button>`;
  const phChip = (k, label) =>
    `<button class="c sm ${state.histPhoto === k ? 'on' : ''}" data-act="histphoto" data-v="${k}">${label}</button>`;
  const exemptN = state.sessions.filter(s => s.exempt).length;

  const filterBar = `
    <div class="filter-box">
      <div class="frow">
        ${stChip('all', '全部状态')}${stChip('done', '有转录稿')}${stChip('none', '无转录稿')}${stChip('pending', '待处理')}${exemptN ? stChip('exempt', `已免记 ${exemptN}`) : ''}
      </div>
      <div class="frow">
        ${phChip('all', '板书不限')}${phChip('has', '有板书')}${phChip('none', '无板书')}
      </div>
      <div class="frow dates">
        <input class="inp" type="date" id="histFrom" value="${state.histFrom}" max="${state.today}">
        <span class="dash">–</span>
        <input class="inp" type="date" id="histTo" value="${state.histTo}" max="${state.today}">
        ${(state.histFrom || state.histTo) ? '<button class="btn sm ghost" data-act="histclear">清除日期</button>' : ''}
      </div>
    </div>`;

  const head = `<div class="chips">${chips}</div>
    <div class="search"><input placeholder="搜索学科、日期或转录稿内容" data-act="libsearch" value="${esc(state.libQuery)}"></div>
    ${filterBar}`;

  const exportBtn = state.libSubject !== 'all'
    ? `<div style="margin:4px 0 14px"><button class="btn sm primary" data-act="exportsubject" data-id="${state.libSubject}">导出该学科 ZIP</button></div>`
    : '';
  // 免记的能一键恢复，清账点错了不至于只能一条条点回来
  const restoreBtn = (state.histStatus === 'exempt' && all.length)
    ? `<div style="margin:4px 0 14px"><button class="btn sm" data-act="unexemptall">把筛出的 ${all.length} 节恢复成待处理</button></div>`
    : '';
  const actions = exportBtn + restoreBtn;

  if (!all.length) {
    view.innerHTML = `${head}${actions}
      <div class="empty"><div class="big">▣</div>
      <p>${state.sessions.length ? '没有符合筛选条件的记录。' : '还没有归档记录。<br>先去「今日」上传资料，或用「补录往期记录」补以前的课。'}</p>
      ${state.sessions.length ? '' : '<button class="btn primary" data-act="backfill">＋ 补录往期记录</button>'}</div>`;
    return;
  }

  let html = head + actions;

  if (state.libSubject === 'all') {
    for (const sub of state.subjects) {
      const items = all.filter(s => s.subjectId === sub.id);
      if (!items.length) continue;
      html += `<div class="lib-group">
        <div class="lib-head"><b><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${sub.color};margin-right:7px"></span>${esc(sub.name)}</b>
        <span class="cnt">${items.length} 节</span></div>
        ${items.map(s => sessionCard(s, { showDate: true })).join('')}
      </div>`;
    }
    const orphan = all.filter(s => !state.subjects.some(x => x.id === s.subjectId));
    if (orphan.length) {
      html += `<div class="lib-group"><div class="lib-head"><b>其他</b><span class="cnt">${orphan.length} 节</span></div>
        ${orphan.map(s => sessionCard(s, { showDate: true })).join('')}</div>`;
    }
  } else {
    html += all.map(s => sessionCard(s, { showDate: true })).join('');
  }
  view.innerHTML = html;
}

/* ==================== 渲染：设置 ==================== */
let storageInfo = null;
async function refreshStorageInfo() {
  try {
    const est = (navigator.storage && navigator.storage.estimate)
      ? await navigator.storage.estimate() : {};
    let persisted = false;
    if (navigator.storage && navigator.storage.persisted) persisted = await navigator.storage.persisted();
    storageInfo = { usage: est.usage || 0, quota: est.quota || 0, persisted };
  } catch (_) { storageInfo = null; }
}
function storageText() {
  if (!storageInfo) return '这个浏览器不支持查询占用，只知道自己存了多少';
  const { usage, quota, persisted } = storageInfo;
  const head = quota
    ? `已用 ${fmtSize(usage)} / 可用约 ${fmtSize(quota)}`
    : `已用 ${fmtSize(usage)}`;
  return head + (persisted
    ? ' · 已申请常驻，浏览器不会主动清理'
    : ' · 未常驻，空间紧张时可能被浏览器清掉');
}

async function renderSettings() {
  const totalSessions = state.sessions.length;
  const withText = state.sessions.filter(s => (s.transcriptText || '').trim()).length;
  const withPhoto = state.sessions.filter(s => (s.photos || []).length).length;
  const libN = activeFiles().length;
  const libBytes = activeFiles().reduce((n, f) => n + (f.size || 0), 0);
  await refreshStorageInfo();

  setHeader('我的', '设置与数据', '');

  const statusText = reminderStatusText();
  const P = periodsOf();

  view.innerHTML = `
    <div class="stat">
      <div class="s"><b>${totalSessions}</b><span>课程记录</span></div>
      <div class="s"><b>${withText}</b><span>有转录稿</span></div>
      <div class="s"><b>${withPhoto}</b><span>有板书</span></div>
    </div>

    <div class="panel">
      <h3>学期</h3>
      <div class="item">
        <div><div class="lbl">学期开始日期</div><div class="hint">用来计算第几周，填第一周的任意一天</div></div>
        <div class="ctl"><input type="date" id="setSemester" value="${state.settings.semesterStart}"></div>
      </div>
    </div>

    <div class="panel">
      <h3>作息表</h3>
      <div class="item">
        <div>
          <div class="lbl">节次时间</div>
          <div class="hint">共 ${P.length} 节 · 第1节 ${P[0].start} 上课 · 第${P.length}节 ${P[P.length - 1].end} 下课</div>
        </div>
        <div class="ctl"><button class="btn sm" data-act="editperiod">编辑</button></div>
      </div>
    </div>

    <div class="panel">
      <h3>晚间提醒</h3>
      <div class="item">
        <div><div class="lbl">每晚检查时间</div><div class="hint">过了这个时间，今天还有课没归档就推送一次（只查今天，不追旧账）</div></div>
        <div class="ctl"><input type="time" id="setRemind" value="${state.settings.reminderTime}"></div>
      </div>

      <div class="item">
        <div>
          <div class="lbl">微信通知 · Server酱</div>
          <div class="hint">推到微信服务号，免费 5 条/天，一天只发一条汇总</div>
        </div>
        <div class="ctl"><button class="btn sm ${state.settings.scEnabled ? '' : 'primary'}" data-act="togglesc">${state.settings.scEnabled ? '关闭' : '开启'}</button></div>
      </div>
      ${state.settings.scEnabled ? `
      <div class="chan-box">
        <input class="inp" id="setScKey" placeholder="粘贴 SendKey（SCT 开头）" value="${esc(state.settings.scKey || '')}" autocomplete="off" spellcheck="false">
        <div class="chan-hint">用微信扫码登录 sct.ftqq.com → 复制 SendKey 粘到这里。Key 只存在本机浏览器，不会上传。</div>
        <div class="btn-row">
          <button class="btn sm" data-act="testsc">发一条测试</button>
          <a class="btn sm ghost" href="https://sct.ftqq.com/sendkey" target="_blank" rel="noopener">去获取 SendKey</a>
        </div>
      </div>` : ''}

      <div class="item">
        <div>
          <div class="lbl">通用 Webhook</div>
          <div class="hint">POST 一段 JSON 到任意地址，可接企业微信/钉钉/Bark/邮件网关</div>
        </div>
        <div class="ctl"><button class="btn sm ${state.settings.hookEnabled ? '' : 'primary'}" data-act="togglehook">${state.settings.hookEnabled ? '关闭' : '开启'}</button></div>
      </div>
      ${state.settings.hookEnabled ? `
      <div class="chan-box">
        <input class="inp" id="setHookUrl" placeholder="https://example.com/webhook" value="${esc(state.settings.hookUrl || '')}" autocomplete="off" spellcheck="false">
        <div class="chan-hint">发送内容：{ date, count, title, desp, courses:[{name,time,location}] }。目标服务需允许跨域（CORS）。</div>
        <div class="btn-row"><button class="btn sm" data-act="testhook">发一条测试</button></div>
      </div>` : ''}

      <div class="item">
        <div>
          <div class="lbl">浏览器系统通知</div>
          <div class="hint">${state.settings.notifEnabled ? '已开启，打开页面时会弹一次' : '未开启，只在页面内提示'}</div>
        </div>
        <div class="ctl"><button class="btn sm ${state.settings.notifEnabled ? '' : 'primary'}" data-act="enablenotif">${state.settings.notifEnabled ? '关闭' : '开启'}</button></div>
      </div>

      <div class="item">
        <div>
          <div class="lbl">小程序服务通知</div>
          <div class="hint">要走微信订阅消息，需要先把应用迁到小程序，本地版暂不可用</div>
        </div>
        <div class="ctl"><button class="btn sm" disabled>规划中</button></div>
      </div>

      <div class="item">
        <div><div class="lbl">日历兜底提醒</div><div class="hint">生成 .ics，导进手机日历每天定点响，不依赖任何服务</div></div>
        <div class="ctl"><button class="btn sm" data-act="ics">导出 .ics</button></div>
      </div>

      <div class="item">
        <div><div class="lbl">今天的状态</div><div class="hint" id="reminderStatus">${statusText}</div></div>
        <div class="ctl"><button class="btn sm" data-act="pushnow">立即试推</button></div>
      </div>
    </div>

    <div class="panel">
      <h3>导出与备份</h3>
      <div class="item">
        <div><div class="lbl">按学科导出 ZIP</div><div class="hint">课堂记录 + 课程资料 + 资料目录.html，同一个文件只放一份</div></div>
        <div class="ctl">
          <select class="inp" id="expSubject" style="max-width:104px">
            ${state.subjects.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('') || '<option value="">暂无学科</option>'}
          </select>
          <button class="btn sm primary" data-act="exportpick">导出</button>
        </div>
      </div>
      <div class="item">
        <div>
          <div class="lbl">全量备份</div>
          <div class="hint">ZIP 格式，含 ${libN} 个课程文件（${fmtSize(libBytes)}），可换设备导入恢复</div>
        </div>
        <div class="ctl">
          <button class="btn sm" data-act="backup">导出</button>
          <label class="btn sm file">导入<input type="file" accept=".json,.zip,application/json,application/zip" data-act="restore" hidden></label>
        </div>
      </div>
    </div>

    <div class="panel">
      <h3>数据</h3>
      <div class="item">
        <div><div class="lbl">本机存储占用</div><div class="hint" id="storageHint">${esc(storageText())}</div></div>
        <div class="ctl"><button class="btn sm" data-act="persist">申请常驻</button></div>
      </div>
      <div class="item">
        <div>
          <div class="lbl">课程文件存在哪</div>
          <div class="hint">PPT / Word 存在浏览器本地，单份上限 ${fmtSize(MAX_FILE_BYTES)}。长期使用建议定期导出备份，或后续转到云存储</div>
        </div>
        <div class="ctl"><button class="btn sm" data-act="go" data-tab="library">去资料库</button></div>
      </div>
      <div class="item">
        <div><div class="lbl">全部数据保存在本机浏览器</div><div class="hint">不上传服务器。清理浏览器数据会丢失，请定期备份</div></div>
        <div class="ctl"><button class="btn sm danger" data-act="wipe">清空</button></div>
      </div>
    </div>
    <p style="text-align:center;color:var(--muted);font-size:11.5px;margin:18px 0 8px">课堂资料收件箱 · 本地原型 v1.0</p>
  `;
}

/* ==================== 主渲染 ==================== */
async function render() {
  const fn = {
    today: renderToday, schedule: renderSchedule, library: renderLibrary,
    history: renderHistory, settings: renderSettings
  }[state.tab] || renderToday;
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === state.tab));
  try {
    await fn();
  } catch (err) {
    console.error(err);
    view.innerHTML = `<div class="empty"><div class="big">!</div><p>渲染出错：${esc(err.message)}</p></div>`;
  }
}

/* ==================== 提醒 ==================== */
function isReminderDue() {
  const [h, m] = (state.settings.reminderTime || '20:30').split(':').map(Number);
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes() >= h * 60 + m;
}
/* ---------- 推送渠道 ---------- */
const CHANNEL_LABEL = { sc: '微信', hook: 'Webhook' };

/** 已配置且开启的渠道 */
function reminderChannels() {
  const out = [];
  if (state.settings.scEnabled && (state.settings.scKey || '').trim()) out.push('sc');
  if (state.settings.hookEnabled && (state.settings.hookUrl || '').trim()) out.push('hook');
  return out;
}

/** 设置页「今天的状态」一行文案 */
function reminderStatusText() {
  const pend = pendingKeyOf(state.today);
  const chans = reminderChannels();
  const sentMap = state.settings.pushSent || {};
  const sentToday = chans.filter(ch => sentMap[ch] === state.today);
  if (!pend.length) return '今天的课都齐了，今晚不会提醒';
  if (!chans.length) return `还有 ${pend.length} 节待归档，但没开推送渠道，只在打开页面时本地提示`;
  if (sentToday.length === chans.length) return `还有 ${pend.length} 节待归档，今天的提醒已推送`;
  if (isReminderDue()) return `还有 ${pend.length} 节待归档，下次打开页面就补推`;
  return `还有 ${pend.length} 节待归档，${state.settings.reminderTime} 后自动推送`;
}
/** 只改这一行文字，避免整页重渲染把输入框和点击目标弄丢 */
function refreshReminderStatus() {
  const el = document.getElementById('reminderStatus');
  if (el) el.textContent = reminderStatusText();
}


function buildReminderPayload(ds) {
  const pend = pendingKeyOf(ds);
  if (!pend.length) return null;
  const courses = pend.map(s => {
    return {
      name: subjectOf(s).name,
      time: timeText(s),
      location: placeOf(s)
    };
  });
  const title = `还有 ${courses.length} 节课没归档`;
  const desp = [
    `**${ds}** 还有 ${courses.length} 节课没上传转录稿：`,
    '',
    ...courses.map(c => `- ${c.name}　${c.time}${c.location ? '　' + c.location : ''}`),
    '',
    '补齐后今晚不会再提醒。本条只含课程名/节次/地点，不含任何转录正文或板书。'
  ].join('\n');
  return { date: ds, count: courses.length, title, desp, courses };
}

const TEST_PAYLOAD = {
  date: '', count: 1, courses: [],
  title: '测试：课堂资料提醒已接通',
  desp: [
    '这是一条测试消息。收到就说明晚间提醒能用了。',
    '',
    '正式提醒只会列出 **课程名 + 节次 + 地点**，不会包含转录稿正文或板书照片。'
  ].join('\n')
};

async function pushServerChan(key, payload) {
  const url = `https://sctapi.ftqq.com/${encodeURIComponent(String(key).trim())}.send`;
  // application/x-www-form-urlencoded 属于 CORS 安全类型，不会触发预检
  const res = await fetch(url, {
    method: 'POST',
    body: new URLSearchParams({
      title: String(payload.title || '').slice(0, 32),
      desp: String(payload.desp || '')
    })
  });
  const json = await res.json().catch(() => null);
  if (!json) throw new Error(`返回内容无法解析（HTTP ${res.status}）`);
  if (Number(json.code) !== 0) {
    const msg = String(json.message || '').replace(/^\[[^\]]*\]\s*/, '').trim();
    throw new Error(msg || `返回 code=${json.code}`);
  }
  return json;
}

async function pushWebhook(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`目标返回 HTTP ${res.status}`);
  return true;
}

/** 发送到指定渠道；mark=true 时记下「今天已推」，避免重复 */
async function sendReminder(payload, channels, mark = true) {
  const sent = [], failed = [];
  for (const ch of channels) {
    try {
      if (ch === 'sc') await pushServerChan(state.settings.scKey, payload);
      else await pushWebhook(state.settings.hookUrl, payload);
      sent.push(ch);
      if (mark) {
        state.settings.pushSent = Object.assign({}, state.settings.pushSent, { [ch]: payload.date || state.today });
      }
    } catch (err) {
      failed.push(`${CHANNEL_LABEL[ch] || ch}：${err.message}`);
    }
  }
  if (sent.length && mark) await saveSettings();
  return { sent, failed };
}

/**
 * 每晚检查。本地页面不能后台推送，所以策略是：
 * 过了提醒时间后，每次打开页面 / 每分钟心跳都检查一次，当天只推一次。
 */
async function checkReminder(opts = {}) {
  const force = !!opts.force;
  const ds = state.today;
  if (!force && !isReminderDue()) return;

  const pend = pendingKeyOf(ds);

  // 浏览器系统通知（本地，不消耗推送额度）
  if (!force && pend.length && state.settings.notifEnabled && 'Notification' in window &&
      Notification.permission === 'granted' && state.settings.lastNotified !== ds) {
    try {
      new Notification('今天的课还没归档', {
        body: pend.map(s => subjectOf(s).name).join('、') + ` —— 共 ${pend.length} 节`
      });
      state.settings.lastNotified = ds;
      await saveSettings();
    } catch (_) { /* 部分环境不支持构造 Notification */ }
  }

  const payload = buildReminderPayload(ds);
  if (!payload) return;
  const sentMap = state.settings.pushSent || {};
  const chans = reminderChannels().filter(ch => sentMap[ch] !== ds);
  if (!chans.length) return;

  const { sent, failed } = await sendReminder(payload, chans);
  if (sent.length) toast(`已推送提醒 · ${payload.count} 节待归档`);
  if (failed.length) toast('提醒发送失败 · ' + failed.join('；'));
  refreshReminderStatus();
}

/** 设置页的「立即试推」：发今天的真实清单，但不占用当天的去重标记 */
async function pushNow() {
  const chans = reminderChannels();
  if (!chans.length) { toast('先开启并填好一个推送渠道'); return; }
  const payload = buildReminderPayload(state.today);
  if (!payload) { toast('今天没有待归档的课，不用提醒'); return; }
  toast('正在推送…');
  const { sent, failed } = await sendReminder(payload, chans, false);
  if (sent.length && !failed.length) toast(`已推送 · ${payload.count} 节待归档`);
  else if (sent.length) toast(`部分成功 · ${failed.join('；')}`);
  else toast('推送失败 · ' + failed.join('；'));
  refreshReminderStatus();
}

/* ==================== 保存（防抖） ==================== */
const saveTimers = new Map();
function saveSoon(s) {
  clearTimeout(saveTimers.get(s.id));
  saveTimers.set(s.id, setTimeout(() => { dbPut('sessions', s); }, 350));
}
function flushSave(s) {
  clearTimeout(saveTimers.get(s.id));
  dbPut('sessions', s);
}

/* ==================== 文件与图片 ==================== */
function readImage(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => rej(new Error('图片解码失败'));
      im.src = fr.result;
    };
    fr.onerror = () => rej(fr.error);
    fr.readAsDataURL(file);
  });
}
async function compressImage(file, maxSide = 1600, quality = 0.82) {
  const im = await readImage(file);
  const scale = Math.min(1, maxSide / Math.max(im.width, im.height));
  const w = Math.max(1, Math.round(im.width * scale));
  const h = Math.max(1, Math.round(im.height * scale));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(im, 0, 0, w, h);
  return c.toDataURL('image/jpeg', quality);
}

/* ==================== ZIP（store 无压缩，无外部依赖） ==================== */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();
function crc32(u8) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
const enc = new TextEncoder();
const strToBytes = s => enc.encode(s);
function dataUrlToBytes(durl) {
  const b64 = durl.split(',')[1] || '';
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}
function dosDateTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}
function makeZip(files) {
  const { time, date } = dosDateTime();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const nameBytes = strToBytes(f.name);
    const crc = crc32(f.data);
    const lh = new Uint8Array(30 + nameBytes.length);
    const dv = new DataView(lh.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 0x0800, true);
    dv.setUint16(8, 0, true);
    dv.setUint16(10, time, true);
    dv.setUint16(12, date, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, f.data.length, true);
    dv.setUint32(22, f.data.length, true);
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, 0, true);
    lh.set(nameBytes, 30);
    locals.push(lh, f.data);

    const ch = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, f.data.length, true);
    cv.setUint32(24, f.data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    ch.set(nameBytes, 46);
    centrals.push(ch);

    offset += lh.length + f.data.length;
  }
  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  return new Blob([...locals, ...centrals, end], { type: 'application/zip' });
}
function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ==================== 导出：按学科 ==================== */
/* 目录结构：
     学科/
       汇总.csv
       资料目录.html          ← 哪个文件关联了哪几节课
       课堂记录/2026-09-07/转录稿.md | 板书-01.jpg | 备注.txt | 相关课程资料.md
       课程资料/PPT/xxx.pptx
       课程资料/实验报告/xxx.docx
       课程资料/<类型>/历史版本/v1-xxx.pptx
   同一个文件只出现一次，课堂记录里只放指向它的相对链接。 */
function catalogHtml(sub, list, flist, pathOf, emitted) {
  const root = safeName(sub.name);
  const href = p => p.split('/').map(encodeURIComponent).join('/');
  const totalBytes = flist.reduce((n, f) => n + (f.size || 0), 0);
  const groups = KIND_ORDER.map(k => ({ k, items: flist.filter(f => (f.kind || 'other') === k) }))
    .filter(g => g.items.length);

  const fileSections = groups.map(g => {
    const K = FILE_KINDS[g.k] || FILE_KINDS.other;
    const rows = g.items.map(f => {
      const p = pathOf.get(f.id) || '';
      const links = (f.links || []).map(l => {
        const s = list.find(x => x.id === l.sid);
        if (!s) return '';
        const rel = `课堂记录/${s.date}/转录稿.md`;
        const label = `${s.date} ${timeText(s)}`;
        return emitted.has(`${root}/${rel}`)
          ? `<a href="${href(rel)}">${esc(label)}</a>`
          : `<span class="pl">${esc(label)}</span>`;
      }).filter(Boolean);
      return `<tr>
        <td><a href="${href(p)}">${esc(p.split('/').pop() || f.name)}</a>${f.supersededBy ? ' <em class="old">历史版本</em>' : ''}</td>
        <td class="n">${fmtSize(f.size)}</td>
        <td>${links.length ? links.join('　') : '<span class="warn">未关联课堂</span>'}</td>
      </tr>`;
    }).join('');
    return `<h2>${esc(K.label)}<span>${g.items.length} 个</span></h2>
      <table><thead><tr><th>文件</th><th>大小</th><th>关联课堂</th></tr></thead><tbody>${rows}</tbody></table>`;
  }).join('') || '<p class="warn">这个学科还没有上传课程文件。</p>';

  const sessRows = list.map(s => {
    const rel = `课堂记录/${s.date}/转录稿.md`;
    const hasT = emitted.has(`${root}/${rel}`);
    const st = (STATUS_MAP[s.status] || STATUS_MAP.pending).label;
    const nf = filesOfSession(s.id).length;
    return `<tr>
      <td class="n">${s.date}</td>
      <td>${esc(timeText(s))}</td>
      <td>${esc(st)}</td>
      <td>${hasT ? `<a href="${href(rel)}">转录稿</a>` : '<span class="warn">—</span>'}</td>
      <td class="n">${(s.photos || []).length}</td>
      <td class="n">${nf}</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>${esc(sub.name)} · 资料目录</title>
<style>
  body{font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
    max-width:860px;margin:0 auto;padding:32px 20px 60px;color:#15171c;background:#fff}
  h1{font-size:24px;margin:0 0 6px}
  h2{font-size:15px;margin:30px 0 8px;color:#374151;border-bottom:1px solid #e7e9ef;padding-bottom:6px}
  h2 span{font-weight:400;color:#6b7280;font-size:12px;margin-left:8px}
  .sub{color:#6b7280;font-size:13px;margin:0 0 4px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;font-weight:600;color:#6b7280;font-size:12px;padding:6px 8px;border-bottom:1px solid #e7e9ef}
  td{padding:7px 8px;border-bottom:1px solid #f2f4f8;vertical-align:top}
  td.n{font-variant-numeric:tabular-nums;white-space:nowrap}
  a{color:#3b5bfd;text-decoration:none}
  a:hover{text-decoration:underline}
  em{font-style:normal;font-size:11px;color:#3b5bfd;background:#eef2ff;border-radius:5px;padding:1px 5px;margin-left:4px}
  em.old{color:#8a93a3;background:#f1f3f7}
  .warn{color:#b45309}
  .pl{color:#4b5563}
  .note{margin-top:26px;font-size:12px;color:#6b7280;line-height:1.7;border-top:1px solid #e7e9ef;padding-top:12px}
</style></head>
<body>
<h1>${esc(sub.name)}</h1>
<p class="sub">资料目录 · 导出于 ${dateStr()} · 共 ${list.length} 节课 / ${flist.length} 个课程文件 / ${fmtSize(totalBytes)}
  · <a href="汇总.csv">汇总.csv</a></p>

<h2>课程文件<span>按类型分组，点文件名直接打开</span></h2>
${fileSections}

<h2>课堂记录<span>按上课日期</span></h2>
${list.length ? `<table><thead><tr><th>日期</th><th>节次</th><th>状态</th><th>转录稿</th><th>板书</th><th>资料</th></tr></thead>
<tbody>${sessRows}</tbody></table>` : '<p class="warn">还没有课堂记录。</p>'}

<p class="note">
  「课程资料」里的文件是唯一的：一节课关联了它，只是在
  <code>课堂记录/日期/相关课程资料.md</code> 里写一条指向它的链接，不会复制第二份。<br>
  同一份文件改过几版时，当前版本保留原文件名，旧版本放进该类型的「历史版本」文件夹，文件名前加 v1、v2 前缀。
</p>
</body></html>`;
}

async function exportSubject(subjectId) {
  const sub = state.subjects.find(x => x.id === subjectId);
  if (!sub) { toast('请先选择一个学科'); return; }
  const list = state.sessions
    .filter(s => s.subjectId === subjectId)
    .sort((a, b) => a.date.localeCompare(b.date));
  const flist = state.files.filter(f => f.subjectId === subjectId);
  if (!list.length && !flist.length) { toast('这个学科还没有记录'); return; }

  const libBytes = flist.reduce((n, f) => n + (f.size || 0), 0);
  toast(libBytes > 200 * 1024 * 1024
    ? `课程文件共 ${fmtSize(libBytes)}，打包要一会儿…`
    : '正在打包…');

  const root = safeName(sub.name);
  const files = [];
  const emitted = new Set();
  const push = (name, data) => { files.push({ name, data }); emitted.add(name); };

  /* 先算好每个课程文件在 zip 里的路径（重名自动加后缀），课堂记录里要用它写链接 */
  const pathOf = new Map();
  const usedNames = new Set();
  const ordered = flist.filter(f => !f.supersededBy).concat(flist.filter(f => f.supersededBy));
  for (const f of ordered) {
    const K = FILE_KINDS[f.kind] || FILE_KINDS.other;
    const baseDir = f.supersededBy
      ? `${root}/课程资料/${K.dir}/历史版本`
      : `${root}/课程资料/${K.dir}`;
    const fname = f.supersededBy
      ? `v${f.version || 1}-${safeFile(f.name)}`
      : safeFile(f.name);
    let full = `${baseDir}/${fname}`;
    if (usedNames.has(full)) {
      const ext = extOf(fname);
      const stem = ext ? fname.slice(0, -(ext.length + 1)) : fname;
      let i = 2;
      do { full = `${baseDir}/${stem} (${i++})${ext ? '.' + ext : ''}`; } while (usedNames.has(full));
    }
    usedNames.add(full);
    pathOf.set(f.id, full.slice(root.length + 1));
  }

  /* —— 课堂记录 —— */
  const csv = ['日期,星期,节次,时间,教室,状态,转录字数,板书张数,资料数,备注'];
  for (const s of list) {
    const dir = `${root}/课堂记录/${s.date}`;
    const sn = snapOf(s);
    const linked = filesOfSession(s.id);
    csv.push([
      s.date,
      WEEK_LABEL[weekdayOf(s.date) - 1],
      (sn && sn.sections) || s.customTime || '',
      sn && sn.startTime ? `${sn.startTime}-${sn.endTime}` : '',
      (sn && sn.location ? sn.location : '').replace(/[",\n]/g, ' '),
      (STATUS_MAP[s.status] || STATUS_MAP.pending).label,
      (s.transcriptText || '').length,
      (s.photos || []).length,
      linked.length,
      (s.note || '').replace(/[",\n]/g, ' ')
    ].join(','));

    if ((s.transcriptText || '').trim()) {
      push(`${dir}/转录稿.md`, strToBytes(`# ${sub.name} · ${s.date}\n\n${s.transcriptText}\n`));
    } else if (s.status === 'none') {
      push(`${dir}/无转录稿.txt`, strToBytes('本节课没有转录稿。'));
    } else if (s.status === 'cancelled') {
      push(`${dir}/课程取消.txt`, strToBytes('本节课取消。'));
    }
    (s.photos || []).forEach((p, i) => {
      push(`${dir}/板书-${pad2(i + 1)}.jpg`, dataUrlToBytes(p));
    });
    if ((s.note || '').trim()) {
      push(`${dir}/备注.txt`, strToBytes(s.note));
    }
    if (linked.length) {
      const md = [
        `# 相关课程资料`,
        '',
        `上课日期：${s.date}　${WEEK_LABEL[weekdayOf(s.date) - 1]}　${timeText(s)}`,
        '',
        ...linked.map(f => {
          const K = FILE_KINDS[f.kind] || FILE_KINDS.other;
          const p = pathOf.get(f.id) || '';
          const label = `${f.name}（${K.label} · ${fmtSize(f.size)}${(f.version || 1) > 1 ? ` · v${f.version}` : ''}）`;
          return p ? `- [${label}](../../${p})` : `- ${label}`;
        })
      ];
      push(`${dir}/相关课程资料.md`, strToBytes(md.join('\n') + '\n'));
    }
  }

  /* —— 课程资料（文件字节只出现这一次） —— */
  for (const f of ordered) {
    const p = pathOf.get(f.id);
    if (!p) continue;
    const bytes = await fileBytes(f.id);
    if (!bytes) continue;
    push(`${root}/${p}`, bytes);
  }

  push(`${root}/资料目录.html`, strToBytes(catalogHtml(sub, list, ordered, pathOf, emitted)));
  files.unshift({ name: `${root}/汇总.csv`, data: strToBytes('\ufeff' + csv.join('\r\n')) });

  const blob = makeZip(files);
  download(blob, `${root}-课堂资料.zip`);
  toast(`已导出 ${list.length} 节课 · ${flist.length} 个文件`);
}

/* ==================== 导出：ICS ==================== */
function exportICS() {
  const [h, m] = (state.settings.reminderTime || '20:30').split(':');
  const d = new Date();
  const dt = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}T${pad2(h)}${pad2(m)}00`;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ClassInbox//CN', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${uid()}@class-inbox`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${dt}`,
    'RRULE:FREQ=DAILY',
    'SUMMARY:检查今天的课堂资料',
    'DESCRIPTION:打开课堂资料收件箱，确认每节课的转录稿和板书是否已归档。',
    'BEGIN:VALARM', 'TRIGGER:-PT0M', 'ACTION:DISPLAY', 'DESCRIPTION:课堂资料检查', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR'
  ];
  download(new Blob([lines.join('\r\n')], { type: 'text/calendar;charset=utf-8' }), '课堂资料每日提醒.ics');
  toast('已生成 .ics，用手机日历打开即可');
}

/* ==================== 备份 ==================== */
/* 课程文件是二进制，塞进 JSON 会膨胀 1/3，所以整包备份改成 ZIP：
     data.json      —— 课表 / 记录 / 设置 / 文件元信息（不含字节）
     files/<id>.bin —— 每个课程文件的原始字节
   旧版的纯 JSON 备份仍然能导入。 */
async function backupAll() {
  const libBytes = state.files.reduce((n, f) => n + (f.size || 0), 0);
  toast(libBytes ? `正在打包备份（含 ${fmtSize(libBytes)} 课程文件）…` : '正在打包备份…');
  const meta = state.files.map(f => {
    const o = { ...f };
    delete o.data;
    return o;
  });
  const data = {
    app: 'class-inbox', version: 2, exportedAt: new Date().toISOString(),
    subjects: state.subjects, entries: state.entries, sessions: state.sessions,
    settings: state.settings, files: meta
  };
  const files = [{ name: 'data.json', data: strToBytes(JSON.stringify(data)) }];
  for (const f of state.files) {
    const bytes = await fileBytes(f.id);
    if (bytes) files.push({ name: `files/${f.id}.bin`, data: bytes });
  }
  download(makeZip(files), `课堂资料备份-${dateStr()}.zip`);
  toast(`备份已导出 · ${state.files.length} 个课程文件`);
}

async function restoreAll(file) {
  const buf = await file.arrayBuffer();
  const u8 = new Uint8Array(buf);
  const isZip = u8.length > 4 && u8[0] === 0x50 && u8[1] === 0x4b;

  let data, zip = null;
  try {
    if (isZip) {
      zip = await readZip(buf);
      const de = zip.get('data.json');
      if (!de) { toast('这个 ZIP 里没有 data.json，不是本应用的备份'); return; }
      data = JSON.parse(await entryText(de));
    } else {
      data = JSON.parse(new TextDecoder('utf-8').decode(u8));
    }
  } catch (err) {
    toast(isZip ? '备份解不开：' + err.message : '文件不是有效的备份 JSON');
    return;
  }
  if (!data || !Array.isArray(data.sessions)) { toast('备份格式不对'); return; }

  const fileN = (data.files || []).length;
  if (!confirm(`将导入 ${data.sessions.length} 条课程记录${fileN ? `、${fileN} 个课程文件` : ''}，同 ID 的记录会被覆盖。继续？`)) return;

  for (const s of (data.subjects || [])) await dbPut('subjects', s);
  for (const e of (data.entries || [])) await dbPut('entries', e);
  for (const s of data.sessions) await dbPut('sessions', s);

  let restored = 0;
  for (const m of (data.files || [])) {
    const rec = { ...m };
    delete rec.data;              // 老备份的元数据里可能带过字节，别让它又回到 files
    if (zip) {
      const entry = zip.get(`files/${m.id}.bin`);
      if (entry) {
        try {
          await dbPut('blobs', { id: rec.id, data: toBuf(await entryBytes(entry)) });
          restored++;
        } catch (_) { /* 解不开就当没有，下面会提示 */ }
      }
    }
    await dbPut('files', rec);
  }

  if (data.settings) {
    state.settings = Object.assign(state.settings, data.settings);
    await saveSettings();
  }
  await loadAll();
  await render();
  toast(fileN ? `导入完成 · ${restored}/${fileN} 个课程文件还原成功` : '导入完成');
}

/* ==================== 弹窗 ==================== */
function openModal(html) {
  $('#modalBody').innerHTML = html;
  $('#modal').hidden = false;
}
function closeModal() {
  $('#modal').hidden = true;
  $('#modalBody').innerHTML = '';
  pickFileCtx = null;
  pickSessCtx = null;
  // 有弹窗在等用户选择时，关掉就算取消，避免 Promise 永远挂着
  if (dlgCtx) { const r = dlgCtx; dlgCtx = null; r('cancel'); }
}

function entryFormModal(entry) {
  const isEdit = !!entry;
  if (!state.subjects.length) {
    openModal(`
      <h3>先建一个学科</h3>
      <p class="sub">课表里的每门课都要挂在一个学科下，期末按学科导出。</p>
      <div class="form-row one"><div class="f"><label>学科名称</label>
        <input class="inp" id="f_newsubject" placeholder="如：高等数学"></div></div>
      <div class="modal-actions">
        <button class="btn ghost" data-act="closemodal">取消</button>
        <button class="btn primary" data-act="createsubject">创建</button>
      </div>`);
    return;
  }
  const P = periodsOf();
  const isCustom = entry && entry.timeMode === 'custom';
  // 编辑导入的课时，节次从 sectionsKey 反解；手动新课默认落在第1-2节
  let secA = 1, secB = Math.min(2, P.length);
  if (entry && entry.sectionsKey) {
    const [a, b] = String(entry.sectionsKey).split('-').map(Number);
    if (a && b) { secA = Math.min(a, P.length); secB = Math.min(b, P.length); }
  }
  const e = entry || {
    weekday: ((new Date().getDay() + 6) % 7) + 1,
    startTime: P[0].start, endTime: P[Math.min(1, P.length - 1)].end,
    weekMode: 'all', weekFrom: 1, weekTo: 20,
    location: '', subjectId: state.subjects[0].id
  };
  const secOpts = sel => P.map((p, i) => {
    const n = i + 1;
    return `<option value="${n}" ${n === sel ? 'selected' : ''}>第${n}节</option>`;
  }).join('');
  const t = slotsToTime([secA, secB]);

  openModal(`
    <h3>${isEdit ? '编辑课程' : '添加课程'}</h3>
    <p class="sub">填好后，每个对应星期的日期都会自动生成一条课程记录。</p>
    <div class="form-row">
      <div class="f"><label>学科</label>
        <select class="inp" id="f_subject">
          ${state.subjects.map(s => `<option value="${s.id}" ${s.id === e.subjectId ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
        </select>
      </div>
      <div class="f"><label>星期</label>
        <select class="inp" id="f_weekday">
          ${WEEK_LABEL.map((w, i) => `<option value="${i + 1}" ${i + 1 === e.weekday ? 'selected' : ''}>${w}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="form-row">
      <div class="f"><label>节次</label>
        <div class="sec-pick">
          <select class="inp" id="f_sec_from">${secOpts(secA)}</select>
          <span class="dash">–</span>
          <select class="inp" id="f_sec_to">${secOpts(secB)}</select>
        </div>
        <div class="hint" id="f_sechint">${t.startTime}–${t.endTime}</div>
      </div>
      <div class="f"><label>自定义时间</label>
        <div class="sec-pick">
          <input class="inp" type="time" id="f_start" value="${e.startTime}" ${isCustom ? '' : 'disabled'}>
          <span class="dash">–</span>
          <input class="inp" type="time" id="f_end" value="${e.endTime}" ${isCustom ? '' : 'disabled'}>
        </div>
        <label class="ck"><input type="checkbox" id="f_customtime" ${isCustom ? 'checked' : ''}> 这节课时间特殊，不跟作息表</label>
      </div>
    </div>
    <div class="form-row">
      <div class="f"><label>周次规则</label>
        <select class="inp" id="f_weekmode">
          ${Object.entries(WEEK_MODE).map(([k, v]) => `<option value="${k}" ${k === (e.weekMode || 'all') ? 'selected' : ''}>${v}</option>`).join('')}
        </select>
      </div>
      <div class="f"><label>周次范围</label>
        <div style="display:flex;gap:6px;align-items:center">
          <input class="inp" type="number" min="1" max="30" id="f_from" value="${e.weekFrom || 1}">
          <span style="color:var(--muted)">–</span>
          <input class="inp" type="number" min="1" max="30" id="f_to" value="${e.weekTo || 20}">
        </div>
      </div>
    </div>
    <div class="form-row one">
      <div class="f"><label>上课地点（可选）</label>
        <input class="inp" id="f_location" value="${esc(e.location || '')}" placeholder="如：教三-201"></div>
    </div>
    <div class="modal-actions">
      <button class="btn ghost" data-act="closemodal">取消</button>
      <button class="btn primary" data-act="saveentry" data-id="${isEdit ? entry.id : ''}">${isEdit ? '保存' : '添加'}</button>
    </div>`);
}

/* ==================== 补录往期 ==================== */
/** 某一天课表上应有的课（按时间排），不看 level —— 补录时由用户自己决定要补哪节 */
function entriesOn(ds) {
  const wk = weekNoOf(ds, state.settings.semesterStart);
  const wd = weekdayOf(ds);
  return state.entries
    .filter(e => e.weekday === wd && weekMatches(e, wk))
    .sort((a, b) => (a.startTime || '99:99').localeCompare(b.startTime || '99:99'));
}

function backfillModal(ds) {
  const picked = ds || '';
  let body = '';
  if (picked) {
    const wk = weekNoOf(picked, state.settings.semesterStart);
    const ents = entriesOn(picked);
    body = `<div class="pick-head">${fmtDateCN(picked)} · 第${wk}周</div>`;
    if (ents.length) {
      body += ents.map(e => {
        const sub = state.subjects.find(x => x.id === e.subjectId) || { name: '未命名', color: '#94a3b8' };
        const sess = state.sessions.find(s => s.id === `${picked}__${e.id}`);
        const st = sess ? (STATUS_MAP[sess.status] || STATUS_MAP.pending) : { label: '未补录', cls: 'st-none' };
        return `<button class="pick-row" data-act="fillpick" data-date="${picked}" data-id="${sess ? sess.id : ''}" data-entry="${e.id}">
          <span class="dot" style="background:${sub.color}"></span>
          <span class="grow"><b>${esc(sub.name)}</b>
            <span class="meta">${esc(e.sections || `${e.startTime}–${e.endTime}`)}${e.location ? ' · ' + esc(e.location) : ''}</span></span>
          <span class="chip ${st.cls}">${st.label}</span>
        </button>`;
      }).join('');
    } else {
      body += `<div class="pick-empty">这一天课表里没有课。<br>可以手动选学科补一条。</div>`;
    }
    body += `<button class="btn sm ghost" style="margin-top:10px" data-act="fillpick" data-date="${picked}" data-id="" data-entry="">＋ 没找到课程，手动选择</button>`;
  }

  const quick = (() => {
    const out = [];
    for (let i = 1; i <= 3; i++) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const ds2 = dateStr(d);
      out.push(`<button class="c sm ${picked === ds2 ? 'on' : ''}" data-act="backfilldate" data-v="${ds2}">${i === 1 ? '昨天' : `${d.getMonth() + 1}/${d.getDate()}`}</button>`);
    }
    return out.join('');
  })();

  openModal(`
    <h3>补录往期记录</h3>
    <p class="sub">选一个上课日期，把那天缺的资料补进去。资料会归到那天的课，不会算成今天。</p>
    <label class="field-label">上课日期</label>
    <div class="frow" style="margin-bottom:8px">${quick}</div>
    <input class="inp" type="date" id="bfDate" value="${picked}" max="${state.today}">
    ${body}
    <div class="modal-actions">
      <button class="btn ghost" data-act="closemodal">关闭</button>
      <button class="btn" data-act="continuous">连续补录</button>
    </div>`);
}

/* ==================== 填写某一次课（补录/连续补录共用） ==================== */
let fillCtx = null;   // { date, sessionId, returnTo }

async function fillSessionModal(ds, sessionId, returnTo = 'backfill', entryId = '') {
  let s = sessionId ? state.sessions.find(x => x.id === sessionId) : null;
  // 每次进来都重置上下文，否则上一次的 returnTo / isNewManual 会串味
  fillCtx = { date: ds, sessionId: '', returnTo, isNewManual: false, isNewEntry: false };

  // 有课但还没生成过记录：按课表建一条
  if (!s && entryId) {
    const e = state.entries.find(x => x.id === entryId);
    if (e) {
      s = {
        id: `${ds}__${e.id}`, date: ds, entryId: e.id, subjectId: e.subjectId,
        status: 'pending', transcriptText: '', photos: [], note: '', exempt: false,
        snap: snapOfEntry(e),
        uploadedAt: null, createdAt: Date.now(), updatedAt: Date.now()
      };
      fillCtx.sessionId = s.id; fillCtx.isNewEntry = true;
      state.sessions = state.sessions.filter(x => x.id !== s.id).concat(s);
    }
  }

  // 没找到课程：手动建一条（学科 + 节次自己选）
  if (!s && !sessionId && !entryId) {
    if (!state.subjects.length) { toast('先在课表里加一门课'); return; }
    const P = periodsOf();
    const a = 1, b = Math.min(2, P.length);
    s = {
      id: `${ds}__manual_${uid()}`, date: ds, entryId: '', subjectId: state.subjects[0].id,
      status: 'pending', transcriptText: '', photos: [], note: '', exempt: false,
      customTime: sectionLabel(a, b), uploadedAt: null,
      createdAt: Date.now(), updatedAt: Date.now()
    };
    fillCtx.sessionId = s.id; fillCtx.isNewManual = true; fillCtx.secA = a; fillCtx.secB = b;
    state.sessions = state.sessions.filter(x => x.id !== s.id).concat(s);
  }
  if (!s) { toast('这节课的记录找不到'); return; }
  fillCtx.sessionId = s.id;

  const P = periodsOf();
  const isManual = fillCtx.isNewManual;
  const st = s._bfStatus || s.status;
  const photoN = (s.photos || []).length;

  openModal(`
    <h3>${fmtDateCN(ds)}</h3>
    <p class="sub">补录到这一天的课。上传日期会记成今天，导出时按上课日期排。</p>

    ${isManual ? `
    <div class="form-row">
      <div class="f"><label>学科</label>
        <select class="inp" id="bf_subject">${state.subjects.map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select>
      </div>
      <div class="f"><label>节次</label>
        <div class="sec-pick">
          <select class="inp" id="bf_sec_from">${P.map((p, i) => `<option value="${i + 1}" ${i + 1 === fillCtx.secA ? 'selected' : ''}>第${i + 1}节</option>`).join('')}</select>
          <span class="dash">–</span>
          <select class="inp" id="bf_sec_to">${P.map((p, i) => `<option value="${i + 1}" ${i + 1 === fillCtx.secB ? 'selected' : ''}>第${i + 1}节</option>`).join('')}</select>
        </div>
      </div>
    </div>` : `
    <div class="pick-head" style="margin-bottom:12px">
      <span class="dot" style="background:${subjectOf(s).color}"></span>
      <b>${esc(subjectOf(s).name)}</b>
      <span class="meta">${esc(timeText(s))}${placeOf(s) ? ' · ' + esc(placeOf(s)) : ''}</span>
    </div>`}

    <label class="field-label">转录稿状态</label>
    <div class="frow" style="margin-bottom:4px">
      <button class="c sm ${st === 'done' ? 'on' : ''}" data-act="bfstatus" data-v="done">已上传转录稿</button>
      <button class="c sm ${st === 'none' ? 'on' : ''}" data-act="bfstatus" data-v="none">没有转录稿</button>
      <button class="c sm ${st === 'pending' ? 'on' : ''}" data-act="bfstatus" data-v="pending">暂时还没整理</button>
    </div>

    <label class="field-label">转录稿正文</label>
    <textarea class="ta" id="bf_text" rows="4" placeholder="从豆包复制全文粘进来；选「没有转录稿」可以留空">${esc(s.transcriptText || '')}</textarea>
    <div class="btn-row">
      <label class="btn sm file">导入 txt / md
        <input type="file" accept=".txt,.md,.markdown,text/*" data-act="bf_file" hidden>
      </label>
    </div>

    <label class="field-label">板书照片${photoN ? `（${photoN} 张）` : ''}</label>
    <div class="photo-grid" id="bf_photos">
      ${(s.photos || []).map((p, i) => `
        <div class="ph"><img src="${p}" alt="板书 ${i + 1}">
          <button class="x" data-act="bf_delphoto" data-idx="${i}">×</button></div>`).join('')}
      <label class="ph add">＋<input type="file" accept="image/*" multiple data-act="bf_photos" hidden></label>
    </div>

    <label class="field-label">备注</label>
    <input class="inp" id="bf_note" value="${esc(s.note || '')}" placeholder="比如：这节课主要讲期末重点">

    <div class="modal-actions">
      <button class="btn ghost" data-act="bfcancel">取消</button>
      <button class="btn primary" data-act="bfsave">保存</button>
    </div>`);
}

function fillCurrent() {
  return fillCtx ? state.sessions.find(x => x.id === fillCtx.sessionId) : null;
}

async function saveFill() {
  const s = fillCurrent();
  if (!s) return;
  const text = ($('#bf_text') ? $('#bf_text').value : s.transcriptText || '').trim();
  const note = ($('#bf_note') ? $('#bf_note').value : s.note || '').trim();
  // 没点状态按钮时按内容推断：有正文或照片就算已归档，否则保持原状态
  const status = s._bfStatus || ((text || (s.photos || []).length) ? 'done' : s.status);

  if (status === 'done' && !text && !(s.photos || []).length) {
    toast('选了「已上传转录稿」，但正文是空的——粘一下，或改成「没有转录稿」');
    return;
  }
  if (fillCtx.isNewManual) {
    const P = periodsOf();
    const a = Number($('#bf_sec_from').value) || 1;
    const b = Math.max(a, Number($('#bf_sec_to').value) || a);
    const t = slotsToTime([a, b]);
    s.subjectId = $('#bf_subject').value;
    s.customTime = sectionLabel(a, b);
    s.startTime = t.startTime; s.endTime = t.endTime;
    // 手动补录的课没有课表可依，快照直接按手选的内容写死
    const sub = state.subjects.find(x => x.id === s.subjectId);
    s.snap = {
      subjectId: s.subjectId,
      subjectName: sub ? sub.name : '未命名课程',
      color: sub ? sub.color : '#94a3b8',
      sections: s.customTime,
      startTime: t.startTime, endTime: t.endTime,
      location: '', teacher: ''
    };
  }
  s.status = status;
  s.transcriptText = text;
  s.note = note;
  s.photos = s.photos || [];
  delete s._bfStatus;
  stampUploaded(s);
  await dbPut('sessions', s);
  state.sessions = state.sessions.filter(x => x.id !== s.id).concat(s);
  closeModal();

  const back = fillCtx.returnTo;
  if (back === 'continuous') {
    state.contSel.delete(s.id);
    continuousModal();
    toast('已保存，接着补下一节');
  } else {
    await render();
    toast('已补录');
  }
}

/* ==================== 连续补录 ==================== */
async function continuousModal(days) {
  if (days) state.contDays = days;
  const n = state.contDays || 30;
  const from = recentDates(n)[0];

  openModal(`<h3>连续补录</h3><p class="sub">正在整理最近 ${n} 天的课…</p>`);
  const created = await backfillRange(from, state.today);
  if (created) state.sessions = await dbAll('sessions');

  const desc = (a, b) => b.date.localeCompare(a.date) || sortKeyOf(a).localeCompare(sortKeyOf(b));
  const inRange = state.sessions.filter(s => s.date >= from && s.date < state.today);
  const rows = inRange.filter(isPending).sort(desc);

  let sub, empty;
  if (rows.length) {
    sub = `最近 ${n} 天还没归档的课。点一节补完会自动回到这个列表。`;
  } else if (!inRange.length) {
    sub = `最近 ${n} 天课表里没有课。`;
    empty = '这段时间没有课，换个范围试试。';
  } else {
    sub = `最近 ${n} 天的课都归档了。`;
    empty = `最近 ${n} 天的课都补齐了 🎉`;
  }

  const rangeChip = (d, label) =>
    `<button class="c sm ${state.contDays === d ? 'on' : ''}" data-act="contrange" data-v="${d}">${label}</button>`;

  const rowHtml = s => {
    const sub2 = subjectOf(s);
    const on = state.contSel.has(s.id);
    return `<div class="cont-row">
      <label class="ckb"><input type="checkbox" data-act="contsel" data-id="${s.id}" ${on ? 'checked' : ''}></label>
      <button class="cont-main" data-act="contfill" data-date="${s.date}" data-id="${s.id}">
        <span class="dot" style="background:${sub2.color}"></span>
        <span class="grow"><b>${esc(sub2.name)}</b>
          <span class="meta">${fmtDateCN(s.date)} · ${esc(timeText(s))}</span></span>
        <span class="arrow">›</span>
      </button>
    </div>`;
  };

  const listHtml = rows.length
    ? rows.map(rowHtml).join('')
    : `<div class="pick-empty">${empty || '没有可补的课。'}</div>`;

  const selN = rows.filter(s => state.contSel.has(s.id)).length;

  // 更早的欠账（不在当前区间里的也算）才给「清账」入口
  const olderN = pastPendingKey(state.today).length;
  const cut = defaultDebtBefore();
  const debtBox = olderN ? `
    <div class="debt-box">
      <div class="debt-top">
        <b>更早的欠账不想补了？</b>
        <span>选一个日期，比它更早的待处理课全部标记为「免记」，一次性清掉。</span>
      </div>
      <div class="debt-row">
        <input class="inp" type="date" id="debtBefore" value="${cut}" max="${state.today}">
        <button class="btn sm" data-act="ignorebefore">之前的一律不记</button>
      </div>
      <div class="debt-hint" id="debtHint">${debtHintText(cut)}</div>
    </div>` : '';

  openModal(`
    <h3>连续补录</h3>
    <p class="sub">${sub}</p>
    <div class="frow" style="margin-bottom:10px">
      ${rangeChip(7, '最近 7 天')}${rangeChip(30, '最近 30 天')}${rangeChip(90, '最近 90 天')}
    </div>
    <div class="cont-list">${listHtml}</div>
    ${debtBox}
    <div class="modal-actions">
      <button class="btn ghost" data-act="closemodal">关闭</button>
      <button class="btn primary" data-act="contmark" ${selN ? '' : 'disabled'}>标记选中的 ${selN} 节无转录稿</button>
    </div>`);
}

/* ==================== 作息表编辑 ==================== */
function periodRowsHtml(P) {
  return P.map((p, i) => `
    <div class="period-row">
      <span class="pn">第${i + 1}节</span>
      <input class="inp" type="time" data-p="start" value="${p.start}">
      <span class="dash">–</span>
      <input class="inp" type="time" data-p="end" value="${p.end}">
      <button class="icon-btn" data-act="delperiod" data-i="${i}" title="删掉这一节">✕</button>
    </div>`).join('');
}
/** 从 DOM 里读当前编辑中的作息表（不依赖内存数组，增删行后才不会错位） */
function readPeriodRows() {
  return Array.from(document.querySelectorAll('#periodList .period-row')).map(r => ({
    start: (r.querySelector('[data-p="start"]').value || '08:00').slice(0, 5),
    end: (r.querySelector('[data-p="end"]').value || '08:45').slice(0, 5)
  }));
}
function periodsModal() {
  openModal(`
    <h3>作息表</h3>
    <p class="sub">第 N 节对应的上下课时间。保存后，所有按节次排的课会重新换算时间；手填过自定义时间的课不动。</p>
    <div class="period-list" id="periodList">${periodRowsHtml(periodsOf())}</div>
    <div class="btn-row" style="margin-top:10px">
      <button class="btn sm" data-act="addperiod">+ 添加一节</button>
      <button class="btn sm ghost" data-act="resetperiod">恢复默认</button>
    </div>
    <div class="modal-actions">
      <button class="btn ghost" data-act="closemodal">取消</button>
      <button class="btn primary" data-act="saveperiod">保存</button>
    </div>`);
}

function manualSessionModal() {
  if (!state.subjects.length) { entryFormModal(null); return; }
  const d = new Date();
  openModal(`
    <h3>临时加一节课</h3>
    <p class="sub">用于调课、补课，或课表里没有的课。只加今天这一条。</p>
    <div class="form-row one"><div class="f"><label>学科</label>
      <select class="inp" id="m_subject">${state.subjects.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select>
    </div></div>
    <div class="form-row">
      <div class="f"><label>开始</label><input class="inp" type="time" id="m_start" value="${pad2(d.getHours())}:${pad2(d.getMinutes())}"></div>
      <div class="f"><label>结束</label><input class="inp" type="time" id="m_end" value="${pad2((d.getHours() + 2) % 24)}:${pad2(d.getMinutes())}"></div>
    </div>
    <div class="form-row one"><div class="f"><label>备注（可选）</label>
      <input class="inp" id="m_note" placeholder="如：补周四的课"></div></div>
    <div class="modal-actions">
      <button class="btn ghost" data-act="closemodal">取消</button>
      <button class="btn primary" data-act="savemanual">添加</button>
    </div>`);
}

/* ==================== 课表导入：读 xlsx ==================== */
/* 不用第三方库：手解 zip（中央目录）+ DecompressionStream 解 deflate-raw */
async function readZip(buf) {
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  if (u8.length > 4 && u8[0] === 0x50 && u8[1] === 0x4b && u8[2] === 0x03 && u8[3] === 0x04) {
    // ok，是 zip
  } else if (u8.length > 4 && u8[0] === 0xD0 && u8[1] === 0xCF && u8[2] === 0x11 && u8[3] === 0xE0) {
    throw new Error('这是旧版 .xls（Excel 97 格式），请在 WPS / Excel 里另存为 .xlsx 再导入');
  } else {
    throw new Error('不是 xlsx 文件');
  }
  let eocd = -1;
  const minPos = Math.max(0, u8.length - 66000);
  for (let i = u8.length - 22; i >= minPos; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('xlsx 结构异常（找不到目录）');
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const method = dv.getUint16(off + 10, true);
    const compSize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const cmtLen = dv.getUint16(off + 32, true);
    const lho = dv.getUint32(off + 42, true);
    const name = new TextDecoder('utf-8').decode(u8.subarray(off + 46, off + 46 + nameLen));
    const lnameLen = dv.getUint16(lho + 26, true);
    const lextraLen = dv.getUint16(lho + 28, true);
    const dataStart = lho + 30 + lnameLen + lextraLen;
    files.set(name, { method, raw: u8.subarray(dataStart, dataStart + compSize) });
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return files;
}
async function entryBytes(entry) {
  if (entry.method === 0) return entry.raw;
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('这个浏览器不支持解压，请用新版 Chrome / Edge / Safari 打开');
  }
  const stream = new Blob([entry.raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function entryText(entry) {
  return new TextDecoder('utf-8').decode(await entryBytes(entry));
}
function colIndex(ref) {
  const m = String(ref).match(/^([A-Z]+)/);
  if (!m) return 0;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
function parseSharedStrings(xml) {
  if (!xml) return [];
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  return Array.from(doc.getElementsByTagName('si')).map(si =>
    Array.from(si.getElementsByTagName('t')).map(t => t.textContent).join('')
  );
}
function parseSheetGrid(xml, shared) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const rows = Array.from(doc.getElementsByTagName('row'));
  const grid = [];
  for (const row of rows) {
    const r = Number(row.getAttribute('r')) - 1;
    const arr = grid[r] || (grid[r] = []);
    for (const c of Array.from(row.getElementsByTagName('c'))) {
      const ci = colIndex(c.getAttribute('r'));
      const t = c.getAttribute('t');
      let val = '';
      if (t === 's') {
        const v = c.getElementsByTagName('v')[0];
        val = v ? (shared[Number(v.textContent)] || '') : '';
      } else if (t === 'inlineStr') {
        val = Array.from(c.getElementsByTagName('t')).map(x => x.textContent).join('');
      } else {
        const v = c.getElementsByTagName('v')[0];
        val = v ? v.textContent : '';
      }
      arr[ci] = String(val).trim();
    }
  }
  // 展开合并单元格：把左上角的值铺满整个区域
  const merges = [];
  for (const m of Array.from(doc.getElementsByTagName('mergeCell'))) {
    const ref = m.getAttribute('ref') || '';
    const [a, b] = ref.split(':');
    if (!a || !b) continue;
    const r1 = Number(String(a).match(/\d+/)[0]) - 1;
    const c1 = colIndex(a);
    const r2 = Number(String(b).match(/\d+/)[0]) - 1;
    const c2 = colIndex(b);
    merges.push({ r1, c1, r2, c2 });
    const v = (grid[r1] && grid[r1][c1]) || '';
    for (let r = r1; r <= r2; r++) {
      const arr = grid[r] || (grid[r] = []);
      for (let c = c1; c <= c2; c++) if (!arr[c]) arr[c] = v;
    }
  }
  // 补齐空行
  for (let i = 0; i < grid.length; i++) if (!grid[i]) grid[i] = [];
  return { grid, merges };
}

/* ==================== 课表导入：从表格里认课程 ==================== */
/** 解析周次，支持「1-4周,7-17周」「2-4周,7周,10-16周」「(5-6节)10周」「1-16周(单)」 */
function parseWeekRanges(s) {
  let t = String(s).replace(/\s/g, '');
  // 括号里的节次是「这一次在哪几节」，先摘出来
  let secOverride = null;
  const paren = t.match(/[（(]([^）)]*)[）)]/);
  if (paren && /\d/.test(paren[1])) {
    const secs = paren[1].match(/(\d{1,2})[-–~](\d{1,2})/);
    if (secs) secOverride = [+secs[1], +secs[2]];
  }
  t = t.replace(/[（(][^）)]*[）)]/g, '');
  const odd = /单/.test(t), even = /双/.test(t);

  const ranges = [];
  const re = /(\d{1,2})\s*[-–~至]\s*(\d{1,2})/g;
  let rest = t;
  let m;
  while ((m = re.exec(t))) {
    ranges.push([+m[1], +m[2]]);
    rest = rest.replace(m[0], ' ');          // 挖掉已识别的区间，剩下的才是单周
  }
  const singles = rest.match(/(\d{1,2})(?=\s*周)/g);
  if (singles) singles.forEach(n => ranges.push([+n, +n]));
  if (!ranges.length) {
    const one = t.match(/(\d{1,2})/);
    if (one) ranges.push([+one[1], +one[1]]);
  }
  if (!ranges.length) return null;

  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return {
    ranges: merged,
    mode: odd ? 'odd' : even ? 'even' : 'range',
    from: merged[0][0],
    to: merged[merged.length - 1][1],
    secOverride
  };
}
const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 };

function parseSections(s) {
  let t = String(s).replace(/[第节\s（）()]/g, '');
  if (!t || /:/.test(t)) return null;
  const range = t.match(/^(\d{1,2})[-–~至、,，](\d{1,2})$/);
  if (range) return [+range[1], +range[2]];
  if (/^\d{1,2}$/.test(t)) return [+t, +t];
  const nums = t.match(/\d{1,2}/g);
  if (nums && nums.length) return [Math.min(...nums.map(Number)), Math.max(...nums.map(Number))];
  return null;
}
/** 节次列可能写「1-2」「第3-4节」，也可能写中文大节「一/二/三」（每个大节=2小节） */
function parseSectionLabel(s) {
  const raw = String(s || '').trim();
  if (!raw || raw.length > 16) return null;
  const sec = parseSections(raw);
  if (sec) return { sections: sec, block: false };
  const cn = raw.replace(/[第节\s]/g, '');
  if (CN_NUM[cn]) {
    const n = CN_NUM[cn];
    return { sections: [n * 2 - 1, n * 2], block: true };
  }
  return null;
}
function parseWeekdayCell(s) {
  const t = String(s).replace(/\s/g, '');
  const m = t.match(/([一二三四五六日天])/);
  if (m) {
    const order = '一二三四五六日';
    return m[1] === '天' ? 7 : order.indexOf(m[1]) + 1;
  }
  const n = t.match(/^([1-7])$/);
  return n ? +n[1] : 0;
}
const ROOM_RE = /(楼|教室|馆|室|机房|实验|校区|中心|区\s*\d|^教[一二三四五六七八九十A-Za-z]?[-－]?\d{2,4}$|^[A-Za-z]?\d{3,4}$|[-－]\d{3,4}$)/;

function splitCellBlocks(text) {
  const lines = String(text).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const isWeekLine = l => /\d\s*[-–~至]?\s*\d*\s*周/.test(l);
  const blocks = [];
  let cur = [];
  for (let i = 0; i < lines.length; i++) {
    cur.push(lines[i]);
    if (isWeekLine(lines[i])) {
      // 一个格子里塞了两门课时，周次行后面紧跟的教室行属于当前这门课
      if (i + 1 < lines.length && ROOM_RE.test(lines[i + 1]) && !isWeekLine(lines[i + 1])) {
        cur.push(lines[++i]);
      }
      blocks.push(cur);
      cur = [];
    }
  }
  if (cur.length) {
    if (blocks.length) blocks[blocks.length - 1].push(...cur);
    else blocks.push(cur);
  }
  return blocks;
}

/** 「课程/周次/地点/教师/教学班/教学班组成/选课备注/总学时/学分」这种斜杠格式 */
function parseSlashCourse(text) {
  const parts = String(text).split('/').map(s => s.trim());
  if (parts.length < 3) return null;
  const name = parts[0].replace(/\s+/g, '');
  if (!name || !/\d/.test(parts[1] || '') || !/周/.test(parts[1] || '')) return null;
  const wk = parseWeekRanges(parts[1]);
  if (!wk) return null;
  return {
    name,
    weeks: wk,
    room: (parts[2] || '').replace(/^[／/]+/, '').trim(),
    teacher: (parts[3] || '').trim(),
    secOverride: wk.secOverride || null
  };
}

function parseCourseBlock(lines) {
  const joined = lines.join('\n');
  const slash = parseSlashCourse(joined);
  if (slash) return slash;

  let weeks = null;
  const rest = [];
  for (const l of lines) {
    if (!weeks && /周/.test(l) && /\d/.test(l)) { weeks = parseWeekRanges(l); continue; }
    rest.push(l);
  }
  const name = (rest.shift() || '').replace(/[（(][^）)]*[）)]\s*$/, '').trim() || '未命名课程';
  // 剩下的行里：像教室的当教室，其余第一行当教师
  let room = '', teacher = '';
  for (const l of rest) {
    if (!room && ROOM_RE.test(l)) { room = l; continue; }
    if (!teacher && l.length <= 12) { teacher = l; continue; }
    if (!room) room = l;
  }
  return { name, weeks, room, teacher, secOverride: null };
}

/** 网格型课表：行=节次，列=星期 */
function parseGridLayout(grid, merges = []) {
  let header = null;
  for (let r = 0; r < Math.min(grid.length, 20) && !header; r++) {
    const map = {};
    (grid[r] || []).forEach((cell, c) => {
      const wd = parseWeekdayCell(cell);
      if (wd && /周|星期/.test(String(cell))) map[c] = wd;
    });
    if (Object.keys(map).length >= 3) header = { row: r, map };
  }
  if (!header) return { drafts: [], notes: [] };
  const cols = Object.keys(header.map).map(Number);
  const minCol = Math.min(...cols);

  // 合并区域索引：只有左上角那一格负责产出课程
  const owner = new Map();
  for (const m of merges) {
    for (let r = m.r1; r <= m.r2; r++) {
      for (let c = m.c1; c <= m.c2; c++) owner.set(`${r},${c}`, m);
    }
  }

  // 每行对应的节次（「一/二/三」这种大节 → 第1-2、3-4、5-6 节）
  const rowSec = {};
  const found = {};
  let fallbackSec = 1;
  for (let r = header.row + 1; r < grid.length; r++) {
    const row = grid[r] || [];
    let sec = null;
    for (let c = 0; c < minCol; c++) {
      const s = parseSectionLabel(row[c]);
      if (s) { sec = s.sections; break; }
    }
    if (sec) found[r] = true;
    else sec = [fallbackSec, fallbackSec];
    rowSec[r] = sec;
    fallbackSec = sec[1] + 1;
  }
  // 节次列被纵向合并时（HTML 的 rowspan），下面几行沿用最上面那一行的节次
  for (let r = header.row + 1; r < grid.length; r++) {
    if (found[r]) continue;
    for (let c = 0; c < minCol; c++) {
      const own = owner.get(`${r},${c}`);
      if (own && own.r1 < r && found[own.r1] && rowSec[own.r1]) {
        rowSec[r] = rowSec[own.r1];
        found[r] = true;
        break;
      }
    }
  }

  const out = [];
  const notes = [];
  for (let r = header.row + 1; r < grid.length; r++) {
    for (const c of cols) {
      const text = (grid[r] || [])[c];
      if (!text || String(text).length < 2) continue;
      const own = owner.get(`${r},${c}`);
      if (own && (own.r1 !== r || own.c1 !== c)) continue;   // 合并区里非左上角，跳过

      // 纵向合并：节次跨多行，合成一段
      let sec = rowSec[r];
      if (own && own.r2 > r && rowSec[own.r2]) {
        sec = [rowSec[r][0], rowSec[own.r2][1]];
      }
      for (const block of splitCellBlocks(text)) {
        const course = parseCourseBlock(block);
        if (!course.name || course.name === '未命名课程') continue;
        out.push({
          name: course.name,
          weekday: header.map[c],
          sections: course.secOverride || sec,
          weeks: course.weeks || { ranges: [[1, 20]], mode: 'all', from: 1, to: 20 },
          room: course.room,
          teacher: course.teacher,
          keep: true
        });
      }
    }
  }
  // 表格底部常见的「其他课程：xxx」——没有固定星期，单独记下来提示用户
  for (const row of grid) {
    for (const cell of (row || [])) {
      const t = String(cell || '').trim();
      if (/^其他课程/.test(t)) { notes.push(t.replace(/\s+/g, ' ').slice(0, 80)); break; }
    }
  }
  return { drafts: out, notes: [...new Set(notes)] };
}

/** 列表型课表：表头里有 课程名称 / 星期 / 节次 */
function parseListLayout(grid) {
  let head = null;
  for (let r = 0; r < Math.min(grid.length, 15) && !head; r++) {
    const row = (grid[r] || []).map(c => String(c || '').replace(/\s/g, ''));
    const idx = {};
    row.forEach((c, i) => {
      if (idx.name == null && /课程名称|课程名|课程/.test(c)) idx.name = i;
      else if (idx.weekday == null && /星期|周几/.test(c)) idx.weekday = i;
      else if (idx.sections == null && /节次|节/.test(c)) idx.sections = i;
      else if (idx.weeks == null && /周次|周数|起止周|上课周/.test(c)) idx.weeks = i;
      else if (idx.room == null && /教室|地点/.test(c)) idx.room = i;
      else if (idx.teacher == null && /教师|老师|任课/.test(c)) idx.teacher = i;
    });
    if (idx.name != null && idx.weekday != null) head = { row: r, idx };
  }
  if (!head) return { drafts: [], notes: [] };
  const out = [];
  for (let r = head.row + 1; r < grid.length; r++) {
    const row = grid[r] || [];
    const name = String(row[head.idx.name] || '').trim();
    if (!name) continue;
    const wd = parseWeekdayCell(row[head.idx.weekday]);
    if (!wd) continue;
    out.push({
      name,
      weekday: wd,
      sections: head.idx.sections != null ? (parseSectionLabel(row[head.idx.sections]) || {}).sections || null : null,
      weeks: (head.idx.weeks != null && parseWeekRanges(row[head.idx.weeks])) || { ranges: [[1, 20]], mode: 'all', from: 1, to: 20 },
      room: head.idx.room != null ? String(row[head.idx.room] || '').trim() : '',
      teacher: head.idx.teacher != null ? String(row[head.idx.teacher] || '').trim() : '',
      keep: true
    });
  }
  return { drafts: out, notes: [] };
}

/* ==================== 读 .xls（OLE2 复合文档 + BIFF8） ==================== */
function concatBytes(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let w = 0;
  for (const p of parts) { out.set(p, w); w += p.length; }
  return out;
}

/** 从 OLE2 容器里取出 Workbook 流 */
function readCFBWorkbookStream(buf) {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  const secSize = 1 << dv.getUint16(0x1E, true);
  const miniSize = 1 << dv.getUint16(0x20, true);
  const dirStart = dv.getUint32(0x30, true);
  const miniCutoff = dv.getUint32(0x38, true);
  const miniFatStart = dv.getUint32(0x3C, true);
  const difatStart = dv.getUint32(0x44, true);
  const secOff = n => (n + 1) * secSize;

  // FAT 扇区表（头部 109 项 + DIFAT 链）
  const fatSectors = [];
  for (let i = 0; i < 109; i++) {
    const v = dv.getUint32(0x4C + i * 4, true);
    if (v === 0xFFFFFFFF || v === 0xFFFFFFFE) break;
    fatSectors.push(v);
  }
  let d = difatStart, guard = 0;
  while (d !== 0xFFFFFFFE && d !== 0xFFFFFFFF && guard++ < 4096) {
    const off = secOff(d);
    const per = secSize / 4 - 1;
    for (let i = 0; i < per; i++) {
      const v = dv.getUint32(off + i * 4, true);
      if (v !== 0xFFFFFFFF) fatSectors.push(v);
    }
    d = dv.getUint32(off + per * 4, true);
  }
  const fat = new Uint32Array(fatSectors.length * (secSize / 4));
  let fi = 0;
  for (const s of fatSectors) {
    const off = secOff(s);
    for (let i = 0; i < secSize / 4; i++) fat[fi++] = dv.getUint32(off + i * 4, true);
  }

  const readChainAll = start => {
    const parts = [];
    let cur = start, g = 0;
    while (cur !== 0xFFFFFFFE && cur !== 0xFFFFFFFF && g++ < 100000) {
      const off = secOff(cur);
      if (off + secSize > u8.length) break;
      parts.push(u8.subarray(off, off + secSize));
      cur = fat[cur];
    }
    return concatBytes(parts);
  };

  // 目录项
  const dir = readChainAll(dirStart);
  const dvDir = new DataView(dir.buffer, dir.byteOffset, dir.byteLength);
  const entries = [];
  for (let p = 0; p + 128 <= dir.length; p += 128) {
    const nameLen = dvDir.getUint16(p + 64, true);
    if (!nameLen) continue;
    const name = new TextDecoder('utf-16le').decode(dir.subarray(p, p + Math.max(0, nameLen - 2)));
    entries.push({
      name,
      type: dir[p + 66],
      start: dvDir.getUint32(p + 116, true),
      size: dvDir.getUint32(p + 120, true)
    });
  }

  const want = entries.find(e => e.type === 2 && /^(Workbook|Book)$/i.test(e.name));
  if (!want) throw new Error('这个 xls 里没有工作簿数据');
  if (want.size >= miniCutoff) return readChainAll(want.start).subarray(0, want.size);

  // 小于 4096 字节的流存在 mini stream 里
  const root = entries.find(e => e.type === 5);
  const miniStream = readChainAll(root.start).subarray(0, root.size);
  const miniFatBytes = readChainAll(miniFatStart);
  const mfat = new Uint32Array(miniFatBytes.buffer, miniFatBytes.byteOffset, Math.floor(miniFatBytes.length / 4));
  const out = new Uint8Array(want.size);
  let cur = want.start, w = 0, g = 0;
  while (cur !== 0xFFFFFFFE && cur !== 0xFFFFFFFF && w < want.size && g++ < 100000) {
    const off = cur * miniSize;
    const n = Math.min(miniSize, want.size - w);
    out.set(miniStream.subarray(off, off + n), w);
    w += n;
    cur = mfat[cur];
  }
  return out;
}

/** 读 BIFF8 的 Unicode 字符串（SST 里的那种） */
function readSstStrings(buf, bounds, out) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const boundArr = [...bounds].sort((a, b) => a - b);
  const nextBound = i => { for (const b of boundArr) if (b > i) return b; return buf.length; };
  let p = 8; // 跳过 total / unique 计数

  while (p + 3 <= buf.length) {
    const cch = dv.getUint16(p, true); p += 2;
    let grbit = buf[p]; p += 1;
    let high = grbit & 0x01;
    let rich = 0, ext = 0;
    if (grbit & 0x08) { rich = dv.getUint16(p, true); p += 2; }
    if (grbit & 0x04) { ext = dv.getUint32(p, true); p += 4; }

    let str = '';
    let remaining = cch;
    while (remaining > 0 && p < buf.length) {
      if (bounds.has(p)) { grbit = buf[p]; p += 1; high = grbit & 0x01; }
      const nb = nextBound(p);
      const per = high ? 2 : 1;
      const avail = Math.floor((nb - p) / per);
      const take = Math.min(remaining, avail);
      if (take <= 0) { p = nb; continue; }
      if (high) {
        for (let i = 0; i < take; i++) str += String.fromCharCode(dv.getUint16(p + i * 2, true));
      } else {
        for (let i = 0; i < take; i++) str += String.fromCharCode(buf[p + i]);
      }
      p += take * per;
      remaining -= take;
    }
    p += rich * 4 + ext;
    out.push(str);
  }
}

function rkToNumber(rk) {
  let n;
  if (rk & 0x02) {
    n = (rk | 0) >> 2;
  } else {
    const b = new ArrayBuffer(8);
    const dv = new DataView(b);
    dv.setUint32(0, 0);
    dv.setUint32(4, (rk & 0xFFFFFFFC) >>> 0);
    n = dv.getFloat64(0);
  }
  return (rk & 0x01) ? n / 100 : n;
}
const numToStr = n => {
  if (!isFinite(n)) return '';
  if (Math.abs(n - Math.round(n)) < 1e-9) return String(Math.round(n));
  return String(Math.round(n * 100) / 100);
};

/** 解析 BIFF8 工作簿，返回第一张表的网格 + 合并区 */
function parseBiffWorkbook(stream) {
  const dv = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  const recs = [];
  for (let p = 0; p + 4 <= stream.length;) {
    const id = dv.getUint16(p, true);
    const len = dv.getUint16(p + 2, true);
    if (p + 4 + len > stream.length) break;
    recs.push({ id, p: p + 4, len });
    p += 4 + len;
  }

  // SST（共享字符串表），后面可能跟多个 CONTINUE
  const sst = [];
  const sstIdx = recs.findIndex(r => r.id === 0x00FC);
  if (sstIdx >= 0) {
    const chunks = [recs[sstIdx]];
    for (let i = sstIdx + 1; i < recs.length && recs[i].id === 0x003C; i++) chunks.push(recs[i]);
    const total = chunks.reduce((n, c) => n + c.len, 0);
    const buf = new Uint8Array(total);
    const bounds = new Set();
    let w = 0;
    for (const c of chunks) {
      if (w) bounds.add(w);
      buf.set(stream.subarray(c.p, c.p + c.len), w);
      w += c.len;
    }
    readSstStrings(buf, bounds, sst);
  }

  const cells = new Map();
  const merges = [];
  let sheetNo = 0, inSheet = false;
  const setCell = (r, c, v) => { if (v !== '' && v != null) cells.set(`${r},${c}`, v); };

  for (const rec of recs) {
    if (rec.id === 0x0809) {                       // BOF
      const dt = dv.getUint16(rec.p + 2, true);
      if (dt === 0x0010) {                          // 工作表
        sheetNo++;
        inSheet = sheetNo === 1;
        if (sheetNo > 1) break;
      }
      continue;
    }
    if (!inSheet) continue;

    switch (rec.id) {
      case 0x00FD: {                                // LABELSST
        const isst = dv.getUint32(rec.p + 6, true);
        setCell(dv.getUint16(rec.p, true), dv.getUint16(rec.p + 2, true), sst[isst] || '');
        break;
      }
      case 0x0204: {                                // LABEL
        const cch = dv.getUint16(rec.p + 6, true);
        const grbit = stream[rec.p + 8];
        let s = '';
        if (grbit & 0x01) {
          for (let i = 0; i < cch; i++) s += String.fromCharCode(dv.getUint16(rec.p + 9 + i * 2, true));
        } else {
          for (let i = 0; i < cch; i++) s += String.fromCharCode(stream[rec.p + 9 + i]);
        }
        setCell(dv.getUint16(rec.p, true), dv.getUint16(rec.p + 2, true), s);
        break;
      }
      case 0x027E: {                                // RK
        setCell(dv.getUint16(rec.p, true), dv.getUint16(rec.p + 2, true),
          numToStr(rkToNumber(dv.getUint32(rec.p + 6, true))));
        break;
      }
      case 0x0203: {                                // NUMBER
        setCell(dv.getUint16(rec.p, true), dv.getUint16(rec.p + 2, true),
          numToStr(dv.getFloat64(rec.p + 6, true)));
        break;
      }
      case 0x00BD: {                                // MULRK
        const row = dv.getUint16(rec.p, true);
        const colFirst = dv.getUint16(rec.p + 2, true);
        const n = (rec.len - 6) / 6;
        for (let i = 0; i < n; i++) {
          const rk = dv.getUint32(rec.p + 4 + i * 6 + 2, true);
          setCell(row, colFirst + i, numToStr(rkToNumber(rk)));
        }
        break;
      }
      case 0x0006: {                                // FORMULA
        const r = dv.getUint16(rec.p, true), c = dv.getUint16(rec.p + 2, true);
        const b6 = stream[rec.p + 12], b7 = stream[rec.p + 13];
        if (b6 === 0xFF && b7 === 0xFF) break;      // 字符串/布尔结果，跳过
        setCell(r, c, numToStr(dv.getFloat64(rec.p + 6, true)));
        break;
      }
      case 0x00E5: {                                // MERGEDCELLS
        const n = dv.getUint16(rec.p, true);
        for (let i = 0; i < n; i++) {
          const o = rec.p + 2 + i * 8;
          merges.push({
            r1: dv.getUint16(o, true), r2: dv.getUint16(o + 2, true),
            c1: dv.getUint16(o + 4, true), c2: dv.getUint16(o + 6, true)
          });
        }
        break;
      }
    }
  }

  // 组装成二维数组
  let maxR = 0, maxC = 0;
  for (const k of cells.keys()) {
    const [r, c] = k.split(',').map(Number);
    if (r > maxR) maxR = r;
    if (c > maxC) maxC = c;
  }
  const grid = [];
  for (let r = 0; r <= maxR; r++) grid.push(new Array(maxC + 1).fill(''));
  for (const [k, v] of cells) {
    const [r, c] = k.split(',').map(Number);
    grid[r][c] = v;
  }
  // 合并区铺满
  for (const m of merges) {
    const v = (grid[m.r1] && grid[m.r1][m.c1]) || '';
    for (let r = m.r1; r <= m.r2 && r < grid.length; r++) {
      for (let c = m.c1; c <= m.c2 && c < grid[r].length; c++) {
        if (!grid[r][c]) grid[r][c] = v;
      }
    }
  }
  return { grid, merges };
}

/* ==================== 读文本型「假 xls」（HTML / CSV） ==================== */
function decodeTextSmart(buf) {
  const u8 = new Uint8Array(buf);
  if (u8[0] === 0xEF && u8[1] === 0xBB && u8[2] === 0xBF) return new TextDecoder('utf-8').decode(u8.subarray(3));
  const head = new TextDecoder('latin1').decode(u8.subarray(0, 3000));
  const m = head.match(/charset\s*=\s*["']?([\w-]+)/i);
  let encName = m ? m[1].toLowerCase() : '';
  if (/gb2312|gbk|gb18030/.test(encName)) encName = 'gbk';
  if (encName && encName !== 'utf-8') {
    try { return new TextDecoder(encName).decode(u8); } catch (_) { /* 落到下面 */ }
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(u8); }
  catch (_) {
    try { return new TextDecoder('gbk').decode(u8); }
    catch (e) { return new TextDecoder('utf-8').decode(u8); }
  }
}

function parseHtmlGrid(text) {
  const html = text.replace(/<br\s*\/?>/gi, '\n');
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const tables = Array.from(doc.querySelectorAll('table'));
  if (!tables.length) return null;
  // 取行数最多的那张表（教务系统的页面里常有多张）
  const table = tables.sort((a, b) => b.querySelectorAll('tr').length - a.querySelectorAll('tr').length)[0];

  const grid = [];
  const merges = [];
  Array.from(table.querySelectorAll('tr')).forEach((tr, ri) => {
    const row = grid[ri] || (grid[ri] = []);
    let ci = 0;
    for (const cell of Array.from(tr.children)) {
      if (!/^(TD|TH)$/i.test(cell.tagName)) continue;
      while (row[ci] !== undefined) ci++;
      const text = (cell.textContent || '').replace(/\u00a0/g, ' ').trim();
      const rs = Math.min(Number(cell.getAttribute('rowspan')) || 1, 50);
      const cs = Math.min(Number(cell.getAttribute('colspan')) || 1, 50);
      if (rs > 1 || cs > 1) merges.push({ r1: ri, c1: ci, r2: ri + rs - 1, c2: ci + cs - 1 });
      for (let r = 0; r < rs; r++) {
        const rr = grid[ri + r] || (grid[ri + r] = []);
        for (let c = 0; c < cs; c++) if (rr[ci + c] === undefined) rr[ci + c] = (r === 0 && c === 0) ? text : '';
      }
      ci += cs;
    }
  });
  return { grid, merges };
}

function parseDelimited(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  const delim = lines.slice(0, 5).some(l => l.includes('\t')) ? '\t' : ',';
  return {
    grid: lines.map(l => l.split(delim).map(s => s.trim().replace(/^"|"$/g, ''))),
    merges: []
  };
}

/* ==================== 导入入口：按文件内容分派 ==================== */
async function parseTimetableFile(file) {
  const buf = await file.arrayBuffer();
  const u8 = new Uint8Array(buf);
  let grid, merges;

  if (u8[0] === 0x50 && u8[1] === 0x4B) {
    // ---- xlsx（zip） ----
    const files = await readZip(buf);
    const sheetName = [...files.keys()].find(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
    if (!sheetName) throw new Error('这个文件里没有工作表');
    const shared = files.has('xl/sharedStrings.xml')
      ? parseSharedStrings(await entryText(files.get('xl/sharedStrings.xml')))
      : [];
    ({ grid, merges } = parseSheetGrid(await entryText(files.get(sheetName)), shared));
  } else if (u8[0] === 0xD0 && u8[1] === 0xCF && u8[2] === 0x11 && u8[3] === 0xE0) {
    // ---- 真正的 .xls（OLE2 + BIFF8） ----
    ({ grid, merges } = parseBiffWorkbook(readCFBWorkbookStream(buf)));
  } else {
    // ---- 文本型：教务系统常把 HTML 表格存成 .xls ----
    const text = decodeTextSmart(buf);
    const html = /<table[\s>]/i.test(text) ? parseHtmlGrid(text) : null;
    if (html) ({ grid, merges } = html);
    else ({ grid, merges } = parseDelimited(text));
  }

  if (!grid || !grid.length) throw new Error('没读到表格内容');

  // 先试列表型（有明确表头），再试网格型（节次×星期）
  let res = parseListLayout(grid);
  if (!res.drafts.length) res = parseGridLayout(grid, merges);

  // 去掉重复的完全相同的安排
  const seen = new Set();
  const drafts = res.drafts.filter(d => {
    const k = `${d.name}|${d.weekday}|${d.sections ? d.sections.join('-') : ''}|${JSON.stringify(d.weeks.ranges)}${d.weeks.mode}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // 表尾通常写着「本学期 2026-08-31 正式上课」，顺手把学期开始日期捞出来
  let semesterStart = '';
  for (const row of grid) {
    for (const cell of (row || [])) {
      const t = String(cell || '');
      const m = t.match(/本学期\s*(\d{4})\s*[-./年]\s*(\d{1,2})\s*[-./月]\s*(\d{1,2})/);
      if (m) { semesterStart = `${m[1]}-${pad2(+m[2])}-${pad2(+m[3])}`; break; }
    }
    if (semesterStart) break;
  }

  return { drafts, notes: res.notes || [], semesterStart };
}

/* ==================== 课表导入：预览与确认 ==================== */
let importDraft = [];
let importFileName = '';
let importNotes = [];
let importSemester = '';
let importMode = 'merge';   // merge = 只增改；sync = 文件里没有的课程从课表移除

function openImportPreview(drafts, fileName, notes = [], semesterStart = '') {
  importDraft = drafts;
  importFileName = fileName || '';
  importNotes = notes || [];
  importSemester = semesterStart || '';
  importMode = 'merge';       // 每次导入都回到最安全的默认
  renderImportPreview();
}

function weeksText(w) {
  if (!w || !Array.isArray(w.ranges) || !w.ranges.length) return '全学期';
  if (w.mode === 'all') return '全学期';
  const body = w.ranges.map(r => r[0] === r[1] ? String(r[0]) : `${r[0]}-${r[1]}`).join(',');
  const pre = w.mode === 'odd' ? '单周 ' : w.mode === 'even' ? '双周 ' : '';
  return `${pre}${body} 周`;
}

const draftKey = d => `${d.name.trim()}|${d.weekday}|${d.sections ? d.sections.join('-') : ''}`;

/** 「同步替换」要删掉哪些旧安排：文件里提到这门课，但这次没勾（或没有这一格） */
function importSyncPlan() {
  const inFile = new Set(importDraft.map(d => d.name.trim()));
  const keep = new Set(importDraft.filter(d => d.keep && d.name.trim()).map(draftKey));
  const kill = [];
  for (const e of state.entries) {
    const sub = state.subjects.find(x => x.id === e.subjectId);
    const name = sub ? sub.name : '';
    if (!inFile.has(name)) continue;      // 文件里压根没提到这门课，不归这次管
    if (!keep.has(`${name}|${e.weekday}|${e.sectionsKey || ''}`)) kill.push(e);
  }
  return kill;
}

function impModeHint() {
  if (importMode === 'sync') {
    const n = importSyncPlan().length;
    return n
      ? `<b style="color:#b45309">将移除 ${n} 条旧安排</b>：这次文件里没有的、或取消勾选的课程会从课表里消失。<br>已经归档的历史记录不受影响（它们存了自己的课堂快照）。`
      : '这次文件覆盖了现有课表，没有需要移除的旧安排。';
  }
  return '只增加和更新，<b>不删除</b>任何现有安排。适合「又导了一份新表，先看看有没有变化」。';
}

function renderImportPreview() {
  const prevScroll = document.querySelector('.imp-list')?.scrollTop || 0;
  const uniq = new Set(importDraft.filter(d => d.keep).map(d => d.name.trim())).size;
  const rows = importDraft.map((d, i) => {
    const secTxt = d.sections ? sectionLabel(d.sections[0], d.sections[1]) : '';
    return `<div class="imp-row${d.keep ? '' : ' off'}" data-idx="${i}">
      <input type="checkbox" data-act="impkeep" data-idx="${i}" ${d.keep ? 'checked' : ''}>
      <div class="imp-body">
        <input class="inp imp-name" data-act="impname" data-idx="${i}" value="${esc(d.name)}">
        <div class="imp-meta">${WEEK_LABEL[d.weekday - 1]}${secTxt ? ' · ' + secTxt : ''} · ${weeksText(d.weeks)}${d.room ? ' · ' + esc(d.room) : ''}</div>
      </div>
      <button class="icon-btn" data-act="impdel" data-idx="${i}">✕</button>
    </div>`;
  }).join('');

  const semHint = importSemester
    ? `<div class="imp-note">识别到学期开始日 <b>${importSemester}</b>，导入时会一起更新</div>` : '';
  const notesHint = importNotes.length
    ? `<div class="imp-note">表尾还有：${importNotes.map(n => esc(n)).join('；')}<br>这类课没有固定星期，先没导入。</div>` : '';

  openModal(`
    <h3>课表导入预览</h3>
    <p class="sub">已识别 <b id="impUniq">${uniq}</b> 门课程、<b id="impTotal">${importDraft.length}</b> 个上课安排。
    不想要的可以取消勾选，剩下的都会进每日清单。</p>
    ${semHint}${notesHint}
    <div class="frow" style="margin:2px 0 8px">
      <button class="c sm ${importMode === 'merge' ? 'on' : ''}" data-act="impmode" data-v="merge">合并更新</button>
      <button class="c sm ${importMode === 'sync' ? 'on' : ''}" data-act="impmode" data-v="sync">同步替换</button>
    </div>
    <div class="imp-note" id="impModeHint">${impModeHint()}</div>
    <div class="imp-list">${rows || '<p class="sub">没有可导入的课程</p>'}</div>
    <div class="modal-actions">
      <button class="btn ghost" data-act="closemodal">取消</button>
      <button class="btn primary" data-act="impconfirm">${importMode === 'sync' ? '同步替换' : '确认导入'}</button>
    </div>`);

  const list = document.querySelector('.imp-list');
  if (list && prevScroll) list.scrollTop = prevScroll;
}

/** 只改计数，不重渲染（否则点一次列表就跳回顶部） */
function updateImpSummary() {
  const uniq = new Set(importDraft.filter(d => d.keep).map(d => d.name.trim())).size;
  const a = document.getElementById('impUniq');
  const b = document.getElementById('impTotal');
  const h = document.getElementById('impModeHint');
  if (a) a.textContent = uniq;
  if (b) b.textContent = importDraft.length;
  // 取消勾选会影响「同步替换」要移除的条数，跟着刷一下提示
  if (h && importMode === 'sync') h.innerHTML = impModeHint();
}

async function confirmImport() {
  const picked = importDraft.filter(d => d.keep && d.name.trim());
  if (!picked.length) { toast('没有勾选任何课程'); return; }

  // 同步替换：先算好要移除哪些旧安排（要在改课表之前算，否则匹配关系已经变了）
  const kill = importMode === 'sync' ? importSyncPlan() : [];
  if (kill.length && !confirm(
    `「同步替换」会从课表里移除 ${kill.length} 条安排：\n\n` +
    kill.slice(0, 8).map(e => {
      const sub = state.subjects.find(x => x.id === e.subjectId);
      return `· ${sub ? sub.name : '未命名'}　${WEEK_LABEL[e.weekday - 1]}　${e.sections || ''}`;
    }).join('\n') +
    (kill.length > 8 ? `\n· …还有 ${kill.length - 8} 条` : '') +
    `\n\n已经归档的历史记录不受影响。继续？`
  )) return;

  let added = 0, updated = 0, same = 0;
  const touched = [];
  const nameToSub = new Map(state.subjects.map(s => [s.name, s]));
  // 同一门课同一天同一节，可能因为周次/教室不同而有多条（比如换教室），先数一下
  const draftSlots = new Map();
  for (const d of picked) {
    const k = `${d.name.trim()}|${d.weekday}|${d.sections ? d.sections.join('-') : ''}`;
    draftSlots.set(k, (draftSlots.get(k) || 0) + 1);
  }

  for (const d of picked) {
    const name = d.name.trim();
    let sub = nameToSub.get(name);
    if (!sub) {
      sub = { id: uid(), name, color: PALETTE[state.subjects.length % PALETTE.length], createdAt: Date.now() };
      await dbPut('subjects', sub);
      state.subjects.push(sub);
      nameToSub.set(name, sub);
    }
    const t = slotsToTime(d.sections);
    const sectionsKey = d.sections ? d.sections.join('-') : '';
    const wkSig = JSON.stringify(d.weeks.ranges);
    const slotKey = `${name}|${d.weekday}|${sectionsKey}`;
    const slotCount = draftSlots.get(slotKey) || 1;
    // 先按「学科+星期+节次+周次」精确匹配；只有这一格只导入一条时，才退化成按格子覆盖
    const sameSlot = e => e.subjectId === sub.id && e.weekday === d.weekday &&
      ((e.sectionsKey || '') === sectionsKey || (!e.sectionsKey && e.startTime === t.startTime));
    let match = state.entries.find(e => sameSlot(e) && JSON.stringify(e.weekRanges || []) === wkSig);
    if (!match && slotCount === 1) match = state.entries.find(sameSlot);

    if (match) {
      const changed = JSON.stringify(match.weekRanges || null) !== JSON.stringify(d.weeks.ranges) ||
        match.weekMode !== d.weeks.mode || (match.location || '') !== (d.room || '') ||
        match.startTime !== t.startTime;
      match.weekRanges = d.weeks.ranges;
      match.weekMode = d.weeks.mode;
      match.weekFrom = d.weeks.from;
      match.weekTo = d.weeks.to;
      match.location = d.room || '';
      match.sections = d.sections ? sectionLabel(d.sections[0], d.sections[1]) : '';
      match.sectionsKey = sectionsKey;
      if (t.startTime) { match.startTime = t.startTime; match.endTime = t.endTime; }
      match.teacher = d.teacher || match.teacher || '';
      await dbPut('entries', match);
      touched.push(match.id);
      changed ? updated++ : same++;
    } else {
      const entry = {
        id: uid(), subjectId: sub.id, weekday: d.weekday,
        startTime: t.startTime || '08:00', endTime: t.endTime || '09:40',
        sections: d.sections ? sectionLabel(d.sections[0], d.sections[1]) : '',
        sectionsKey,
        weekRanges: d.weeks.ranges, weekMode: d.weeks.mode,
        weekFrom: d.weeks.from, weekTo: d.weeks.to,
        location: d.room || '', teacher: d.teacher || '',
        createdAt: Date.now()
      };
      await dbPut('entries', entry);
      state.entries.push(entry);
      added++;
    }
  }

  // 表尾识别到的学期开始日：直接采用，否则「第几周」会全错
  if (importSemester && importSemester !== state.settings.semesterStart) {
    state.settings.semesterStart = importSemester;
    await saveSettings();
  }

  // 文件里没出现、但库里还在的课程：合并模式下不删，只报告
  const keptNames = new Set(picked.map(d => d.name.trim()));
  const orphan = state.entries.filter(e => {
    const sub = state.subjects.find(s => s.id === e.subjectId);
    return sub && !keptNames.has(sub.name);
  }).length;

  /* —— 同步替换：移除文件里没有的旧安排 —— */
  let removed = 0, ghost = 0;
  for (const e of kill) {
    await dbDel('entries', e.id);
    state.entries = state.entries.filter(x => x.id !== e.id);
    removed++;
    // 这门课「今天及以后、还没填内容」的记录一起清掉，
    // 否则删了课表还会留下永远补不完的幽灵待办
    const gone = state.sessions.filter(s => s.entryId === e.id && s.date >= state.today && !hasContent(s));
    for (const s of gone) {
      await dbDel('sessions', s.id);
      await purgeSessionLinks(s.id);
      state.sessions = state.sessions.filter(x => x.id !== s.id);
      ghost++;
    }
  }

  state.entries = await dbAll('entries');
  state.subjects = (await dbAll('subjects')).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  // 课表改了教室/节次：只同步「今天及以后」的记录快照，过去的保持原样
  if (touched.length) await refreshSnaps(touched);
  closeModal();
  await ensureSessionsFor(state.today);
  state.sessions = await dbAll('sessions');
  state.tab = 'schedule';
  await render();
  const bits = [`新增 ${added}`, `更新 ${updated}`, `未变 ${same}`];
  if (removed) bits.push(`移除 ${removed} 条旧安排${ghost ? `（连带 ${ghost} 条待处理记录）` : ''}`);
  else if (orphan) bits.push(`文件里没有的 ${orphan} 条已保留`);
  toast(`导入完成：${bits.join('、')}`);
  importDraft = [];
}

/* ==================== 事件 ==================== */
document.addEventListener('click', async ev => {
  const tabBtn = ev.target.closest('.tab');
  if (tabBtn) {
    state.tab = tabBtn.dataset.tab;
    await render();
    window.scrollTo({ top: 0 });
    return;
  }

  const el = ev.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  const id = el.dataset.id;

  // 弹窗背景关闭
  if (ev.target.id === 'modal') { closeModal(); return; }

  const sess = id ? state.sessions.find(x => x.id === id) : null;

  switch (act) {
    case 'go':
      state.tab = el.dataset.tab;
      await render();
      break;

    case 'toggle': {
      if (state.openIds.has(id)) state.openIds.delete(id);
      else state.openIds.add(id);
      await render();
      break;
    }

    case 'status': {
      if (!sess) break;
      sess.status = el.dataset.status;
      stampUploaded(sess);
      await dbPut('sessions', sess);
      if (sess.status === 'done' && !(sess.transcriptText || '').trim()) {
        toast('已标记为已上传，记得补上转录稿正文');
      }
      await render();
      break;
    }

    case 'clip': {
      if (!sess) break;
      try {
        const text = await navigator.clipboard.readText();
        if (!text.trim()) { toast('剪贴板是空的'); break; }
        sess.transcriptText = (sess.transcriptText ? sess.transcriptText + '\n\n' : '') + text;
        sess.status = 'done';
        stampUploaded(sess);
        await dbPut('sessions', sess);
        await render();
        toast(`已读入 ${text.length} 字`);
      } catch (_) {
        toast('浏览器不允许读剪贴板，请手动粘贴到输入框');
      }
      break;
    }

    case 'delphoto': {
      if (!sess) break;
      sess.photos.splice(Number(el.dataset.idx), 1);
      sess.updatedAt = Date.now();
      await dbPut('sessions', sess);
      await render();
      break;
    }

    case 'delsession': {
      if (!sess) break;
      if (!confirm('删除这节课的记录？转录稿和板书会一起删掉。\n（关联的课程文件不会删，只是不再挂在课上）')) break;
      await dbDel('sessions', sess.id);
      await purgeSessionLinks(sess.id);
      state.sessions = state.sessions.filter(x => x.id !== sess.id);
      state.openIds.delete(sess.id);
      await render();
      toast('已删除');
      break;
    }

    case 'addentry': entryFormModal(null); break;
    case 'addmanual': manualSessionModal(); break;
    case 'closemodal': closeModal(); break;

    case 'editentry': {
      const e = state.entries.find(x => x.id === id);
      if (e) entryFormModal(e);
      break;
    }

    case 'delentry': {
      const e = state.entries.find(x => x.id === id);
      if (!e) break;
      if (!confirm('从课表删除这节课？\n\n已经归档的历史记录会保留（它们存了自己的课堂快照）。\n今天及以后还没填内容的记录会一起清掉。')) break;
      await dbDel('entries', id);
      state.entries = state.entries.filter(x => x.id !== id);
      // 删了课表，这门课「今天及以后、还没填内容」的记录就没意义了，一起清掉
      const gone = state.sessions.filter(s => s.entryId === id && s.date >= state.today && !hasContent(s));
      for (const s of gone) {
        await dbDel('sessions', s.id);
        await purgeSessionLinks(s.id);
        state.sessions = state.sessions.filter(x => x.id !== s.id);
      }
      await render();
      toast(gone.length ? `已从课表移除 · 顺带清掉 ${gone.length} 条待处理记录` : '已从课表移除');
      break;
    }

    case 'createsubject': {
      const name = ($('#f_newsubject')?.value || '').trim();
      if (!name) { toast('请输入学科名称'); break; }
      const sub = {
        id: uid(), name,
        color: PALETTE[state.subjects.length % PALETTE.length],
        createdAt: Date.now()
      };
      await dbPut('subjects', sub);
      state.subjects.push(sub);
      closeModal();
      entryFormModal(null);
      break;
    }

    case 'saveentry': {
      const subjectId = $('#f_subject').value;
      const custom = $('#f_customtime') && $('#f_customtime').checked;
      let entry;
      if (custom) {
        const startTime = $('#f_start').value || '08:00';
        const endTime = $('#f_end').value || '09:40';
        if (endTime <= startTime) { toast('结束时间要晚于开始时间'); break; }
        entry = {
          id: id || uid(),
          subjectId,
          weekday: Number($('#f_weekday').value),
          startTime, endTime,
          timeMode: 'custom',
          sections: '', sectionsKey: '',
          weekMode: $('#f_weekmode').value,
          weekFrom: Number($('#f_from').value) || 1,
          weekTo: Number($('#f_to').value) || 20,
          location: ($('#f_location').value || '').trim(),
          createdAt: Date.now()
        };
      } else {
        const a = Number($('#f_sec_from').value) || 1;
        const b = Math.max(a, Number($('#f_sec_to').value) || a);
        const t = slotsToTime([a, b]);
        entry = {
          id: id || uid(),
          subjectId,
          weekday: Number($('#f_weekday').value),
          startTime: t.startTime, endTime: t.endTime,
          timeMode: 'period',
          sections: sectionLabel(a, b),
          sectionsKey: `${a}-${b}`,
          weekMode: $('#f_weekmode').value,
          weekFrom: Number($('#f_from').value) || 1,
          weekTo: Number($('#f_to').value) || 20,
          location: ($('#f_location').value || '').trim(),
          createdAt: Date.now()
        };
      }
      await dbPut('entries', entry);
      state.entries = state.entries.filter(x => x.id !== entry.id).concat(entry);
      // 改了教室/节次：今天及以后的记录跟着更新，过去的不动
      await refreshSnaps([entry.id]);
      closeModal();
      await ensureSessionsFor(state.today);
      state.sessions = await dbAll('sessions');
      await render();
      toast('已保存');
      break;
    }


    case 'toggleexempt': {
      if (!sess) break;
      sess.exempt = !sess.exempt;
      sess.updatedAt = Date.now();
      await dbPut('sessions', sess);
      await render();
      toast(sess.exempt ? '本次不再提醒' : '已恢复提醒');
      break;
    }

    case 'importxlsx': {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = '.xls,.xlsx,.csv,.txt,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      inp.onchange = async () => {
        const f = inp.files && inp.files[0];
        if (!f) return;
        try {
          toast('正在解析课表…');
          const res = await parseTimetableFile(f);
          if (!res.drafts.length) {
            alert('没认出课程。\n\n如果这是你们学校的模板，可以把文件发我，我按这个版式加一条解析规则。');
            return;
          }
          openImportPreview(res.drafts, f.name, res.notes, res.semesterStart);
        } catch (err) {
          console.error(err);
          alert('解析失败：' + err.message);
        }
      };
      inp.click();
      break;
    }

    case 'savemanual': {
      const subjectId = $('#m_subject').value;
      const start = $('#m_start').value, end = $('#m_end').value;
      const msub = state.subjects.find(x => x.id === subjectId);
      const ns = {
        id: `${state.today}__manual_${uid()}`,
        date: state.today,
        entryId: '',
        subjectId,
        customTime: `${start}–${end}`,
        status: 'pending',
        transcriptText: '',
        photos: [],
        note: ($('#m_note').value || '').trim(),
        snap: {
          subjectId, subjectName: msub ? msub.name : '未命名课程',
          color: msub ? msub.color : '#94a3b8',
          sections: '', startTime: start, endTime: end, location: '', teacher: ''
        },
        createdAt: Date.now(), updatedAt: Date.now()
      };
      await dbPut('sessions', ns);
      state.sessions.push(ns);
      closeModal();
      await render();
      toast('已加入今天的清单');
      break;
    }

    case 'impmode': {
      importMode = el.dataset.v === 'sync' ? 'sync' : 'merge';
      renderImportPreview();
      break;
    }

    case 'impkeep': {
      const i = Number(el.dataset.idx);
      importDraft[i].keep = !importDraft[i].keep;
      const row = el.closest('.imp-row');
      if (row) row.classList.toggle('off', !importDraft[i].keep);
      updateImpSummary();
      break;
    }
    case 'impdel': {
      const i = Number(el.dataset.idx);
      importDraft.splice(i, 1);
      renderImportPreview();
      break;
    }
    case 'impconfirm':
      await confirmImport();
      break;


    case 'libfilter': {      state.libSubject = el.dataset.id;
      await render();
      break;
    }

    case 'exportsubject':
      await exportSubject(el.dataset.id);
      break;

    /* ---- 学科资料库 ---- */
    case 'dlg': {
      const v = el.dataset.v || '';
      const r = dlgCtx; dlgCtx = null;
      closeModal();
      if (r) r(v);
      break;
    }

    case 'filefilter':
      state.fileSubject = el.dataset.id;
      await render();
      break;

    case 'uploadlib': {
      let sid = state.fileSubject;
      if (sid === 'all') sid = await askSubject();
      if (!sid) break;
      pickLocalFiles(files => importFiles(files, { subjectId: sid }));
      break;
    }

    case 'upfiles': {
      const sid = id;
      pickLocalFiles(files => importFiles(files, { sessionId: sid }));
      break;
    }

    case 'pickfiles':
      pickFilesModal(id);
      break;

    case 'pftoggle': {
      if (!pickFileCtx) break;
      const fid = el.dataset.fid;
      if (pickFileCtx.sel.has(fid)) pickFileCtx.sel.delete(fid);
      else pickFileCtx.sel.add(fid);
      renderPickFiles();
      break;
    }

    case 'pfok': {
      if (!pickFileCtx) break;
      const { sessionId, sel } = pickFileCtx;
      const ids = Array.from(sel);
      closeModal();
      let n = 0;
      for (const fid of ids) if (await linkFile(fid, sessionId)) n++;
      await render();
      toast(n ? `已关联 ${n} 个文件到这节课` : '没有变化');
      break;
    }

    case 'picksess':
      pickSessionsModal(el.dataset.fid);
      break;

    case 'pstoggle': {
      if (!pickSessCtx) break;
      if (pickSessCtx.sel.has(id)) pickSessCtx.sel.delete(id);
      else pickSessCtx.sel.add(id);
      renderPickSessions();
      break;
    }

    case 'psok': {
      if (!pickSessCtx) break;
      const { fileId, sel, linked } = pickSessCtx;
      const want = Array.from(sel);
      closeModal();
      let add = 0, del = 0;
      for (const sid of want) {
        if (!linked.has(sid) && await linkFile(fileId, sid)) add++;
      }
      for (const sid of Array.from(linked)) {
        if (!sel.has(sid) && await unlinkFile(fileId, sid)) del++;
      }
      await render();
      toast(add || del ? `已更新关联（+${add} / -${del}）` : '没有变化');
      break;
    }

    case 'unlinkfile': {
      const fid = el.dataset.fid;
      if (await unlinkFile(fid, id)) {
        await render();
        toast('已解除关联，文件还在资料库里');
      }
      break;
    }

    case 'dlfile':
      downloadFile(el.dataset.fid);
      break;

    case 'rekind':
      kindModal(el.dataset.fid);
      break;

    case 'versions':
      versionsModal(el.dataset.fid);
      break;

    case 'setver': {
      await setCurrentVersion(el.dataset.fid);
      closeModal();
      await render();
      toast('已切换当前版本');
      break;
    }

    case 'setkind': {
      const f = fileOf(el.dataset.fid);
      if (!f) break;
      f.kind = el.dataset.v;
      await dbPut('files', f);
      closeModal();
      await render();
      toast(`已改为「${kindOf(f).label}」`);
      break;
    }

    case 'delfile': {
      const f = fileOf(el.dataset.fid);
      if (!f) break;
      const n = (f.links || []).length;
      if (!confirm(`从资料库彻底删除「${f.name}」？${n ? `\n它关联了 ${n} 节课，这些课上的这条资料也会消失。` : ''}\n文件本身如果还需要，先下载一份。`)) break;
      await dbDel('files', f.id);
      await dbDel('blobs', f.id);
      state.files = state.files.filter(x => x.id !== f.id);
      await render();
      toast('已删除');
      break;
    }

    case 'persist': {
      if (!(navigator.storage && navigator.storage.persist)) { toast('这个浏览器不支持申请常驻'); break; }
      const ok = await navigator.storage.persist();
      await refreshStorageInfo();
      const hint = $('#storageHint');
      if (hint) hint.textContent = storageText();
      toast(ok ? '已申请常驻，浏览器不会主动清数据' : '浏览器没批准，建议定期导出备份');
      break;
    }

    case 'exportpick': {
      const sel = $('#expSubject');
      if (!sel || !sel.value) { toast('还没有学科'); break; }
      await exportSubject(sel.value);
      break;
    }

    case 'ics': exportICS(); break;
    case 'backup': await backupAll(); break;

    /* ---- 补录往期 ---- */
    case 'backfill': backfillModal(''); break;
    case 'backfilldate': backfillModal(el.dataset.v); break;
    case 'continuous': await continuousModal(); break;
    case 'contrange': await continuousModal(Number(el.dataset.v)); break;

    case 'ignorebefore': {
      const inp = $('#debtBefore');
      await ignoreBefore(inp ? inp.value : '');
      break;
    }

    case 'fillpick': {
      const ds = el.dataset.date;
      const sid = el.dataset.id || '';
      const eid = el.dataset.entry || '';
      await fillSessionModal(ds, sid, 'backfill', eid);
      break;
    }

    case 'contfill': {
      await fillSessionModal(el.dataset.date, el.dataset.id, 'continuous');
      break;
    }

    case 'bfstatus': {
      const s = fillCurrent();
      if (!s) break;
      s._bfStatus = el.dataset.v;
      // 只换按钮高亮，不重渲染，避免把已经粘进去的正文弄丢
      document.querySelectorAll('[data-act="bfstatus"]').forEach(b => {
        b.classList.toggle('on', b.dataset.v === el.dataset.v);
      });
      break;
    }

    case 'bfcancel': {
      const s = fillCurrent();
      const back = fillCtx && fillCtx.returnTo;
      // 还没落库的那条（手动新建 / 按课表新建）如果什么都没填，直接丢掉
      if (s && (fillCtx.isNewManual || fillCtx.isNewEntry) && !hasContent(s)) {
        state.sessions = state.sessions.filter(x => x.id !== s.id);
      }
      closeModal();
      if (back === 'continuous') continuousModal();
      else backfillModal(fillCtx ? fillCtx.date : '');
      break;
    }

    case 'bfsave': await saveFill(); break;

    case 'bf_delphoto': {
      const s = fillCurrent();
      if (!s) break;
      s.photos = s.photos || [];
      s.photos.splice(Number(el.dataset.idx), 1);
      await dbPut('sessions', s);
      // 局部重绘照片区
      const grid = $('#bf_photos');
      if (grid) {
        grid.innerHTML = s.photos.map((p, i) => `
          <div class="ph"><img src="${p}" alt="板书 ${i + 1}">
            <button class="x" data-act="bf_delphoto" data-idx="${i}">×</button></div>`).join('') +
          '<label class="ph add">＋<input type="file" accept="image/*" multiple data-act="bf_photos" hidden></label>';
      }
      break;
    }

    case 'contsel': {
      if (el.checked) state.contSel.add(el.dataset.id);
      else state.contSel.delete(el.dataset.id);
      // 只更新底部按钮文案
      const n = document.querySelectorAll('[data-act="contsel"]:checked').length;
      const btn = document.querySelector('[data-act="contmark"]');
      if (btn) { btn.textContent = `标记选中的 ${n} 节无转录稿`; btn.disabled = !n; }
      break;
    }

    case 'contmark': {
      const ids = Array.from(state.contSel);
      if (!ids.length) break;
      if (!confirm(`把这 ${ids.length} 节课标记为「无转录稿」？`)) break;
      let n = 0;
      for (const id of ids) {
        const s = state.sessions.find(x => x.id === id);
        if (!s) continue;
        s.status = 'none';
        stampUploaded(s);
        await dbPut('sessions', s);
        n++;
      }
      state.contSel.clear();
      await continuousModal();
      toast(`已标记 ${n} 节为无转录稿`);
      break;
    }

    /* ---- 历史筛选 ---- */
    case 'histstatus': state.histStatus = el.dataset.v; await render(); break;
    case 'histphoto': state.histPhoto = el.dataset.v; await render(); break;
    case 'histclear': state.histFrom = ''; state.histTo = ''; await render(); break;

    case 'unexemptall': {
      const list = histFiltered().filter(s => s.exempt);
      if (!list.length) break;
      if (!confirm(`把筛出来的 ${list.length} 节免记的课恢复成待处理？\n恢复后会重新出现在待办和历史欠账里。`)) break;
      for (const s of list) {
        s.exempt = false;
        s.updatedAt = Date.now();
        await dbPut('sessions', s);
      }
      await render();
      toast(`已恢复 ${list.length} 节`);
      break;
    }

    case 'editperiod': periodsModal(); break;

    case 'addperiod': {
      const P = readPeriodRows();
      const last = P[P.length - 1] || { start: '08:00', end: '08:45' };
      const start = addMinutes(last.end, 10);
      P.push({ start, end: addMinutes(start, 45) });
      $('#periodList').innerHTML = periodRowsHtml(P);
      const rows = document.querySelectorAll('#periodList .period-row');
      if (rows.length) rows[rows.length - 1].scrollIntoView({ block: 'nearest' });
      break;
    }

    case 'delperiod': {
      const P = readPeriodRows();
      if (P.length <= 1) { toast('至少留一节'); break; }
      P.splice(Number(el.dataset.i), 1);
      $('#periodList').innerHTML = periodRowsHtml(P);
      break;
    }

    case 'resetperiod':
      $('#periodList').innerHTML = periodRowsHtml(DEFAULT_PERIODS.map(x => ({ ...x })));
      toast('已恢复默认，点保存才生效');
      break;

    case 'saveperiod': {
      const P = readPeriodRows();
      if (!P.length) { toast('至少留一节'); break; }
      const bad = P.findIndex(p => p.end <= p.start);
      if (bad >= 0) { toast(`第${bad + 1}节：下课时间要晚于上课时间`); break; }
      let disorder = 0;
      for (let i = 1; i < P.length; i++) if (P[i].start < P[i - 1].start) disorder++;
      state.settings.periods = P;
      await saveSettings();
      const n = await recalcEntryTimes();
      closeModal();
      await render();
      if (disorder) toast(`已保存，但有 ${disorder} 处时间不是递增的`);
      else toast(n ? `已保存，重算了 ${n} 门课的时间` : '已保存');
      break;
    }

    case 'togglesc': {
      state.settings.scEnabled = !state.settings.scEnabled;
      await saveSettings();
      await render();
      if (state.settings.scEnabled) {
        const inp = $('#setScKey');
        if (inp) { inp.focus(); }
        if (!state.settings.scKey) toast('把 SendKey 粘贴进来才能收到微信');
      }
      break;
    }

    case 'togglehook': {
      state.settings.hookEnabled = !state.settings.hookEnabled;
      await saveSettings();
      await render();
      if (state.settings.hookEnabled) {
        const inp = $('#setHookUrl');
        if (inp) inp.focus();
      }
      break;
    }

    case 'testsc': {
      const key = (state.settings.scKey || '').trim();
      if (!key) { toast('先填 SendKey'); break; }
      toast('正在发送测试消息…');
      try {
        await pushServerChan(key, TEST_PAYLOAD);
        toast('已发送，去微信看看有没有收到');
      } catch (err) {
        toast('发送失败 · ' + err.message);
      }
      break;
    }

    case 'testhook': {
      const url = (state.settings.hookUrl || '').trim();
      if (!url) { toast('先填 Webhook 地址'); break; }
      toast('正在发送测试消息…');
      try {
        await pushWebhook(url, Object.assign({}, TEST_PAYLOAD, { date: state.today }));
        toast('已发送，检查接收端');
      } catch (err) {
        toast('发送失败 · ' + err.message);
      }
      break;
    }

    case 'pushnow': await pushNow(); break;

    case 'enablenotif': {
      if (state.settings.notifEnabled) {
        state.settings.notifEnabled = false;
        await saveSettings();
        await render();
        break;
      }
      if (!('Notification' in window)) { toast('这个浏览器不支持系统通知'); break; }
      const perm = await Notification.requestPermission();
      if (perm === 'granted') {
        state.settings.notifEnabled = true;
        await saveSettings();
        await render();
        toast('已开启');
      } else {
        toast('没有拿到通知权限，可以用日历兜底');
      }
      break;
    }

    case 'wipe': {
      if (!confirm('清空全部数据？课表、转录稿、板书、课程文件都会删除，且无法恢复。')) break;
      if (!confirm('再确认一次：真的清空？')) break;
      await dbClear('sessions'); await dbClear('entries'); await dbClear('subjects');
      await dbClear('files'); await dbClear('blobs');
      state.sessions = []; state.entries = []; state.subjects = []; state.files = [];
      state.openIds.clear();
      await render();
      toast('已清空');
      break;
    }
  }
});

document.addEventListener('input', ev => {
  const t = ev.target;
  const act = t.dataset.act;

  if (act === 'impname') {
    const i = Number(t.dataset.idx);
    if (importDraft[i]) importDraft[i].name = t.value;
    return;
  }
  if (act === 'libsearch') {
    state.libQuery = t.value;
    clearTimeout(window.__libTimer);
    window.__libTimer = setTimeout(() => renderHistory(), 220);
    return;
  }
  if (act !== 'text' && act !== 'note') return;
  const s = state.sessions.find(x => x.id === t.dataset.id);
  if (!s) return;
  if (act === 'text') {
    s.transcriptText = t.value;
    const hasText = t.value.trim().length > 0;
    // 有正文就算已归档，清空则退回待处理（不动「无转录稿 / 取消」这两个手动状态）
    if (hasText && s.status === 'pending') { s.status = 'done'; syncStatusUI(s); }
    else if (!hasText && s.status === 'done') { s.status = 'pending'; syncStatusUI(s); }
  }
  if (act === 'note') s.note = t.value;
  if (act === 'text') stampUploaded(s); else s.updatedAt = Date.now();
  saveSoon(s);
});

/** 只改状态时不动整个列表，避免输入框失焦 */
function syncStatusUI(s) {
  const card = document.querySelector(`.card[data-card="${s.id}"]`);
  if (!card) return;
  const st = STATUS_MAP[s.status] || STATUS_MAP.pending;
  const chip = card.querySelector('.chip');
  if (chip) { chip.className = 'chip ' + st.cls; chip.textContent = st.label; }
  card.querySelectorAll('[data-act="status"]').forEach(b => {
    const on = b.dataset.status === s.status;
    b.classList.toggle('on', on);
    b.classList.remove('st-pending', 'st-done', 'st-none', 'st-cancel');
    if (on) b.classList.add(st.cls);
  });
}

document.addEventListener('change', async ev => {
  const t = ev.target;
  const act = t.dataset.act;
  if (!act) return;
  const s = state.sessions.find(x => x.id === t.dataset.id);

  if (act === 'file' && s) {
    const f = t.files && t.files[0];
    if (!f) return;
    if (f.size > 2 * 1024 * 1024) { toast('文件超过 2MB，建议只保留文字部分'); }
    try {
      const text = await f.text();
      s.transcriptText = (s.transcriptText ? s.transcriptText + '\n\n' : '') + text;
      s.status = 'done';
      s.transcriptFileName = f.name;
      stampUploaded(s);
      await dbPut('sessions', s);
      await render();
      toast(`已导入 ${f.name}`);
    } catch (_) {
      toast('这个格式读不了，请在豆包里复制文字粘贴');
    }
    return;
  }

  if (act === 'photos' && s) {
    const files = Array.from(t.files || []);
    if (!files.length) return;
    toast(`正在处理 ${files.length} 张照片…`);
    let ok = 0;
    for (const f of files) {
      try {
        const durl = await compressImage(f);
        s.photos = s.photos || [];
        s.photos.push(durl);
        ok++;
      } catch (_) {
        toast(`${f.name} 解码失败（可能是 HEIC 格式）`);
      }
    }
    stampUploaded(s);
    await dbPut('sessions', s);
    await render();
    if (ok) toast(`已添加 ${ok} 张板书`);
    return;
  }

  if (act === 'restore') {
    const f = t.files && t.files[0];
    if (f) await restoreAll(f);
    return;
  }

  /* ---- 补录弹窗里的文件 ---- */
  if (act === 'bf_file') {
    const f = t.files && t.files[0];
    if (!f) return;
    try {
      const text = await f.text();
      const ta = $('#bf_text');
      if (ta) ta.value = (ta.value ? ta.value + '\n\n' : '') + text;
      const s2 = fillCurrent();
      if (s2) s2._bfStatus = 'done';
      document.querySelectorAll('[data-act="bfstatus"]').forEach(b => b.classList.toggle('on', b.dataset.v === 'done'));
      toast(`已读入 ${f.name}`);
    } catch (_) {
      toast('这个格式读不了，请在豆包里复制文字粘贴');
    }
    return;
  }

  if (act === 'bf_photos') {
    const files = Array.from(t.files || []);
    const s2 = fillCurrent();
    if (!files.length || !s2) return;
    toast(`正在处理 ${files.length} 张照片…`);
    s2.photos = s2.photos || [];
    let ok = 0;
    for (const f of files) {
      try { s2.photos.push(await compressImage(f)); ok++; }
      catch (_) { toast(`${f.name} 解码失败（可能是 HEIC 格式）`); }
    }
    await dbPut('sessions', s2);
    const grid = $('#bf_photos');
    if (grid) {
      grid.innerHTML = s2.photos.map((p, i) => `
        <div class="ph"><img src="${p}" alt="板书 ${i + 1}">
          <button class="x" data-act="bf_delphoto" data-idx="${i}">×</button></div>`).join('') +
        '<label class="ph add">＋<input type="file" accept="image/*" multiple data-act="bf_photos" hidden></label>';
    }
    if (ok) toast(`已添加 ${ok} 张板书`);
    return;
  }
});

// 设置页的输入框（不通过 data-act 委托，单独绑定）
document.addEventListener('change', async ev => {
  const t = ev.target;

  if (t.id === 'bfDate') {
    backfillModal(t.value);
    return;
  }
  if (t.id === 'histFrom' || t.id === 'histTo') {
    if (t.id === 'histFrom') state.histFrom = t.value;
    else state.histTo = t.value;
    await render();
    return;
  }
  if (t.id === 'debtBefore') {
    // 只改提示文案，不重新渲染弹窗，避免把刚选的日期冲掉
    const hint = $('#debtHint');
    if (hint) hint.innerHTML = debtHintText(t.value);
    if (t.value) { state.settings.ignoreBefore = t.value; await saveSettings(); }
    return;
  }
  if (t.id === 'setSemester' && t.value) {
    state.settings.semesterStart = t.value;
    await saveSettings();
    toast('学期开始日期已更新');
  }
  if (t.id === 'setRemind' && t.value) {
    state.settings.reminderTime = t.value;
    await saveSettings();
    toast(`每晚 ${t.value} 检查遗漏`);
  }
  if (t.id === 'setScKey') {
    state.settings.scKey = t.value.trim();
    await saveSettings();
    refreshReminderStatus();
    if (state.settings.scKey) toast('SendKey 已保存');
  }
  if (t.id === 'setHookUrl') {
    state.settings.hookUrl = t.value.trim();
    await saveSettings();
    refreshReminderStatus();
    if (state.settings.hookUrl) toast('Webhook 地址已保存');
  }

  // 加课弹窗：节次 → 时间联动
  if (t.id === 'f_sec_from' || t.id === 'f_sec_to') {
    const from = $('#f_sec_from'), to = $('#f_sec_to');
    if (from && to) {
      if (Number(to.value) < Number(from.value)) to.value = from.value;
      const t2 = slotsToTime([Number(from.value), Number(to.value)]);
      const hint = $('#f_sechint');
      if (hint) hint.textContent = `${t2.startTime}–${t2.endTime}`;
      // 没勾自定义时，把算出来的时间同步进输入框，方便直接保存
      const ck = $('#f_customtime');
      if (ck && !ck.checked) {
        if ($('#f_start')) $('#f_start').value = t2.startTime;
        if ($('#f_end')) $('#f_end').value = t2.endTime;
      }
    }
  }
  if (t.id === 'f_customtime') {
    const on = t.checked;
    const from = $('#f_sec_from'), to = $('#f_sec_to');
    const st = $('#f_start'), en = $('#f_end');
    if (from) from.disabled = on;
    if (to) to.disabled = on;
    if (st) st.disabled = !on;
    if (en) en.disabled = !on;
    const hint = $('#f_sechint');
    if (from && to) {
      const t2 = slotsToTime([Number(from.value), Number(to.value)]);
      if (hint) hint.textContent = on ? '用右边的自定义时间' : `${t2.startTime}–${t2.endTime}`;
      if (!on) {
        if (st) st.value = t2.startTime;
        if (en) en.value = t2.endTime;
      }
    }
  }
});

// 离开页面前落盘
window.addEventListener('beforeunload', () => {
  for (const s of state.sessions) {
    if (saveTimers.has(s.id)) { clearTimeout(saveTimers.get(s.id)); dbPut('sessions', s); }
  }
});

/* ==================== 启动 ==================== */
let __lastReminderCheck = 0;
function tickReminder() {
  // 10 分钟最多重试一次，避免失败时每分钟刷 toast
  if (Date.now() - __lastReminderCheck < 10 * 60 * 1000) return;
  __lastReminderCheck = Date.now();
  checkReminder();
}

(async function boot() {
  try {
    await loadAll();
    await render();
    setTimeout(() => { __lastReminderCheck = Date.now(); checkReminder(); }, 600);
    // 跨过零点后自动刷新"今日"；顺便补推当天漏掉的提醒
    setInterval(async () => {
      const now = dateStr();
      if (now !== state.today) {
        state.today = now;
        if (state.tab === 'today') await render();
      }
      tickReminder();
    }, 60000);
    // 手机切回前台时补一次
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) tickReminder();
    });
  } catch (err) {
    console.error(err);
    view.innerHTML = `<div class="empty"><div class="big">!</div><p>启动失败：${esc(err.message)}<br>请用 Chrome / Edge / Safari 打开。</p></div>`;
  }
})();
