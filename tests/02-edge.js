/* v0.8 边界情况：无课堂上下文的上传 / 改类型 / 另存一份 / 旧版 JSON 备份 / 课表导入回归 */
const { chromium } = require('playwright');
const fs = require('fs');
const { startServer, fixture } = require('./helpers');

const results = [];
const ok = (label, cond, extra = '') => {
  results.push({ label, pass: !!cond, extra });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
};

(async () => {
  const srv = await startServer();
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 430, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(srv.url + '/index.html', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof state !== 'undefined' && state.tab === 'today');

  /* ---------- 1. 课表导入回归（xls） ---------- */
  const imp = await page.evaluate(async (b64) => {
    const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const f = new File([bin], 'sample-timetable.xls', { type: 'application/vnd.ms-excel' });
    const res = await parseTimetableFile(f);
    return { n: res.drafts.length, start: res.semesterStart, names: res.drafts.map(d => d.subjectName).slice(0, 3) };
  }, fs.readFileSync(fixture('sample-timetable.xls')).toString('base64'));
  ok('课表 xls 仍能解析', imp.n > 0, `${imp.n} 门 · 学期 ${imp.start}`);
  ok('解析出 21 门课', imp.n === 21, `n=${imp.n}`);

  /* ---------- 2. 从资料页上传（没有课堂上下文） ---------- */
  const setup = await page.evaluate(async () => {
    const sub = { id: 's2', name: '操作系统', color: '#0ea472', createdAt: Date.now() };
    await dbPut('subjects', sub); state.subjects.push(sub);
    state.fileSubject = 's2';
    await render();
    const f1 = new File([new TextEncoder().encode('OS-SLIDES-V1')], '进程管理.pptx', { type: 'application/octet-stream' });
    await importFiles([f1], { subjectId: 's2' });
    return { n: state.files.length, links: state.files[0].links.length };
  });
  ok('资料页可以直接上传（不挂课）', setup.n === 1, `files=${setup.n}`);
  ok('此时没有任何课堂关联', setup.links === 0);

  /* ---------- 3. 同样内容再传一次：不该出现「关联已有到本节课」 ---------- */
  await page.evaluate(async () => {
    const f = new File([new TextEncoder().encode('OS-SLIDES-V1')], '进程管理-备份.pptx', { type: 'application/octet-stream' });
    window.__imp = importFiles([f], { subjectId: 's2' });
  });
  await page.waitForSelector('#modalBody .dupe', { timeout: 4000 });
  await page.waitForTimeout(250);
  const d = await page.locator('#modalBody').innerText();
  ok('无课堂上下文时不提供「关联已有到本节课」', !/关联已有文件到本节课/.test(d), d.split('\n')[0]);
  ok('默认推荐「不用重复上传」', /不用重复上传/.test(d));
  await page.click('#modalBody [data-v="cancel"]');
  await page.waitForTimeout(400);
  const still1 = await page.evaluate(() => state.files.length);
  ok('选「不用重复上传」后文件数不变', still1 === 1, `files=${still1}`);

  /* ---------- 4. 同名不同内容 → 另存一份 ---------- */
  await page.evaluate(async () => {
    const f = new File([new TextEncoder().encode('OS-SLIDES-V2-DIFFERENT')], '进程管理.pptx', { type: 'application/octet-stream' });
    window.__imp = importFiles([f], { subjectId: 's2' });
  });
  await page.waitForSelector('#modalBody .dupe', { timeout: 4000 });
  await page.click('#modalBody [data-v="separate"]');
  await page.waitForTimeout(600);
  const sep = await page.evaluate(() => ({
    n: state.files.length,
    versions: state.files.map(f => f.version),
    superseded: state.files.filter(f => f.supersededBy).length
  }));
  ok('「另存一份」后有两个文件', sep.n === 2, `files=${sep.n}`);
  ok('「另存一份」不产生历史版本', sep.superseded === 0);
  ok('「另存一份」都是 v1', sep.versions.every(v => v === 1), sep.versions.join(','));

  /* ---------- 5. 改类型 ---------- */
  const rekind = await page.evaluate(async () => {
    const f = state.files.find(x => !x.supersededBy);
    kindModal(f.id);
    return f.id;
  });
  await page.waitForSelector('#modalBody [data-act="setkind"]', { timeout: 3000 });
  await page.click('#modalBody [data-v="experiment"]');
  await page.waitForTimeout(500);
  const k = await page.evaluate((fid) => state.files.find(x => x.id === fid).kind, rekind);
  ok('可以手动改成「实验报告」', k === 'experiment', `kind=${k}`);
  const persisted = await page.evaluate(async (fid) => {
    const all = await dbAll('files');
    return all.find(x => x.id === fid).kind;
  }, rekind);
  ok('改完落到 IndexedDB', persisted === 'experiment', persisted);

  /* ---------- 6. 资料库按学科筛选 ---------- */
  await page.click('.tab[data-tab="library"]');
  await page.waitForTimeout(400);
  await page.evaluate(() => { state.fileSubject = 'all'; });
  await page.evaluate(() => render());
  await page.waitForTimeout(300);
  const allTxt = await page.locator('#view').innerText();
  ok('「全部」能看到两个学科的文件', /进程管理/.test(allTxt));
  await page.evaluate(() => { state.fileSubject = 's2'; });
  await page.evaluate(() => render());
  await page.waitForTimeout(300);
  const oneTxt = await page.locator('#view').innerText();
  ok('按学科筛选后只剩该学科', /进程管理/.test(oneTxt) && !/数据结构/.test(oneTxt));

  /* ---------- 7. 旧版纯 JSON 备份仍可导入 ---------- */
  const legacy = await page.evaluate(async () => {
    const payload = {
      app: 'class-inbox', version: 1, exportedAt: new Date().toISOString(),
      subjects: [{ id: 'old1', name: '编译原理', color: '#9b51e0', createdAt: 1 }],
      entries: [],
      sessions: [{
        id: '2026-09-01__old', date: '2026-09-01', entryId: '', subjectId: 'old1',
        status: 'done', transcriptText: '旧备份里的内容', photos: [], note: '',
        uploadedAt: Date.now(), createdAt: 1, updatedAt: 1
      }],
      settings: {}
    };
    const f = new File([new Blob([JSON.stringify(payload)])], 'old.json', { type: 'application/json' });
    const _c = window.confirm; window.confirm = () => true;
    await restoreAll(f);
    window.confirm = _c;
    return {
      hasOld: state.subjects.some(s => s.id === 'old1'),
      hasSess: state.sessions.some(s => s.id === '2026-09-01__old'),
      filesIntact: state.files.length
    };
  });
  ok('旧版 JSON 备份还能导入', legacy.hasOld && legacy.hasSess, JSON.stringify(legacy));
  ok('导入旧备份不会冲掉课程文件', legacy.filesIntact === 2, `files=${legacy.filesIntact}`);

  ok('没有控制台错误', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  await srv.close();

  const failed = results.filter(r => !r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
  if (failed.length) { failed.forEach(f => console.log('  - ' + f.label + ' :: ' + f.extra)); process.exit(1); }
})();
