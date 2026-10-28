/* 测试共用：起一个临时静态服务器，让 E2E 不用手动开端口。
 *
 * 每个测试文件自己起一个（端口 0，由系统分配），所以可以并行，
 * 也不会和你在 8899 上开着的预览服务撞车。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');            // class-inbox/
const FIXTURES = path.join(ROOT, 'fixtures');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
};

function startServer(port = 0) {
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(String(req.url || '/').split('?')[0]);
    if (!rel || rel === '/') rel = '/index.html';
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store'
      });
      res.end(buf);
    });
  });
  return new Promise(resolve => {
    server.listen(port, '127.0.0.1', () => {
      const p = server.address().port;
      resolve({
        url: `http://127.0.0.1:${p}`,
        close: () => new Promise(r => server.close(r))
      });
    });
  });
}

/** fixtures/ 里的文件，按名字取绝对路径 */
function fixture(name) {
  return path.join(FIXTURES, name);
}

/** 测试结果收集 + 汇总退出码 */
function makeReporter() {
  const results = [];
  const ok = (label, cond, extra = '') => {
    results.push({ label, pass: !!cond, extra });
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  };
  const summary = () => {
    const failed = results.filter(r => !r.pass);
    console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
    if (failed.length) {
      console.log('FAILED:');
      failed.forEach(f => console.log('  - ' + f.label + (f.extra ? ' :: ' + f.extra : '')));
      process.exitCode = 1;
    }
    return failed.length;
  };
  return { ok, summary, results };
}

module.exports = { startServer, fixture, makeReporter, ROOT, FIXTURES };
