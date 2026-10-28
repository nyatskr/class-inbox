/* 本地静态服务器：npm start
 *
 * 只是把 class-inbox 目录当静态站点发出去。生产环境不需要它——
 * 这是纯前端项目，丢到任何静态托管（GitHub Pages / 对象存储）都能跑。
 *
 * 端口默认 8899，可用 PORT 环境变量改：PORT=8080 npm start
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 8899;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

http.createServer((req, res) => {
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
}).listen(PORT, '127.0.0.1', () => {
  console.log(`课堂资料收件箱：http://127.0.0.1:${PORT}/`);
  console.log('注意：数据按「协议+域名+端口」隔离，换端口等于换一个空库。');
});
