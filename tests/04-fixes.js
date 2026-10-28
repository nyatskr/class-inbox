/* v1.0 底层修正 E2E
 *  1. 课堂快照：课表怎么改，过去的课都不变形
 *  2. 今日页统计：已处理 + 免记，不再有一节「凭空消失」
 *  3. 二次导入：合并更新 / 同步替换两种模式
 *  4. 文件字节移出启动路径（blobs），以及 v2→v3 的老数据迁移
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { startServer } = require('./helpers');

let BASE = '';
const OUT = path.join(__dirname, '..', 'screenshots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

function readZipEntries(buf) {
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
    const compSize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const cmtLen = dv.getUint16(off + 32, true);
    const lho = dv.getUint32(off + 42, true);
    const name = new TextDecoder('utf-8').decode(buf.subarray(off + 46, off + 46 + nameLen));
    const lnameLen = dv.getUint16(lho + 26, true);
    const lextraLen = dv.getUint16(lho + 28, true);
    const start = lho + 30 + lnameLen + lextraLen;
    out.push({ name, raw: buf.subarray(start, start + compSize) });
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
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('dialog', d => d.accept());

  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof state !== 'undefined' && state.tab === 'today');

  /* ================= 造数据 =================
     计算机网络：周一 3-4 节（二区601）+ 周三 1-2 节（二区601）
     专业英语：周三 9-10 节（三区303）
     今天 2026-10-28 是周三，所以今天 2 节 */
  const seed = await page.evaluate(async () => {
    const s1 = { id: 's1', name: '计算机网络', color: '#3b5bfd', createdAt: Date.now() };
    const s2 = { id: 's2', name: '专业英语', color: '#f2994a', createdAt: Date.now() + 1 };
    for (const s of [s1, s2]) { await dbPut('subjects', s); state.subjects.push(s); }
    const mk = (id, sid, wd, a, b, room) => ({
      id, subjectId: sid, weekday: wd,
      startTime: `${pad2(a + 7)}:00`, endTime: `${pad2(b + 7)}:40`, timeMode: 'period',
      sections: `第${a}-${b}节`, sectionsKey: `${a}-${b}`,
      weekMode: 'all', weekFrom: 1, weekTo: 20, location: room, createdAt: Date.now()
    });
    const entries = [
      mk('e1', 's1', 1, 3, 4, '二区601'),
      mk('e2', 's1', 3, 1, 2, '二区601'),
      mk('e3', 's2', 3, 9, 10, '三区303')
    ];
    for (const e of entries) { await dbPut('entries', e); state.entries.push(e); }
    await backfillRange('2026-09-28', state.today);
    // 往后补一段，才有「未来的待办」可验证（删课表时应该一起清掉）
    await backfillRange(state.today, '2026-11-16');
    state.sessions = await dbAll('sessions');
    await render();
    const todaySess = sessionsOf(state.today);
    return {
      today: state.today,
      todayN: todaySess.length,
      past: state.sessions.filter(s => s.date < state.today).length,
      future: state.sessions.filter(s => s.date > state.today).length,
      snapN: state.sessions.filter(s => s.snap).length,
      total: state.sessions.length
    };
  });
  ok('今天 2 节课', seed.todayN === 2, `todayN=${seed.todayN}`);
  ok('补出了未来的记录', seed.future > 0, `future=${seed.future}`);
  ok('每条记录都有课堂快照', seed.snapN === seed.total, `${seed.snapN}/${seed.total}`);

  /* ================= 1. 快照：改教室 ================= */
  const snap1 = await page.evaluate(async () => {
    const hist = state.sessions.find(s => s.date === '2026-10-05' && s.entryId === 'e1');
    const before = { time: timeText(hist), place: placeOf(hist), name: subjectOf(hist).name };
    // 改课表教室 + 改节次
    const e = state.entries.find(x => x.id === 'e1');
    e.location = '教五-101';
    await dbPut('entries', e);
    await refreshSnaps(['e1']);
    state.sessions = await dbAll('sessions');
    const hist2 = state.sessions.find(s => s.id === hist.id);
    const todayE1 = state.sessions.find(s => s.entryId === 'e1' && s.date > state.today);
    return {
      before,
      histAfter: { time: timeText(hist2), place: placeOf(hist2) },
      future: todayE1 ? placeOf(todayE1) : '(无未来记录)'
    };
  });
  ok('历史记录原本是「第3-4节 · 二区601」',
    snap1.before.time === '第3-4节' && snap1.before.place === '二区601',
    `${snap1.before.time} · ${snap1.before.place}`);
  ok('改教室后历史记录不变',
    snap1.histAfter.time === '第3-4节' && snap1.histAfter.place === '二区601',
    `${snap1.histAfter.time} · ${snap1.histAfter.place}`);

  /* ================= 2. 快照：删掉整条课表 ================= */
  const snap2 = await page.evaluate(async () => {
    // 模拟「从课表删除」：直接删 entry，再走一遍界面那条路径里的清理逻辑
    const histId = state.sessions.find(s => s.date === '2026-10-12' && s.entryId === 'e1').id;
    await dbDel('entries', 'e1');
    state.entries = state.entries.filter(x => x.id !== 'e1');
    const gone = state.sessions.filter(s => s.entryId === 'e1' && s.date >= state.today && !hasContent(s));
    for (const s of gone) { await dbDel('sessions', s.id); state.sessions = state.sessions.filter(x => x.id !== s.id); }
    const hist = state.sessions.find(s => s.id === histId);
    return {
      kept: !!hist,
      time: hist ? timeText(hist) : '',
      place: hist ? placeOf(hist) : '',
      name: hist ? subjectOf(hist).name : '',
      entryExists: !!state.entries.find(x => x.id === 'e1'),
      futureGone: gone.length
    };
  });
  ok('删掉课表后历史记录还在', snap2.kept);
  ok('历史记录的节次/教室/学科名都还在',
    snap2.time === '第3-4节' && snap2.place === '二区601' && snap2.name === '计算机网络',
    `${snap2.time} · ${snap2.place} · ${snap2.name}`);
  ok('未来还没填内容的记录被清掉了', snap2.futureGone > 0, `gone=${snap2.futureGone}`);

  /* ================= 3. 今日页统计：已处理 + 免记 ================= */
  const stat = await page.evaluate(async () => {
    const list = sessionsOf(state.today);
    const a = list[0], b = list[1];
    a.status = 'done'; a.transcriptText = '转录稿正文'; stampUploaded(a);
    b.exempt = true;
    for (const s of [a, b]) await dbPut('sessions', s);
    await render();
    const txt = document.querySelector('#view .stat').innerText.replace(/\s+/g, ' ');
    const bar = document.querySelector('#view .stat + div > div');
    return { txt, width: bar ? bar.style.width : '', pending: pendingKeyOf(state.today).length };
  });
  ok('统计里有「已处理」而不是「已归档」', /已处理/.test(stat.txt) && !/已归档/.test(stat.txt), stat.txt);
  ok('单独显示「免记 1」', /1\s*免记/.test(stat.txt), stat.txt);
  ok('已处理 = 2（归档 1 + 免记 1）', /2\s*已处理/.test(stat.txt), stat.txt);
  ok('待处理 0，进度条 100%', /0\s*待处理/.test(stat.txt) && stat.width === '100%', `width=${stat.width}`);
  await page.screenshot({ path: path.join(OUT, 'v10-stats.png') });

  /* ================= 4. 导入：合并 / 同步替换 ================= */
  const merge = await page.evaluate(async () => {
    // 只勾选「计算机网络 周三 1-2」，专业英语整门取消
    const drafts = [
      { name: '计算机网络', weekday: 3, sections: [1, 2], weeks: { ranges: [[1, 20]], mode: 'all', from: 1, to: 20 }, room: '二区601', teacher: '', keep: true },
      { name: '专业英语', weekday: 3, sections: [9, 10], weeks: { ranges: [[1, 20]], mode: 'all', from: 1, to: 20 }, room: '三区303', teacher: '', keep: false }
    ];
    openImportPreview(drafts, 't.xlsx', [], '');
    const mode0 = importMode;
    const kill0 = importSyncPlan().length;
    const before = state.entries.length;
    await confirmImport();
    return { mode0, kill0, before, after: state.entries.length, stillHasEn: !!state.entries.find(e => e.subjectId === 's2') };
  });
  ok('导入默认是「合并更新」', merge.mode0 === 'merge', `mode=${merge.mode0}`);
  ok('合并模式下取消勾选不会删旧课', merge.after === merge.before && merge.stillHasEn,
    `${merge.before}→${merge.after}`);

  const sync = await page.evaluate(async () => {
    const drafts = [
      { name: '计算机网络', weekday: 3, sections: [1, 2], weeks: { ranges: [[1, 20]], mode: 'all', from: 1, to: 20 }, room: '二区601', teacher: '', keep: true },
      { name: '专业英语', weekday: 3, sections: [9, 10], weeks: { ranges: [[1, 20]], mode: 'all', from: 1, to: 20 }, room: '三区303', teacher: '', keep: false }
    ];
    openImportPreview(drafts, 't.xlsx', [], '');
    importMode = 'sync';
    const kill = importSyncPlan().map(e => e.id);
    const enBefore = state.sessions.filter(s => s.subjectId === 's2').length;
    await confirmImport();
    const enAfter = state.sessions.filter(s => s.subjectId === 's2').length;
    const histEn = state.sessions.find(s => s.subjectId === 's2' && s.date < state.today);
    return {
      kill, enBefore, enAfter,
      enGone: !state.entries.find(e => e.subjectId === 's2'),
      histKept: !!histEn, histTime: histEn ? timeText(histEn) : '', histPlace: histEn ? placeOf(histEn) : ''
    };
  });
  ok('同步替换算出要移除「专业英语」', sync.kill.length === 1, JSON.stringify(sync.kill));
  ok('同步替换后课表里没有专业英语了', sync.enGone);
  ok('未来的专业英语待办被清掉', sync.enAfter < sync.enBefore, `${sync.enBefore}→${sync.enAfter}`);
  ok('专业英语的历史记录保留，且节次/教室完整',
    sync.histKept && sync.histTime === '第9-10节' && sync.histPlace === '三区303',
    `${sync.histTime} · ${sync.histPlace}`);

  /* ================= 5. 文件字节不在启动路径上 ================= */
  const files = await page.evaluate(async () => {
    const sid = sessionsOf(state.today)[0].id;
    const payload = new TextEncoder().encode('PPT-BYTES-在-blobs-里');
    const f = new File([payload], '第5章 图.pptx', { type: 'application/octet-stream' });
    await importFiles([f], { sessionId: sid });
    const rec = state.files[0];
    const bytes = await fileBytes(rec.id);
    const inStore = await dbGet('blobs', rec.id);
    return {
      n: state.files.length,
      inline: state.files.filter(x => x.data).length,
      size: rec.size,
      bytes: bytes ? new TextDecoder().decode(bytes) : '',
      blobBytes: inStore && inStore.data ? new TextDecoder().decode(new Uint8Array(inStore.data)) : ''
    };
  });
  ok('上传成功，1 个文件', files.n === 1, `n=${files.n}`);
  ok('元数据里没有字节', files.inline === 0, `inline=${files.inline}`);
  ok('字节存在 blobs 里且能取回', files.bytes === 'PPT-BYTES-在-blobs-里', files.bytes);
  ok('blobs 里内容一致', files.blobBytes === files.bytes, files.blobBytes);

  /* ================= 6. 导出的 CSV 带教室列 ================= */
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 20000 }),
    page.evaluate(() => exportSubject('s1'))
  ]);
  const zipPath = path.join(os.tmpdir(), 'export-v10.zip');
  await dl.saveAs(zipPath);
  const entriesZip = readZipEntries(fs.readFileSync(zipPath));
  const csvEntry = entriesZip.find(e => /汇总\.csv$/.test(e.name));
  const csv = csvEntry ? new TextDecoder('utf-8').decode(csvEntry.raw).replace(/^\ufeff/, '') : '';
  const head = csv.split('\r\n')[0] || '';
  const firstRow = csv.split('\r\n')[1] || '';
  ok('CSV 表头有「节次/时间/教室」', /节次,时间,教室/.test(head), head);
  ok('CSV 行里带上了教室', /二区601/.test(firstRow), firstRow);

  ok('没有控制台错误', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();

  /* ================= 7. v2 → v3 老数据迁移（独立上下文） ================= */
  const b2 = await chromium.launch();
  const ctx2 = await b2.newContext();
  const p2 = await ctx2.newPage();
  const err2 = [];
  p2.on('pageerror', e => err2.push(e.message));
  p2.on('console', m => { if (m.type() === 'error') err2.push(m.text()); });
  await p2.goto(BASE, { waitUntil: 'load' });
  await p2.waitForFunction(() => typeof state !== 'undefined');

  // 造一个「v2 时代」的库：files 里内联 data，没有 blobs 表。
  // 先用 route 顶掉 index.html，拿到一个同源但不会跑 app 的空白页，
  // 否则 app 自己的连接会把 deleteDatabase 卡住。
  await p2.route('**/index.html', route => route.fulfill({
    status: 200, contentType: 'text/html',
    body: '<!doctype html><meta charset="utf-8"><title>seed</title>'
  }));
  await p2.goto(BASE, { waitUntil: 'load' });

  const built = await p2.evaluate(async () => {
    await new Promise((res, rej) => {
      const r = indexedDB.deleteDatabase('class-inbox');
      r.onsuccess = () => res(true);
      r.onerror = () => rej(r.error);
      r.onblocked = () => rej(new Error('delete blocked'));
    });
    await new Promise((res, rej) => {
      const r = indexedDB.open('class-inbox', 2);
      r.onupgradeneeded = e => {
        const d = e.target.result;
        ['subjects', 'entries', 'sessions', 'files'].forEach(n => d.createObjectStore(n, { keyPath: 'id' }));
        d.createObjectStore('settings', { keyPath: 'key' });
      };
      r.onsuccess = () => {
        const d = r.result;
        const t = d.transaction('files', 'readwrite');
        const payload = new TextEncoder().encode('LEGACY-V2-BYTES').buffer;
        t.objectStore('files').put({
          id: 'legacy1', subjectId: 's1', name: '旧PPT.pptx', ext: 'pptx',
          size: 16, kind: 'ppt', sha256: 'x', rootId: 'legacy1', version: 1,
          links: [], data: payload, createdAt: 1
        });
        t.oncomplete = () => { d.close(); res(true); };
      };
      r.onerror = () => rej(r.error);
      r.onblocked = () => rej(new Error('open blocked'));
    });
    return true;
  });
  ok('造出一个 v2 老库', built === true);

  await p2.unroute('**/index.html');
  await p2.goto(BASE, { waitUntil: 'load' });
  await p2.waitForFunction(() => typeof state !== 'undefined' && state.tab === 'today');
  await p2.waitForTimeout(400);
  const mig = await p2.evaluate(async () => {
    const rec = state.files.find(f => f.id === 'legacy1');
    const bytes = rec ? await fileBytes(rec.id) : null;
    return {
      ver: (await db()).version,
      hasRec: !!rec,
      inline: rec && rec.data ? 1 : 0,
      text: bytes ? new TextDecoder().decode(bytes) : '',
      stores: Array.from((await db()).objectStoreNames)
    };
  });
  ok('库升到 v3 且有 blobs 表', mig.ver === 3 && mig.stores.includes('blobs'), `v${mig.ver} ${mig.stores.join(',')}`);
  ok('老文件字节搬到了 blobs', mig.text === 'LEGACY-V2-BYTES', mig.text);
  ok('老记录元数据里不再留字节', mig.inline === 0);
  ok('迁移过程没有报错', err2.length === 0, err2.slice(0, 2).join(' | '));

  await b2.close();
  await srv.close();

  const failed = results.filter(r => !r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
  if (failed.length) {
    console.log('FAILED:');
    for (const f of failed) console.log(`  - ${f.label} :: ${f.extra}`);
    process.exit(1);
  }
})();
