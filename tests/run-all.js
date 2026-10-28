/* 顺序跑完 tests/ 下所有 E2E，汇总结果。
 *
 * 用法：npm test
 *      node tests/run-all.js            全部
 *      node tests/run-all.js 03         只跑文件名含 "03" 的
 *
 * 每个测试自己起临时端口（见 helpers.js），所以不用先开本地服务。
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const filter = process.argv[2] || '';

const files = fs.readdirSync(DIR)
  .filter(f => /^\d+.*\.js$/.test(f))
  .filter(f => !filter || f.includes(filter))
  .sort();

if (!files.length) {
  console.error('没有匹配的测试文件');
  process.exit(1);
}

const summary = [];
let failed = 0;

for (const f of files) {
  console.log(`\n${'='.repeat(56)}\n▶ ${f}\n${'='.repeat(56)}`);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(DIR, f)], { stdio: 'inherit', cwd: DIR });
  const ms = Date.now() - t0;
  const bad = r.status !== 0;
  if (bad) failed++;
  summary.push({ file: f, ok: !bad, ms });
}

console.log(`\n${'='.repeat(56)}\n汇总\n${'='.repeat(56)}`);
for (const s of summary) {
  console.log(`${s.ok ? '✓' : '✗'} ${s.file.padEnd(20)} ${(s.ms / 1000).toFixed(1)}s`);
}
console.log(`\n${summary.length - failed}/${summary.length} 个测试文件通过`);
process.exit(failed ? 1 : 0);
