# VoiceScribe 声记

**录屏、长音频、实时录音 → 文字 → 结构化会议纪要**，一个在自己电脑上跑的会议纪要工作台。

线上会议只拿到录屏？把文件丢进来，它会自动抽音频、切片转写、整理成带时间戳的会议纪要；开会时也可以直接开麦克风实时转字幕，结束后一键出纪要。

- 全程本机运行，`127.0.0.1` 单用户，音频与密钥不出内网
- 静态文件默认用 MIMO ASR；开启「区分说话人」后改走百炼离线分离；实时录音用百炼流式识别
- 录音页是三区工作台：顶部时间轴、左侧实时转写、右侧用户标记（回车成条，时间自动对齐）
- 结果落 SQLite，支持搜索、收藏、详情回放、说话人改名、批量删除

> 「区分说话人」本期只作用于**静态文件**。实时流式模型不返回说话人，录音页的开关保留但锁定，点击会说明原因。

---

## 功能特性

### 三个入口

| 入口 | 适用场景 | 处理方式 |
| --- | --- | --- |
| **上传视频** | 会议录屏、回放（mp4 / mov / mkv / avi / webm…） | 自动抽音轨 → 转写 → 纪要 |
| **上传音频** | mp3 / m4a / wav / ogg / flac 等录音文件 | 静音对齐切片 → 转写 → 纪要 |
| **实时录音** | 现场会议、访谈、语音备忘 | 浏览器采音 → 服务端代理百炼流式识别 → 实时字幕 → 结束生成纪要 |

### 长音频处理

- 按 **30 秒**切片（实测 MIMO 在 45s 开始截断、90s 几乎失效），切片点对齐静音段，避免切在字中间
- 并发 4 片转写，串行队列排队，避免多个 ffmpeg 抢 CPU
- **字率护栏**：某片字数低于 1.2 字/秒判为模型退化，自动改用百炼流式兜底
- 断点续跑：切点由音频内容决定、可复现，服务重启后点「继续处理」只补未完成的片
- 支持取消、状态与进度实时回传（探测 → 抽音频 → 切片 → 转写 → 纪要）

### 区分说话人（静态文件）

- 上传页开关：关 → MIMO 切片转写；开 → 百炼 `qwen-audio-3.0-asr-flash-filetrans` 整文件异步识别
- 离线通道四步：取上传凭证 → 直传 `oss://` → 提交异步任务 → 轮询取结果；一次任务内说话人编号全局稳定
- 可选「参会人数」提示（自动 / 2~6+），用于收敛自动聚类偏多的情况
- 结果异常显式暴露：只有一个编号 → 判「分离未生效」，文本照用但提示；编号过多 → 判「疑似过度聚类」，可重跑
- 详情页可给说话人改名（如「说话人2」→「张总」），纪要里的负责人会跟着用真名
- 上线前先验证模型：`npm run verify:diar -- <双人对话音频> --speakers 2`

### 实时录音工作台

- 三区布局：顶部时间轴（波形 / 播放头 / 标记钉）、左侧实时转写、右侧用户标记
- 标记：首次键入锁定音频时间戳并实时显示「开始于 00:12:43」，回车成条；中文输入法选词回车不会误提交
- 标记与字幕共用同一条音频时钟，暂停时时间轴冻结，暂停期间记的标记落在暂停点
- 录音音频边录边落盘，详情页可直接回放、点时间戳跳转
- 纪要生成时标记作为高优先级上下文注入，并单独输出「现场标记」一节，逐条标注是否被采纳

### 会议纪要

- map-reduce 两段式：每 ~1800 字先出分片摘要，再合成结构化结果（长会议不会只总结开头）
- 输出结构：主题 / 分点内容 / 决议 / 待办（带原文时间戳）/ 参会人
- 同时生成 Markdown，可一键复制或导出
- 纪要失败不影响转写结果，可在详情页重试

### 记录工作台

- 最近 / 我的 / 收藏三个 tab，关键词搜索，列表与网格两种视图
- 分页加载（加载更多）
- 行首复选框 + 表头全选，选中后底部浮出批量操作条，可一次删除多条记录（连带清理任务目录）
- 详情页：分段时间轴转写、音频播放器（点时间戳跳转）、收藏、删除、重新生成纪要

---

## 环境要求

| 依赖 | 版本 / 说明 |
| --- | --- |
| Node.js | **≥ 22.13**（依赖内置 `node:sqlite`，无需安装数据库；本项目在 v22.22 实测） |
| ffmpeg | 需在 PATH 中，用于探测、抽音频、切片（本项目在 9.0.1 实测） |
| 网络 | 能访问 MIMO 接口与阿里云百炼 WebSocket |

---

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

```bash
cp .env.example .env
```

然后填入自己的凭证：

| 变量 | 用途 | 示例 |
| --- | --- | --- |
| `MIMO_API_KEY` | MIMO 接口密钥（转写 + 纪要共用） | `sk-...` |
| `MIMO_API_URL` | MIMO Chat Completions 地址 | `https://api.xiaomimimo.com/v1/chat/completions` |
| `MIMO_ASR_MODEL` | 静态文件转写模型 | `mimo-v2.5-asr` |
| `MIMO_SUMMARY_MODEL` | 纪要生成模型 | `mimo-v2.6-flash` |
| `DASHSCOPE_API_KEY` | 百炼密钥（实时录音 + 转写兜底） | `sk-...` |
| `BAILIAN_WS_HOST` | 百炼 workspace 专属域名 | `{WorkspaceId}.cn-beijing.maas.aliyuncs.com` |
| `BAILIAN_WORKSPACE` | 百炼 workspace id | `{WorkspaceId}` |
| `ASR_MODEL` | 百炼流式识别模型 | `qwen-audio-3.0-asr-flash-streaming` |
| `DIAR_MODEL` | 静态文件的说话人分离模型 | `qwen-audio-3.0-asr-flash-filetrans` |
| `PORT` | 服务端口，默认 3000 | `3000` |

> 百炼的三项参数都来自控制台下载的 `apiKey-*.csv`（`apiKey` / `apiHost` / `workspaceId`）。
> 缺少 MIMO 配置时启动会告警转写不可用；缺少百炼配置时告警实时录音不可用。

### 3. 启动

```bash
npm start          # 等价于 npm run dev
```

看到下面两行即为成功：

```
服务器运行在 http://127.0.0.1:3000
```

### 4. 打开

浏览器访问 <http://127.0.0.1:3000>。

> 服务只监听 `127.0.0.1`，局域网内其他设备访问不到，这是刻意的设计。
>
> `npm start` 里带了 `NODE_TLS_REJECT_UNAUTHORIZED=0`：本机上游网络经代理转发出局，会拦截证书校验，不开这个开关请求 ASR 接口会直接失败。若你的网络直连正常，可去掉该前缀。

---

## 使用说明

### 上传视频 / 音频

1. 首页点「上传视频」或「上传音频」
2. 拖拽或选择文件（单文件最大 **2GB**，时长上限 **4 小时**，超限会在上传阶段直接拒绝）
3. 选择输出类型：**会议纪要**（转写 + 结构化纪要）或 **仅转写**
4. 选择识别语言（自动 / 中文 / 英文 / 日语 / 韩语）
5. 点「开始处理」，页面显示阶段、百分比、切片进度；可随时「取消任务」
6. 完成后自动进入详情页，可复制全文、播放音频、点时间戳定位、导出 Markdown

### 实时录音

1. 首页点「实时录音」，浏览器会请求麦克风权限
2. 「暂停」只停止推流，恢复后时间轴自动跳过暂停区间（音频时钟按已推入的 PCM 时长计，不是墙钟）
3. 字幕逐句出现在下方，说话中的句子会原地覆盖为终稿
4. 「结束并生成纪要」→ 自动落成一条记录并生成纪要

> 单任务每 20 分钟做一次连接轮转，规避长连接不稳定；时间轴跨轮转保持连续。

### 批量删除

列表行首勾选，或点表头复选框全选当前列表 → 底部浮出操作条显示已选数量 → 「删除」并二次确认后清理记录、分片与任务目录。

---

## 目录结构

```
voicerecorder/
├── server.js                 # Express 入口：路由、上传、静态资源、WS 挂载
├── package.json
├── .env.example              # 环境变量模板
│
├── server/                   # 后端核心
│   ├── audio.js              # ffmpeg 封装：probe / 抽 wav / 静音检测 / 切片 / PCM
│   ├── asr-mimo.js           # MIMO 转写适配层（仅短片段，带退避重试）
│   ├── asr-bailian.js        # 百炼流式识别：run-task → 推 PCM → finish-task
│   ├── realtime.js           # /ws/record：浏览器 ↔ 服务端 ↔ 百炼，录音会话与轮转
│   ├── jobs.js               # 任务状态机、串行队列、并发切片、字率护栏、续跑
│   ├── summary.js            # 会议纪要 map-reduce 与 Markdown 渲染
│   ├── db.js                 # node:sqlite：records / jobs / segments 表与读写
│   ├── data/                 # SQLite 数据库文件（gitignore）
│   ├── uploads/              # 上传暂存（gitignore）
│   └── jobs/<jobId>/         # 每个任务的工作目录：audio.wav、切片临时文件（gitignore）
│
├── public/                   # 前端（原生 JS，无构建步骤）
│   ├── index.html            # 四个视图：首页 / 上传 / 录音 / 详情
│   ├── app.js                # 视图切换、任务轮询、录音、列表与批量操作
│   ├── pcm-worklet.js        # AudioWorklet：16kHz 降采样采集
│   └── style.css             # 设计令牌与全部组件样式
│
├── scripts/
│   └── transcribe.js         # 命令行批处理工具（走百炼，输出 json + txt）
│
├── docs/
│   ├── meeting-recording-pipeline.md   # 录屏转写技术方案与实测结论
│   ├── meeting-minutes-ui-plan.md      # 功能与界面优化实施计划（v4）
│   └── backend-persistence.md          # 后端持久化方案
│
└── testData/                 # 本地测试音频（gitignore）
```

### 数据表

| 表 | 作用 |
| --- | --- |
| `records` | 记录主表：标题、摘要、来源、时长、转写全文、纪要文本、结构化纪要 JSON |
| `jobs` | 任务表：状态、阶段、进度、切片总数/已完成、源文件与 wav 路径 |
| `segments` | 切片表：每片起止时间、文本、引擎（mimo / bailian_stream / skip_silence） |

---

## 处理流程

```
上传文件
  └─ probe 探测时长/音轨（超 4h 直接拒绝，无音轨直接报错）
      └─ 抽取 16kHz 单声道 wav
          └─ 静音检测 → 规划 30s 切点（对齐全片）
              └─ 并发 4 片转写
                   ├─ MIMO 转写 → 字率护栏通过 → 落 segment
                   └─ 护栏不过 / 报错 → 百炼流式兜底 → 落 segment
                       └─ 合并全文 → 写入 records
                           └─ 输出类型为「纪要」→ map-reduce 生成结构化纪要
```

实时录音走另一条链路：浏览器 AudioWorklet 采 16k PCM → 本机 WS `/ws/record` → 服务端代理百炼（密钥不下发浏览器）→ 逐句回推字幕 → 结束时把句子写成 `segments` + `records`。

---

## 接口一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/jobs` | 上传文件并创建任务（multipart：`file` / `output` / `language` / `diarize` / `speakerCount`） |
| `GET` | `/api/jobs/:id` | 任务状态、进度、切片、标记、说话人名册、关联记录 |
| `POST` | `/api/jobs/:id/cancel` | 取消任务 |
| `POST` | `/api/jobs/:id/resume` | 断点续跑 |
| `POST` | `/api/jobs/:id/summary` | 基于已有转写重新生成纪要（自动带上标记） |
| `POST` | `/api/jobs/:id/diarize` | 对已有音频重新做说话人分离 |
| `PATCH` | `/api/jobs/:id/speakers` | 说话人改名（`{ localId, label }`） |
| `DELETE` | `/api/jobs/:id/markers/:markerId` | 删除单条标记 |
| `GET` | `/api/jobs/:id/audio` | 播放用 wav（支持 Range；录音记录首次可用） |
| `WS` | `/ws/record` | 实时录音通道（`started` / `ready` / `sentence` / `mark` / `paused` / `resumed` / `done` / `error`） |
| `GET` | `/api/records` | 记录列表（`q` / `page` / `pageSize`） |
| `GET` | `/api/records/:id` | 记录详情 |
| `POST` | `/api/records` | 新建记录 |
| `PATCH` | `/api/records/:id` | 更新记录 |
| `POST` | `/api/records/batch-delete` | 批量删除（`{ ids: [] }`） |
| `DELETE` | `/api/records/:id` | 删除单条（连带清理任务目录） |
| `POST` | `/api/meeting-summary` | 对纯文本重新生成纪要（兼容老记录） |

---

## 命令行工具

不想开网页时，可以直接用脚本批处理（走百炼流式识别）：

```bash
node scripts/transcribe.js testData/录音.m4a
node scripts/transcribe.js 会议录屏.mp4 --chunk 900 --concurrency 3 --lang zh
```

| 参数 | 说明 |
| --- | --- |
| `--out` | 输出目录，默认 `./workspace/<文件名>-<时间戳>/` |
| `--chunk` | 切片时长（秒），默认 900 |
| `--concurrency` | 并发数，默认 3 |
| `--speed` | 推送速度倍率，默认 4 |
| `--lang` | 语言，默认 `zh` |
| `--vocab` | 热词，逗号分隔 |
| `--keep-temp` | 保留临时 PCM |

输出 `transcript.json`（含句级时间戳）与 `transcript.txt`（`[mm:ss] 文本`）。

---

## 已知限制

- **实时录音不做说话人分离**：流式模型不返回 `speaker_id`，录音页开关保留但锁定。需要分离时把音频作为文件上传处理。
- **分离开启后音频上限 2 小时**：超过时开关置灰。分离走百炼离线任务（临时上传 `oss://` → 异步识别 → 轮询），失败时文本照用，只是没有说话人标签。
- **分离效果需先验证**：`qwen-audio-3.0-asr-flash-filetrans` 的 `speaker_id` 在本 workspace 曾实测恒为 0。上线前先跑 `npm run verify:diar -- <双人对话音频> --speakers 2`；仍恒 0 就把 `DIAR_MODEL` 换成 `paraformer-v2`，调用序列不用改。
- 单文件上限 2GB / 4 小时，超出请先裁剪
- 录音与转写强依赖网络；百炼连接失败会断流报错，不会静默丢字
- 录音音频会落盘到 `server/jobs/<id>/audio.wav`（约 115MB/小时），随记录删除一起清理
- 服务重启会把运行中的任务标记为中断，需在详情页手动「继续处理」；中断的录音会话会被清理半截音频，已提交的标记保留
- 收藏仅存浏览器 `localStorage`，换浏览器或清缓存后会丢失

---

## 相关文档

- [录屏转写技术方案](docs/meeting-recording-pipeline.md) — 实测结论、切片策略、两种引擎的取舍
- [UI 实施计划 v4](docs/meeting-minutes-ui-plan.md) — 布局、按钮时机与状态、任务拆解
- [后端持久化方案](docs/backend-persistence.md) — 数据表设计与接口演进

---

## License

[MIT](LICENSE) © 2026 JRLionel
