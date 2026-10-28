/* v0.9 欠账清账：10.19 之前的一键免记 */
const { chromium } = require('playwright');
const { startServer } = require('./helpers');

const results = [];
const ok = (label, cond, extra = '') => {
  results.push({ label, pass: !!cond, extra });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
};

(async () => {
  const srv = await startServer();
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 430, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('dialog', d => d.accept());

  await page.goto(srv.url + '/index.html', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof state !== 'undefined' && state.tab === 'today');

  /* ---------- 造课：每周一 1-2 节，补出 9-29 ~ 今天 ---------- */
  const seed = await page.evaluate(async () => {
    const sub = { id: 's1', name: '计算机网络', color: '#3b5bfd', createdAt: Date.now() };
    await dbPut('subjects', sub); state.subjects.push(sub);
    const entry = {
      id: 'e1', subjectId: 's1', weekday: 1,
      startTime: '10:00', endTime: '11:40', timeMode: 'period',
      sections: '第3-4节', sectionsKey: '3-4',
      weekMode: 'all', weekFrom: 1, weekTo: 20, location: '二区601', createdAt: Date.now()
    };
    await dbPut('entries', entry); state.entries.push(entry);
    await backfillRange('2026-09-29', state.today);
    state.sessions = await dbAll('sessions');
    await render();
    const pend = state.sessions.filter(isPending).map(s => s.date).sort();
    return { today: state.today, pend, histN: pastPendingKey(state.today).length };
  });
  ok('造出 4 节待处理的周一课', seed.pend.join(',') === '2026-10-05,2026-10-12,2026-10-19,2026-10-26',
    seed.pend.join(','));
  ok('今日页历史欠账 = 4', seed.histN === 4, `histN=${seed.histN}`);

  /* ---------- 打开连续补录，看清账入口 ---------- */
  await page.click('[data-act="continuous"]');
  await page.waitForSelector('#modalBody .debt-box', { timeout: 5000 });
  await page.waitForTimeout(400);

  const cut = await page.inputValue('#debtBefore');
  ok('默认截止日是上周一 2026-10-19', cut === '2026-10-19', `cut=${cut}`);

  const hint = await page.locator('#debtHint').innerText();
  ok('提示「之前还有 2 节」', /还有\s*2\s*节/.test(hint), hint);
  await page.screenshot({ path: 'screenshots/v09-debt.png' });

  /* ---------- 改日期，提示跟着变 ---------- */
  await page.fill('#debtBefore', '2026-10-26');
  await page.waitForTimeout(300);
  const hint2 = await page.locator('#debtHint').innerText();
  ok('改成 10-26 后提示变成 3 节', /还有\s*3\s*节/.test(hint2), hint2);

  // 改回 10-19
  await page.fill('#debtBefore', '2026-10-19');
  await page.waitForTimeout(300);

  /* ---------- 执行清账 ---------- */
  await page.click('[data-act="ignorebefore"]');
  await page.waitForTimeout(900);

  const after = await page.evaluate(() => {
    const byDate = {};
    for (const s of state.sessions) byDate[s.date] = { status: s.status, exempt: !!s.exempt };
    return {
      byDate,
      pend: state.sessions.filter(isPending).map(s => s.date).sort(),
      exemptN: state.sessions.filter(s => s.exempt).length,
      total: state.sessions.length,
      remembered: state.settings.ignoreBefore
    };
  });
  ok('10-05 / 10-12 被标记免记',
    after.byDate['2026-10-05'].exempt && after.byDate['2026-10-12'].exempt,
    JSON.stringify(after.byDate['2026-10-05']));
  ok('10-19 / 10-26 不受影响',
    !after.byDate['2026-10-19'].exempt && !after.byDate['2026-10-26'].exempt);
  ok('记录没有被删，总数仍是 4', after.total === 4, `total=${after.total}`);
  ok('待处理只剩 10-19 和 10-26', after.pend.join(',') === '2026-10-19,2026-10-26', after.pend.join(','));
  ok('记住截止日，下次默认还是它', after.remembered === '2026-10-19', after.remembered);

  /* ---------- 连续补录列表里不再出现 10-19 之前的 ---------- */
  const listTxt = await page.locator('#modalBody .cont-list').innerText().catch(() => '');
  ok('连续补录列表里没有 10月5日 / 10月12日',
    !/10月5日/.test(listTxt) && !/10月12日/.test(listTxt),
    listTxt.split('\n').filter(Boolean).slice(0, 4).join(' / '));

  /* ---------- 再次打开：提示说「已经全部处理过了」 ---------- */
  const hint3 = await page.locator('#debtHint').innerText();
  ok('提示变成「已经全部处理过了」', /已经全部处理过/.test(hint3), hint3);

  await page.evaluate(() => closeModal());
  await page.waitForTimeout(400);

  /* ---------- 今日页欠账数字降下来 ---------- */
  await page.click('.tab[data-tab="today"]');
  await page.waitForTimeout(400);
  const todayTxt = await page.locator('#view').innerText();
  ok('今日页历史欠账变成 2', /历史还有\s*2\s*节/.test(todayTxt), (todayTxt.match(/历史还有.*/) || [''])[0]);

  /* ---------- 历史页：待处理不含免记，另有「已免记」筛选 ---------- */
  await page.click('.tab[data-tab="history"]');
  await page.waitForTimeout(400);
  const chips = await page.locator('.filter-box').innerText();
  ok('出现「已免记 2」筛选', /已免记 2/.test(chips), chips.split('\n')[0]);

  await page.click('[data-act="histstatus"][data-v="pending"]');
  await page.waitForTimeout(400);
  const pendTxt = await page.locator('#view').innerText();
  const pendCards = await page.locator('.card').count();
  ok('「待处理」筛出 2 条（不含免记）', pendCards === 2, `cards=${pendCards}`);

  await page.click('[data-act="histstatus"][data-v="exempt"]');
  await page.waitForTimeout(400);
  const exCards = await page.locator('.card').count();
  ok('「已免记」筛出 2 条', exCards === 2, `cards=${exCards}`);
  const exTxt = await page.locator('#view').innerText();
  ok('免记的课在历史里还能看到', /计算机网络/.test(exTxt) && /已免记/.test(exTxt));
  const chipTexts = await page.locator('.card .chip').allInnerTexts();
  ok('卡片上的状态 chip 是「已免记」而不是「待处理」',
    chipTexts.length > 0 && chipTexts.every(t => t.trim() === '已免记'), chipTexts.join(','));

  /* ---------- 清账后，再生成的旧课自动免记（否则清了又冒出来） ---------- */
  const autoEx = await page.evaluate(async () => {
    const s = state.sessions.find(x => x.date === '2026-10-05');
    await dbDel('sessions', s.id);
    state.sessions = state.sessions.filter(x => x.id !== s.id);
    const n = await ensureSessionsFor('2026-10-05');
    const re = state.sessions.find(x => x.date === '2026-10-05');
    await render();
    return { n, exempt: re ? !!re.exempt : null, pend: state.sessions.filter(isPending).length };
  });
  ok('清账后再生成的旧课自动带上免记', autoEx.n === 1 && autoEx.exempt === true, JSON.stringify(autoEx));
  ok('自动免记的课不进待办', autoEx.pend === 2, `pend=${autoEx.pend}`);

  /* ---------- 单条恢复 ---------- */
  await page.click('[data-act="histstatus"][data-v="exempt"]');
  await page.waitForTimeout(400);
  await page.locator('.card .card-main').first().click();
  await page.waitForTimeout(400);
  await page.locator('[data-act="toggleexempt"]').first().click();
  await page.waitForTimeout(500);
  const restored = await page.evaluate(() => state.sessions.filter(s => s.exempt).length);
  ok('点一下能单独恢复', restored === 1, `exempt=${restored}`);

  /* ---------- 批量恢复（清账点错了的后悔药） ---------- */
  await page.click('[data-act="histstatus"][data-v="exempt"]');
  await page.waitForTimeout(400);
  const exBtnTxt = await page.locator('[data-act="unexemptall"]').innerText();
  ok('「已免记」筛选下有恢复按钮', /恢复成待处理/.test(exBtnTxt), exBtnTxt);
  await page.click('[data-act="unexemptall"]');
  await page.waitForTimeout(600);
  const zero = await page.evaluate(() => state.sessions.filter(s => s.exempt).length);
  ok('批量恢复后免记清零', zero === 0, `exempt=${zero}`);

  ok('没有控制台错误', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  await srv.close();

  const failed = results.filter(r => !r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
  if (failed.length) { failed.forEach(f => console.log('  - ' + f.label + ' :: ' + f.extra)); process.exit(1); }
})();
