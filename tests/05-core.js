/* 05-core.js —— core/ 纯逻辑单元测试（不需要浏览器）
 *
 * 这一组跑得很快，改完 core 里任何判断先跑它。
 * 覆盖的是「算错了会连锁出错」的地方：周次、待办判定、快照兜底、提醒内容。
 */

const core = require('../miniprogram/core');

const results = [];
const ok = (label, cond, extra = '') => {
  results.push({ label, pass: !!cond, extra });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
};
const eq = (label, actual, expected) =>
  ok(label, JSON.stringify(actual) === JSON.stringify(expected), `得到 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`);

/* ---------- 日期与周次 ---------- */
eq('2026-10-28 是周三', core.weekdayOf('2026-10-28'), 3);
eq('2026-11-01 是周日', core.weekdayOf('2026-11-01'), 7);
eq('2026-10-26 是周一', core.weekdayOf('2026-10-26'), 1);

eq('2026-10-28 所在周的周一是 10-26', core.dateStr(core.mondayOf(core.parseDate('2026-10-28'))), '2026-10-26');

// 学期 2026-08-31 开始（周一），10-28 应该是第 9 周
eq('10-28 是第 9 周', core.weekNoOf('2026-10-28', '2026-08-31'), 9);
eq('08-31 是第 1 周', core.weekNoOf('2026-08-31', '2026-08-31'), 1);
eq('08-24（开学前一周）是第 0 周', core.weekNoOf('2026-08-24', '2026-08-31'), 0);

eq('最近 3 天（到 10-28）', core.recentDates(3, '2026-10-28'), ['2026-10-26', '2026-10-27', '2026-10-28']);
eq('上周一是 10-19', core.lastMondayStr('2026-10-28'), '2026-10-19');
eq('周一当天也返回上一个周一', core.lastMondayStr('2026-10-26'), '2026-10-19');
eq('fmtDateCN 带星期', core.fmtDateCN('2026-10-28'), '10月28日 周三');

/* ---------- 周次匹配 ---------- */
const multi = { weekRanges: [[2, 4], [7, 7], [10, 16]], weekMode: 'all' };
ok('多段周次：第 3 周要上', core.weekMatches(multi, 3));
ok('多段周次：第 7 周（单周段）要上 —— 当年就丢在这', core.weekMatches(multi, 7));
ok('多段周次：第 5 周不上', !core.weekMatches(multi, 5));
ok('多段周次：第 9 周不上', !core.weekMatches(multi, 9));
ok('多段周次：第 12 周要上', core.weekMatches(multi, 12));

const odd = { weekRanges: [[1, 16]], weekMode: 'odd' };
ok('单周：第 3 周上', core.weekMatches(odd, 3));
ok('单周：第 4 周不上', !core.weekMatches(odd, 4));

const range = { weekMode: 'range', weekFrom: 3, weekTo: 6 };
ok('区间：第 2 周不上', !core.weekMatches(range, 2));
ok('区间：第 4 周上', core.weekMatches(range, 4));
ok('全学期', core.weekMatches({ weekMode: 'all' }, 99));

eq('周次文案（多段）', core.weekText(multi), '2-4,7,10-16 周');
eq('周次文案（全学期）', core.weekText({ weekMode: 'all' }), '全学期');
eq('parseWeekRanges 展开', core.parseWeekRanges('1-4,7,10-16'), [[1, 4], [7, 7], [10, 16]]);

/* ---------- 待办判定 ---------- */
ok('pending 算欠着', core.isPending({ status: 'pending' }));
ok('pending + 免记 不算欠着', !core.isPending({ status: 'pending', exempt: true }));
ok('done 不算欠着', !core.isPending({ status: 'done' }));
ok('免记算已处理', core.isHandled({ status: 'pending', exempt: true }));

eq('pending+免记 显示「已免记」', core.statusChip({ status: 'pending', exempt: true }).label, '已免记');
eq('done 显示「已上传转录稿」', core.statusChip({ status: 'done' }).label, '已上传转录稿');

const stamped = core.stampUploaded({ status: 'pending', transcriptText: 'abc' }, 1000);
ok('有内容 → 记上传时间', stamped.uploadedAt === 1000);
const cleared = core.stampUploaded({ status: 'pending', transcriptText: '', uploadedAt: 999 }, 2000);
ok('内容清空 → 上传时间置 null', cleared.uploadedAt === null);
const kept = core.stampUploaded({ status: 'done', transcriptText: 'x', uploadedAt: 500 }, 3000);
ok('已有上传时间不覆盖', kept.uploadedAt === 500);

/* ---------- 课堂快照 ---------- */
const entry = {
  subjectId: 's1', sections: '第3-4节', startTime: '10:00', endTime: '11:40',
  location: '二区601', teacher: '沈老师'
};
const snap = core.snapOfEntry(entry, { name: '计算机网络', color: '#3b5bfd' });
eq('快照抄下当时的教室', snap.location, '二区601');
eq('快照抄下当时的学科名', snap.subjectName, '计算机网络');

const rec = { entryId: 'e1', date: '2026-10-20', snap: { subjectName: '旧名字', sections: '第5-6节', location: '三区303', startTime: '14:00' } };
eq('有快照就只读快照', core.timeTextOf(rec, () => entry), '第5-6节');
eq('快照里的学科名不被现在的课表覆盖', core.subjectNameOf(rec, () => entry), '旧名字');

const old = { entryId: 'e1', date: '2026-10-20' };
eq('老数据没快照时兜底查课表', core.timeTextOf(old, () => entry), '第3-4节');
eq('老数据兜底能拿到教室', core.placeOf(old, () => entry), '二区601');

/* ---------- 文件分类 ---------- */
eq('pptx 是 PPT', core.guessKind('第3章 树.pptx'), 'ppt');
eq('实验报告归实验', core.guessKind('实验一 实验报告.docx'), 'experiment');
eq('习题归作业', core.guessKind('习题3-树.docx'), 'homework');
eq('普通 docx 是 Word', core.guessKind('课程大纲.docx'), 'doc');
eq('未知扩展名归 other', core.guessKind('data.bin'), 'other');
eq('safeFile 去掉非法字符', core.safeFile('a/b:c*.pptx'), 'a_b_c_.pptx');

const linked = core.linkTo({ links: [] }, 'sess1');
ok('关联后能查到', core.isLinkedTo(linked, 'sess1'));
ok('重复关联不会加两条', core.linkTo(linked, 'sess1').links.length === 1);
ok('取消关联后查不到', !core.isLinkedTo(core.unlinkFrom(linked, 'sess1'), 'sess1'));

/* ---------- 晚间提醒 ---------- */
const pendingList = [
  { status: 'pending', snap: { subjectName: '计算机网络', sections: '第3-4节', location: '二区601' }, transcriptText: '这里是绝不能被推送出去的正文' },
  { status: 'pending', snap: { subjectName: '专业英语', sections: '第9-10节', location: '三区303' } }
];
const payload = core.buildReminderPayload('2026-10-28', pendingList, () => null);
ok('有欠账才生成通知', !!payload);
eq('通知里课程数正确', payload.count, 2);
ok('标题含「还有 2 节课没归档」', /还有 2 节课没归档/.test(payload.title), payload.title);
ok('正文含课程名和地点', /计算机网络/.test(payload.desp) && /二区601/.test(payload.desp));
ok('★ 正文绝不包含转录稿内容', !/绝不能被推送出去/.test(payload.desp), '这是硬约束');
ok('没有欠账时返回 null', core.buildReminderPayload('2026-10-28', [], () => null) === null);
ok('标题不超过 32 字（Server酱限制）', core.clampTitle(payload.title).length <= 32);

eq('去重键按 用户+日期+渠道', core.reminderKey('u1', '2026-10-28', 'sc'), 'u1__2026-10-28__sc');
ok('不同渠道键不同', core.reminderKey('u1', '2026-10-28', 'sc') !== core.reminderKey('u1', '2026-10-28', 'hook'));
ok('不同日期键不同', core.reminderKey('u1', '2026-10-28', 'sc') !== core.reminderKey('u1', '2026-10-29', 'sc'));

/* ---------- 汇总 ---------- */
const failed = results.filter(r => !r.pass);
console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
if (failed.length) {
  console.log('FAILED:');
  failed.forEach(f => console.log('  - ' + f.label + (f.extra ? ' :: ' + f.extra : '')));
  process.exit(1);
}
