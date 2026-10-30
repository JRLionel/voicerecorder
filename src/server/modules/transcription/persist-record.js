/**
 * 转写结果落库：合并全文、新建或更新记录。
 *
 * 被「静态文件转写」与「实时录音收尾」共用，避免两处各写一份合并逻辑。
 */

const repos = require("../../data/db/repositories");
const { limits } = require("../../data");
const { stripExt, collapseSpaces } = require("../../shared/utils/text");

const { createRecord, getRecord, updateRecord } = repos.records;
const { updateJob } = repos.jobs;
const { listSpeakers } = repos.speakers;

/** 汇总文本、写记录 */
async function persistRecord(jobId, job, totalSec, segments, overrides = {}) {
  const transcript = segments
    .map((s) => {
      const text = (s.text || "").trim();
      if (!text) return "";
      const label = s.speaker_label || s.speaker;
      return label ? `${label}：${text}` : text;
    })
    .filter(Boolean)
    .join("\n");

  if (!transcript.trim()) {
    throw new Error("音频中没有识别到语音内容");
  }

  const speakers = listSpeakers(jobId);
  const speakersJson = speakers.length ? JSON.stringify(speakers) : null;

  const pick = (key, fallback) => (key in overrides ? overrides[key] : fallback);

  let record = job.record_id ? getRecord(job.record_id) : null;
  if (!record) {
    record = createRecord({
      title: pick("title", stripExt(job.filename)),
      summary: transcript.replace(/\s+/g, " ").slice(0, limits.records.summaryChars),
      source: pick("source", job.source_type === "recording" ? "recording" : "upload"),
      template: "transcribe",   // 有纪要后由纪要动作改为 meeting，仅驱动列表配色
      filename: pick("filename", job.filename),
      size: pick("size", job.size),
      duration: Math.round(totalSec),
      language: pick("language", job.language),
      transcript,
      speakers_json: speakersJson,
      job_id: jobId,
    });
    updateJob(jobId, { record_id: record.id });
  } else {
    updateRecord(record.id, {
      transcript,
      summary: transcript.replace(/\s+/g, " ").slice(0, limits.records.summaryChars),
      duration: Math.round(totalSec),
      speakers_json: speakersJson,
    });
  }

  return { record, transcript };
}

/**
 * 执行任务（可断点续跑）。
 * 切点由 wav + 固定目标时长 + 静音分布决定，重跑能复现同一组切点，
 * 所以「跳过已完成片」就是续跑的全部逻辑。
 */

module.exports = { persistRecord };
