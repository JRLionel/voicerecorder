# 说话人分离 + 三区录音界面 · 实现计划（v2）

> 版本：v2 ｜ 相对 v1 的核心变化：**分离从「实时录音两遍式」改为「静态文件异步分离」，录音不做分离**
> v1 的分片 flash + 跨片指认方案整体作废（原因见附录 A），录音侧回落为「流式字幕 + 用户标记」
> 前置：`docs/meeting-minutes-ui-plan.md`（v4）。本文恢复 v4 删掉的离线识别通道，但只服务于分离场景。

---

## 0. 本版结论

### 0.1 三条链路，各用一种模型

| 场景 | 模型 | 说话人 | 说明 |
|---|---|---|---|
| 静态音频/视频，开关**关** | `mimo-v2.5-asr` | ❌ | 沿用现有：30s 静音切片 + 并发 4 |
| 静态音频/视频，开关**开** | `qwen-audio-3.0-asr-flash-filetrans` | ✅ `diarization_enabled` | 整文件异步：上传 → 提交 → 轮询 |
| 实时录音 | `qwen-audio-3.0-asr-flash-streaming` | ❌（本期不做） | 只用流式字幕，UI 保留开关入口 |

### 0.2 三件事分开看，不要互相牵连

1. **分离**是静态文件的离线能力，和实时录音**没有关系**。实时流式模型不提供 `speaker_id`，所以录音侧不做分离，只把开关按钮留着。
2. **三区录音界面**照做：顶部时间轴 + 左下实时转写 + 右下用户标记。分离缺席不影响这三区的职责。
3. **用户标记**仍然是一等公民数据，独立表、独立时间轴、独立进纪要的一节。它和说话人是两条互不依赖的增强线。

### 0.3 唯一的前置门禁

`qwen-audio-3.0-asr-flash-filetrans` 的分离能力**必须先验证**（§4.6）。历史实测为全 0，与官方文档冲突；两者只能有一个是真的。验证不通过则回退 `paraformer-v2`（已实测正确），其余设计不变。

---

## 1. 现状盘点（已核对代码）

| 模块 | 现状 | 影响 |
|---|---|---|
| `server/jobs.js` | MIMO 30s 切片 + 并发 4 + 字率护栏 + 续跑 | 关开关的路径不动 |
| `server/asr-bailian.js` | 流式 WS，`speaker_id` 恒 null | 录音链路直接复用 |
| `server/realtime.js` | 流式代理；**音频不落盘**；`stop()` 才建 job | 三区界面需要 jobId 起始存在、需要音频回放 |
| `server/db.js` | `segments.speaker_fk` 恒 NULL；无 `markers`/`speakers` 表 | 需加表加列 |
| `server/summary.js` | 只吃 `[时间] 文本` | 需支持说话人与标记两种上下文 |
| `public/index.html` | `#diarizationCard` 为 `is-locked` 占位 | 需解锁为真开关 + 人数选择 |
| v3 的离线通道 | **代码已在 v4 删除**，但调用序列完整记录在文档附录 | 需要重新实现（约 200 行），不是从零摸索 |

---

## 2. 能力矩阵（只列与本需求相关的）

| 模型 | 协议 | 上限 | 说话人 | 输入方式 |
|---|---|---|---|---|
| `qwen-audio-3.0-asr-flash-streaming` | WebSocket 双向流 | 无限制 | ❌ | PCM 帧 |
| `qwen-audio-3.0-asr-flash-filetrans` | HTTP 异步任务 | 12 小时 / 2GB | ✅ `diarization_enabled` | `file_urls`，支持 `oss://` |
| `mimo-v2.5-asr` | HTTP 同步 | 建议 ≤30s/片 | ❌ | 音频文件 |

约束（来自文档 + v3 实测）：

- **开启分离后建议音频 ≤2 小时**，超过可能识别失败或超时。因此**开关在文件时长 >2h 时置灰**并说明原因。
- `speaker_count` 取值 2~100，只是参考值，不保证输出该人数；不传则自动判断。
- 自动判断会**过度聚类**（v3 实测：10 分钟音频出现 0~8 共 9 个 id）。所以 UI 提供「参会人数（可选，默认自动）」能明显改善结果。
- `oss://` 临时 URL 有效期 48 小时，仅用于本次任务。
- 提交异步任务时 `parameters` **必填**，没有参数也要传 `{}`。
- 必须带 `X-DashScope-OssResourceResolve: enable`，否则 `oss://` 资源不可达。

---

## 3. 架构

### 3.1 静态音频/视频

```
文件 → ffprobe（时长/音轨）
     ├─ 时长 > 4h 或 > 2GB → 拒绝（沿用现有）
     └─ 分离开关？
         ├─ 关：抽 16k wav → silencedetect 30s 切片 → MIMO 并发 4
         │      → 字率护栏（<1.2 字/秒 → 该片走百炼流式兜底）→ segments(无 speaker)
         └─ 开：时长 > 2h → 拒绝并说明
                抽 16k 单声道 wav（不拆声道，分离只支持单声道）
                → 取上传凭证 → 传 OSS → 得 oss://
                → 提交 transcription（diarization_enabled + speaker_count?）
                → 轮询 task_id → 下载 transcription_url
                → transcripts[0].sentences[] → segments(带 speaker)
     → 可选：map-reduce 生成纪要（注入说话人名册）
```

### 3.2 实时录音

```
AudioWorklet 16k → 100ms 帧 → /ws/record → 百炼 streaming
  ├→ sentence 事件 → 左栏实时字幕（无说话人）
  ├→ RecordingSink → jobs/<jobId>/audio.wav（新增）
  └→ mark 上行 → markers（新增）
结束 → 回填 WAV 头 → 流式终稿落 segments → 生成纪要（注入标记）
```

> 录音不做任何分离，也不做「结束后补人」。开关只是占位入口，不产生请求，也不增加计费。

### 3.3 与 v1 的差异

| 项 | v1 | v2 |
|---|---|---|
| 分离对象 | 实时录音 | 静态文件 |
| 分离模型 | `flash` 同步 + 240s 切片 | `filetrans` 异步 + 整文件 |
| 跨片说话人 | 需要重叠指认算法 | **不需要**，一次任务全局编号 |
| 录音音频落盘 | 必需（分离要用） | 仍要做（详情页回放 + 标记对齐），但不再是分离的前置 |
| 录音时长上限 | 影响分离 | 不影响 |

---

## 4. 分离实现（filetrans）

### 4.1 四步调用序列（v3 已跑通，可直接照做）

```js
// 1) 取上传凭证
GET {host}/api/v1/uploads?action=getPolicy&model=qwen-audio-3.0-asr-flash-filetrans
→ { policy, signature, upload_dir, upload_host, oss_access_key_id,
    x_oss_object_acl, x_oss_forbid_overwrite, expire_in_seconds, max_file_size_mb }

// 2) 表单直传 OSS（multipart）
POST {upload_host}
  OSSAccessKeyId / Signature / policy / key  ← 字段顺序不能乱
  success_action_status=200
  file=<wav>
→ oss://{upload_dir}/{filename}

// 3) 提交异步任务
POST {host}/api/v1/services/audio/asr/transcription
  X-DashScope-Async: enable
  X-DashScope-OssResourceResolve: enable
  { model, input:{ file_urls:[oss://...] },
    parameters:{ diarization_enabled:true, ...(speaker_count ? {speaker_count} : {}) } }

// 4) 轮询
GET {host}/api/v1/tasks/{task_id}   // 2s 间隔，上限 5 分钟
→ results[0].transcription_url → 下载 JSON
→ transcripts[0].sentences[{ begin_time, end_time, text, speaker_id }]
```

`host` 复用现有 `BAILIAN_WS_HOST`（同一业务空间专属域名），不新增配置。

### 4.2 结果归一化

```js
{
  idx, startMs: begin_time, endMs: end_time, text,
  speaker: `S${speaker_id}`,          // 全局编号，一次任务内稳定
  engine: "bailian_filetrans",
  status: "done",
}
```

- 句级时间戳直接可用，不需要与别的转写对齐（本路径**只有**这一份结果）。
- 若 `speaker_id` 全为同一个值且句数 > 5 → 判定「分离未生效」，`diarize_status='failed'`，**照常出稿出纪要**，UI 明确提示「本次未能区分说话人」而不是静默。
- 若出现异常多的编号（如 10 分钟 > 8 人）→ 判定过度聚类，`diarize_status='suspect'`，提示用户可指定人数重跑。

### 4.3 说话人名册与重命名

- 生成 `speakers` 行：`local_id = S0/S1…`，`label = 说话人1/2…`，`color` 取 6 色板，`talk_ms` 由句子时长累加。
- 用户在详情页点击 chip 改名为「张总」→ 更新 `speakers.label`，同步刷新 `segments.speaker_label`。
- 改名后已有纪要需要重生成（提示一次，不静默）。

### 4.4 失败与降级

| 失败点 | 行为 | 用户可见 |
|---|---|---|
| 取凭证/上传失败 | 重试 2 次；仍失败则整单失败 | 明确报错 + 「改用不分离重新处理」按钮 |
| 任务 failed | 读 `error_code/message`，同上 | 同左 |
| 轮询超时（5 分钟） | 判失败，保留 task_id 供手动续查 | 提示可稍后重试 |
| `speaker_id` 全同 | 降级为「无说话人」，文本照用 | 黄条「未能区分说话人」 |
| 过度聚类 | 保留结果但标 suspect | 提示「可指定参会人数重跑」 |

**降级不重跑 MIMO**：filetrans 已经返回了文本，分离失效时直接用它的文本，只是丢掉 speaker 字段。省一次全量转写。

### 4.5 与 MIMO 路径的关系

- 两条路径**互斥**，由开关决定，不做「MIMO 转写 + filetrans 只取说话人」的混合（两次全量识别，成本翻倍且时间戳对齐麻烦）。
- 开关切换要清空已选文件之外的状态；已提交的任务不受影响。

### 4.6 ★ 接入前必须验证（P0，不通过就不写业务代码）

历史实测（v3）：

| 音频 | 模型 | 句数 | `speaker_id` 分布 |
|---|---|---|---|
| 93s 双人对话（16 轮交替） | qwen 3.0 filetrans | 18 | `{0:18}` ❌ |
| 374s 同内容循环 | qwen 3.0 filetrans | 83 | `{0:83}` ❌ |
| 93s 双人对话 | qwen **3.1** filetrans | 18 | `{0:18}` ❌ |
| 36s 真人多人 | qwen 3.0 filetrans | 7 | `{0:6, 1:1}` ❌ |
| 93s 双人对话 | **paraformer-v2** | 19 | `{0:10, 1:9}` ✅ |

同参数下 paraformer 生效，说明参数格式没问题，是 qwen filetrans 在该 workspace 下 `speaker_id` 为空实现。

**判定动作**：拿一段**真实双人、逐轮交替、≥90 秒**的音频，走完整四步（含 `oss://` 与 `OssResourceResolve`），看 `speaker_id` 分布。
- 出现 ≥2 个 id 且与轮次对应 → 通过，按本方案实施。
- 仍恒 0 → 把 `DIAR_MODEL` 换成 `paraformer-v2`（调用序列完全相同），UI 加一句「文本质量略低于 MIMO」提示。**其余设计一行不改**。

---

## 5. 数据模型

### 5.1 SQL（`server/db.js`）

```sql
-- 分离名册
CREATE TABLE IF NOT EXISTS speakers (
  id          TEXT PRIMARY KEY,
  job_id      TEXT NOT NULL,
  local_id    TEXT NOT NULL,        -- S0 / S1 ...
  label       TEXT NOT NULL,        -- 说话人1 / 张总
  color       TEXT,
  first_ms    INTEGER,
  talk_ms     INTEGER DEFAULT 0,
  UNIQUE(job_id, local_id)
);

-- 用户标记（仅录音产生）
CREATE TABLE IF NOT EXISTS markers (
  id            TEXT PRIMARY KEY,
  job_id        TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  start_ms      INTEGER NOT NULL,   -- 首次键入的音频时钟
  end_ms        INTEGER,            -- 回车时的音频时钟
  text          TEXT NOT NULL,
  during_pause  INTEGER DEFAULT 0,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_markers_job ON markers(job_id, start_ms);

-- 加列
segments.speaker        TEXT   -- 'S0'，NULL = 无说话人
segments.speaker_label  TEXT   -- 冗余快照
jobs.diarize_status     TEXT   -- off | ok | failed | suspect
jobs.speaker_count      INTEGER
records.speakers_json   TEXT
```

沿用 `ensureColumns` 做幂等迁移；`deleteRecords` 的级联里加入 `markers` / `speakers`。

### 5.2 前端状态（录音）

```js
const rec = {
  jobId: null,
  clock: { audioMs: 0, skewMs: 0, lastFrameAt: 0, paused: false },
  sentences: new Map(),      // id -> {id,startMs,endMs,text,final}
  marks: [],                 // {id,startMs,endMs,text,duringPause,createdAt,synced}
  draft: { active:false, startMs:0, startedWallAt:null, text:"" },
  stage: "idle",             // idle|recording|paused|finalizing|done
};
```

### 5.3 WS 协议新增

| 方向 | 消息 | 说明 |
|---|---|---|
| C→S | `{type:"start", language, output}` | 不传 `diarize`（录音不支持） |
| S→C | `{type:"started", jobId}` | 起始下发 jobId，供标记归属与回放 |
| C→S | `{type:"mark", id, startMs, endMs, text, duringPause, seq}` | 回车即上行 |
| S→C | `{type:"marker-ack", id}` | 幂等确认 |
| S→C | `{type:"stage", stage, progress}` | `finalizing` 等 |

---

## 6. 界面

### 6.1 录音页：三区布局（对齐附图）

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ● 录音中  00:12:43  ▁▂▃▅▇▅▃▂▁▂▄▆█▆▄▂  ▲     ▲          [暂停] [结束]   │  92px
│                     └─ 时间轴 / 已录进度 / 标记钉 ─┘                     │
├───────────────────────────────────────┬──────────────────────────────────┤
│ 实时转写            ⏺ 实时  1,240 字  │ 我的标记              3 条       │
│ 00:00:12  我们先过一下本周进度。      │ ┌ 00:12:43 ─────────────────┐   │
│ 00:00:19  交付这块我这边有两个风险。  │ │ 客户下周来，重点讲交付     │   │
│ 00:00:31  第一是第三方接口还没联调…   │ └───────────────────────────┘   │
│ 00:00:44  那我们把联调提前到周三      │ ┌ 草稿 ─────────────────────┐   │
│                                        │ │ ● 开始于 00:14:05  已 6 秒 │   │
│                                        │ │ [输入…                    ]│   │
│ 已转写 00:12:30 / 已录 00:12:43        │ Enter 提交 · Shift+Enter 换行   │
└───────────────────────────────────────┴──────────────────────────────────┘
        flex 1.15                                  flex 0.85
```

桌面端高度锁死为视口高度，**页面本身不滚动**，只有两个面板内部滚动。输入框永远在视野内。

### 6.2 顶部：时间轴（不是百分比进度条）

录音没有固定总长，所以「进度」用时间轴表达：

| 元素 | 行为 |
|---|---|
| 状态灯 | 录音中红色呼吸；暂停琥珀常亮 |
| 计时 | 音频时钟 `HH:MM:SS`，暂停冻结 |
| 轨道 | 全长 = `max(已录时长, 60s)`，5 分钟一格；Canvas 波形按 2s 聚合，最多 600 柱 |
| 播放头 | 右端竖线，跟随 `audioMs` |
| 标记钉 | 每条标记在对应位置画 ▲；hover 显示文本，点击滚到左栏对应句 |
| 识别追平度 | 轨道下方 1px 细线，通常贴近 100% |
| 按钮 | 暂停/继续、结束并生成纪要（固定右侧） |

### 6.3 左：实时转写

- 每句 `[00:00:12] 文本`，时间戳可点击复制。
- 未定稿句淡色 + 闪烁光标，按 `sentence_id` 原地替换，不新增行。
- **不出现说话人 chip**（本期录音不做分离）。若将来接入，chip 位置已在设计里预留。
- 自动贴底；用户上滚即暂停跟随，回到底部恢复。
- 底部：`已转写 00:12:30 / 已录 00:12:43`。

### 6.4 右：用户标记

- 已提交卡片按 `start_ms` 升序：时间徽章 + 正文 + 编辑/删除。
- 草稿区固定在面板底部：
  - 首行 `● 开始于 00:14:05 · 已输入 6 秒`（开始时间固定，秒数每秒刷新）
  - textarea 3 行自动增高至 8 行
  - 底部 `Enter 提交 · Shift+Enter 换行 · Esc 清空`，右侧字数 `6/2000`
- 暂停期间可继续记，卡片带「暂停中」标。
- **「区分说话人」开关在录音页保留但锁定**：`区分说话人（实时录音暂不支持）`，点击弹说明「结束后可把同一段音频做离线分离」。不产生请求，不计费。

### 6.5 上传页：开关解锁

| 状态 | 表现 |
|---|---|
| 关（默认） | `区分说话人` 关；走 MIMO；耗时不变 |
| 开 | 展开「参会人数」下拉（自动 / 2 / 3 / 4 / 5 / 6+），提示「离线分离，处理时间略长」 |
| 文件 > 2h | 开关置灰，文案「开启分离时上限 2 小时」 |
| 任务进行中 | 锁定，不可切换 |

### 6.6 状态机（录音）

| 状态 | 顶栏 | 左栏 | 右栏 | 允许 |
|---|---|---|---|---|
| `idle` | 大按钮「开始录音」+ 电平条 | 隐藏 | 隐藏 | 开始 |
| `recording` | 计时走动 | 追加字幕 | 可输入 | 暂停/结束/记标记 |
| `paused` | 计时冻结 | 冻结 | 可输入（标 `duringPause`） | 继续/结束 |
| `finalizing` | 「正在收尾…」 | 只读 | 强制提交草稿 | 返回（需确认） |
| `done` | 跳详情页 | — | — | — |

### 6.7 交互细节（必须逐条实现）

1. **中文输入法**：`keydown` 的 `Enter` 在 `event.isComposing === true` 时忽略，否则选词回车会误提交。
2. **首键判定**：`compositionstart` / `keydown`（可打印）/ `input` / `paste` 四者最先触发者锁定 `startMs`，之后不变。
3. **提交**：Enter（非 Shift、非 composing）提交；Shift+Enter 换行；Esc 清空（有内容时二次确认）。
4. **全局键入**：焦点不在输入框时按可打印字符 → 自动聚焦草稿并插入。
5. **空提交**：不产生记录，抖动提示。
6. **离开确认**：录音中返回 → 提示「将结束录音并保存已转写内容」，改为**保存**（现有实现是丢弃，要改）。
7. **响应式**：<900px 折为「转写 / 标记」Tab，草稿区固定底部，切换不丢内容。
8. **可访问性**：字幕容器 `aria-live="off"`，仅新句定稿时用隐藏 `role="status"` 播报；标记卡片 `aria-label="00:12:43 的标记"`；颜色不是唯一区分手段。

---

## 7. 时间戳

### 7.1 两个时钟

| 时钟 | 定义 | 用途 |
|---|---|---|
| **音频时钟** | 已推送 PCM 的累计时长，暂停不前进 | 字幕、标记、纪要的唯一对齐基准 |
| **墙钟** | `Date.now()` | 展示「几点记的」、崩溃恢复 |

### 7.2 采集与精度

- 前端 `rec.audioMs` 每收一帧 100ms PCM 递增 100；首键时刻直接取它，与字幕同源。
- 100ms 精度对会议纪要充分，不做 `performance.now()` 插值。

### 7.3 漂移校正

- 服务端在 `ready` / `paused` / `resumed` 携带 `audioMs`；前端比较本地值，偏差 > 800ms 才修正 `skewMs`。
- 校正只影响此后新增的标记，**已提交的不回改**（避免时间跳变）。

### 7.4 显示规则

| 场景 | 显示 |
|---|---|
| 顶栏 | `HH:MM:SS`，小时为 0 时省略 |
| 草稿 | `● 开始于 00:12:43 · 已输入 6 秒` |
| 标记卡 | 徽章 `00:12:43`，hover 显示墙钟 |
| 字幕/纪要 | `[00:12:43]`，与 `summary.js` 的 `fmtTime` 一致 |

### 7.5 边界

| 情况 | 处理 |
|---|---|
| 暂停期间输入 | 时间等于暂停点，标 `during_pause=1`，纪要注明「（暂停时记录）」 |
| 输入跨暂停 | `start_ms` 取开始时刻，`end_ms` 取回车时刻；跨度仅作参考 |
| 刷新/崩溃 | 每条已提交标记写 `localStorage: vs.marks.<jobId>`；重进时提示恢复 |
| 结束时仍在编辑 | 强制提交，`end_ms = 结束时 audioMs` |

---

## 8. 纪要整合

### 8.1 两种上下文，同一套事件流

`buildBlocks()` 从「只吃 segments」改为吃**事件数组**，两种来源都映射成 `{start_ms, kind, speaker, text}`：

```js
// 上传 + 分离
[00:00:12] 张总：我们先过一下本周进度。
[00:00:19] 李工：交付这块我这边有两个风险。

// 录音 + 标记
[00:00:12] 我们先过一下本周进度。
[00:12:43] 【现场标记】客户下周来，重点讲交付。
```

规则：
- 有 `speaker_label` 用标签，否则 `S0`，都没有则不加前缀。
- 标记行加 `【现场标记】` 前缀，**永不参与分块切割**：落在块边界时整体挪到下一块开头。
- 分块仍按 1800 字；map 阶段每块都能看到落在本块时间范围内的标记。

### 8.2 Prompt 增补

```
【关于说话人】
- 每行开头的「说话人N」或人名是说话人标签，可靠；不要凭空推断身份。
- 负责人只能取材料中出现的人名或名册里的名字，否则写「未提及」。

【关于现场标记】（无标记时整段省略）
- 以【现场标记】开头的行是主持人当场记下的重点，优先级高于普通转写内容。
- 每条标记都必须被处理：进入 content/decisions，或转化为 todo；
  确实无关则在 markers 里标 usedIn="unused" 并说明原因。
- 标记含「跟进/确认/发/找/下周/负责」等行动语义时，必须生成 todo。
```

### 8.3 输出结构

```json
{
  "topic": "…",
  "content": ["…"],
  "decisions": ["…"],
  "todos": [{"text": "…", "owner": "张总", "at": "00:14:32", "fromMarker": true}],
  "attendees": ["张总", "李工"],
  "markers": [{"at": "00:12:43", "text": "…", "usedIn": "decisions"}],
  "speakerPoints": [{"speaker": "张总", "points": ["…"]}]
}
```

- `markers` 仅在录音场景出现；`speakerPoints` 仅在分离场景出现；两者都为空时结构退化为现有形态。
- `attendees` 来源顺序：用户重命名过的说话人 > 原文人名 > 空。

### 8.4 Markdown 增节

```markdown
## 现场标记          ← 仅录音
- 00:12:43 客户下周来，重点讲交付 → 已纳入「决议」
- 00:13:20 周三前必须出联调环境 → 已转待办（负责人：李工）
- 00:21:05 这段音质差，回去听 → 未纳入（与议题无关）

## 按人要点          ← 仅分离
- 张总：本周进度、客户来访安排
- 李工：第三方接口风险、联调时间
```

「现场标记」这一节是用户核对标记有没有被吃掉的唯一证据，不能省。

### 8.5 负责人推断

- 待办来自某说话人的句子 → 该说话人已改名则直接取名字。
- 来自标记 → 优先用标记文本里的人名；没有则取前后 30 秒的主要说话人，标 `ownerConfidence:"inferred"`，前端浅色 + 「推断」小标，可一键改。
- 都没有 → 「未提及」。

---

## 9. 详情页

| 区域 | 改动 |
|---|---|
| 顶部 | 有分离时显示「说话人：3 人」；`diarize_status` 非 ok 时黄条 + 「重新标注」 |
| 播放器 | 录音记录首次可播放（WAV 已落盘） |
| 转写 | 连续同人句子合并为「发言块」，块首彩色 chip + 起止时间；chip 可内联改名 |
| 标记 | 录音记录在对应时间点插入高亮卡片，点击跳音频 |
| 纪要 | 两种附加节按场景出现 |
| 导出 | Markdown 一并导出 |

---

## 10. 文件级改动

| 文件 | 改动 | 量级 |
|---|---|---|
| `server/bailian-offline.js` | **新增**：getPolicy → OSS 直传 → 提交 → 轮询 → 归一化 | ~200 行 |
| `server/recorder.js` | **新增**：WAV 落盘、头回填 | ~110 行 |
| `server/jobs.js` | 分支：开关开走 offline，关走 MIMO；阶段与进度 | ~120 行改 |
| `server/realtime.js` | 起始建 job、写 sink、mark 上行、stop 收尾 | ~110 行改 |
| `server/db.js` | 2 张新表、4 个新列、speakers/markers CRUD、级联 | ~120 行 |
| `server/summary.js` | 事件流、prompt、schema、markdown | ~90 行改 |
| `server.js` | 开关参数、详情接口扩展、speakers PATCH | ~50 行 |
| `public/index.html` | 录音三区重构；上传开关解锁 + 人数下拉；详情说话人区 | ~160 行改 |
| `public/style.css` | 三区栅格、时间轴、标记卡、草稿区、响应式 | ~430 行 |
| `public/app.js` | 录音状态机、时间轴 Canvas、IME/回车、增量渲染、WS、详情 | ~420 行改 |
| `.env` | `DIAR_MODEL=qwen-audio-3.0-asr-flash-filetrans` | — |

---

## 11. 阶段与验收

| 阶段 | 内容 | 验收 | 估时 |
|---|---|---|---|
| **P0 门禁** | 双人对话跑通 filetrans 分离 | `speaker_id` 出现 ≥2 个值且与轮次对应；否则切 paraformer | 0.5d |
| P1 | 离线通道（上传→提交→轮询→落库） | 10 分钟双人音频：人数正确、耗时 < 90s、失败可重试 | 2d |
| P2 | 上传页开关 + 人数 + 阶段进度 | 关→MIMO 路径零回归；开→分段进度可见；>2h 置灰 | 1d |
| P3 | 录音三区布局 + 时间轴 | 1280×800 无溢出；暂停/继续/结束可用；300 句不卡 | 2d |
| P4 | 标记链路 + 时间戳 | 首键锁定、回车提交、IME 不误触发、刷新可恢复；误差 ≤200ms | 1.5d |
| P5 | 纪要整合 | 10 条标记全部出现在「现场标记」节；含行动语义 100% 转 todo；说话人进入 owner | 1d |
| P6 | 详情页 + 改名 + 回归 | 上传两条路径、录音链路全部回归通过 | 1d |

合计 **9 个工作日**（P0 不通过则多 0.5d 换模型，总工期不变）。

---

## 12. 风险

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| **filetrans 分离恒 0** | 中（已实测过一次） | 功能名存实亡 | P0 门禁；切 paraformer-v2，调用序列不变 |
| 过度聚类 | 中 | 人数虚高 | 默认可指定人数；`suspect` 状态提示重跑 |
| >2h 音频分离失败 | 中 | 用户等待后失败 | 开关处前置置灰并说明，不做事后报错 |
| OSS 上传字段顺序错 | 低 | 上传 403 | 按 v3 记录的字段顺序实现，单测覆盖 |
| 录音 WAV 占磁盘 | 确定 | 115MB/小时 | 随 job 目录清理；启动时清 7 天前孤儿目录 |
| 三区布局在小屏拥挤 | 中 | 体验差 | <900px 折 Tab；草稿区固定底部 |
| 上传链路回归 | 中 | 已有功能受损 | 开关关闭时走原代码路径，不改 `jobs.js` 的 MIMO 分支逻辑 |

---

## 13. 待确认（2 条，均有默认值）

| # | 决策 | 默认 |
|---|---|---|
| 1 | 录音页的「区分说话人」开关形态 | **锁定可见**：显示为关、点击弹说明「实时暂不支持，可结束后离线分离」 |
| 2 | 分离失败时的兜底 | **保留 filetrans 的文本**，只丢 speaker（不重跑 MIMO，省一次全量识别） |

另：`ASR_MODEL` 维持 `qwen-audio-3.0-asr-flash-streaming` 不动（按你的决定，不升 3.1）。

确认后从 P0 开始：先写一个只跑验证的脚本，不碰业务代码。

---

## 附录 A · v1 方案为什么作废（留档，避免重走）

v1 假设「分离必须在录音侧完成」，于是设计了：240s 切片 → 逐片调 `qwen-audio-3.1-asr-flash` 同步接口 → 30s 重叠 + 共现矩阵跨片指认 → 与流式句对齐合并。

作废原因：

1. **目标选错了**。分离的真实需求在静态文件（会议录音回放、访谈整理），录音场景用户更在意「边开边记」，而不是「谁说的」。
2. **复杂度不成比例**。跨片指认需要重叠窗口、置信度阈值、人工合并 UI，全部是为了绕开「单次请求 5 分钟」的限制；而 filetrans 一次任务就能覆盖 12 小时，这个限制根本不存在。
3. **成本更高**。1 小时会议 = 14 次同步调用 + 14 次音频编解码；filetrans 是 1 次上传 + 1 次任务。

保留下来仍然有效的部分：三区布局、时间戳口径、标记进纪要——这三块与分离无关，已在 v2 沿用。

---

## 附录 B · 实施记录（2026-10-29）

代码层已按本计划落地，69/84 项任务完成；剩余 15 项是需要真实音频/麦克风的验证，留给用户执行。

### 新增文件

| 文件 | 作用 |
|---|---|
| `server/bailian-offline.js` | 取上传凭证 → 直传 OSS → 提交异步任务 → 轮询 → 归一化；含 `analyzeDiarization` 质量判定 |
| `server/recorder.js` | 录音 WAV 落盘：44 字节头占位 + 逐帧追加 + 定点回填长度 |
| `scripts/verify-diarization.js` | P0 门禁脚本，打印 `speaker_id` 分布并给出结论 |
| `scripts/test-offline.js` | 13 项本地单测（归一化 / 判定 / 事件流 / 分块 / Markdown） |

### 与计划的偏差

1. **时间轴改成滚动窗口**：原设计是「全长 = max(已录, 60s)，播放头始终在右端」，实际做出来发现超过 1 分钟后播放头就不动了，读不出「在推进」。改成 5 分钟滚动窗口：不足 5 分钟时播放头从左走到右，超过后窗口整体右移。
2. **时钟校正阈值从 800ms 收到 200ms**：暂停时服务端会补 0.5s 静音促使断句，这 500ms 必须被客户端吸收，否则暂停一次之后所有标记都早半秒。
3. **分离判定失败时清除 speaker 字段**：原计划只是打标提示，实现时改成不写 `speaker`/`speaker_label`——否则整篇顶着「说话人1」，比没有更误导。
4. **本地标记只恢复「started 之前」的部分**：原计划是刷新后恢复全部，但刷新会让服务端会话结束、jobId 变化，把旧标记挂到新录音上会错位。现在只合并 jobId 到达前写入 `pending` 的那几条，宁可不恢复也不张冠李戴。

### 验证入口

```bash
npm run test:offline                      # 13 项静态单测
npm run verify:diar -- <双人对话> --speakers 2   # P0 门禁
```
