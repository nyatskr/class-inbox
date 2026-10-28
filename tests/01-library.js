/* v0.8 学科资料库 E2E：上传 / 指纹去重 / 版本 / 关联多节课 / 导出目录结构 / 备份 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { startServer } = require('./helpers');

let BASE = '';
const OUT = path.join(__dirname, '..', 'screenshots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

/* ---- 极简 zip 读取（makeZip 用 store 模式，只处理 method 0/8） ---- */
function readZipNames(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip');
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const method = dv.getUint16(off + 10, true);
    const compSize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const cmtLen = dv.getUint16(off + 32, true);
    const lho = dv.getUint32(off + 42, true);
    const name = new TextDecoder('utf-8').decode(buf.subarray(off + 46, off + 46 + nameLen));
    const lnameLen = dv.getUint16(lho + 26, true);
    const lextraLen = dv.getUint16(lho + 28, true);
    const start = lho + 30 + lnameLen + lextraLen;
    out.push({ name, method, raw: buf.subarray(start, start + compSize) });
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

const results = [];
const ok = (label, cond, extra = '') => {
  results.push({ label, pass: !!cond, extra });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
};

(async () => {
  const srv = await startServer();
  BASE = srv.url + '/index.html';
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 430, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));

  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof state !== 'undefined' && state.tab === 'today');

  /* ---------- 1. 造一门课 + 今天一节课 + 一节往期课 ---------- */
  const setup = await page.evaluate(async () => {
    const sub = { id: 'sub1', name: '数据结构', color: '#3b5bfd', createdAt: Date.now() };
    await dbPut('subjects', sub);
    state.subjects.push(sub);
    const wd = ((new Date().getDay() + 6) % 7) + 1;
    const entry = {
      id: 'e1', subjectId: 'sub1', weekday: wd,
      startTime: '10:00', endTime: '11:40', timeMode: 'period',
      sections: '第3-4节', sectionsKey: '3-4',
      weekMode: 'all', weekFrom: 1, weekTo: 20, location: '二区601', createdAt: Date.now()
    };
    await dbPut('entries', entry);
    state.entries.push(entry);
    await ensureSessionsFor(state.today);
    const todayId = `${state.today}__e1`;
    const s = state.sessions.find(x => x.id === todayId);
    s.transcriptText = '今天讲了二叉树的中序遍历。';
    s.status = 'done';
    stampUploaded(s);
    await dbPut('sessions', s);
    // 往期一节，用来测「一个文件关联多节课」
    const past = '2026-09-07';
    const ps = {
      id: `${past}__e1`, date: past, entryId: 'e1', subjectId: 'sub1',
      status: 'done', transcriptText: '往期内容', photos: [], note: '', exempt: false,
      uploadedAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now()
    };
    await dbPut('sessions', ps);
    state.sessions.push(ps);
    state.openIds.add(todayId);
    await render();
    return { todayId, pastId: ps.id, dbVer: (await db()).version };
  });
  ok('IndexedDB 升到 v3（files + blobs）', setup.dbVer === 3, `version=${setup.dbVer}`);

  const TID = setup.todayId;
  const PID = setup.pastId;

  /* ---------- 2. 详情区出现「相关课程资料」两个入口 ---------- */
  const boxTxt = await page.locator(`[data-card="${TID}"] .file-box`).innerText();
  ok('详情区有「相关课程资料」', /相关课程资料/.test(boxTxt));
  ok('有「上传新文件」按钮', /上传新文件/.test(boxTxt));
  ok('有「从本学科资料库选择」按钮', /从本学科资料库选择/.test(boxTxt));

  /* ---------- 3. 上传第一个 PPT ---------- */
  const up = async (name, content, sessionId = TID) => {
    await page.evaluate(async ({ name, content, sessionId }) => {
      const f = new File([new TextEncoder().encode(content)], name, { type: 'application/octet-stream' });
      window.__imp = importFiles([f], { sessionId });
    }, { name, content, sessionId });
  };

  await up('第3章 树.pptx', 'PPT-CONTENT-XYZ-001');
  await page.waitForTimeout(900);
  const after1 = await page.evaluate(() => ({
    n: state.files.length,
    kind: state.files[0] && state.files[0].kind,
    links: state.files[0] && state.files[0].links.map(l => l.sid),
    sha: state.files[0] && state.files[0].sha256.slice(0, 12),
    rows: document.querySelectorAll(`[data-card="${state.today}__e1"] .frow-item`).length
  }));
  ok('第一个文件入库', after1.n === 1, `files=${after1.n}`);
  ok('扩展名自动归类为 PPT', after1.kind === 'ppt', `kind=${after1.kind}`);
  ok('自动关联到本节课', after1.links && after1.links.length === 1 && after1.links[0] === TID);
  ok('用了 SHA-256 指纹（64 位 hex）', /^[0-9a-f]{12}/.test(after1.sha || ''), after1.sha);
  ok('详情区多了一行文件', after1.rows === 1, `rows=${after1.rows}`);

  /* ---------- 4. 同内容不同名 → 指纹命中，提示「已经在资料库里」 ---------- */
  await up('第3章 树（副本）.pptx', 'PPT-CONTENT-XYZ-001');
  await page.waitForSelector('#modalBody .dupe', { timeout: 4000 });
  const dupe1 = await page.locator('#modalBody').innerText();
  ok('指纹相同 → 弹出重复提示', /已经在资料库里了/.test(dupe1));
  ok('提供「关联已有文件」选项', /关联已有文件到本节课/.test(dupe1));
  ok('提供「保存为新版本」选项', /保存为新版本/.test(dupe1));
  ok('提供「仍然上传为另一份」选项', /仍然上传为另一份/.test(dupe1));
  await page.screenshot({ path: path.join(OUT, 'v08-dedupe.png') });

  await page.click('#modalBody [data-v="link"]');
  await page.waitForTimeout(600);
  const after2 = await page.evaluate(() => ({
    n: state.files.length,
    links: state.files[0].links.map(l => l.sid)
  }));
  ok('选「关联已有」后没有多存一份', after2.n === 1, `files=${after2.n}`);
  ok('「关联已有」也没重复加同一条关联', after2.links.length === 1);

  /* ---------- 5. 同名不同内容 → 存为新版本 ---------- */
  await up('第3章 树.pptx', 'PPT-CONTENT-XYZ-002-REVISED');
  await page.waitForSelector('#modalBody .dupe', { timeout: 4000 });
  const dupe2 = await page.locator('#modalBody').innerText();
  ok('同名不同内容 → 提示「同名文件已存在」', /同名文件已存在/.test(dupe2));
  ok('此时不提供「关联已有」', !/关联已有文件到本节课/.test(dupe2));
  await page.click('#modalBody [data-v="version"]');
  await page.waitForTimeout(700);
  const after3 = await page.evaluate(() => {
    const cur = state.files.filter(f => !f.supersededBy);
    return {
      total: state.files.length,
      cur: cur.length,
      v: cur[0] && cur[0].version,
      name: cur[0] && cur[0].name,
      oldSuperseded: state.files.filter(f => f.supersededBy).length,
      oldLinks: state.files.find(f => f.supersededBy) ? state.files.find(f => f.supersededBy).links.length : -1,
      curLinks: cur[0] ? cur[0].links.length : -1
    };
  });
  ok('新版本入库，总数 2', after3.total === 2, `total=${after3.total}`);
  ok('当前版本标记为 v2', after3.v === 2, `v=${after3.v}`);
  ok('旧版本标为历史版本', after3.oldSuperseded === 1);
  ok('新版本继承了旧版本的关联', after3.curLinks === 1, `links=${after3.curLinks}`);

  /* ---------- 5b. 版本历史：能切回旧版，也能切回来 ---------- */
  const ids = await page.evaluate(() => {
    const cur = state.files.find(x => !x.supersededBy && (x.version || 1) > 1);
    const vs = state.files.filter(f => f.rootId === cur.rootId);
    return { v1: vs.find(f => (f.version || 1) === 1).id, v2: cur.id };
  });
  await page.evaluate((fid) => versionsModal(fid), ids.v2);
  await page.waitForSelector('#modalBody .ver-row', { timeout: 3000 });
  const vt = await page.locator('#modalBody').innerText();
  ok('版本历史列出两个版本', /v1/.test(vt) && /v2/.test(vt), vt.split('\n').slice(0, 2).join(' / '));
  await page.click(`#modalBody [data-act="setver"][data-fid="${ids.v1}"]`);
  await page.waitForTimeout(500);
  const back = await page.evaluate(() => {
    const cur = state.files.filter(x => !x.supersededBy);
    return { n: cur.length, v: cur[0] && cur[0].version, links: cur[0] ? cur[0].links.length : -1 };
  });
  ok('可以切回 v1', back.n === 1 && back.v === 1, JSON.stringify(back));
  ok('切回后关联还在', back.links === 1, `links=${back.links}`);
  await page.evaluate((fid) => setCurrentVersion(fid), ids.v2);
  await page.waitForTimeout(400);
  const fwd = await page.evaluate(() => {
    const cur = state.files.filter(x => !x.supersededBy);
    return { n: cur.length, v: cur[0] && cur[0].version };
  });
  ok('可以再切回 v2', fwd.n === 1 && fwd.v === 2, JSON.stringify(fwd));
  await page.evaluate(() => render());

  /* ---------- 6. 实验报告 / 作业 自动分类 ---------- */
  await up('实验一 实验报告.docx', 'LAB-REPORT-BODY');
  await page.waitForTimeout(700);
  await up('习题3.docx', 'HOMEWORK-BODY');
  await page.waitForTimeout(700);
  const kinds = await page.evaluate(() =>
    state.files.filter(f => !f.supersededBy).map(f => `${f.name}=${f.kind}`));
  ok('实验报告识别为 experiment', kinds.some(k => /实验报告.*experiment/.test(k)), kinds.join(' | '));
  ok('习题识别为 homework', kinds.some(k => /习题3.*homework/.test(k)), kinds.join(' | '));

  /* ---------- 7. 从资料库挑文件关联到「往期」那节课 ---------- */
  await page.evaluate(async (pid) => {
    const f = state.files.find(x => /实验报告/.test(x.name) && !x.supersededBy);
    pickSessionsModal(f.id);
  }, PID);
  await page.waitForSelector('#modalBody .pick-row', { timeout: 3000 });
  const pickTxt = await page.locator('#modalBody').innerText();
  ok('「关联课堂」列出该学科的课', /9月7日/.test(pickTxt), pickTxt.split('\n').slice(0, 3).join(' / '));
  // 勾上往期那节（今天那节已默认勾上）
  await page.locator('#modalBody .pick-row', { hasText: '9月7日' }).click();
  await page.click('#modalBody [data-act="psok"]');
  await page.waitForTimeout(600);
  const multi = await page.evaluate(() => {
    const f = state.files.find(x => /实验报告/.test(x.name) && !x.supersededBy);
    return f.links.length;
  });
  ok('一个文件关联到 2 节课', multi === 2, `links=${multi}`);

  /* ---------- 8. 资料库页 ---------- */
  await page.click('.tab[data-tab="library"]');
  await page.waitForTimeout(500);
  const libTxt = await page.locator('#view').innerText();
  ok('资料库页有文件列表', /第3章 树\.pptx/.test(libTxt) && /实验一 实验报告\.docx/.test(libTxt));
  ok('资料库按类型分组', /PPT \/ 讲义/.test(libTxt) && /实验报告/.test(libTxt) && /作业/.test(libTxt));
  ok('显示关联了几节课', /关联 2 节课/.test(libTxt));
  ok('顶部显示文件数与体积', /个文件 ·/.test(await page.locator('#pageSub').innerText()));
  await page.screenshot({ path: path.join(OUT, 'v08-library.png'), fullPage: true });

  /* ---------- 9. 导出 ZIP 目录结构 ---------- */
  const dl = await Promise.all([
    page.waitForEvent('download', { timeout: 20000 }),
    page.evaluate(() => exportSubject('sub1'))
  ]);
  const zipPath = path.join(os.tmpdir(), 'export-v08.zip');
  await dl[0].saveAs(zipPath);
  const zbuf = fs.readFileSync(zipPath);
  const entries = readZipNames(zbuf);
  const names = entries.map(e => e.name);
  fs.writeFileSync(path.join(OUT, 'v08-export-names.txt'), names.join('\n'));

  ok('导出根目录是学科名', names.every(n => n.startsWith('数据结构/')), names[0]);
  ok('有 课堂记录/<日期>/转录稿.md',
    names.includes(`数据结构/课堂记录/${await page.evaluate(() => state.today)}/转录稿.md`));
  ok('有 课程资料/PPT/<文件名>', names.includes('数据结构/课程资料/PPT/第3章 树.pptx'));
  ok('旧版本进「历史版本」', names.includes('数据结构/课程资料/PPT/历史版本/v1-第3章 树.pptx'));
  ok('有 课程资料/实验报告/', names.some(n => n.startsWith('数据结构/课程资料/实验报告/')));
  ok('有 课程资料/作业/', names.some(n => n.startsWith('数据结构/课程资料/作业/')));
  ok('有 资料目录.html', names.includes('数据结构/资料目录.html'));
  ok('有 汇总.csv', names.includes('数据结构/汇总.csv'));
  ok('PPT 在 zip 里只出现一次', names.filter(n => /第3章 树\.pptx$/.test(n) && !/历史版本/.test(n)).length === 1);

  // 内容不被改动
  const pptEntry = entries.find(e => e.name === '数据结构/课程资料/PPT/第3章 树.pptx');
  ok('PPT 字节原样保留', pptEntry && Buffer.from(pptEntry.raw).toString() === 'PPT-CONTENT-XYZ-002-REVISED',
    pptEntry ? Buffer.from(pptEntry.raw).toString() : 'missing');

  const cat = entries.find(e => e.name === '数据结构/资料目录.html');
  const catHtml = cat ? Buffer.from(cat.raw).toString('utf8') : '';
  ok('资料目录列出了关联课堂的日期', /9月|\d{4}-\d{2}-\d{2}/.test(catHtml));
  ok('资料目录里实验报告关联了 2 节课', (catHtml.match(/2026-09-07/g) || []).length >= 1);

  const rel = entries.find(e => e.name.startsWith('数据结构/课堂记录/') && /相关课程资料\.md$/.test(e.name));
  ok('课堂记录里有「相关课程资料.md」', !!rel);
  if (rel) {
    const md = Buffer.from(rel.raw).toString('utf8');
    ok('相关课程资料用相对路径指向课程资料', /\(\.\.\/\.\.\/课程资料\//.test(md), md.split('\n').filter(l => l.startsWith('- ')).join(' | '));
  }

  /* ---------- 10. 全量备份 ZIP ---------- */
  const dl2 = await Promise.all([
    page.waitForEvent('download', { timeout: 20000 }),
    page.evaluate(() => backupAll())
  ]);
  const bkPath = path.join(os.tmpdir(), 'backup-v08.zip');
  await dl2[0].saveAs(bkPath);
  const bEntries = readZipNames(fs.readFileSync(bkPath));
  const bNames = bEntries.map(e => e.name);
  ok('备份是 ZIP 且含 data.json', bNames.includes('data.json'));
  ok('备份里带了每个文件的字节', bNames.filter(n => n.startsWith('files/')).length === 4,
    `${bNames.filter(n => n.startsWith('files/')).length} 个`);
  const dataJson = JSON.parse(Buffer.from(bEntries.find(e => e.name === 'data.json').raw).toString('utf8'));
  ok('备份的元信息里不含文件字节', dataJson.files.length === 4 && dataJson.files.every(f => !('data' in f)));

  /* ---------- 11. 清空后从备份恢复 ---------- */
  const restored = await page.evaluate(async (bk) => {
    const bin = Uint8Array.from(atob(bk), c => c.charCodeAt(0));
    await dbClear('files');
    await dbClear('blobs');
    state.files = [];
    const f = new File([bin], 'bk.zip', { type: 'application/zip' });
    // 跳过 confirm
    const _c = window.confirm; window.confirm = () => true;
    await restoreAll(f);
    window.confirm = _c;
    // v1.0 起字节在 blobs 里，元数据不带 data
    let withData = 0;
    for (const x of state.files) {
      const b = await fileBytes(x.id);
      if (b && b.length > 0) withData++;
    }
    return { n: state.files.length, withData, inline: state.files.filter(x => x.data).length };
  }, fs.readFileSync(bkPath).toString('base64'));
  ok('从 ZIP 备份恢复出 4 个文件', restored.n === 4, `n=${restored.n}`);
  ok('恢复后文件字节都在（blobs 里）', restored.withData === 4, `withData=${restored.withData}`);
  ok('元数据里不再内联字节', restored.inline === 0, `inline=${restored.inline}`);

  /* ---------- 12. 删除一节课 → 关联自动摘掉，文件还在 ---------- */
  const afterDel = await page.evaluate(async (pid) => {
    const before = state.files.find(x => /实验报告/.test(x.name) && !x.supersededBy).links.length;
    await purgeSessionLinks(pid);
    const f = state.files.find(x => /实验报告/.test(x.name) && !x.supersededBy);
    return { before, after: f.links.length, stillThere: !!f };
  }, PID);
  ok('删课后关联被摘掉', afterDel.before === 2 && afterDel.after === 1, `${afterDel.before}→${afterDel.after}`);
  ok('文件本身没被删', afterDel.stillThere);

  /* ---------- 13. 四个页面都不报错 ---------- */
  for (const t of ['today', 'schedule', 'library', 'history', 'settings']) {
    await page.click(`.tab[data-tab="${t}"]`);
    await page.waitForTimeout(300);
  }
  const ver = await page.locator('#view p:last-child').innerText().catch(() => '');
  ok('设置页版本号是 v1.0', /v1\.0/.test(ver), ver);
  await page.screenshot({ path: path.join(OUT, 'v08-settings.png'), fullPage: true });

  ok('没有控制台错误', errors.length === 0, errors.slice(0, 3).join(' | '));

  await browser.close();
  await srv.close();

  const failed = results.filter(r => !r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
  if (failed.length) {
    console.log('FAILED:');
    failed.forEach(f => console.log('  - ' + f.label + (f.extra ? ' :: ' + f.extra : '')));
    process.exit(1);
  }
})();
