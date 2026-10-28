/* cloudfunctions/sendTestReminder —— 手动试推一条
 *
 * 用途：配好 SendKey 以后，先在设置页点一下，确认微信真能收到。
 * 和 nightlyReminder 的区别：**不写 reminder_logs**，不占当天「已推送」的名额，
 * 所以试推完当晚该推还是会推。
 */

const cloud = require('wx-server-sdk');
const https = require('https');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const SENDKEY = process.env.SENDKEY || '';

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

exports.main = async () => {
  if (!SENDKEY) {
    return { ok: false, error: '还没有配置 SENDKEY 环境变量。到云开发控制台 → 云函数 → sendTestReminder → 配置 → 环境变量里加一条 SENDKEY。' };
  }

  const title = '测试：课堂资料提醒已接通';
  const desp = [
    '如果你看到这条，说明「云函数 → Server酱 → 微信」这条路是通的。',
    '',
    '正式提醒长这样：',
    '',
    '- 还有 2 节课没归档',
    '- 计算机网络　第3-4节　二区601',
    '- 专业英语　第9-10节　三区303',
    '',
    '只含课程名 / 节次 / 地点，不含任何转录正文或板书。'
  ].join('\n');

  const res = await postForm(`https://sctapi.ftqq.com/${encodeURIComponent(SENDKEY)}.send`, { title, desp });

  if (!res.json || Number(res.json.code) !== 0) {
    const msg = String((res.json && res.json.message) || '').replace(/^\[[^\]]*\]\s*/, '').trim();
    return { ok: false, error: msg || `Server酱返回 code=${res.json && res.json.code}` };
  }

  return { ok: true, message: '已发送，去微信里看看（Server酱 免费版每天 5 条）。' };
};
