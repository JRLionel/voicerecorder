# VoiceScribe 后端持久化技术方案

> 目标：将转写 / 会议纪要结果从"仅前端返回"升级为"服务端落库"，支撑工作台的历史记录列表、详情、搜索与删除，替代原生 localStorage 方案。

- 技术栈延续：Node.js + Express
- 数据库：SQLite，采用 **`node:sqlite` 内置模块**（Node ≥ 22.5，免安装、免编译）
- 本文档记录环境准备、数据结构、接口设计与实施步骤。

---

## 1. 环境准备清单

| 项 | 要求 | 说明 |
|----|------|------|
| Node.js | ≥ 22.5（需含 `node:sqlite` 模块） | 本机 macOS；`node -v` 确认版本 |
| 数据库依赖 | 无（使用内置模块） | `node:sqlite` 为 Node 内置，`require("node:sqlite")` 引入 |
| 构建工具 | 不需要 | 内置模块无需原生编译，无需 Xcode CLT / Python3 |
| `.env` | 无需改动 | 沿用 `MIMO_API_KEY`（提供转写/纪要能力） |
| 数据目录 | `server/data/` | 新增，存放 `voicerecorder.db`，需加入 `.gitignore` |

> 校验命令：
> ```bash
> node -v          # 需 ≥ 22.5
> node -e "require('node:sqlite'); console.log('sqlite ok')"
> ```

> 风险提示：`node:sqlite` 目前仍处于 **Experimental** 状态，Node 升级到跨大版本时 API 可能有小变动，本方案将其收敛在单一 `db.js` 封装模块内，便于将来切换或替换为 `better-sqlite3`。

---

## 2. 数据结构

`server/db.js` 初始化时创建表与索引：

```sql
CREATE TABLE IF NOT EXISTS records (
  id            TEXT PRIMARY KEY,               -- 形如 'rec_xxxxxxxx'
  title         TEXT NOT NULL,                  -- 列表标题（默认取文件名/模板名）
  summary       TEXT,                           -- 列表摘要（取正文或纪要的前若干字，可空）
  source        TEXT NOT NULL DEFAULT 'upload', -- 'upload' | 'flash'
  template      TEXT,                           -- 使用的模板类型，如 'meeting' | 'transcribe'
  filename      TEXT,                           -- 原始文件名
  size          INTEGER,                        -- 字节数
  duration      INTEGER,                        -- 时长（秒，可空）
  language      TEXT DEFAULT 'auto',            -- 识别语言
  transcript    TEXT,                           -- 转写正文
  summary_text  TEXT,                           -- 会议纪要
  client_id     TEXT,                           -- 归属标识（单用户可省，多用户预留）
  created_at    TEXT NOT NULL,                  -- ISO 8601 时间，用于排序
  updated_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_records_created ON records(created_at);
CREATE INDEX IF NOT EXISTS idx_records_client  ON records(client_id);
```

## 3. 服务端改动（`server.js` + 新增 `server/db.js`）

新增独立封装模块 `server/db.js`，职责：
- 打开/初始化数据库（内存或 `server/data/voicerecorder.db`）
- 封装 CRUD：`createRecord / listRecords / getRecord / updateRecord / deleteRecord`
- 统一处理 `node:sqlite` 的 Experimental 提示（首次调用时打印一次 `--experimental-sqlite` 警告，或通过命令行开关抑制）

> 提醒：`node:sqlite` 在 Node 22 下需要以 `--experimental-sqlite` 运行。建议把启动脚本改为：
> `node --experimental-sqlite server.js`，并同步调整 `package.json` 的 `start` / `dev` 脚本。若 Node ≥ 23 则无需该开关，跨版本时以实际提示为准。

**新增接口（保留现有 `/api/transcribe` 与 `/api/meeting-summary` 不变，仅在其成功分支内落库）：**

```
GET    /api/records                列表（支持 ?q= 搜索标题&page=&pageSize=）
GET    /api/records/:id            详情（返回完整 transcript / summary_text）
POST   /api/records                创建记录（一般由内部调用，也可做成手动入口）
PATCH  /api/records/:id            更新标题/摘要等
DELETE /api/records/:id            删除记录
```

**落库业务逻辑：**
1. 服务启动时 `db.js` 完成建表
2. `/api/transcribe` 成功 → `createRecord({ transcript, title=文件名, ... })`（此时纪要为空）
3. `/api/meeting-summary` 成功 → `updateRecord(id, { summary_text })`（需前端在创建记录时拿到 `id` 后回传，或用 `client_id` + 最近记录定位）

## 4. 前端改动（`public/app.js` + `public/index.html`）

- 移除 localStorage 持久化逻辑
- 首页列表/网格：拉取 `GET /api/records` 渲染
- 转写/纪要成功后：创建/更新服务端记录，并刷新列表
- 详情页：`GET /api/records/:id` 拉全文与纪要
- 出发单次「闪记」流程时，前端生成 `clientId`（localStorage 单存一条），随创建请求上报，实现「我的」归属

## 5. 数据安全与运维

- 单用户工具默认不做鉴权；若将来对外，需在首页与全部 `/api/records*` 统一校验会话
- `.gitignore` 追加 `server/data/`，防止转写文本入库后被提交到 git
- 备份：SQLite 为单文件，定期复制 `voicerecorder.db` 或在详情/批量场景导出 JSON

## 6. 实施步骤（建议顺序）

1. 确认 Node 版本满足要求 → 更新 `package.json` 启动脚本（加 `--experimental-sqlite`）
2. 新建 `server/data/` 并更新 `.gitignore`
3. 编写 `server/db.js`（建表 + CRUD 封装），冒烟验证增删查
4. 改造 `server.js`：在转写/纪要成功分支落库，新增 5 个 `/api/records*` 路由
5. 改造前端：列表/详情/新建走接口，去掉 localStorage，接删除与搜索
6. 验证：上传→转写→纪要→刷新后列表仍在；删除/搜索/分页正常

## 7. 备选方案

- **better-sqlite3**：原生编译模块，稳定、同步 API；macOS 需 Xcode CLT，安装报错时需 Python3。仅当 Node 版本不满足 `node:sqlite` 时兜底采用，API 封装思路不变。