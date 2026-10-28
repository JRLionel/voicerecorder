# 录屏文件 → 会议纪要：技术实现方案

> 场景：线上会议只拿到录屏文件（mp4/mov，1~3 小时），需要「抽音频 → 转文字 → 结构化会议纪要」。
> 本文是基于当前 `voicerecorder` 代码现状的方案设计。ASR 已定为阿里云百炼实时流式识别，并已在本机跑通验证。

---

## 0. 已实测结论

链路已用真实录音打通，可执行入口：`npm run transcribe -- <文件>`（实现见 `scripts/transcribe.js`、`server/audio.js`、`server/asr-bailian.js`）。

| 项 | 实测值 |
|---|---|
| WebSocket 端点 | `wss://{workspaceHost}/api-ws/v1/inference`（**workspace 专属域名**，不是 `dashscope.aliyuncs.com`） |
| 鉴权 | `Authorization: bearer <apiKey>` + `X-DashScope-WorkSpace: <workspaceId>` |
| 模型 | `qwen-audio-3.0-asr-flash-streaming`；`qwen-audio-3.1-asr-flash-streaming` 同样可用 |
| 36s 样本 | 3.7x 实时（9.8~13.1s 出结果），3 句，计费 35s |
| 12min 样本 / 3 片并发 | 137s 完成，**5.3x 实时**，42 句，切点前后无重复、无丢句 |
| 时间戳 | 句级 `begin_time/end_time`（ms）+ 字级 `words[]` |
| 说话人 | **不支持**，`speaker_id` 恒为 `null` |
| 单任务时长上限 | 未在文档中说明；单任务 5 分钟已验证，默认 15 分钟/片 |
| 计费 | 按音频 `duration` 秒计，静音也计费 |

---


## 1. 现状核对（代码事实）

| 项 | 当前实现 | 对长会议录屏的影响 |
|---|---|---|
| 上传上限 | `MAX_SIZE = 25MB`（`server.js:21`） | 1h 1080p 录屏 300MB~1.5GB，**直接被拒** |
| 上传存储 | `multer.memoryStorage()` | 大文件全量进内存，**OOM 风险** |
| 转写方式 | 整个音频 base64 成 data URI 一次性请求 | 1h 音频 mp3 ≈ 40MB → base64 ≈ 54MB，**超限且必然超时** |
| 转写同步 | 请求内 `await fetch` 等结果 | 长音频需数分钟，**HTTP 请求超时/前端假死** |
| 时间戳 | 无 | 纪要要点**无法回跳原音频** |
| 说话人 | 无 | 会议纪要**无法区分谁说的** |
| 纪要 | 单次 LLM 调用，纯文本模板 | 长文本**超上下文**，且无法结构化渲染 |

结论：现有链路是「短语音」链路（设计目标是 25MB 以内、几十秒到几分钟的录音），**不能直接用于会议录屏**，需要新增一条长音频管线，而不是改几个参数。

---

## 2. 关键量化约束

| 量 | 数值 | 含义 |
|---|---|---|
| 1h 16kHz 单声道 16bit wav | 16000 × 2 × 3600 ≈ **115MB** | 不能整块送 ASR |
| 1h 音频 mp3 64kbps | ≈ **29MB** | base64 后 38MB，仍超 25MB |
| 8min 16kHz wav | ≈ **15.4MB** | base64 20.5MB，安全 |
| 5min 16kHz wav | ≈ **9.6MB** | base64 12.8MB，最稳 |
| 2h 会议文本量 | 约 2~3 万字，≈ 3~5 万 token | 纪要需 map-reduce |
| 1h 切 15min | 4 片 | 并发 3 → 2 轮 |

→ 分片仍然必要，但**目的变了**：不再是绕开 API 的单次大小限制（流式接口逐帧推送，没有 25MB 概念），而是为了**并行加速**——单片串行只有 3.7x 实时，3 片并发可到 10x 以上。

---

## 3. 总体架构

```
录屏文件
  ↓ ① 探测（ffprobe：时长/音轨/编码/声道）
  ↓ ② 抽音频（ffmpeg：16k 单声道 wav + 增益归一化）
  ↓ ③ 分片（silencedetect 找静音点，≤15min/片）
  ↓ ④ 并行流式转写（每片一条 WebSocket，并发 3，句级时间戳）
  ↓ ⑤ 时间轴合并（chunk.start + 片内 begin_time → [hh:mm:ss]）
  ↓ ⑥ 纪要生成（分片摘要 map → 合并 reduce → JSON 结构化）
  ↓ ⑦ 产物（transcript.txt / transcript.json / minutes.md + 可回跳播放器）
```

核心原则：**每一步都有独立可验证的中间产物**。抽音频和分片不依赖任何 API，可以先跑通并对文件大小、片数、静音分布做人工校验，再接 AI。

---

## 4. 详细设计

### 4.1 探测（必做，成本极低）

```bash
ffprobe -v error -print_format json -show_format -show_streams input.mp4
```

要拿到的字段：`format.duration`、`streams[].codec_type`、`channels`、`sample_rate`、`bit_rate`。

- **没有 audio 流** → 立即失败并明确报错（录屏静音录制是常见坑）
- `channels == 2` → 记录下来，进入 4.5 的双声道判定分支
- 时长 > 3h → 提示分批或降采样

### 4.2 抽音频

```bash
ffmpeg -y -hide_banner -loglevel error -i input.mp4 \
  -map 0:a:0 -vn -sn -dn \
  -ac 1 -ar 16000 -c:a pcm_s16le \
  -af "highpass=f=80,loudnorm=I=-16:TP=-2:LRA=11" \
  out.wav
```

- `-vn` 丢掉视频流，解码成本是主要耗时点（软解 1h 视频约 1~3 分钟，可接受）
- `highpass=f=80` 滤掉空调/风扇低频；`loudnorm` 把远端会议声音拉到统一响度，对 ASR 准确率有实测收益
- 需要极致提速时用 `-ss/-t` 分段并行解码后再拼，但会引入边界问题，一期不做

### 4.3 分片

切在词中间会让该句在片尾被强制收尾、下片开头再出现一次，实测能看到断句破碎。做法（已实现）：

1. 静音检测：`ffmpeg -i audio.wav -af silencedetect=noise=-35dB:d=0.6 -f null -`，解析 stderr 得到静音区间
2. 以 15 分钟为目标（`--chunk` 可调），在 ±35% 目标时长的窗口内选**离目标最近的静音中点**作为切点
3. 窗口内没有静音点（连续讲话）就按目标硬切，**不做重叠**——重叠会让同一句被识别两次，去重比重新断句更麻烦
4. 切片输出裸 PCM（`-f s16le`），不重编码，直接喂 WebSocket
5. 每片校验时长 > 3s；纯静音片可按 RMS 预筛丢弃（静音也计费）

产物：`chunks/chunk_000.pcm`，切点记录在 `transcript.json.chunks`。

### 4.4 转写编排（WebSocket 流式）

不再「切好片一次性 POST」，而是每片独立建一条 WebSocket，按时序驱动：

| 阶段 | 要点 |
|---|---|
| 建连 | `wss://{host}/api-ws/v1/inference`，header 带 `Authorization: bearer` 与 `X-DashScope-WorkSpace` |
| run-task | `payload.task=asr`、`function=recognition`；`parameters.format=pcm`、`sample_rate=16000`，可选 `language_hints` / `vocabulary`（即时热词）/ `max_sentence_silence` |
| 推流 | **必须等 `task-started` 才发音频**；每帧 100ms（3200 字节），按 `speed` 倍速推进；`bufferedAmount > 4MB` 时暂停发送做背压 |
| 收结果 | `result-generated` 中只有 `sentence_end=true` 是终稿；中间结果按 `sentence_id` 覆盖，**不能逐条拼接** |
| 结束 | `finish-task` → `task-finished`，`payload.usage.duration` 即计费秒数 |
| 失败 | `task-failed` 后连接不可复用，必须重建连接重跑该片 |

关键参数与实测结论：

- **推送速度 4x 是甜点**：3x 时端到端只有 2.4x 实时（被推流节奏拖累），6x 也只到 3.7x（服务端处理是瓶颈），默认 4x。
- **并发 3**：限流阈值未知，先保守；12 分钟音频 3 片并发实测 137s，约 5.3x。
- **时间轴**：`abs_ms = chunk.start_ms + sentence.begin_time`，服务端给的就是句级 ms，直接加偏移即可，无需估算。
- **重试**：仅对网络错误 / `task-failed` / 429 重试，指数退避 1s→2s→4s，最多 3 次；401/403/模型未开通立即中止。
- **断点续跑**：每片成功即写库（`chunks.status='done'`），中断只补未完成片，这是长任务能用的前提。
- **连接复用**：`task-finished` 后可同连接再发 `run-task`（换 task_id），但实现复杂、收益有限，一期每片新建连接。


### 4.5 说话人区分（按成本从低到高）

百炼流式接口**不返回说话人**（实测 `speaker_id` 恒为 `null`），只能外部解决：

| 方案 | 做法 | 成本 | 准确度 |
|---|---|---|---|
| A. 双声道拆分 | 若左右声道分别是「系统声/麦克风」，拆声道各转各的，天然分离 | 0 | 高（仅特定录制方式成立） |
| B. 本地 pyannote / WhisperX | Python + HF token，Apple Silicon 可跑 MPS | 中（需 Python 环境） | 高 |
| C. 停顿规则 | 长停顿 + 换人启发式 | 0 | 低 |

一期建议：先做 A 的自动判定（`channels==2` 且两声道相关性低 → 拆）。B/C 留到二期。

### 4.6 纪要生成

不要「2 万字一次性塞进去」，而是两级：

**Map**：每片转写完成后立刻产出 150~250 字分片摘要 + 该片内的待办候选（带时间戳）。可与转写流水线并行，不必等全部转完。

**Reduce**：把所有分片摘要 + 全部待办候选 + 会议元信息（时长、片数、日期）合成终稿。

输出**结构化 JSON**，而不是自由文本，前端才能渲染和导出：

```json
{
  "topic": "",
  "attendees": [{"name": "", "role": ""}],
  "decisions": [{"text": "", "at": "00:12:30"}],
  "todos": [{"task": "", "owner": "", "due": "", "at": "00:45:10"}],
  "risks": [],
  "open_questions": []
}
```

Prompt 硬约束：**不得编造未出现的人名与时间**；`owner` 不明确时填 `"待确认"`；每条 `decisions/todos` 必须带 `at`，便于回跳。

### 4.7 产物

```
workspace/<jobId>/
  source.mp4            原始文件（可配置是否保留）
  audio.wav             抽取后音频（供播放器回跳）
  chunks/               分片
  transcript.txt        纯文本
  transcript.json       带时间轴的分段
  minutes.md            纪要（人读）
  minutes.json          纪要（机读，用于渲染）
  minutes.docx          可选，走 workbuddy-docx
```

---

## 5. 数据模型（新增表，不动 `records`）

```sql
CREATE TABLE media (
  id TEXT PRIMARY KEY, path TEXT NOT NULL, filename TEXT, size INTEGER,
  duration_sec REAL, channels INTEGER, sample_rate INTEGER,
  video_codec TEXT, audio_codec TEXT, created_at TEXT NOT NULL);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY, media_id TEXT NOT NULL, record_id TEXT,
  status TEXT NOT NULL,        -- pending|probing|extracting|splitting|transcribing|summarizing|done|failed
  stage TEXT, progress REAL DEFAULT 0, error TEXT,
  chunk_total INTEGER, chunk_done INTEGER,
  asr_model TEXT, summary_model TEXT,
  created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT);

CREATE TABLE chunks (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL, idx INTEGER,
  start_sec REAL, end_sec REAL, path TEXT,
  status TEXT,                 -- pending|running|done|failed|skipped
  retries INTEGER DEFAULT 0, text TEXT, latency_ms INTEGER, error TEXT);

CREATE TABLE segments (          -- 最终时间轴，供回跳
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL,
  start_sec REAL, end_sec REAL, speaker TEXT, text TEXT);
```

`records` 只加一列 `job_id`，列表/详情页沿用现有逻辑，不需要重写前端。

---

## 6. 接口与入口

```
POST /api/jobs            { path } 或 multipart → 返回 jobId（立即返回，不等结果）
GET  /api/jobs/:id        状态 + 进度（前端每 2s 轮询）
GET  /api/jobs/:id/events SSE 推送进度（更优，可后续加）
GET  /api/jobs/:id/result transcript + minutes
POST /api/jobs/:id/retry  重跑失败片
```

CLI（一期主力入口，绕开上传问题，**已可用**）：

```bash
npm run transcribe -- "/path/会议录屏.mp4" --chunk 900 --concurrency 3
# 可选：--lang zh|en|auto  --vocab "百炼,通义千问"  --speed 4  --out 目录  --keep-temp
```

CLI 直接读本地路径，无上传、无大小限制，是**最快能跑通全链路的形态**。网页上传作为二期。

---

## 7. ASR 方案（已定：百炼实时流式）

| 维度 | 结论 |
|---|---|
| 模型 | `qwen-audio-3.0-asr-flash-streaming`；3.1 可选，多 `vad_model=far_field_meeting_16k`（远场会议）与 `keep_dialect` |
| 端点 | workspace 专属域名，**不是**公共 `dashscope.aliyuncs.com`；四项配置见 `.env.example` |
| 计费 | 按音频 `duration` 秒计，静音也计费 → 纯静音片预筛仍有价值 |
| 时间戳 | 句级 + 字级（`words[]`），可直接支撑纪要回跳 |
| 说话人 | 不支持（`speaker_id` 恒 null） |
| 吞吐 | 单任务 ~3.7x；3 并发约 5~10x，1h 会议约 6~10 分钟 |
| 限流 | 未知，需按错误退避；默认并发 3 |

若后续要换「录音文件识别」（离线批量、原生说话人分离），只需替换 `server/asr-bailian.js` 这一个适配层，`audio.js` 与管线不动。

---

## 8. 分阶段实施（按验收标准切，不给工期）

### P0 事实核查（已完成）
- 实测百炼流式识别：端点、鉴权、模型可用；36s 与 12min 样本均通过（见 §0）
- 已确认：不返回说话人、按秒计费、推送 4x 为甜点、3 片并发约 5.3x
- 剩余未知：**单任务音频时长上限**、**并发限流阈值** → 首次跑真实会议时观察 `task-failed`

### P1 音频管线（无 AI 依赖）✅
- `server/audio.js`：probe / 抽 wav / 静音检测 / 规划切点 / 切片 PCM
- **验收**：任意录屏 → `audio.wav` + 切点列表；无音轨明确报错（12min 样本已验证）

### P2 转写编排 ✅（单机版）
- `server/asr-bailian.js`：run-task → 推流 → 收句 → finish-task，含重试与背压
- **验收**：12min / 3 片并发跑通、时间轴对齐无重复丢句（已完成）
- 待补：`jobs` 表 + 断点续跑 + 失败片清单（当前 CLI 单次执行，中断需重跑）

### P3 时间轴与纪要
- 分段合并落库 + map-reduce 纪要 + JSON schema 校验
- **验收**：纪要 JSON 通过 schema；每条待办带可回跳时间戳；随机抽 5 条对照原音频内容一致

### P4 界面与产物
- 上传改 `diskStorage`（或分片上传）+ 任务进度页 + 播放器点击时间戳跳转 + 导出 md/docx
- **验收**：网页提交 1.5h 录屏，全程不超时、不 OOM，进度可见，产物可下载

### P5 质量优化
- 热词表（`vocabulary` 即时热词，已验证参数可用）、术语后处理替换表、纯静音片预筛、说话人

---

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| 上传 OOM / 25MB 限制 | 一期走 CLI 本地路径；网页二期改 `diskStorage` + 分片上传 |
| ffmpeg 不在部署环境 | 本地已有 9.0.1；容器化用 `ffmpeg-static` 或镜像内 apt/brew 安装 |
| 切点切断词语 | 静音点优先；无静音点时硬切（不做重叠，避免重复识别） |
| 长任务被中断 | 每片落库 + 断点续跑 |
| 人名/术语错字 | 即时热词 `vocabulary` + LLM 后处理统一替代表 |
| 静音段浪费费用 | RMS 预筛丢弃纯静音片 |
| 单任务时长/并发限流未知 | 默认 15min/片、并发 3，遇 `task-failed` 自动降级重试 |
| 会议内容敏感 | 提供纯本地路线（faster-whisper + 本地 LLM），代价是速度与部署复杂度 |
| 纪要幻觉（编造待办） | 结构化输出 + 「无则写无」+ 每条必须带原文时间戳 |

---

## 10. 待决策项

1. **入口形态**：一期只做本地 CLI 批处理，还是同时要网页上传？
2. **纪要模型**：用哪家 LLM 做 map-reduce？现有 `.env` 里是 MIMO，百炼也有 qwen 系列可直连
3. **说话人**：会议纪要是否必须区分「谁说的」？（决定要不要引入 Python 侧 diarization）
4. **数据边界**：会议内容能否出本机？（决定是否必须本地模型）
5. **产物形态**：md 够用，还是要 Word / 自动发企微群？

