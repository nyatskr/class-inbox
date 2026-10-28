/* cloudfunctions/exportSubject —— 按学科打包导出
 *
 * 目录结构必须和网页版一致，否则同一门课在两边导出会得到两个形状：
 *
 *   学科/
 *     汇总.csv
 *     资料目录.html
 *     课堂记录/<日期>/转录稿.md | 板书-01.jpg | 备注.txt | 相关课程资料.md
 *     课程资料/PPT/第3章 树.pptx
 *     课程资料/PPT/历史版本/v1-第3章 树.pptx
 *
 * 关键：同一份 PPT 在包里只出现一次。课堂记录里只写一条指向它的相对链接，
 * 不复制字节。一门课几十节共用一份 20MB 的 PPT，包只多 20MB，不是 20MB×课次。
 *
 * 打包在云端做，因为要把所有文件读进内存；做完传回云存储，返回临时链接。
 */

const cloud = require('wx-server-sdk');
const AdmZip = require('adm-zip');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const KIND_DIR = {
  ppt: 'PPT', doc: 'Word', pdf: 'PDF',
  experiment: '实验报告', homework: '作业', other: '其他'
};

const STATUS_LABEL = {
  pending: '待处理', done: '已上传转录稿', none: '无转录稿', cancelled: '课程取消'
};

function safeName(s) {
  return String(s || '未命名').replace(/[\\/:*?"<>|\r\n]/g, '_').trim().slice(0, 40) || '未命名';
}

function pad2(n) { return String(n).padStart(2, '0'); }

function fmtSize(n) {
  n = Number(n) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

/** 分页取某用户某个集合里符合条件的文档 */
async function fetchAll(colName, where) {
  const out = [];
  const PAGE = 20;
  for (let skip = 0; ; skip += PAGE) {
    const r = await db.collection(colName).where(where).skip(skip).limit(PAGE).get();
    out.push(...r.data);
    if (r.data.length < PAGE) break;
  }
  return out;
}

/** 同一学科里重名文件加后缀，避免解压时互相覆盖 */
function uniquePath(base, used) {
  if (!used.has(base)) { used.add(base); return base; }
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  let i = 2;
  for (;;) {
    const p = `${stem} (${i})${ext}`;
    if (!used.has(p)) { used.add(p); return p; }
    i++;
  }
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const subjectId = event.subjectId;
  if (!subjectId) return { ok: false, error: '缺少 subjectId' };

  const subject = await db.collection('subjects').doc(subjectId).get()
    .then(r => r.data).catch(() => null);
  if (!subject) return { ok: false, error: '找不到这个学科' };

  const root = safeName(subject.name);
  const sessions = (await fetchAll('class_sessions', { _openid: OPENID, subjectId }))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const files = await fetchAll('course_files', { _openid: OPENID, subjectId });

  if (!sessions.length && !files.length) return { ok: false, error: '这个学科还没有内容' };

  const zip = new AdmZip();
  const used = new Set();

  /* ---------- 先算每个文件在包里的路径（课堂记录那轮要引用它） ---------- */
  const pathOf = new Map();
  const byRoot = new Map();
  for (const f of files) {
    const rid = f.rootId || f._id;
    if (!byRoot.has(rid)) byRoot.set(rid, []);
    byRoot.get(rid).push(f);
  }

  for (const f of files) {
    const dir = KIND_DIR[f.kind] || KIND_DIR.other;
    const isOld = !!f.supersededBy;
    const prefix = isOld ? `v${f.version || 1}-` : '';
    const base = `课程资料/${dir}/${isOld ? '历史版本/' : ''}${prefix}${safeName(f.name)}`;
    pathOf.set(f._id, uniquePath(base, used));
  }

  /* ---------- 课堂记录 ---------- */
  const csv = ['日期,星期,节次,时间,教室,状态,转录字数,板书张数,资料数,备注'];
  const WD = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

  for (const s of sessions) {
    const dir = `课堂记录/${s.date}`;
    const sn = s.snap || {};
    const linked = files.filter(f => (f.links || []).some(l => l.sid === (s._id || s.id)));

    csv.push([
      s.date,
      WD[(new Date(s.date + 'T00:00:00').getDay() + 6) % 7],
      sn.sections || '',
      sn.startTime ? `${sn.startTime}-${sn.endTime}` : (s.customTime || ''),
      sn.location || '',
      STATUS_LABEL[s.status] || '待处理',
      (s.transcriptText || '').length,
      (s.photos || []).length,
      linked.length,
      (s.note || '').replace(/[",\n]/g, ' ')
    ].join(','));

    if ((s.transcriptText || '').trim()) {
      zip.addFile(`${dir}/转录稿.md`, Buffer.from(`# ${subject.name} · ${s.date}\n\n${s.transcriptText}\n`, 'utf8'));
    } else if (s.status === 'none') {
      zip.addFile(`${dir}/无转录稿.txt`, Buffer.from('本节课没有转录稿。', 'utf8'));
    } else if (s.status === 'cancelled') {
      zip.addFile(`${dir}/课程取消.txt`, Buffer.from('本节课取消。', 'utf8'));
    }

    if ((s.note || '').trim()) {
      zip.addFile(`${dir}/备注.txt`, Buffer.from(s.note, 'utf8'));
    }

    // 相关课程资料：只写相对链接，不复制字节
    if (linked.length) {
      const lines = linked.map(f => {
        const p = pathOf.get(f._id);
        return `- [${f.name}](../../${p})`;
      });
      zip.addFile(`${dir}/相关课程资料.md`,
        Buffer.from(`# ${s.date} 相关课程资料\n\n${lines.join('\n')}\n`, 'utf8'));
    }

    // 板书照片：fileID 在云存储里，先下再塞进包
    const photos = s.photos || [];
    for (let i = 0; i < photos.length; i++) {
      try {
        const r = await cloud.downloadFile({ fileID: photos[i] });
        zip.addFile(`${dir}/板书-${pad2(i + 1)}.jpg`, r.fileContent);
      } catch (err) {
        console.error('[exportSubject] 板书下载失败', photos[i], err);
      }
    }
  }

  /* ---------- 课程资料（每个文件的字节只出现这一次） ---------- */
  for (const f of files) {
    const p = pathOf.get(f._id);
    if (!f.fileID) continue;
    try {
      const r = await cloud.downloadFile({ fileID: f.fileID });
      zip.addFile(p, r.fileContent);
    } catch (err) {
      console.error('[exportSubject] 文件下载失败', f._id, err);
    }
  }

  /* ---------- 资料目录 ---------- */
  zip.addFile('汇总.csv', Buffer.from('\ufeff' + csv.join('\r\n'), 'utf8'));
  zip.addFile('资料目录.html', Buffer.from(renderCatalog(subject, sessions, files, pathOf), 'utf8'));

  /* ---------- 传回云存储，给个临时链接 ---------- */
  const buf = zip.toBuffer();
  const cloudPath = `exports/${OPENID}/${root}-课堂资料-${Date.now()}.zip`;
  const up = await cloud.uploadFile({ cloudPath, fileContent: buf });
  const urlRes = await cloud.getTempFileURL({ fileList: [up.fileID] });

  return {
    ok: true,
    fileID: up.fileID,
    url: (urlRes.fileList[0] && urlRes.fileList[0].tempFileURL) || '',
    sessions: sessions.length,
    files: files.length,
    bytes: buf.length,
    sizeText: fmtSize(buf.length)
  };
};

/** 资料目录：按类型分组的文件表 + 按日期的课堂记录表 */
function renderCatalog(subject, sessions, files, pathOf) {
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const groups = {};
  for (const f of files) {
    const d = KIND_DIR[f.kind] || KIND_DIR.other;
    (groups[d] = groups[d] || []).push(f);
  }

  const fileRows = Object.keys(groups).map(dir => {
    const rows = groups[dir].map(f => {
      const links = (f.links || []).map(l => l.sid).join('　');
      return `<tr><td><a href="${esc(pathOf.get(f._id))}">${esc(f.name)}</a>${(f.version || 1) > 1 ? ` <em>v${f.version}</em>` : ''}${f.supersededBy ? ' <em class="old">历史版本</em>' : ''}</td>
        <td class="n">${fmtSize(f.size)}</td><td>${links || '<span class="warn">未关联课堂</span>'}</td></tr>`;
    }).join('');
    return `<h2>${esc(dir)}</h2><table><tr><th>文件</th><th>大小</th><th>关联课堂</th></tr>${rows}</table>`;
  }).join('');

  const sessRows = sessions.map(s => {
    const sn = s.snap || {};
    return `<tr><td><a href="课堂记录/${esc(s.date)}/">${esc(s.date)}</a></td>
      <td>${esc(sn.sections || '')}</td><td>${esc(sn.location || '')}</td>
      <td>${esc(STATUS_LABEL[s.status] || '待处理')}</td>
      <td class="n">${(s.transcriptText || '').length}</td>
      <td class="n">${(s.photos || []).length}</td></tr>`;
  }).join('');

  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>${esc(subject.name)} · 资料目录</title>
<style>
body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;max-width:860px;margin:40px auto;padding:0 20px;color:#1f2937;line-height:1.7}
h1{font-size:22px;margin-bottom:4px}h2{font-size:15px;margin:26px 0 8px;color:#374151}
.sub{color:#8a8f98;font-size:13px;margin:0 0 20px}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{border-bottom:1px solid #eef0f2;padding:7px 6px;text-align:left}
th{color:#8a8f98;font-weight:500;font-size:12px}
td.n{text-align:right;color:#6b7280;white-space:nowrap}
a{color:#3b5bfd;text-decoration:none}a:hover{text-decoration:underline}
em{font-style:normal;font-size:11px;color:#8a8f98;border:1px solid #e5e7eb;border-radius:3px;padding:0 4px;margin-left:4px}
em.old{color:#b45309;border-color:#fed7aa}
.warn{color:#b45309}
.note{font-size:12px;color:#8a8f98;margin-top:26px;border-top:1px solid #eef0f2;padding-top:14px}
</style>
<h1>${esc(subject.name)}</h1>
<p class="sub">资料目录 · 共 ${sessions.length} 节课 / ${files.length} 个课程文件</p>
<h2>课程文件</h2>
${fileRows || '<p class="sub">还没有课程文件。</p>'}
<h2>课堂记录</h2>
<table><tr><th>日期</th><th>节次</th><th>教室</th><th>状态</th><th>转录字数</th><th>板书</th></tr>${sessRows}</table>
<p class="note">「课程资料」里的文件是唯一的：一节课关联了它，只在「课堂记录/日期/相关课程资料.md」里写一条指向它的链接，不会复制第二份。</p>
</html>`;
}
