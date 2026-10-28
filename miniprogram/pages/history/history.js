/* pages/history/history.js —— 历史记录
 *
 * 和今日页的区别：这里按学科分组、按上课日期倒序，可以筛状态。
 * 「已免记」是一个独立筛选项——清账之后那一大批课都在这儿，
 * 想反悔可以批量恢复。
 */

const db = require('../../services/db');
const core = require('../../core');

Page({
  data: {
    groups: [],
    filter: 'all',
    statusChips: [
      { key: 'all', label: '全部' },
      { key: 'done', label: '有转录稿' },
      { key: 'none', label: '无转录稿' },
      { key: 'pending', label: '待处理' },
      { key: 'exempt', label: '已免记' }
    ],
    total: 0,
    loading: true
  },

  onShow() {
    this.load();
  },

  async load() {
    this.setData({ loading: true });

    let sessions = [];
    let entries = [];
    try {
      [sessions, entries] = await Promise.all([db.all('sessions'), db.all('entries')]);
    } catch (err) {
      console.error('[history] 读取失败', err);
    }

    const findEntry = id => entries.find(e => (e._id || e.id) === id) || null;
    const f = this.data.filter;

    const filtered = sessions.filter(s => {
      if (f === 'all') return true;
      if (f === 'exempt') return !!s.exempt;
      if (f === 'pending') return core.isPending(s);
      return s.status === f;
    });

    const bySubject = new Map();
    for (const s of filtered) {
      const name = core.subjectNameOf(s, findEntry);
      if (!bySubject.has(name)) bySubject.set(name, []);
      bySubject.get(name).push(s);
    }

    const groups = Array.from(bySubject.entries()).map(([name, list]) => ({
      name,
      items: list
        .sort((a, b) => String(b.date).localeCompare(String(a.date)))
        .map(s => {
          const chip = core.statusChip(s);
          return {
            id: s._id || s.id,
            dateText: core.fmtDateCN(s.date),
            time: core.timeTextOf(s, findEntry),
            place: core.placeOf(s, findEntry),
            chipLabel: chip.label,
            chipCls: chip.cls,
            textLen: (s.transcriptText || '').trim().length
          };
        })
    }));

    this.setData({ groups, total: filtered.length, loading: false });
  },

  setFilter(e) {
    this.setData({ filter: e.currentTarget.dataset.k }, () => this.load());
  },

  /** 「已免记」筛选下，一键恢复成待处理 */
  async unexemptAll() {
    const n = this.data.total;
    if (!n) return;
    const r = await new Promise(resolve => {
      wx.showModal({
        title: '恢复成待处理',
        content: `把当前筛出的 ${n} 节恢复成待处理？它们会重新出现在历史欠账里。`,
        success: res => resolve(res.confirm)
      });
    });
    if (!r) return;

    wx.showLoading({ title: '恢复中' });
    try {
      const sessions = await db.all('sessions');
      const target = sessions.filter(s => s.exempt);
      for (const s of target) {
        await db.put('sessions', { ...s, exempt: false, updatedAt: Date.now() });
      }
      wx.hideLoading();
      wx.showToast({ title: `已恢复 ${target.length} 节`, icon: 'none' });
      this.load();
    } catch (err) {
      wx.hideLoading();
      wx.showModal({ title: '恢复失败', content: String(err.message || err), showCancel: false });
    }
  }
});
