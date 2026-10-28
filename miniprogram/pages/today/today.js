/* pages/today/today.js —— 今日清单（主流程）
 *
 * 这一页是整个产品的心脏：上完课回来，看到今天几节课、哪些还没归档，
 * 点一下改状态。转录稿正文和板书在「展开」里填。
 */

const db = require('../../services/db');
const storage = require('../../services/storage');
const core = require('../../core');
const app = getApp();

Page({
  data: {
    today: '',
    dateText: '',
    list: [],
    stat: { total: 0, handled: 0, exempt: 0, pending: 0 },
    histN: 0,
    loading: true,
    expandedId: ''
  },

  onShow() {
    this.load();
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  async load() {
    const today = app.refreshToday();
    this.setData({ today, dateText: core.fmtDateCN(today), loading: true });

    let sessions = [];
    let entries = [];
    try {
      [sessions, entries] = await Promise.all([db.all('sessions'), db.all('entries')]);
    } catch (err) {
      console.error('[today] 读取失败', err);
    }

    const findEntry = id => entries.find(e => (e._id || e.id) === id) || null;

    const todayList = sessions
      .filter(s => s.date === today)
      .sort((a, b) => core.sortKeyOf(a, findEntry).localeCompare(core.sortKeyOf(b, findEntry)));

    const list = todayList.map(s => {
      const chip = core.statusChip(s);
      return {
        id: s._id || s.id,
        name: core.subjectNameOf(s, findEntry),
        time: core.timeTextOf(s, findEntry),
        place: core.placeOf(s, findEntry),
        chipLabel: chip.label,
        chipCls: chip.cls,
        textLen: (s.transcriptText || '').trim().length,
        photoN: (s.photos || []).length,
        fileN: (s.links || []).length,
        exempt: !!s.exempt,
        expanded: (s._id || s.id) === this.data.expandedId
      };
    });

    const handled = todayList.filter(core.isHandled).length;
    const exempt = todayList.filter(s => s.exempt).length;

    // 历史欠账只做提示，绝不进今晚的提醒
    const histN = sessions.filter(s => s.date < today && core.isPending(s)).length;

    this.setData({
      list,
      histN,
      stat: { total: todayList.length, handled, exempt, pending: todayList.length - handled },
      loading: false
    });
  },

  toggle(e) {
    const id = e.currentTarget.dataset.id;
    this.setData({ expandedId: this.data.expandedId === id ? '' : id }, () => this.load());
  },

  /** 点状态：直接改，不校验正文（正文可能已经贴在别处了） */
  async setStatus(e) {
    const { id, status } = e.currentTarget.dataset;
    const s = await db.get('sessions', id);
    if (!s) return;
    const next = core.stampUploaded({ ...s, status, exempt: false });
    await db.put('sessions', next);
    this.load();
    wx.showToast({ title: '已更新', icon: 'none' });
  },

  /** 本次免记 / 恢复 */
  async toggleExempt(e) {
    const id = e.currentTarget.dataset.id;
    const s = await db.get('sessions', id);
    if (!s) return;
    await db.put('sessions', { ...s, exempt: !s.exempt, updatedAt: Date.now() });
    this.load();
  },

  async onNote(e) {
    const id = e.currentTarget.dataset.id;
    const s = await db.get('sessions', id);
    if (!s) return;
    await db.put('sessions', core.stampUploaded({ ...s, note: e.detail.value }));
  },

  /** 板书照片：拍照/相册 → 云存储 → 只存 fileID */
  async addPhotos(e) {
    const id = e.currentTarget.dataset.id;
    const s = await db.get('sessions', id);
    if (!s) return;

    const paths = await storage.chooseImage(9);
    if (!paths.length) return;

    wx.showLoading({ title: '上传中' });
    try {
      const ids = [];
      for (let i = 0; i < paths.length; i++) {
        ids.push(await storage.uploadFile(paths[i], s.subjectId, `${id}_p${Date.now()}_${i}`, 'jpg'));
      }
      const photos = [...(s.photos || []), ...ids];
      await db.put('sessions', core.stampUploaded({ ...s, photos }));
      this.load();
    } catch (err) {
      wx.showModal({ title: '上传失败', content: String(err.errMsg || err.message || err), showCancel: false });
    } finally {
      wx.hideLoading();
    }
  },

  goSchedule() {
    wx.switchTab({ url: '/pages/schedule/schedule' });
  }
});
