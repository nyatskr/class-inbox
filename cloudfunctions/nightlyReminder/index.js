/* cloudfunctions/nightlyReminder —— 每晚检查并推送
 *
 * 触发：定时触发器，每天 20:30（见同目录 config.json）。
 * 也可以在设置页手动调（force 参数忽略「已经推过」）。
 *
 * 三条规则（和网页版一致，别改）：
 *   1. 只查「今天」。历史欠账绝不进这条通知。
 *   2. 通知里只有课程名 / 节次 / 地点，不含任何转录正文或板书。
 *   3. 同一用户 + 同一天 + 同一渠道只发一次。定时触发器可能重复触发，
 *      靠 reminder_logs 的固定 _id 做唯一约束。
 *
 * SendKey 只从这里读环境变量，绝不下发到客户端。
 */

const cloud = require('wx-server-sdk');
const https = require('https');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const SENDKEY = process.env.SENDKEY || '';
const CHANNEL = 'sc';

/** 云函数默认 UTC+8，但别赌，显式算一次上海时间 */
function todayCN() {
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${now.getUTCFullYear()}-${p(now.getUTCMonth() + 1)}-${p(now.getUTCDate())}`;
}

function postForm(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = new URLSearchParams(body).toString();
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 10000
    }, res => {
      let raw = '';
      res.on('data', c => (raw += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(raw) }); }
        catch (_) { reject(new Error(`返回无法解析（HTTP ${res.statusCode}）`)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/** 拉某用户某天的待处理课程（分页，云开发单次上限 20） */
async function pendingOf(openid, date) {
  const out = [];
  const PAGE = 20;
  for (let skip = 0; ; skip += PAGE) {
    const r = await db.collection('class_sessions')
      .where({ _openid: openid, date, status: 'pending', exempt: _.neq(true) })
      .skip(skip).limit(PAGE).get();
    out.push(...r.data);
    if (r.data.length < PAGE) break;
  }
  return out;
}

function buildPayload(date, list) {
  const courses = list.map(s => ({
    name: (s.snap && s.snap.subjectName) || s.customName || '未命名课程',
    time: (s.snap && (s.snap.sections || `${s.snap.startTime}-${s.snap.endTime}`)) || s.customTime || '',
    location: (s.snap && s.snap.location) || ''
  }));
  const title = `还有 ${courses.length} 节课没归档`.slice(0, 32);
  const desp = [
    `**${date}** 还有 ${courses.length} 节课没上传转录稿：`,
    '',
    ...courses.map(c => `- ${c.name}　${c.time}${c.location ? '　' + c.location : ''}`),
    '',
    '补齐后今晚不会再提醒。本条只含课程名/节次/地点，不含任何转录正文或板书。'
  ].join('\n');
  return { title, desp };
}

exports.main = async (event = {}) => {
  const date = todayCN();
  const force = !!event.force;

  if (!SENDKEY) {
    return { ok: false, error: '没有配置 SENDKEY 环境变量', date };
  }

  // 找出开启了提醒的用户
  const settings = await db.collection('user_settings')
    .where({ notifEnabled: true, scEnabled: true })
    .get();

  const report = [];

  for (const st of settings.data) {
    const openid = st._openid;
    const logId = `${openid}__${date}__${CHANNEL}`;

    try {
      if (!force) {
        const seen = await db.collection('reminder_logs').doc(logId).get().catch(() => null);
        if (seen && seen.data) { report.push({ openid, skipped: 'already-sent' }); continue; }
      }

      const list = await pendingOf(openid, date);
      if (!list.length) { report.push({ openid, skipped: 'nothing-pending' }); continue; }

      const { title, desp } = buildPayload(date, list);
      const res = await postForm(`https://sctapi.ftqq.com/${encodeURIComponent(SENDKEY)}.send`, { title, desp });

      if (!res.json || Number(res.json.code) !== 0) {
        report.push({ openid, error: (res.json && res.json.message) || `code=${res.json && res.json.code}` });
        continue;
      }

      // 先写日志再返回：宁可少发一条，不要重复轰炸
      await db.collection('reminder_logs').doc(logId).set({
        data: { _openid: openid, date, channel: CHANNEL, count: list.length, sentAt: Date.now() }
      });

      report.push({ openid, sent: list.length });
    } catch (err) {
      report.push({ openid, error: String(err.message || err) });
    }
  }

  return { ok: true, date, users: settings.data.length, report };
};
