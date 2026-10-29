require("dotenv").config();

const express = require("express");
const multer = require("multer");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");

const {
  db,
  createRecord, listRecords, getRecord, updateRecord, deleteRecord, deleteRecords,
  createJob, getJob, updateJob, markInterruptedJobs, listRunningRecordingJobs,
  listSegments, listMarkers, listSpeakers, renameSpeaker, deleteMarker,
} = require("./server/db");
const { probe } = require("./server/audio");
const { enqueue, cancel, detectSourceType, JOBS_DIR, MAX_DIARIZE_SEC } = require("./server/jobs");
const { generateSummary } = require("./server/summary");
const { attachRealtime } = require("./server/realtime");

const app = express();
const PORT = Number(process.env.PORT || 3000);

const MAX_SIZE = 2 * 1024 * 1024 * 1024;    // 2GB
const MAX_DURATION_SEC = 4 * 3600;          // 4 小时

const ALLOWED_EXTENSIONS = new Set([
  ".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".webm", ".amr", ".wma",
  ".mp4", ".mov", ".mkv", ".avi", ".m4v", ".flv", ".ts", ".wmv",
]);

const UPLOAD_DIR = path.join(__dirname, "server", "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(JOBS_DIR, { recursive: true });

/** multer 把非 ASCII 文件名按 latin1 解码，中文会乱码，这里还原一次 */
function decodeFilename(name) {
  try {
    const fixed = Buffer.from(name, "latin1").toString("utf8");
    if (fixed.includes("\uFFFD")) return name;
    return /[\u4e00-\u9fa5]/.test(fixed) || !/[\u4e00-\u9fa5]/.test(name) ? fixed : name;
  } catch {
    return name;
  }
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(decodeFilename(file.originalname)).toLowerCase() || ".bin";
      cb(null, `up_${Date.now()}_${crypto.randomBytes(4).toString("hex")}${ext}`);
    },
  }),
  limits: { fileSize: MAX_SIZE },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(decodeFilename(file.originalname)).toLowerCase();
    if (ALLOWED_EXTENSIONS.has(ext)) return cb(null, true);
    cb(new Error(`不支持的文件格式：${ext || "(无扩展名)"}。支持 ${[...ALLOWED_EXTENSIONS].join(" / ")}`));
  },
});

app.use(express.json({ limit: "8mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ============ 任务（上传 → 转写 → 纪要） ============

app.post("/api/jobs", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: "请选择要上传的文件" });
  }

  const file = req.file;
  const srcPath = file.path;
  const filename = decodeFilename(file.originalname);
  const output = req.body.output === "transcript" ? "transcript" : "summary";
  const language = req.body.language || "auto";
  const diarize = req.body.diarize === "true" || req.body.diarize === true;
  const speakerCount = Number(req.body.speakerCount) || null;

  try {
    // 同步探测：时长超限要立刻拒绝，而不是等任务跑到一半才失败
    const meta = await probe(srcPath);

    if (meta.durationSec > MAX_DURATION_SEC) {
      fs.unlinkSync(srcPath);
      return res.status(400).json({
        success: false,
        error: `音频时长 ${(meta.durationSec / 3600).toFixed(1)} 小时，超过 4 小时上限，请先裁剪`,
      });
    }
    if (!meta.durationSec || meta.durationSec < 1) {
      fs.unlinkSync(srcPath);
      return res.status(400).json({ success: false, error: "音频时长不足 1 秒，无法转写" });
    }
    // 开启分离后官方建议 ≤2h，宁可前置拦截，也别让用户等十分钟再失败
    if (diarize && meta.durationSec > MAX_DIARIZE_SEC) {
      fs.unlinkSync(srcPath);
      return res.status(400).json({
        success: false,
        error: "开启说话人分离时音频上限 2 小时，请先裁剪或关闭开关",
      });
    }

    const job = createJob({
      sourceType: detectSourceType(filename),
      filePath: srcPath,
      filename,
      size: file.size,
      durationMs: Math.round(meta.durationSec * 1000),
      output,
      language,
      engine: diarize ? "bailian_filetrans" : "mimo",
      options: { diarize, speakerCount: diarize ? speakerCount : null },
    });

    // 源文件搬进任务目录，便于按任务清理与回放
    const jobDir = path.join(JOBS_DIR, job.id);
    fs.mkdirSync(jobDir, { recursive: true });
    const moved = path.join(jobDir, path.basename(srcPath));
    try {
      fs.renameSync(srcPath, moved);
      updateJob(job.id, { file_path: moved });
    } catch {
      // 跨设备重命名会失败，退回原路径也能跑
    }

    enqueue(job.id);
    res.json({
      success: true,
      jobId: job.id,
      duration: Math.round(meta.durationSec),
      size: file.size,
      chunks: Math.ceil(meta.durationSec / 30),
    });
  } catch (err) {
    try { fs.existsSync(srcPath) && fs.unlinkSync(srcPath); } catch {}
    console.error("创建任务失败:", err);
    res.status(400).json({ success: false, error: err.message });
  }
});

app.get("/api/jobs/:id", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ success: false, error: "任务不存在" });
  const segments = listSegments(job.id);
  const markers = listMarkers(job.id);
  const speakers = listSpeakers(job.id);
  const record = job.record_id ? getRecord(job.record_id) : null;
  res.json({
    success: true,
    job: {
      id: job.id,
      status: job.status,
      stage: job.stage,
      progress: job.progress,
      chunkTotal: job.chunk_total,
      chunkDone: job.chunk_done,
      durationMs: job.duration_ms,
      effectiveMs: job.effective_ms,
      error: job.error,
      output: job.output,
      recordId: job.record_id,
      sourceType: job.source_type,
      diarizeStatus: job.diarize_status || "off",
      speakerCount: job.speaker_count || speakers.length || null,
    },
    segments: segments.map((s) => ({
      idx: s.idx,
      startMs: s.start_ms,
      endMs: s.end_ms,
      text: s.text || "",
      engine: s.engine,
      status: s.status,
      speaker: s.speaker || null,
      speakerLabel: s.speaker_label || null,
    })),
    markers: markers.map((m) => ({
      id: m.id,
      startMs: m.start_ms,
      endMs: m.end_ms,
      text: m.text,
      duringPause: Boolean(m.during_pause),
      createdAt: m.created_at,
    })),
    speakers: speakers.map((s) => ({
      localId: s.local_id,
      label: s.label,
      color: s.color,
      firstMs: s.first_ms,
      talkMs: s.talk_ms,
    })),
    hasAudio: Boolean(job.audio_path && fs.existsSync(job.audio_path)),
    record: record
      ? {
          id: record.id,
          title: record.title,
          source: record.source,
          transcript: record.transcript,
          summary: record.summary_text,
          summaryJson: record.summary_json ? JSON.parse(record.summary_json) : null,
          duration: record.duration,
          created_at: record.created_at,
        }
      : null,
  });
});

app.post("/api/jobs/:id/cancel", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ success: false, error: "任务不存在" });
  if (!["queued", "running"].includes(job.status)) {
    return res.status(400).json({ success: false, error: "任务已结束，无法取消" });
  }
  res.json({ success: true, job: cancel(job.id) });
});

app.post("/api/jobs/:id/resume", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ success: false, error: "任务不存在" });
  if (job.status === "running") {
    return res.status(400).json({ success: false, error: "任务正在运行" });
  }
  if (job.status === "done") {
    return res.status(400).json({ success: false, error: "任务已完成，无需续跑" });
  }
  updateJob(job.id, { status: "queued", stage: "QUEUED", error: null });
  enqueue(job.id, { resume: true });
  res.json({ success: true, jobId: job.id });
});

app.post("/api/jobs/:id/summary", async (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ success: false, error: "任务不存在" });
  const segments = listSegments(job.id);
  if (!segments.length) {
    return res.status(400).json({ success: false, error: "该任务还没有转写结果" });
  }
  try {
    // 标记必须一起进纪要：它是用户当场认定的重点，不能被摘要流程丢掉
    const markers = listMarkers(job.id);
    const { json, markdown } = await generateSummary(segments, { markers });
    if (job.record_id) {
      updateRecord(job.record_id, {
        summary_json: JSON.stringify(json),
        summary_text: markdown,
        summary: (json.topic || "").slice(0, 100) || undefined,
      });
    }
    res.json({ success: true, summary: json, markdown });
  } catch (e) {
    console.error("生成纪要失败:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

/** 说话人重命名：同步更新段落的冗余显示名 */
app.patch("/api/jobs/:id/speakers", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ success: false, error: "任务不存在" });
  const { localId, label } = req.body || {};
  if (!localId || !String(label || "").trim()) {
    return res.status(400).json({ success: false, error: "缺少说话人编号或名称" });
  }
  try {
    const result = renameSpeaker(job.id, String(localId), String(label));
    if (!result.changed) {
      return res.status(404).json({ success: false, error: "说话人不存在" });
    }
    res.json({ success: true, speakers: result.speakers, needsSummary: true });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

/** 删除单条标记（录音结束后的编辑） */
app.delete("/api/jobs/:id/markers/:markerId", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ success: false, error: "任务不存在" });
  const ok = deleteMarker(req.params.markerId);
  if (!ok) return res.status(404).json({ success: false, error: "标记不存在" });
  res.json({ success: true });
});

/** 重新标注：对已有音频重跑一次离线分离 */
app.post("/api/jobs/:id/diarize", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ success: false, error: "任务不存在" });
  if (job.status === "running" || job.status === "queued") {
    return res.status(400).json({ success: false, error: "任务正在运行，无法重新标注" });
  }
  if (!job.audio_path || !fs.existsSync(job.audio_path)) {
    return res.status(400).json({ success: false, error: "音频已不存在，无法重新标注" });
  }
  const speakerCount = Number(req.body?.speakerCount) || null;
  const options = { diarize: true, speakerCount };
  updateJob(job.id, {
    status: "queued",
    stage: "QUEUED",
    progress: 0,
    error: null,
    engine: "bailian_filetrans",
    diarize_status: "running",
  });
  try {
    db.prepare("UPDATE jobs SET options_json = ? WHERE id = ?").run(
      JSON.stringify(options), job.id
    );
  } catch {}
  enqueue(job.id);
  res.json({ success: true, jobId: job.id });
});

/** 播放器用：16k 单声道 wav，支持 Range 以便点时间戳跳转 */
app.get("/api/jobs/:id/audio", (req, res) => {
  const job = getJob(req.params.id);
  if (!job || !job.audio_path || !fs.existsSync(job.audio_path)) {
    return res.status(404).json({ success: false, error: "音频不存在" });
  }
  res.sendFile(path.resolve(job.audio_path));
});

// ============ 记录列表（沿用） ============

app.get("/api/records", (req, res) => {
  const { q, page, pageSize } = req.query;
  res.json({ success: true, ...listRecords({ q, page, pageSize }) });
});

app.get("/api/records/:id", (req, res) => {
  const record = getRecord(req.params.id);
  if (!record) return res.status(404).json({ success: false, error: "记录不存在" });
  res.json({ success: true, record });
});

app.post("/api/records", (req, res) => {
  try {
    const b = req.body || {};
    const record = createRecord({
      title: b.title,
      summary: b.summary,
      source: b.source,
      template: b.template,
      filename: b.filename,
      size: b.size,
      duration: b.duration,
      language: b.language,
      transcript: b.transcript,
      summary_text: b.summaryText,
      client_id: b.clientId,
    });
    res.json({ success: true, record });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.patch("/api/records/:id", (req, res) => {
  try {
    const record = updateRecord(req.params.id, req.body || {});
    if (!record) return res.status(404).json({ success: false, error: "记录不存在" });
    res.json({ success: true, record });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 批量删除（列表页多选）
app.post("/api/records/batch-delete", (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
  if (!ids.length) {
    return res.status(400).json({ success: false, error: "请选择要删除的记录" });
  }
  try {
    const { deleted, jobIds } = deleteRecords(ids);
    for (const jobId of jobIds) {
      try { fs.rmSync(path.join(JOBS_DIR, jobId), { recursive: true, force: true }); } catch {}
    }
    res.json({ success: true, deleted });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message || "删除失败" });
  }
});

app.delete("/api/records/:id", (req, res) => {
  const record = getRecord(req.params.id);
  if (!record) return res.status(404).json({ success: false, error: "记录不存在" });

  const ok = deleteRecord(record.id);
  if (!ok) return res.status(404).json({ success: false, error: "记录不存在" });

  // 顺手清掉任务目录，避免 1.5 小时录屏的 wav 一直堆着
  if (record.job_id) {
    const dir = path.join(JOBS_DIR, record.job_id);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  res.json({ success: true });
});

// 老记录的「重新生成纪要」（无 segments 时走纯文本单次总结）
app.post("/api/meeting-summary", async (req, res) => {
  const { text, recordId } = req.body || {};
  if (!text || !text.trim()) {
    return res.status(400).json({ success: false, error: "请提供转写文本" });
  }
  try {
    const pseudo = text
      .split(/\n+/)
      .filter(Boolean)
      .map((t, i) => ({ text: t, start_ms: i * 60000, end_ms: (i + 1) * 60000 }));
    const { json, markdown } = await generateSummary(pseudo);
    if (recordId) {
      updateRecord(recordId, {
        summary_json: JSON.stringify(json),
        summary_text: markdown,
        summary: (json.topic || "").slice(0, 100),
      });
    }
    res.json({ success: true, summary: markdown, json, recordId });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ success: false, error: "文件超过 2GB 上限" });
    }
    return res.status(400).json({ success: false, error: err.message });
  }
  if (err) return res.status(400).json({ success: false, error: err.message });
  next();
});

const server = http.createServer(app);
attachRealtime(server);

// 重启意味着录音会话已死：先拿到名单，再标失败，最后清掉半截音频
const runningRecordings = listRunningRecordingJobs();
const interrupted = markInterruptedJobs();
for (const job of runningRecordings) {
  try {
    fs.rmSync(path.join(JOBS_DIR, job.id), { recursive: true, force: true });
  } catch {}
}
if (interrupted) {
  console.log(`发现 ${interrupted} 个上次未完成的任务，可在详情页点「继续处理」续跑`);
}
if (runningRecordings.length) {
  console.log(`清理了 ${runningRecordings.length} 个中断的录音会话（半截音频已删除，标记保留）`);
}

/** 清理孤儿任务目录：无对应 job 行，或 7 天内没产生记录且已结束 */
function cleanupOrphanJobs() {
  let removed = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(JOBS_DIR, { withFileTypes: true });
  } catch {
    return 0;
  }
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(JOBS_DIR, entry.name);
    const job = getJob(entry.name);
    if (!job) {
      try { fs.rmSync(dir, { recursive: true, force: true }); removed++; } catch {}
      continue;
    }
    const finished = ["done", "failed", "canceled"].includes(job.status);
    const old = new Date(job.updated_at || job.created_at || 0).getTime() < cutoff;
    if (finished && !job.record_id && old) {
      try { fs.rmSync(dir, { recursive: true, force: true }); removed++; } catch {}
    }
  }
  return removed;
}
const orphans = cleanupOrphanJobs();
if (orphans) console.log(`清理了 ${orphans} 个无用任务目录`);

server.listen(PORT, "127.0.0.1", () => {
  console.log(`服务器运行在 http://127.0.0.1:${PORT}`);
  const missing = [
    ["MIMO_API_KEY", process.env.MIMO_API_KEY],
    ["MIMO_API_URL", process.env.MIMO_API_URL],
    ["MIMO_ASR_MODEL", process.env.MIMO_ASR_MODEL],
    ["MIMO_SUMMARY_MODEL", process.env.MIMO_SUMMARY_MODEL],
  ].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    console.warn(`警告: 未设置 ${missing.join(", ")}，转写与纪要会失败`);
  }
  const rtMissing = ["DASHSCOPE_API_KEY", "BAILIAN_WS_HOST", "BAILIAN_WORKSPACE"]
    .filter((k) => !process.env[k]);
  if (rtMissing.length) {
    console.warn(`警告: 未设置 ${rtMissing.join(", ")}，实时录音不可用`);
  }
});
