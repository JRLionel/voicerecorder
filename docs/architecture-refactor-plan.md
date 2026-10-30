# VoiceScribe 声记 · 模块重构与目录架构方案

> 依据：对当前仓库 `server.js`(659) / `server/*`(约 2.5k) / `public/app.js`(3063) / `public/style.css`(2663) / `scripts/*` 全量通读后的结论。
> 目标：功能模块边界清晰、公共能力单点收敛、参数与配置集中到统一数据层；对外行为（HTTP 契约、WS 协议、数据库文件、目录位置）零变化。

---

## 一、现状诊断

### 1.1 代码分布

| 位置 | 行数 | 实际承担的职责 |
| --- | --- | --- |
| `server.js` | 659 | Express 装配、**30 处**路由/中间件注册、multer 配置、上传前置校验、错误中间件、启动清理、配置告警 |
| `server/db.js` | 838 | 建表、幂等补列、7 张表的 CRUD、内置模板 upsert、批量删除事务、历史数据迁移 |
| `server/jobs.js` | 459 | 串行队列、并发切片、字率护栏、离线分离编排、MIMO/百炼双通道切换、记录落库、自动纪要 |
| `server/templates.js` | 492 | 内置模板常量、Schema 校验、提示词构建、结果归一、Markdown 渲染、快照 |
| `server/minutes.js` | 276 | 纪要动作编排、模板解析、生成锁、多版本指针 |
| `server/summary.js` | 308 | 事件流、分块、LLM 调用、map-reduce、宽松 JSON 解析 |
| `server/realtime.js` | 539 | WS 网关、录音会话状态机、百炼 duplex 中继、轮转、收尾落库 |
| `server/audio.js` / `bailian-offline.js` / `asr-*.js` / `recorder.js` | 192 / 321 / 199 / 82 / 114 | ffmpeg 封装、离线分离四步、两条识别适配、WAV 落盘 |
| `public/app.js` | 3063 | 5 个视图的全部逻辑 + 全局 state + 7 个 localStorage 键 + 所有 DOM 绑定 |
| `public/style.css` | 2663 | 设计令牌 + 基础样式 + 全部组件与视图样式 |

### 1.2 六个结构性问题是重构的直接动因

1. **`server.js` 是上帝入口。** 30 处 `app.get/post/patch/delete/use` 挤在一个文件里；上传受理（`POST /api/jobs` 的 78 行）把「收文件、探时长、判上限、建任务、搬目录、入队」六件事写在一个 handler 里。任何新接口都要改这个 659 行文件。

2. **参数与配置散落，同一事实存在多份。**
   - `process.env.*` 共 **26 处**读取，分布在 8 个文件；缺配置的告警文案手写在 `server.js:645-658`，与实际取值点各写一遍。
   - 百炼流式默认模型 `qwen-audio-3.0-asr-flash-streaming` 在 `jobs.js:100`、`realtime.js:461`、`scripts/transcribe.js:47` 各写一次。
   - 「分离上限 2 小时」在 `jobs.js:18`、`server.js:103`、`public/app.js:519`（`MAX_DIARIZE_SEC`）各写一次；前端 `index.html:181` 还硬编码了「上限 2 小时」的文案。
   - 说话人 6 色调色板在 `jobs.js:20` 与 `app.js:908` 各写一次。
   - 阈值全部埋在函数体里：30s 切片、并发 4、字率 1.2、静音 -35dB/0.6s、切点窗口 0.35、1800 字/块、700/2400 tokens、10 分钟生成锁、20 分钟轮转、4MB 背压。

3. **数据访问层混入了业务规则。** `db.js` 里既有 SQL，也有「系统模板不可删」的守卫（`deleteTemplate` 抛 `TEMPLATE_BUILTIN_LOCKED`）、名称唯一校验、批量删除的手写事务（`BEGIN/COMMIT/ROLLBACK` × 3 处）、以及历史纪要迁移这类一次性动作。它还是**require 即副作用**：模块被加载时立刻建库、建表、补列、upsert 内置模板 —— 任何需要「纯函数」的测试或脚本都绕不开。

4. **`db.js ⇄ templates.js` 双向依赖。** `db.js:5` require 模板库做校验与快照，`templates.js` 是纯逻辑却又被数据层反向依赖；`ensureBuiltinTemplates` 同时需要模板常量与 SQL。

5. **前端单文件 + 隐式全局。** 3063 行里：所有 DOM 引用在模块顶层一次性 `$()`（约 90 个常量）；`state` 是一个 30 字段的大对象；初始化语句写在文件**中段**（`app.js:2591`），模板相关代码反而在后面；`lockScroll` 定义在 `app.js:2601` 却在 `app.js:480` 就被调用（依赖函数提升才没炸）；`#brandHome` 挂了**两个** click 监听（`app.js:617` 负责跳转、`app.js:2570` 捕获阶段拦截录音中离开），靠 `stopImmediatePropagation` 维持顺序。

6. **没有公共层，同一能力写了多份。**
   | 能力 | 重复位置 |
   | --- | --- |
   | 退避重试 | `asr-mimo.js:11` `withRetry`、`asr-bailian.js:181` 循环、`bailian-offline.js:255` `withRetry` |
   | 并发池 | `jobs.js:116` `runPool`、`summary.js:232` 内联 workers、`scripts/transcribe.js:24` `mapLimit` |
   | 带 code/status 的错误类型 | `templates.js:24` `TemplateError`、`minutes.js:14` `MinutesError` |
   | 统一响应体 | 每个路由手写 `res.json({ success: true, ... })` |
   | 宽松 JSON 解析 | `summary.js:161` `parseJsonLoose`（通用能力埋在业务文件里） |
   | 时间格式化 | `audio.js:181` `fmtTime`、`app.js:166-179` 三个 format 函数 |

> 顺带发现两处死代码：`recorder.js` 的 `estimateWavBytes`、`db.js` 的 `updateMarker` 均只有定义与导出、无调用方；`realtime.js` 导出的 `FRAME_MS` 无人使用。

---

## 二、目标架构原则

### 2.1 四层一公共，依赖单向

```
                        ┌──────────────────────────────────────┐
   HTTP / WS  ─────────▶│ routes/          接口层               │
                        │ 只做：解析入参 → 调 service → 统一响应 │
                        └──────────────────┬───────────────────┘
                                           │ 只经 index.js 门面
                        ┌──────────────────▼───────────────────┐
                        │ modules/         业务层               │
                        │ ingestion  transcription  asr         │
                        │ audio      recording      minutes     │
                        │ templates                             │
                        └───────┬──────────────────────┬────────┘
                                │                      │
                 ┌──────────────▼────────┐   ┌─────────▼──────────┐
                 │ data/      数据层      │   │ config/   配置层    │
                 │ db/schema              │   │ env.schema         │
                 │ db/repositories        │   │ paths              │
                 │ presets（内置模板等）   │   └────────────────────┘
                 └──────────────┬─────────┘
                                │ 读共享 JSON（唯一数据源）
                 ┌──────────────▼─────────────────────────────┐
                 │ shared/   公共层（零业务，谁都能用，它不依赖谁）│
                 │ constants/  copy/  utils/  errors/  logger  │
                 └────────────────────────────────────────────┘
```

### 2.2 五条硬规则

| # | 规则 | 目的 |
| --- | --- | --- |
| R1 | `routes/` 不允许 `require` `data/`、`shared/utils/*`，只允许 `modules/*` 门面与 `shared/http`、`shared/errors` | 接口层只做翻译，业务固定在业务层 |
| R2 | `modules/` 之间只能 `require("../<module>")`（即 `index.js`），不能深引内部文件 | 改内部实现不牵动调用方 |
| R3 | `data/` 不得 `require` 任何 `modules/` | 校验、业务守卫上移到 service，仓储保持哑 SQL |
| R4 | `shared/` 不得 `require` 任何业务模块 | 保证公共层可被脚本、测试、前端无障碍复用 |
| R5 | **禁止 require 期副作用**（建目录、建表、upsert、迁移一律进 `bootstrap/`） | 模块可独立测试，启动顺序可控 |

### 2.3 前端三层

```
main.js（装配与路由注册）
   └─ features/*（业务视图，可 import core 与 components）
        └─ components/*（通用 DOM 组件，只会 import core/format、core/dom）
             └─ core/*（api / router / store / dom / format / storage / toast / meta，零业务）
```

方向只能向下。`core/api.js` 不 import 任何 feature，`core/store.js` 不 import `core/api.js`，避免前端 ESM 循环。

---

## 三、目标目录结构

```
voicerecorder/
├── server.js                        # 兼容壳：require("./src/server")，保持 npm start 与文档不变
├── package.json
├── .env.example
│
├── shared/                          # ★ 前后端共用的唯一数据源（纯 JSON，不含代码）
│   ├── constants/
│   │   ├── limits.json              # 上传 2GB / 4h、分离 2h、30s 切片、并发 4、字率 1.2、1800 字/块…
│   │   ├── media.json               # 扩展名白名单、16k 采样、highpass/loudnorm、mp3 64k、静音阈值
│   │   ├── engines.json             # 引擎与阶段枚举、各模型默认名、超时/轮询/重试
│   │   ├── protocol.json            # WS 消息类型、帧长、轮转、背压、断句静音
│   │   └── speakers.json            # 说话人调色板、S0/S1 命名规则
│   └── copy/
│       ├── stages.json              # QUEUED→「排队中」等阶段文案
│       ├── entries.json             # 上传视频/音频的标题、accept、提示
│       ├── modals.json              # 占位弹窗与二次确认文案
│       └── minute-labels.json       # 标记去向文案（已纳入决议 / 已转为待办 / 未纳入）
│
├── src/
│   ├── server/
│   │   ├── index.js                 # 进程入口：loadConfig → runBootstrap → createApp → listen
│   │   ├── app.js                   # createApp()：静态资源、JSON、路由挂载、WS 挂载、错误中间件
│   │   ├── bootstrap/
│   │   │   ├── index.js             # runBootstrap()：按序串起下面几步，返回启动报告
│   │   │   ├── ensure-dirs.js       # data/ uploads/ jobs/ 建目录（原三处 mkdirSync 合并）
│   │   │   ├── migrate.js           # 建表 + ensureColumns + 历史纪要迁移（原 db.js 顶部与尾部）
│   │   │   ├── sync-builtin-templates.js  # 内置模板按 id upsert（原 ensureBuiltinTemplates）
│   │   │   ├── recover-interrupted.js     # markInterruptedJobs + 清半截录音音频
│   │   │   └── cleanup-orphan-jobs.js     # 孤儿任务目录清理（原 server.js:615）
│   │   ├── routes/
│   │   │   ├── index.js             # 注册表：一个文件一行，新接口只加一行
│   │   │   ├── jobs.routes.js       # 上传、查状态、取消、续跑、重新标注、音频、说话人、标记
│   │   │   ├── records.routes.js    # 列表、详情、新建、更新、单删、批删
│   │   │   ├── minutes.routes.js    # 生成、列表、详情、设为当前、删除
│   │   │   ├── templates.routes.js  # CRUD、批量删除、复制
│   │   │   └── legacy.routes.js     # 两个 @deprecated 兼容接口集中隔离
│   │   ├── modules/
│   │   │   ├── ingestion/           # 上传受理
│   │   │   │   ├── index.js
│   │   │   │   ├── upload.middleware.js   # multer：磁盘存储、文件名还原、白名单
│   │   │   │   ├── validate-file.js       # probe + 时长/分离上限前置拦截
│   │   │   │   └── service.js             # 建 job → 搬进任务目录 → 入队
│   │   │   ├── transcription/       # 原 jobs.js
│   │   │   │   ├── index.js         # 门面：enqueue / cancel / resume / runJob / detectSourceType
│   │   │   │   ├── queue.js         # 串行链
│   │   │   │   ├── controls.js      # 取消标记表
│   │   │   │   ├── chunk-plan.js    # 切点规划 + 静音片判定
│   │   │   │   ├── quality-guard.js # 字率护栏
│   │   │   │   ├── job-runner.js    # 状态机编排：探测→抽音→分岔→落记录
│   │   │   │   ├── mimo-runner.js   # 30s 切片 + 并发 4 + 兜底
│   │   │   │   ├── diarize-runner.js# 离线分离整文件通道
│   │   │   │   ├── persist-record.js# 文本合并 + 记录写入（★ 供 recording 复用）
│   │   │   │   └── workspace.js     # jobDir 创建/清理
│   │   │   ├── asr/                 # 识别通道适配（无状态）
│   │   │   │   ├── index.js
│   │   │   │   ├── mimo.client.js
│   │   │   │   ├── bailian-stream.client.js
│   │   │   │   ├── bailian-filetrans.client.js
│   │   │   │   ├── oss-uploader.js  # 凭证 → 直传 OSS
│   │   │   │   └── diarization-quality.js  # normalizeSentences / analyzeDiarization
│   │   │   ├── audio/               # ffmpeg 域
│   │   │   │   ├── index.js
│   │   │   │   ├── ffmpeg.js        # spawn 封装
│   │   │   │   ├── probe.js
│   │   │   │   ├── transcode.js     # extractWav / slicePcm / sliceMp3 / toPcm
│   │   │   │   ├── silence.js       # findSilences / planCuts / isSilentRange
│   │   │   │   └── wav-writer.js    # 原 recorder.js
│   │   │   ├── recording/           # 原 realtime.js
│   │   │   │   ├── index.js         # attachGateway(server)
│   │   │   │   ├── gateway.js       # WS 连接生命周期、心跳、消息分发
│   │   │   │   ├── session.js       # RecordSession 状态机
│   │   │   │   ├── relay.js         # 百炼 duplex：run-task / 推帧 / 轮转 / finish
│   │   │   │   └── finalize.js      # 回填 WAV → 写 segments → 建 record
│   │   │   ├── minutes/             # 原 minutes.js + summary.js
│   │   │   │   ├── index.js
│   │   │   │   ├── service.js       # 生成/列表/详情/设当前/删除、生成锁
│   │   │   │   ├── selection.js     # segments 解析、伪分段、模板解析回退
│   │   │   │   ├── event-stream.js  # buildEvents / buildBlocks / formatEvent
│   │   │   │   ├── composer.js      # map-reduce + LLM 调用 + 纠正重试
│   │   │   │   ├── normalizer.js    # normalizeSummary / fallbackSummary / legacy 兼容
│   │   │   │   └── markdown.js      # toMarkdown / usedLabel
│   │   │   └── templates/           # 原 templates.js 的「代码部分」
│   │   │       ├── index.js
│   │   │       ├── schema.js        # LIMITS / SECTION_TYPES / validate / normalizeSections
│   │   │       ├── prompt.js        # buildSummaryPrompt / templateFocusLine
│   │   │       └── presenter.js     # fromRow / snapshotOf / serializeTemplate(DTO)
│   │   ├── data/                    # ★ 统一数据层
│   │   │   ├── index.js             # 唯一入口：loadPresets() / getConstants() / repos / withTransaction
│   │   │   ├── db/
│   │   │   │   ├── connection.js    # DatabaseSync 单例 + WAL
│   │   │   │   ├── schema.js        # DDL 与 ensureColumns 声明表
│   │   │   │   ├── transaction.js   # withTransaction()：唯一允许 BEGIN 的地方
│   │   │   │   └── repositories/
│   │   │   │       ├── records.repo.js
│   │   │   │       ├── jobs.repo.js
│   │   │   │       ├── segments.repo.js
│   │   │   │       ├── speakers.repo.js
│   │   │   │       ├── markers.repo.js
│   │   │   │       ├── templates.repo.js
│   │   │   │       └── minutes.repo.js
│   │   │   └── presets/             # 内置静态数据（不是代码逻辑，可整体替换）
│   │   │       ├── index.js         # 汇总并冻结，提供 getPresets()
│   │   │       └── minutes-templates/
│   │   │           ├── index.js     # 遍历同目录、按文件名汇总（新增模板只加文件）
│   │   │           └── default.js   # 系统默认模板（原 BUILTIN_TEMPLATES[0]）
│   │   ├── config/
│   │   │   ├── index.js             # loadConfig()：一次性解析并冻结，全进程只读
│   │   │   ├── env.schema.js        # 声明式：键名/分组/必填/默认值/说明（告警文案由此生成）
│   │   │   └── paths.js             # 以仓库根为锚：data / uploads / jobs / public
│   │   └── shared/
│   │       ├── errors.js            # AppError(code, message, status)；TemplateError/MinutesError 继承它
│   │       ├── http.js              # ok() / fail() / asyncHandler() / notFound()
│   │       ├── logger.js
│   │       └── utils/
│   │           ├── retry.js         # 合并三份重试实现
│   │           ├── pool.js          # 合并三份并发池
│   │           ├── json.js          # parseJsonLoose / safeStringify
│   │           ├── time.js          # fmtTime / nowIso
│   │           ├── text.js          # stripExt / decodeFilename / sliceByChars
│   │           ├── id.js
│   │           └── fs.js            # rmDirSafe / exists
│   │
│   └── (无 web 目录：前端仍在 public/，见下)
│
├── public/                          # 静态根不变，内部按层重组
│   ├── index.html                   # 只留结构与 <link>/<script type="module">
│   ├── pcm-worklet.js               # 位置不变（AudioWorklet 用 addModule 绝对路径加载）
│   ├── js/
│   │   ├── main.js                  # 装配：加载 meta → 注册路由 → 首页首屏
│   │   ├── core/
│   │   │   ├── api.js               # fetch 封装：统一 success/error 处理、路径常量
│   │   │   ├── meta.js              # 顶层 await 拉 /api/meta，获得 limits/copy/enums
│   │   │   ├── router.js            # views 切换、beforeLeave 钩子（替代双监听）
│   │   │   ├── store.js             # 状态 + 订阅（拆掉 30 字段大对象）
│   │   │   ├── dom.js               # $ / $$ / el / on / delegate
│   │   │   ├── format.js            # size / duration / frac / date / stamp
│   │   │   ├── storage.js           # 全部 localStorage 键集中 KEYS
│   │   │   └── toast.js             # showError/showInfo
│   │   ├── components/
│   │   │   ├── modal.js             # 占位弹窗
│   │   │   ├── confirm.js           # 二次确认（Promise）
│   │   │   ├── switch.js            # opt-card 开关
│   │   │   ├── icons.js             # 内联 SVG 片段
│   │   │   └── transcript-row.js    # 发言块 / 标记行渲染（纯函数）
│   │   └── features/
│   │       ├── records/  { page.js, list.js, selection.js }
│   │       ├── upload/   { page.js, progress.js, diarize.js }
│   │       ├── recording/ { page.js, session.js, pcm-capture.js, timeline.js,
│   │       │               markers.js, draft-cache.js, leave-guard.js }
│   │       ├── detail/   { page.js, transcript.js, player.js,
│   │       │               speaker-rename.js, export.js }
│   │       ├── minutes/  { panel.js, tabs.js, render.js, actions.js }
│   │       └── templates/ { page.js, picker.js, editor.js }
│   └── styles/
│       ├── tokens.css               # :root 变量（原 style.css 顶部）
│       ├── base.css                 # reset / body / app / 顶栏 / 页脚
│       ├── components.css           # btn / card / tab / switch / modal / toast
│       └── features/
│           ├── records.css
│           ├── upload.css
│           ├── recording.css
│           ├── detail.css
│           └── templates.css
│
├── scripts/                         # 保持不变，只改 require 路径
│   ├── transcribe.js
│   ├── verify-diarization.js
│   ├── test-offline.js
│   └── test-templates.js
├── docs/  openspec/  testData/  LICENSE  README.md
```

---

## 四、统一数据层的具体设计（对应要求 3）

当前「参数 / 配置 / 内置模板」分散在 11 个文件、约 40 个位置。目标是把它们收成**三类、一个入口**：

| 类别 | 内容 | 位置 | 加载方式 |
| --- | --- | --- | --- |
| L1 静态数据 | 阈值、枚举、内置纪要模板、后端提示词片段、前端文案 | `shared/constants/*.json`、`src/server/data/presets/*` | `data/index.js` 的 `getConstants()` / `getPresets()`，启动时一次读入并 `Object.freeze` |
| L2 运行配置 | 端口、密钥、模型名、目录 | `src/server/config/`（读 `.env`） | `loadConfig()` 在入口解析一次，向下传引用；业务代码不再出现 `process.env` |
| L3 持久化数据 | 7 张表的读写 | `src/server/data/db/repositories/*` | service 调用 repo；事务只经 `withTransaction()` |

### 4.1 内置会议纪要模板：从「数组里的一条」变成「一个文件」

现在新增一个系统模板要改 `templates.js` 的 `BUILTIN_TEMPLATES` 数组，还要连带 `DEFAULT_TEMPLATE`、`DEFAULT_TEMPLATE_ID` 等派生常量，且前端 `app.js:1263` 硬编码了 `"tpl_default"` 做分支判断。

改造后：

```
data/presets/minutes-templates/
├── index.js         # readdir 本目录 → 过滤 .js → 按 id 排序 → 冻结数组
├── default.js       # module.exports = { id, name, description, icon, color, sections, extras, promptExtra }
└── weekly.js        # 新增模板 = 新增这个文件，index.js 自动收录
```

`index.js` 负责三件事，且只做这三件：**收集 → 校验 id 唯一 → 冻结**。`sync-builtin-templates.js` 只读 `getPresets().minutesTemplates` 做幂等 upsert。

**前端不再硬编码 `tpl_default`**：`/api/templates` 已返回 `defaultId`，`features/minutes/render.js` 用 `state.defaultTemplateId` 判断标签措辞。

### 4.2 现有散落参数 → 新归属（迁移清单）

| 参数 | 现在在哪 | 迁往 |
| --- | --- | --- |
| 2GB / 4h / 扩展名白名单 | `server.js:27-33`、`index.html:141,585` | `limits.json`、`media.json`（前端由 `/api/meta` 取） |
| 分离 2h 上限 | `jobs.js:18`、`server.js:103`、`app.js:519`、`index.html:181` | `limits.json → maxDiarizeSec` |
| 30s 切片 / 并发 4 / 字率 1.2 | `jobs.js:15-17` | `limits.json` |
| 静音 -35dB / 0.6s / 窗口 0.35 / 最小间隔 0.6 | `audio.js:68,99-104` | `media.json` |
| 16k / highpass 80 / loudnorm -16:-2:11 / 64k | `audio.js:47-65,142` | `media.json` |
| 实时帧 100ms / 20min 轮转 / 30s 缓冲 / 4MB 背压 / 800ms 断句 | `realtime.js:13-17`、`asr-bailian.js:5` | `protocol.json` |
| 模型默认名（3 份重复）、任务超时 5min、轮询 2s、重试 2 次 | `jobs.js:100`、`realtime.js:461`、`transcribe.js:47`、`bailian-offline.js:15-17`、`asr-mimo.js:11`、`asr-bailian.js:181` | `engines.json` + `config/env.schema.js` 默认值 |
| 1800 字/块、700/2400 tokens、温度 0.2/0.1、map 并发 4 | `summary.js:26-28,219,269` | `limits.json → minutes` |
| 纪要生成锁 10 分钟 | `minutes.js:12` | `limits.json` |
| 说话人 6 色、显示名规则 | `jobs.js:20`、`app.js:908` | `speakers.json` |
| **内置纪要模板**（3 章节 + extras + promptExtra） | `templates.js:34-50` | `data/presets/minutes-templates/default.js` |
| 提示词里的固定段落（说话人说明、标记说明、规则 7 条） | `templates.js:150-243` | `modules/templates/prompt.js`（属业务规则，不进 JSON） |
| 阶段文案 / 入口文案 / 弹窗文案 / 标记去向文案 | `app.js:455-464,581-592,703-715,1263-1271` | `shared/copy/*.json` |
| localStorage 键名（7 个） | `app.js:117-144,2313` | `public/js/core/storage.js` 的 `KEYS` |
| data / uploads / jobs 目录 | `db.js:7`、`server.js:35`、`jobs.js:22` | `config/paths.js`（默认值保持原位，见 §7 风险 1） |

### 4.3 前后端如何共用同一份数据（无构建步骤下的落地方式）

项目坚持「零构建」。因此不做跨端 `import`，而是**同一份 JSON，两侧各一个极薄加载器**：

- 服务端：`require("../../shared/constants/limits.json")` —— Node 原生支持，无需转换。
- 浏览器：`GET /api/meta` 一次返回 `{ limits, media, engines, protocol, speakers, copy }`；
  `public/js/core/meta.js` 用**顶层 `await`** 在首屏渲染前完成注入，之后全站读 `meta.limits.maxDiarizeSec`。

这样避免了两件常见的坏事：前后端各维护一份常量（现状就是 2h 上限、6 色调色板各两份）；为共享代码引入打包器。

### 4.4 改造前后的「改动成本」对比

| 场景 | 改造前 | 改造后 |
| --- | --- | --- |
| 新增一个系统内置模板 | 改 `templates.js` 数组 + 派生常量，注意 id 与前端硬编码分支 | 新增 1 个文件，`index.js` 自动收录 |
| 把分离上限从 2h 调到 3h | 改 `jobs.js`、`server.js`、`app.js`、`index.html` 共 4 处 | 改 `limits.json` 1 处 |
| 新增一个识别引擎 | 在 `jobs.js` 里加分支，`require` 新适配层 | 新增 `asr/xxx.client.js` + `engines.json` 注册一行 |
| 新增一个 API | 改 659 行 `server.js`（易冲突） | 新增 `routes/xxx.routes.js` + `routes/index.js` 一行 |
| 查「某个阈值是哪来的」 | 全仓库 grep 数字 | 打开一个 JSON |

---

## 五、模块划分与文件映射

### 5.1 后端：现有文件 → 新位置

| 现有 | 行数 | 新位置 | 备注 |
| --- | --- | --- | --- |
| `server.js` 的 multer/白名单/文件名还原 | 39-64 | `modules/ingestion/upload.middleware.js` | `decodeFilename` 下沉 `shared/utils/text.js` |
| `server.js` 的 `POST /api/jobs` 主体 | 71-149 | `modules/ingestion/{validate-file,service}.js` | 探测 → 拦截 → 建 job → 搬目录 → 入队，四步各自可测 |
| `server.js` 其余 29 处路由 | 151-571 | `routes/*.routes.js` | `fail()` → `shared/http.js` |
| `server.js` 启动清理 | 584-641 | `bootstrap/{recover-interrupted,cleanup-orphan-jobs}.js` | |
| `server.js` 配置告警 | 643-659 | `config/env.schema.js` + `bootstrap/index.js` | 告警文案与取值点合并 |
| `db.js` 建表 / ensureColumns | 15-172 | `data/db/schema.js` | 声明式表定义 |
| `db.js` 各表 CRUD | 178-710 | `data/db/repositories/*.repo.js` | 按表拆 7 个文件 |
| `db.js` 模板业务守卫 | 556-641 | `modules/templates/service.js` | 系统模板锁定、重名、事务编排上移 |
| `db.js` `migrateLegacySummaries` | 723-772 | `bootstrap/migrate.js` | 一次性动作，不留在仓储层 |
| `db.js` `ensureBuiltinTemplates` | 482-508 | `bootstrap/sync-builtin-templates.js` | |
| `jobs.js` 队列/取消/续跑 | 25-40,439-454 | `transcription/{queue,controls}.js` | |
| `jobs.js` 切点与护栏 | 42-60,127-191 | `transcription/{chunk-plan,quality-guard}.js` | |
| `jobs.js` MIMO 通道 | 74-191 | `transcription/mimo-runner.js` | |
| `jobs.js` 离线分离通道 | 197-291 | `transcription/diarize-runner.js` | |
| `jobs.js` 落记录 | 294-338 | `transcription/persist-record.js` | ★ 同时被 `recording/finalize.js` 复用，消除重复 |
| `summary.js` 事件流/分块 | 61-137 | `minutes/event-stream.js` | |
| `summary.js` LLM + map-reduce | 30-59,187-304 | `minutes/composer.js` | `chat()` 的 env 读取改 `config` |
| `summary.js` 宽松 JSON | 154-180 | `shared/utils/json.js` | |
| `templates.js` Schema/校验 | 9-146 | `modules/templates/schema.js` | 去掉对 db 的反向依赖 |
| `templates.js` 提示词 | 148-250 | `modules/templates/prompt.js` | |
| `templates.js` 归一 / Markdown / 快照 | 252-469 | `minutes/{normalizer,markdown}.js` + `templates/presenter.js` | |
| `templates.js` 内置模板常量 | 34-50 | `data/presets/minutes-templates/default.js` | |
| `minutes.js` | 276 | `minutes/{service,selection}.js` | `MinutesError` → `shared/errors.js` |
| `audio.js` | 192 | `modules/audio/{ffmpeg,probe,transcode,silence}.js` | `fmtTime` → `shared/utils/time.js` |
| `asr-mimo.js` | 82 | `modules/asr/mimo.client.js` | 重试改 `utils/retry` |
| `asr-bailian.js` | 199 | `modules/asr/bailian-stream.client.js` | |
| `bailian-offline.js` | 321 | `modules/asr/{bailian-filetrans.client,oss-uploader,diarization-quality}.js` | |
| `recorder.js` | 114 | `modules/audio/wav-writer.js` | 删 `estimateWavBytes` |
| `realtime.js` | 539 | `modules/recording/{gateway,session,relay,finalize}.js` | 删未用导出的 `FRAME_MS` |

### 5.2 前端：`app.js` 行区间 → 新模块

| 现有行区间 | 内容 | 新模块 |
| --- | --- | --- |
| 1-155 | `$`/`$$`、views、约 90 个 DOM 常量、state、clientId、收藏 | `core/{dom,store,storage}.js`、`features/records/favorites.js` |
| 156-211 | format×4、showError、escape、switchView | `core/{format,toast,router}.js` |
| 213-451 | 记录列表、搜索、tab、分页、视图切换、批量选择 | `features/records/{page,list,selection}.js` |
| 453-577 | 弹窗、确认框、分离开关、2h 拦截 | `components/{modal,confirm}.js`、`features/upload/diarize.js` |
| 579-866 | 上传视图、时长探测、进度卡片、轮询、取消 | `features/upload/{page,progress}.js` |
| 868-1099 | 详情渲染、元信息、转写行、分离横幅、旧记录降级 | `features/detail/{page,transcript}.js` |
| 1101-1425 | 纪要版本、轮询、tabs、正文渲染、生成/切换/删除 | `features/minutes/{panel,tabs,render,actions}.js` |
| 1427-1649 | 定位播放、说话人改名、收藏、删除、导出、复制 | `features/detail/{player,speaker-rename,export}.js`、`components/copy.js` |
| 1651-2587 | 录音工作台全部（时钟、时间轴、采音、字幕、标记、本地恢复、收尾） | `features/recording/*` 七个文件 |
| 2591-2594 | 初始化 | `main.js` |
| 2596-3063 | 模板管理页、选择浮层、编辑浮层 | `features/templates/{page,picker,editor}.js` |

### 5.3 需要抽取的公共能力（对应要求 2）

| 公共模块 | 合并来源 | 使用者 |
| --- | --- | --- |
| `shared/utils/retry.js` | `asr-mimo:11`、`asr-bailian:181`、`bailian-offline:255` | 3 个 ASR 适配层 |
| `shared/utils/pool.js` | `jobs:116`、`summary:232`、`scripts/transcribe:24` | 转写、纪要、CLI |
| `shared/utils/json.js` | `summary:154-180` | 纪要、模板、测试 |
| `shared/utils/time.js` | `audio:181`、`db:174` | 纪要、路由、脚本、前端（同名实现） |
| `shared/utils/text.js` | `server.js:40` `decodeFilename`、`jobs:49` `stripExt` | 上传、转写 |
| `shared/errors.js` + `shared/http.js` | `TemplateError`、`MinutesError`、`server.js:249 fail`、各处手写响应 | 全部路由与业务层 |
| `components/{modal,confirm,switch,icons}` | `app.js:455-577` 等 | 4 个 feature 共用 |
| `core/{api,storage,format}` | 全站重复的 fetch / 键名 / 格式化 | 全部 feature |

---

## 六、模块间对应关系

### 6.1 允许的调用矩阵（✓ 允许，— 禁止）

| ↓调用者 \ 被调者→ | routes | modules | data | config | shared |
| --- | --- | --- | --- | --- | --- |
| routes | — | ✓（仅 index） | — | ✓ | ✓（http/errors） |
| modules | — | ✓（仅 index，单向） | ✓ | ✓ | ✓ |
| data | — | — | ✓（repo 间不互调） | ✓ | ✓ |
| config | — | — | — | — | ✓ |
| shared | — | — | — | — | ✓ |

### 6.2 现状中必须保留的跨模块方向

| 方向 | 现状 | 目标形态 |
| --- | --- | --- |
| `transcription → minutes` | `jobs.js:410` 任务完成后异步 `generateMinutes({ jobId })` | `job-runner` 完成后调 `minutes/index.js` 的 `autoGenerate()`；仅此一条单向边 |
| `recording → transcription` | `realtime.js:353` 自己重新拼一遍 record 写入 | 复用 `transcription/persist-record.js`，消除两份「合并文本 + 建记录」 |
| `templates → data/presets` | `templates.js` 内定义并被 `db.js` 反向 require | `bootstrap` 读 presets 写库；`schema` 不再知道数据库 |
| `minutes → templates` | 直接 require 整个模板库 | 只 require `templates` 门面的 `resolve/snapshot/prompt` |

### 6.3 跨端契约（迁移期间必须保持不变）

- **HTTP**：27 条接口的方法、路径、请求体字段、响应字段全部不变；仅新增 `GET /api/meta`。
- **WS `/ws/record`**：`start / started / connecting / ready / sentence / mark / mark-delete / pause / resume / stop / marker-ack / marker-nack / done / error` 全量保留。
- **DB**：库文件仍是 `server/data/voicerecorder.db`，7 张表与列名不变，`templates.id`（含 `tpl_default`）不变。
- **磁盘**：`server/uploads/`、`server/jobs/<jobId>/audio.wav` 位置不变。
- **脚本入口**：`npm run transcribe / verify:diar / test:offline / test:templates` 命令名与参数不变。

---

## 七、关键迁移要点

### 7.1 分六个阶段，每阶段可独立上线与回滚

| 阶段 | 内容 | 改动面 | 验收 |
| --- | --- | --- | --- |
| **P0 基线** | 打 tag；跑通 `test:offline`、`test:templates`；录 7 条冒烟路径（见 §8） | 0 | 基线全绿 |
| **P1 公共层 + 数据层** | 新建 `shared/`、`src/server/{config,shared,data/presets}`；把魔法数字换成引用常量 | 只替换字面量，不改结构 | diff 中无逻辑变化；两套测试全绿 |
| **P2 仓储拆解** | `db.js` → `connection/schema/transaction/repositories`；旧 `server/db.js` 变 re-export 壳 | 数据层 | 老库直接可开；内置模板 upsert 幂等；删除仍走单事务 |
| **P3 业务模块拆解** | `jobs/audio/asr/minutes/templates/realtime` 按 §5.1 拆；旧文件变壳 | 业务层 | 转写两条通道、分离、录音、纪要全部可用 |
| **P4 路由与入口** | `server.js` → `src/server/{app,index}.js` + `routes/*`；根 `server.js` 变 3 行壳 | 接口层 | 27 条接口 200；`/audio` 支持 Range |
| **P5 前端 ESM 化** | 先 `core` + `components`，再逐个 feature 迁移；每迁一个删一段旧代码 | 前端 | 5 个视图冒烟通过；无控制台报错 |
| **P6 样式与清理** | `style.css` 按层/按 feature 拆；删死代码 | 样式 | 视觉零回归（对比 6 张 docs 截图） |

**P3/P4 用「壳文件」过渡**：旧路径保留 `module.exports = require("../src/server/xxx")`，先让所有调用方照常工作，确认无误后再逐个改 import 并删除壳。这样任何一步出问题都能单独回退。

### 7.2 十条容易踩的坑

1. **路径锚点漂移（最高危）。** `db.js:7` 用 `__dirname` 定位 `server/data`，文件一旦挪到 `src/server/data/db/`，`__dirname` 会指向新深度的目录 —— 用户看到的是「历史记录全没了」。`config/paths.js` 必须**以仓库根为锚**（`path.resolve(__dirname, "../../../..")`）并显式保留 `server/data`、`server/uploads`、`server/jobs` 三个默认值，且启动时打印实际路径。

2. **require 期副作用必须外移。** 现在 `db.js` 被 require 就建表、`jobs.js` 被 require 就建目录。拆分后若顺序变化，可能出现「路由已注册、表还没建」。规则：`index.js` 里 `await runBootstrap()` 完成后才 `app.listen()`；`app.js` 只做装配，不碰磁盘。

3. **CJS / ESM 边界。** 服务端保持 CommonJS（`node:sqlite`、脚本、既有生态）；浏览器用原生 ESM。`shared/` 里**只放 JSON，不放 .js**，两侧各写加载器，任何一侧都不要试图 require/import 另一侧。

4. **前端 ESM 是严格模式。** 拆分后隐式全局、重复声明、`this` 指向都会从「静默容忍」变成「直接报错」。迁移前先给 `app.js` 加 `"use strict"` 跑一遍，能提前暴露全部问题。

5. **静态资源路径一次性改全。** `index.html` 的 `<link>`/`<script>`、「`/pcm-worklet.js`」（`app.js:1970` 的 `addModule`）、以及运行中的 `express.static` 根目录必须同步；`pcm-worklet.js` 必须留在根目录。

6. **双监听器语义不能丢。** `#brandHome` 现在的顺序是「捕获阶段先弹确认、`stopImmediatePropagation` 拦住跳转」。拆成 `router.beforeLeave` 钩子更干净，但必须保证「录音中离开 → 二次确认 → 结束并保存」这一条路径可复现。

7. **内置模板 id 不能变。** `templates.id` 是 `minutes.template_id` 的外键式引用（逻辑外键），改 id 会让老纪要显示「模板已删除」。`default.js` 必须沿用 `tpl_default`。

8. **事务只能有一层。** `node:sqlite` 的 `DatabaseSync` 不支持嵌套事务，现状 `deleteRecords` / `deleteTemplates` 是手写 `BEGIN/COMMIT`。拆 repo 后如果 service 与 repo 都开事务，会直接抛错。规则：只有 `data/db/transaction.js` 的 `withTransaction(fn)` 能发 `BEGIN`，repo 只接受当前连接。

9. **一次 commit 只做一种动作。** P2/P3 是纯移动 + 改 import 路径，**不要**顺手改逻辑或格式化，否则 review 与 `git blame` 全废。用 `git mv` 保留历史。

10. **前端 state 拆分时的隐式耦合。** 现在 `state.record/job/segments/markers/speakers/minutes` 被列表页、详情页、纪要面板、导出共用。先定义 `store` 的分片（`records` / `upload` / `recording` / `detail` / `minutes` / `templates`）与最小读取契约，再搬代码；不要按「谁先写谁先搬」的顺序切。

### 7.3 建议的提交切分（便于逐步验证）

```
refactor(P1): 引入 shared 常量与 config 层，替换魔法数字
refactor(P2): 拆分 db 为 schema/repositories/transaction（旧文件保留壳）
refactor(P3.1): 拆 audio 与 asr 适配层
refactor(P3.2): 拆 transcription（原 jobs.js）
refactor(P3.3): 拆 minutes 与 templates（消除 db↔templates 双向依赖）
refactor(P3.4): 拆 recording（原 realtime.js）
refactor(P4): 路由分文件，server.js → app.js + index.js
refactor(P5.1): 前端 ESM 化 —— core 与 components
refactor(P5.2): features/records + upload
refactor(P5.3): features/recording
refactor(P5.4): features/detail + minutes
refactor(P5.5): features/templates，删除旧 app.js
refactor(P6): 样式分层拆分，清理死代码
```

---

## 八、验收标准

**自动化（每阶段必跑）**

```bash
npm run test:offline      # 归一化 / 质量判定 / 纪要事件流
npm run test:templates    # 默认模板等价性 / 校验 / 按 key 回填
npm run verify:diar -- testData/录音.m4a --speakers 2   # 联网门禁，仅 P3 后跑一次
```

**手工冒烟 7 条（P0 录制，之后每阶段复跑）**

1. 上传音频 + 自动纪要 → 详情页有分段、有纪要、可播放跳转
2. 上传禁用自动纪要 → 详情页点「生成会议纪要」→ 用另一模板「＋ 再生成一份」→ 两个胶囊可切换
3. 打开「区分说话人」→ 出现说话人 chip → 改名后分段同步
4. 实时录音 → 打 3 条标记（含暂停中一条）→ 结束 → 详情页标记与时间轴对齐
5. 模板页：新建 / 编辑 / 复制 / 批量删除 / 系统模板不可删
6. 列表页：搜索、分页、全选、批量删除（连带清任务目录）
7. 导出 Markdown，文件名形如 `标题-模板名-1030-0918.md`

**结构性指标（重构完成后）**

| 指标 | 现在 | 目标 |
| --- | --- | --- |
| 单文件最大行数（后端） | 838 | ≤ 200 |
| 单文件最大行数（前端） | 3063 | ≤ 400 |
| `process.env` 读取点 | 26 处 / 8 文件 | 1 处（`config/index.js`） |
| 同一常量出现份数（2h 上限 / 6 色 / 模型名） | 4 / 2 / 3 | 1 / 1 / 1 |
| 新增内置模板改动文件数 | 2-3 | 1 |
| 新增一个 API 改动文件数 | 1（大文件） | 2（新 routes + 注册一行） |

---

## 九、附：三个常见改动的操作路径（改造后）

**加一个内置模板**
`data/presets/minutes-templates/quarterly.js` 写一个对象 → 重启，`index.js` 自动收录、`sync-builtin-templates` 幂等 upsert。前端零改动（从 `/api/templates` 读）。

**把分离上限从 2h 调到 3h**
改 `shared/constants/limits.json` 一个数字 → 服务端拦截、前端置灰阈值、页面提示文案同时生效。

**加一个识别引擎**
新增 `modules/asr/xxx.client.js`（导出 `transcribe({ filePath, language })`）→ 在 `asr/index.js` 注册 → `engines.json` 补默认模型名与超时 → `transcription/mimo-runner.js` 里按引擎名取通道。

---

# 实施结果（2026-10-30 完成）

方案已按 P0–P6 全部落地，对外行为保持不变：HTTP 契约、WS 协议、数据库文件、运行目录、npm 命令全部未变。

## 各阶段与验收

| 阶段 | 内容 | 当阶段验收 |
| --- | --- | --- |
| P0 | 固化基线：新增 `smoke-http.js`（接口契约）与 `smoke-ui.js`（无头浏览器） | 13 + 18 单测、52 接口、25 界面全绿 |
| P1 | `shared/` 常量与文案、`config/`（26 处 env 收敛为 1 处）、`shared/` 公共工具 | 52 + 25 全绿；前后端阈值同源 |
| P2 | `db.js` → connection / schema / transaction / 7 个 repositories；业务守卫上移 service | 级联删除 6 张表清空、批量删模板跳过系统模板、老库直开 |
| P3 | audio / asr / transcription / minutes / templates / recording 六域拆分，消除 `db ⇄ templates` | 13 + 18 + 52 + 25 全绿；真实调用一次纪要生成成功；录音收尾函数级验证 |
| P4 | `server.js` → `app.js` + `routes/*` + `index.js` + `bootstrap/*` | 56 接口全绿；格式拦截仍为 400；`/api/meta` 上线 |
| P5 | `app.js`(3063) → 32 个 ESM 模块 + 事件总线解耦 | 38 项界面全绿；`SMOKE_RECORD=1` 时 47 项，含真实录音/字幕/标记/收尾/回放 |
| P6 | 样式拆 5 文件（内容逐字校验一致）、删除死代码与全部兼容壳 | 13 + 18 + 56 + 38 全绿；截图确认样式无回归 |

## 与方案的偏差（均为降低风险）

1. **录音域拆成 3 个文件而非 7 个。** `session.js`（状态机 + 中继）/ `pcm-capture.js` / `timeline.js`。实时录音的标记草稿、本地恢复与 DOM 绑定耦合紧密，过度切分只会增加 import 出错面。已用假麦克风跑通全链路验证。
2. **前端保留单一 `state` 树。** 字段名与原实现一致，读写分散在各 feature。相比按域拆分多个 store，这样回归风险最低，且仍满足「单一数据来源」。
3. **样式按原历史分块切分，不重新归类选择器。** 2663 行 CSS 存在跨块的层叠覆盖，重排会改变优先级。切分后做了「拼接内容 == 原文」的逐字校验。
4. **新增 `GET /api/meta`。** 这是零构建前提下让前后端共用 `shared/` 的唯一低成本方式；失败时前端退化为内置兜底，不影响可用性。

## 最终指标

| 指标 | 重构前 | 重构后 |
| --- | --- | --- |
| 后端最大文件 | `db.js` 838 行 | `recording/session.js` 359 行 |
| 入口文件 | `server.js` 659 行 / 30 处注册 | `app.js` 24 行 + 6 个路由文件 |
| 前端最大文件 | `app.js` 3063 行 | `recording/page.js` 804 行 |
| 前端文件数 | 1 | 32（core 9 / components 3 / features 19 / main 1） |
| `process.env` 读取点 | 26 处 / 8 文件 | 1 处（`config/index.js`） |
| 「分离 2 小时」出现份数 | 4 | 1（`limits.json`） |
| 「说话人 6 色」出现份数 | 2 | 1（`speakers.json`） |
| 默认模型名出现份数 | 3 | 1（`engines.json`） |
| 重试实现 | 3 份 | 1（`shared/utils/retry.js`） |
| 并发池实现 | 3 份 | 1（`shared/utils/pool.js`） |
| 新增内置模板 | 改 2–3 处 | 新增 1 个文件 |
| 回归测试 | 31 项单测 | 31 单测 + 56 接口 + 38 界面（+9 录音） |

## 后续可做（本次未动）

- `records.summary_json` / `summary_text` 已停止写入但保留，可按原计划再留一个版本后删除。
- `minutes` 的「标记去向」文案目前前端按 `shared/copy/minute-labels.json` 渲染，可进一步由服务端在 DTO 里直接给出 `usedLabel`，前端就完全不需要这段判断。
- `smoke-ui.js` 依赖本机 Playwright 的 chromium headless_shell；换机器时若找不到会跳过界面冒烟（不报失败）。
