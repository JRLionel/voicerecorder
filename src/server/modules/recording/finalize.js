/**
 * 录音收尾：WAV 回填 → 写 segments → 建记录。
 *
 * 与「静态文件转写」共用同一条落库路径（transcription/persist-record），
 * 差别只在标题与来源：录音固定用「实时录音 + 时间」。
 */

const repos = require("../../data/db/repositories");
const { persistRecord } = require("../transcription/persist-record");
const { rmDirSafe } = require("../../shared/utils/fs");
const { JOBS_DIR } = require("../transcription/workspace");
const path = require("node:path");

const { updateJob, getJob } = repos.jobs;
const { upsertSegment, listSegments } = repos.segments;
const { listMarkers } = repos.markers;

/** 没识别到内容：删掉空任务与半截音频，避免留下 0 句的记录 */
function cleanupEmpty(jobId) {
  updateJob(jobId, {
    status: "canceled", stage: "CANCELED", error: "没有识别到语音内容",
  });
  rmDirSafe(path.join(JOBS_DIR, jobId));
}

async function finalizeRecording({ jobId, durationMs, sentences, language, audioPath }) {
  updateJob(jobId, {
    status: "done",
    stage: "DONE",
    progress: 100,
    duration_ms: durationMs,
    effective_ms: durationMs,
    audio_path: audioPath,
    chunk_total: sentences.length,
    chunk_done: sentences.length,
    diarize_status: "off",
  });

  sentences.forEach((s, i) => {
    upsertSegment({
      jobId, idx: i,
      startMs: s.startMs, endMs: s.endMs,
      text: s.text, status: "done", engine: "bailian_stream",
    });
  });

  const markers = listMarkers(jobId);
  const { record } = await persistRecord(jobId, getJob(jobId), durationMs / 1000, listSegments(jobId), {
    title: `实时录音 ${new Date().toLocaleString("zh-CN")}`,
    source: "recording",
    filename: null,
    size: null,
    language,
  });

  return { job: getJob(jobId), record, markers: markers.length };
}

module.exports = { finalizeRecording, cleanupEmpty };
