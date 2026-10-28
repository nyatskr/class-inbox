/* pages/schedule/schedule.js —— 课表
 *
 * 只做两件事：按星期几列出所有上课安排；导入课表（.xls/.xlsx 交给云函数解析）。
 *
 * 导入流程：
 *   chooseMessageFile 从微信会话选文件 → uploadFile 传云存储 → 云函数解析
 *   → 返回预览草稿（不写库）→ 用户确认 → 云函数写库
 * 这样手机上不用跑 OLE2/BIFF 解析，几十 KB 的表在云端几十毫秒就完了。
 */

const db = require('../../services/db');
const cloud = require('../../services/cloud');
const storage = require('../../services/storage');
const core = require('../../core');
const app = getApp();

Page({
  data: {
    weekNo: 0,
    days: [],        // [{ wd, label, items: [] }]
    importing: false
  },

  onShow() {
    this.load();
  },

  async load() {
    const today = app.refreshToday();
    const start = app.globalData.settings.semesterStart;
    const weekNo = start ? core.weekNoOf(today, start) : 0;

    let entries = [];
    let subjects = [];
    try {
      [entries, subjects] = await Promise.all([db.all('entries'), db.all('subjects')]);
    } catch (err) {
      console.error('[schedule] 读取失败', err);
    }

    const subOf = id => subjects.find(s => (s._id || s.id) === id);

    const days = core.WEEK_LABEL.map((label, i) => {
      const wd = i + 1;
      const items = entries
        .filter(e => e.weekday === wd && core.weekMatches(e, weekNo))
        .sort((a, b) => String(a.startTime || '99:99').localeCompare(String(b.startTime || '99:99')))
        .map(e => {
          const sub = subOf(e.subjectId) || {};
          return {
            id: e._id || e.id,
            name: sub.name || '未命名课程',
            color: sub.color || '#94a3b8',
            sections: e.sections || `${e.startTime || ''}–${e.endTime || ''}`,
            weeks: core.weekText(e),
            location: e.location || ''
          };
        });
      return { wd, label, items };
    });

    this.setData({ weekNo, days });
  },

  /** 导入课表：选文件 → 上传 → 云端解析 → 预览 */
  async importTimetable() {
    if (this.data.importing) return;

    const files = await storage.chooseFileFromChat(1);
    if (!files.length) return;

    const f = files[0];
    const ext = core.extOf(f.name);
    if (!/^(xls|xlsx|csv)$/.test(ext)) {
      wx.showModal({ title: '文件类型不对', content: '需要 .xls / .xlsx / .csv 课表', showCancel: false });
      return;
    }

    this.setData({ importing: true });
    wx.showLoading({ title: '解析中' });
    try {
      const fileID = await storage.uploadFile(f.path, 'timetable', `tt_${Date.now()}`, ext);
      const res = await cloud.parseTimetable(fileID, f.name);
      const drafts = res.drafts || [];

      wx.hideLoading();
      if (!drafts.length) {
        wx.showModal({ title: '没解析出课程', content: '这个表的版式可能和样例不一样，先在网页版导入确认一下。', showCancel: false });
        return;
      }

      const names = drafts.map(d => d.name).slice(0, 6).join('、');
      wx.showModal({
        title: `识别到 ${drafts.length} 个上课安排`,
        content: `${names}${drafts.length > 6 ? ' 等' : ''}\n\n确认导入会按「学科 + 星期 + 节次 + 周次」去重，重复的只更新不新增。`,
        confirmText: '导入',
        success: async r => {
          if (!r.confirm) return;
          wx.showLoading({ title: '写入中' });
          try {
            const out = await cloud.applyTimetable(drafts, {
              mode: 'merge',
              semesterStart: res.semesterStart || app.globalData.settings.semesterStart
            });
            if (res.semesterStart) {
              app.globalData.settings.semesterStart = res.semesterStart;
              await app.saveSettings();
            }
            wx.hideLoading();
            wx.showToast({ title: `新增 ${out.added || 0} · 更新 ${out.updated || 0}`, icon: 'none' });
            this.load();
          } catch (err) {
            wx.hideLoading();
            wx.showModal({ title: '导入失败', content: String(err.message || err), showCancel: false });
          }
        }
      });
    } catch (err) {
      wx.hideLoading();
      wx.showModal({ title: '导入失败', content: String(err.errMsg || err.message || err), showCancel: false });
    } finally {
      this.setData({ importing: false });
    }
  }
});
