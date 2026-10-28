/* pages/settings/settings.js —— 我的 / 设置
 *
 * 这里没有 Server酱 SendKey 输入框，这是有意的：
 * key 只存在云函数的环境变量里。小程序包会被解包，任何写在前端的 key
 * 等于公开。
 */

const db = require('../../services/db');
const cloud = require('../../services/cloud');
const storage = require('../../services/storage');
const core = require('../../core');
const app = getApp();

Page({
  data: {
    semesterStart: '',
    reminderTime: '20:30',
    notifEnabled: false,
    stats: { sessions: 0, withText: 0, withPhoto: 0, files: 0 },
    version: 'v1.0.0-mini'
  },

  onShow() {
    this.load();
  },

  async load() {
    const s = app.globalData.settings;
    let sessions = [];
    let files = [];
    try {
      [sessions, files] = await Promise.all([db.all('sessions'), db.all('files')]);
    } catch (err) {
      console.error('[settings] 读取失败', err);
    }

    this.setData({
      semesterStart: s.semesterStart || '',
      reminderTime: s.reminderTime || '20:30',
      notifEnabled: !!s.notifEnabled,
      stats: {
        sessions: sessions.length,
        withText: sessions.filter(x => (x.transcriptText || '').trim()).length,
        withPhoto: sessions.filter(x => (x.photos || []).length).length,
        files: files.length
      }
    });
  },

  async onSemester(e) {
    app.globalData.settings.semesterStart = e.detail.value;
    await app.saveSettings();
    this.setData({ semesterStart: e.detail.value });
    wx.showToast({ title: '已保存', icon: 'none' });
  },

  async onReminderTime(e) {
    app.globalData.settings.reminderTime = e.detail.value;
    await app.saveSettings();
    this.setData({ reminderTime: e.detail.value });
  },

  async onNotif(e) {
    const on = e.detail.value;
    app.globalData.settings.notifEnabled = on;
    await app.saveSettings();
    this.setData({ notifEnabled: on });
  },

  /** 试推一次：走云函数 → Server酱 → 微信 */
  async testPush() {
    wx.showLoading({ title: '发送中' });
    try {
      const r = await cloud.sendTestReminder();
      wx.hideLoading();
      wx.showModal({
        title: '已发送',
        content: r.message || '去微信看看有没有收到。没收到就检查云函数的 SENDKEY 环境变量。',
        showCancel: false
      });
    } catch (err) {
      wx.hideLoading();
      wx.showModal({ title: '发送失败', content: String(err.message || err), showCancel: false });
    }
  },

  /** 从微信会话选网页版导出的备份 ZIP，交给云函数导入 */
  async importBackup() {
    const files = await storage.chooseFileFromChat(1);
    if (!files.length) return;
    const f = files[0];
    if (core.extOf(f.name) !== 'zip') {
      wx.showModal({ title: '需要 ZIP', content: '网页版「全量备份」导出的就是 zip。', showCancel: false });
      return;
    }

    const ok = await new Promise(resolve => {
      wx.showModal({
        title: '导入备份',
        content: '会把这个 ZIP 里的课程、转录稿、板书、课程文件写进云端。同 ID 的记录会被覆盖。继续？',
        success: r => resolve(r.confirm)
      });
    });
    if (!ok) return;

    wx.showLoading({ title: '导入中' });
    try {
      const fileID = await storage.uploadFile(f.path, 'backup', `bk_${Date.now()}`, 'zip');
      const r = await cloud.importBackup(fileID);
      wx.hideLoading();
      wx.showModal({
        title: '导入完成',
        content: `课程记录 ${r.sessions || 0} 条 · 课程文件 ${r.files || 0} 个`,
        showCancel: false
      });
      this.load();
    } catch (err) {
      wx.hideLoading();
      wx.showModal({ title: '导入失败', content: String(err.message || err), showCancel: false });
    }
  },

  about() {
    wx.showModal({
      title: '关于',
      content: '课堂资料收件箱 · 本地优先的课堂资料归档工具。\n数据存在你自己的云开发环境里，不上传任何第三方。',
      showCancel: false
    });
  }
});
