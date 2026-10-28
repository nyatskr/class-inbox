/* app.js —— 小程序入口
 *
 * 职责很薄：初始化存储、把「今天」算一次、把 settings 读进内存。
 * 业务判断全在 core/ 里，这里不做。
 */

const db = require('./services/db');
const core = require('./core');

App({
  globalData: {
    today: '',
    settings: {
      semesterStart: '',
      reminderTime: '20:30',
      notifEnabled: false,
      scEnabled: false
    },
    ready: false
  },

  async onLaunch() {
    db.init();
    this.globalData.today = core.dateStr();

    try {
      const rows = await db.all('settings');
      const main = rows.find(r => (r._id || r.id) === 'main');
      if (main) Object.assign(this.globalData.settings, main);

      // 首次使用：学期开始默认取本周周一
      if (!this.globalData.settings.semesterStart) {
        this.globalData.settings.semesterStart = core.dateStr(core.mondayOf(new Date()));
        await this.saveSettings();
      }
    } catch (err) {
      console.error('[app] 读取设置失败', err);
    }

    this.globalData.ready = true;
  },

  async saveSettings() {
    const s = this.globalData.settings;
    await db.put('settings', { ...s, _id: 'main' });
  },

  /** 换设备后「今天」可能已经变了，每次进页面刷新一下 */
  refreshToday() {
    this.globalData.today = core.dateStr();
    return this.globalData.today;
  }
});
