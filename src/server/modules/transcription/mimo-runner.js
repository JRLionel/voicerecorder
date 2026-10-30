/**
 * MIMO 通道：30 秒切片 + 并发 4 + 字率护栏 + 百炼流式兜底。
 *
 * 行为与改造前完全一致，开关关闭时只走这里。
 */

const fs = require("node:fs");
const path = require("node:path");

const audio = require("../audio");
const { transcribeFile, transcribePcm } = require("../asr");
const { limits, protocol } = require("../../data");
const config = require("../../config");
const { runPool } = require("../../shared/utils/pool");
const repos = require("../../data/db/repositories");

const { getJob, updateJob } = repos.jobs;
const { upsertSegment, doneSegmentIndexes } = repos.segments;

const { setStage } = require("./progress");
const { isCanceled } = require("./controls");
const { looksDegenerate } = require("./quality-guard");
const { planChunks } = require("./chunk-plan");

const CONCURRENCY = limits.transcribe.concurrency;

async function transcribeChunk(wavPath, chunk, dir, job) {
  const durSec = chunk.end - chunk.start;
  const mp3 = path.join(dir, `chunk_${String(chunk.idx).padStart(3, "0")}.mp3`);
  await audio.sliceMp3(wavPath, mp3, chunk.start, durSec);

  let text = "";
  let engine = "mimo";
  let status = "done";

  try {
    const r = await transcribeFile(mp3, { language: job.language || "auto" });
    text = r.text;
    if (looksDegenerate(text, durSec)) {
      throw new Error(`字率过低（${text.length} 字 / ${durSec.toFixed(0)}s），判定模型退化`);
    }
  } catch (mimoErr) {
    console.warn(
      `[${job.id}] 第 ${chunk.idx} 片改走百炼兜底（${durSec.toFixed(0)}s）: ${mimoErr.message}`
    );
    // 兜底：同一段音频转 PCM 走百炼流式
    const pcm = path.join(dir, `chunk_${String(chunk.idx).padStart(3, "0")}.pcm`);
    await audio.toPcm(mp3, pcm);
    const r = await transcribePcm(pcm, {
      apiKey: config.bailian.apiKey,
      host: config.bailian.wsHost,
      workspace: config.bailian.workspace,
      model: config.bailian.asrModel,
      languageHints: job.language && job.language !== "auto" ? [job.language] : undefined,
      speed: protocol.streamSpeed,
      retries: 1,
    });
    text = r.sentences.map((s) => s.text).join("");
    engine = "bailian_stream";
    status = "fallback";
    try { fs.unlinkSync(pcm); } catch {}
  }

  try { fs.unlinkSync(mp3); } catch {}
  return { text, engine, status };
}

/**
 * MIMO 通道：30 秒切片 + 并发 4 + 字率护栏。
 * 行为与改造前完全一致，开关关闭时只走这里。
 */

async function runMimoTranscribe(jobId, job, dir, wavPath, meta, resume) {
  setStage(jobId, "CHUNKING", 14);
  const totalSec = meta.durationSec;
  const chunks = await planChunks(wavPath, totalSec);
  updateJob(jobId, { chunk_total: chunks.length, chunk_done: 0 });
  setStage(jobId, "TRANSCRIBING", 20);

  const doneIdx = resume ? doneSegmentIndexes(jobId) : new Set();
  const todo = chunks.filter((c) => !doneIdx.has(c.idx));
  let completed = chunks.length - todo.length;
  updateJob(jobId, { chunk_done: completed });
  let failed = 0;

  await runPool(todo, CONCURRENCY, async (chunk) => {
    if (isCanceled(jobId)) return;
    if (chunk.silent) {
      upsertSegment({
        jobId, idx: chunk.idx,
        startMs: chunk.start * 1000, endMs: chunk.end * 1000,
        text: "", status: "done", engine: "skip_silence",
      });
    } else {
      try {
        const r = await transcribeChunk(wavPath, chunk, dir, getJob(jobId));
        upsertSegment({
          jobId, idx: chunk.idx,
          startMs: chunk.start * 1000, endMs: chunk.end * 1000,
          text: r.text, status: r.status, engine: r.engine,
        });
      } catch (e) {
        failed += 1;
        upsertSegment({
          jobId, idx: chunk.idx,
          startMs: chunk.start * 1000, endMs: chunk.end * 1000,
          text: "", status: "failed", engine: null,
        });
        console.error(`[${jobId}] 第 ${chunk.idx} 片失败: ${e.message}`);
      }
    }
    completed += 1;
    updateJob(jobId, {
      chunk_done: completed,
      progress: Math.min(85, 20 + (completed / chunks.length) * 65),
    });
  });

  return { failed, totalSec, chunkTotal: chunks.length };
}

/**
 * 离线分离通道：整文件一次任务。
 * 失败时不再重跑 MIMO——文本已经在返回里了，没必要再识别一遍。
 */

module.exports = { transcribeChunk, runMimoTranscribe, CONCURRENCY };
