/* pages/library/library.js —— 学科资料库
 *
 * 文件只存一份，关联到一节或多节课。上传走「从微信会话选文件」，
 * 这是小程序比手机网页方便的地方：老师发在群里的 PPT 直接选进来。
 *
 * 去重：先用 wx.getFileInfo 的 md5 做内容指纹，命中已有的就提示
 * 「关联已有 / 存为新版本 / 仍然上传另一份」。网页版用的是 sha256，
 * 两边算法不同没关系——去重只在同一端内比较，跨端靠 importBackup 重新算。
 */

const db = require('../../services/db');
const storage = require('../../services/storage');
const core = require('../../core');

Page({
  data: {
    files: [],
    totalText: '',
    filter: 'all',
    kinds: core.KIND_ORDER.map(k => ({ key: k, label: core.FILE_KINDS[k].label })),
    loading: true
  },

  onShow() {
    this.load();
  },

  async load() {
    this.setData({ loading: true });
    let files = [];
    let subjects = [];
    try {
      [files, subjects] = await Promise.all([db.all('files'), db.all('subjects')]);
    } catch (err) {
      console.error('[library] 读取失败', err);
    }

    const subOf = id => subjects.find(s => (s._id || s.id) === id);
    const f = this.data.filter;

    const list = files
      .filter(x => f === 'all' || x.kind === f)
      .map(x => {
        const K = core.kindOf(x);
        const sub = subOf(x.subjectId) || {};
        return {
          id: x._id || x.id,
          name: x.name,
          kindLabel: K.label,
          size: this.fmtSize(x.size),
          version: x.version || 1,
          isOld: !!x.supersededBy,
          subject: sub.name || '未分类',
          links: (x.links || []).length,
          linkText: (x.links || []).map(l => String(l.sid).slice(0, 10)).join(' ')
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    const bytes = files.reduce((n, x) => n + (Number(x.size) || 0), 0);
    const orphan = files.filter(x => !(x.links || []).length).length;

    this.setData({
      files: list,
      totalText: `${files.length} 个文件 · ${this.fmtSize(bytes)}${orphan ? ` · ${orphan} 个未关联课堂` : ''}`,
      loading: false
    });
  },

  setFilter(e) {
    this.setData({ filter: e.currentTarget.dataset.k }, () => this.load());
  },

  fmtSize(n) {
    n = Number(n) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1048576) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
    return `${(n / 1048576).toFixed(1)} MB`;
  },

  /** 从微信会话选文件上传（没有课堂上下文，只进学科资料库） */
  async upload() {
    const files = await storage.chooseFileFromChat(9);
    if (!files.length) return;

    const subjects = await db.all('subjects');
    if (!subjects.length) {
      wx.showModal({ title: '还没有学科', content: '先导入课表，或者手动建一个学科。', showCancel: false });
      return;
    }

    const pick = await new Promise(resolve => {
      wx.showActionSheet({
        itemList: subjects.map(s => s.name),
        success: r => resolve(subjects[r.tapIndex]),
        fail: () => resolve(null)
      });
    });
    if (!pick) return;

    const subjectId = pick._id || pick.id;
    wx.showLoading({ title: '上传中' });

    let added = 0;
    let skipped = 0;
    try {
      const existing = await db.all('files');
      for (const f of files) {
        const ext = core.extOf(f.name);
        const fp = await storage.fingerprint(f.path);

        // 内容一致 → 直接跳过，不重复占空间
        if (fp && existing.some(x => x.fingerprint === fp)) { skipped++; continue; }

        const id = `f_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const fileID = await storage.uploadFile(f.path, subjectId, id, ext);
        await db.put('files', {
          _id: id,
          subjectId,
          name: core.safeFile(f.name),
          ext,
          size: f.size || 0,
          kind: core.guessKind(f.name),
          fingerprint: fp,
          rootId: id,
          version: 1,
          links: [],
          fileID,
          createdAt: Date.now()
        });
        added++;
      }
      wx.hideLoading();
      wx.showToast({
        title: skipped ? `新增 ${added} · 跳过重复 ${skipped}` : `新增 ${added} 个文件`,
        icon: 'none'
      });
      this.load();
    } catch (err) {
      wx.hideLoading();
      wx.showModal({ title: '上传失败', content: String(err.errMsg || err.message || err), showCancel: false });
    }
  },

  /** 打开文件：拿临时链接后用 wx.openDocument */
  async open(e) {
    const id = e.currentTarget.dataset.id;
    const f = await db.get('files', id);
    if (!f) return;
    const url = await storage.tempUrl(f.fileID);
    wx.showLoading({ title: '打开中' });
    wx.downloadFile({
      url,
      success: r => {
        wx.hideLoading();
        wx.openDocument({
          filePath: r.tempFilePath,
          fileType: core.extOf(f.name),
          showMenu: true
        });
      },
      fail: err => {
        wx.hideLoading();
        wx.showModal({ title: '打不开', content: String(err.errMsg || err), showCancel: false });
      }
    });
  }
});
