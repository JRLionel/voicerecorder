/**
 * 任务域接口：上传、状态、取消、续跑、重新标注、说话人、标记、音频。
 */

const express = require("express");
const fs = require("node:fs");
const path = require("node:path");

const repos = require("../data/db/repositories");
const ingestion = require("../modules/ingestion");
const transcription = require("../modules/transcription");
const minutesSvc = require("../modules/minutes");
const { ok, fail, bad, missing } = require("../shared/http");

const { getJob, updateJob, setJobOptions } = repos.jobs;
const { getRecord } = repos.records;
const { listSegments, listMarkers, listSpeakers, renameSpeaker, deleteMarker } = {
  listSegments: repos.segments.listSegments,
  listMarkers: repos.markers.listMarkers,
  listSpeakers: repos.speakers.listSpeakers,
  renameSpeaker: repos.speakers.renameSpeaker,
  deleteMarker: repos.markers.deleteMarker,
};
const { getTemplateRow } = repos.templates;

const router = express.Router();

// 上传 → 建任务（multipart）
router.post("/api/jobs", ingestion.upload.single("file"), async (req, res) => {
  if (!req.file) return bad(res, "请选择要上传的文件");
  try {
    const result = await ingestion.createJobFromUpload({ file: req.file, body: req.body });
    return ok(res, result);
  } catch (err) {
    // 与原实现一致：建任务失败一律 400，文案直接回传
    return bad(res, err.message);
  }
});

// 任务详情：状态 + 分段 + 标记 + 说话人 + 关联记录与纪要版本
router.get("/api/jobs/:id", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return missing(res, "任务不存在");

  const segments = listSegments(job.id);
  const markers = listMarkers(job.id);
  const speakers = listSpeakers(job.id);
  const record = job.record_id ? getRecord(job.record_id) : null;
  const jobTemplate = job.template_id ? getTemplateRow(job.template_id) : null;

  return ok(res, {
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
      autoMinutes: Boolean(job.auto_minutes),
      templateId: job.template_id || null,
      templateName: jobTemplate ? jobTemplate.name : null,
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
          templateId: record.template_id,
          templateName: record.template_name,
          currentMinutesId: record.current_minutes_id,
          minutes: minutesSvc.listMinutes(record.id),
          duration: record.duration,
          created_at: record.created_at,
        }
      : null,
  });
});

router.post("/api/jobs/:id/cancel", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return missing(res, "任务不存在");
  if (!["queued", "running"].includes(job.status)) {
    return bad(res, "任务已结束，无法取消");
  }
  return ok(res, { job: transcription.cancel(job.id) });
});

router.post("/api/jobs/:id/resume", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return missing(res, "任务不存在");
  if (job.status === "running") return bad(res, "任务正在运行");
  if (job.status === "done") return bad(res, "任务已完成，无需续跑");

  updateJob(job.id, { status: "queued", stage: "QUEUED", error: null });
  transcription.enqueue(job.id, { resume: true });
  return ok(res, { jobId: job.id });
});

/** 重新标注：对已有音频重跑一次离线分离 */
router.post("/api/jobs/:id/diarize", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return missing(res, "任务不存在");
  if (job.status === "running" || job.status === "queued") {
    return bad(res, "任务正在运行，无法重新标注");
  }
  if (!job.audio_path || !fs.existsSync(job.audio_path)) {
    return bad(res, "音频已不存在，无法重新标注");
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
    setJobOptions(job.id, options);
  } catch {}
  transcription.enqueue(job.id);
  return ok(res, { jobId: job.id });
});

/** 说话人重命名：同步更新段落的冗余显示名 */
router.patch("/api/jobs/:id/speakers", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return missing(res, "任务不存在");

  const { localId, label } = req.body || {};
  if (!localId || !String(label || "").trim()) {
    return bad(res, "缺少说话人编号或名称");
  }
  try {
    const result = renameSpeaker(job.id, String(localId), String(label));
    if (!result.changed) return missing(res, "说话人不存在");
    return ok(res, { speakers: result.speakers, needsSummary: true });
  } catch (e) {
    return bad(res, e.message);
  }
});

/** 删除单条标记（录音结束后的编辑） */
router.delete("/api/jobs/:id/markers/:markerId", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return missing(res, "任务不存在");
  if (!deleteMarker(req.params.markerId)) return missing(res, "标记不存在");
  return ok(res);
});

/** 播放器用：16k 单声道 wav，支持 Range 以便点时间戳跳转 */
router.get("/api/jobs/:id/audio", (req, res) => {
  const job = getJob(req.params.id);
  if (!job || !job.audio_path || !fs.existsSync(job.audio_path)) {
    return missing(res, "音频不存在");
  }
  return res.sendFile(path.resolve(job.audio_path));
});

/** 统一错误出口（含 multer 的体积/格式错误） */
function errorHandler(err, req, res, next) {
  if (err && err.name === "MulterError") {
    if (err.code === "LIMIT_FILE_SIZE") return bad(res, "文件超过 2GB 上限");
    return bad(res, err.message);
  }
  // 与原实现一致：中间件层（如 fileFilter 拒绝）一律按 400 回，带 status 的走统一出口
  if (err && err.status) return fail(res, err);
  return bad(res, (err && err.message) || "请求失败");
}

module.exports = { router, errorHandler };
