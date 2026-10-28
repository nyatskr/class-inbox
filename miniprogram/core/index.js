/* core/index.js —— 纯逻辑总出口
 *
 * 这一层不依赖 DOM，也不依赖 wx API，所以：
 *   - 小程序里 require('../core')
 *   - Node 里直接 require('./miniprogram/core') 就能跑单元测试
 *
 * 迁移原则：界面层和存储层随便换，这里的判断不要重写两遍。
 */

module.exports = {
  ...require('./date'),
  ...require('./weeks'),
  ...require('./status'),
  ...require('./snapshot'),
  ...require('./files'),
  ...require('./reminder')
};
