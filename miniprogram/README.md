# 小程序骨架

原生微信小程序 + 云开发（CloudBase）。**这一版只到「骨架 + 主流程能跑」**，
不是完整迁移，具体差什么在最后一张表里写清楚了。

网页版（上一级目录）仍然是你现在实际在用的版本，没有被这个目录影响。

## 为什么是原生，不是 Taro / uni-app

三个关键能力都是微信独有的，套壳只会多一层麻烦：

- `wx.chooseMessageFile` —— 从微信会话里直接选老师发的 PPT / Excel（手机网页做不到）
- `wx.cloud.uploadFile` —— 文件进云存储，库里只留 fileID
- 云函数定时触发器 —— 真正的「关着也能收到提醒」

## 目录

```
miniprogram/
├─ app.js / app.json / app.wxss     入口、路由、全局样式
├─ core/                            纯逻辑，不依赖 DOM 也不依赖 wx API
│  ├─ date.js        日期、周次、上周一
│  ├─ weeks.js       多段周次匹配 / 解析 / 显示
│  ├─ status.js      四个状态 + 免记，待办判定唯一实现
│  ├─ snapshot.js    课堂快照（过去不变形）
│  ├─ files.js       文件分类、关联关系
│  └─ reminder.js    提醒内容 + 去重键
├─ services/
│  ├─ db.js          云数据库（没配环境时退化成内存，方便先看界面）
│  ├─ storage.js     云存储 + 从微信会话选文件
│  └─ cloud.js       云函数调用封装
└─ pages/            今日 / 课表 / 资料 / 历史 / 我的

cloudfunctions/
├─ nightlyReminder/     ✅ 定时检查 + 推送（含 config.json 定时触发器）
├─ sendTestReminder/    ✅ 手动试推
├─ importBackup/        ✅ 导入网页版备份 ZIP
├─ exportSubject/       ✅ 按学科打包导出
└─ importTimetable/     ⚠️ 写库逻辑完整，课表解析器待搬（见 lib/parse.js）
```

`core/` 是这次拆出来的重点：它用 CommonJS，Node 里能直接 `require`，
所以 `tests/05-core.js` 不用浏览器就能跑 58 项断言。
**界面和存储随便换，这里的判断不要重写两遍。**

## 本地跑起来

1. 微信开发者工具 → 导入项目 → 选本目录（`project.config.json` 已指向 `miniprogram/`）
2. 用自己的 AppID（`appid` 现在是 `touristappid`，只能看界面不能上云）
3. 开通云开发，把环境 ID 填进 `services/db.js` 的 `ENV`
4. 云函数目录右键「上传并部署」，`nightlyReminder` 记得配环境变量 `SENDKEY`

没填 `ENV` 也能打开：`services/db.js` 会退化成内存存储，界面能点，
关掉小程序数据就没了——只用来先看交互。

## 数据模型（和网页版一一对应）

| 网页版 IndexedDB | 小程序 | 说明 |
|---|---|---|
| `subjects` | `subjects` | 学科 |
| `entries` | `schedule_entries` | 课表安排（含 `weekRanges`） |
| `sessions` | `class_sessions` | 课堂记录，`snap` 原样保留 |
| `files` | `course_files` | 文件元信息，`sha256/rootId/version/links` 原样保留 |
| `blobs`（文件字节） | **不建集合** | 改存云存储 `fileID` |
| `settings` | `user_settings` | 单文档，`_id = 'main'` |
| `settings.pushSent` | `reminder_logs` | 固定 `_id = openid__日期__渠道`，天然唯一 |

三条不能动的设计：

1. **`date` 和 `uploadedAt` 分开**。上课日期永不改，上传日期跟着内容走。
   导出按 `date` 排，晚间提醒只查 `date === 今天`。
2. **`snap` 快照**。历史记录只读快照，不回查课表。删课表、改教室都不影响过去。
3. **文件字节不进数据库**。库里只有 `fileID` + 元信息。

## 还没做的

| 项 | 状态 | 说明 |
|---|---|---|
| 课表解析（xls/xlsx） | ⚠️ 待搬 | 写库逻辑已完整，解析器要从网页版 `app.js` 复制到 `importTimetable/lib/parse.js`，顶部有函数清单和两个当年踩过的坑 |
| 转录稿正文编辑 / 导入 txt | ❌ | 今日页目前只能改状态和传板书 |
| 从资料库关联文件到课堂 | ❌ | 资料页能上传，关联 UI 没做 |
| 连续补录 / 清账 | ❌ | 依赖批量生成历史 session，逻辑在网页版里 |
| 订阅消息 | ❌ | 需要先申请到模板，且一次性订阅一次授权只能发一条，只适合做补充 |
| 隐私协议 / 备案 | ❌ | 提交审核前必须做 |

## 从网页版迁移数据

1. 网页版「我的」→ 全量备份，得到 `课堂资料备份-YYYY-MM-DD.zip`
2. 发到微信文件传输助手
3. 小程序「我的」→ 导入网页版备份 → 从会话选这个 ZIP
4. `importBackup` 云函数把课程、快照、转录稿、板书、课程文件全部写进云端
5. **网页版至少再留两周**，对比课程数和文件数都对了再清

## 关于 SendKey

只存在云函数环境变量里。小程序包会被解包，任何写在前端的 key 等于公开。
`pages/settings` 里没有输入框，这是有意的。
