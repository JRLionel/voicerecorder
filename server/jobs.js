const fs = require("node:fs");
const path = require("node:path");

const audio = require("./audio");
const { transcribeFile } = require("./asr-mimo");
const { transcribePcm } = require("./asr-bailian");
const { diarizeFile, analyzeDiarization } = require("./bailian-offline");
const { generateSummary } = require("./summary");
const {
  createRecord, getRecord, updateRecord, getJob, updateJob, upsertSegment,
  listSegments, doneSegmentIndexes, clearSegments,
  upsertSpeaker, listSpeakers, clearSpeakers,
} = require("./db");

const CHUNK_SEC = 30;          // 实测：30s 稳定（6/6 正常），45s 开始截断，90s 只剩 8 字
const CONCURRENCY = 4;
const MIN_CHAR_RATE = 1.2;     // 字/秒，低于此判为模型退化
const MAX_DIARIZE_SEC = 2 * 3600; // 开启分离后官方建议 ≤2h

const SPEAKER_COLORS = ["#3565d9", "#7c4dd4", "#1f9a62", "#c97a12", "#d84a35", "#5f6b7a"];

const JOBS_DIR = path.join(__dirname, "jobs");
fs.mkdirSync(JOBS_DIR, { recursive: true });

/** jobId -> { canceled: boolean } */
const controls = new Map();

function jobDir(jobId) {
  const dir = path.join(JOBS_DIR, jobId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function setStage(jobId, stage, progress) {
  updateJob(jobId, { stage, progress });
}

function isCanceled(jobId) {
  return controls.get(jobId)?.canceled === true;
}

/** 从文件名推断 source_type */
function detectSourceType(filename) {
  const ext = path.extname(filename || "").toLowerCase();
  if ([".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v"].includes(ext)) return "video";
  return "audio";
}

function stripExt(name) {
  return String(name || "未命名").replace(/\.[^.]+$/, "") || "未命名";
}

/** 字率护栏：实测 MIMO 截断时只会吐 5~10 个字，与音频长短无关 */
function looksDegenerate(text, sec) {
  const chars = (text || "").replace(/\s/g, "").length;
  if (!chars) return true;
  if (sec >= 10 && chars <= 12) return true;              // 典型截断
  if (sec >= 10 && chars / sec < MIN_CHAR_RATE) return true; // 明显低于正常语速
  return false;
}

function parseOptions(job) {
  try {
    return JSON.parse(job.options_json || "{}") || {};
  } catch {
    return {};
  }
}

/**
 * 转写单个切片：先 MIMO，退化则用百炼流式兜底。
 * 两条路都不通才判失败，避免一片失败拖垮整个任务。
 */
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
      apiKey: process.env.DASHSCOPE_API_KEY,
      host: process.env.BAILIAN_WS_HOST,
      workspace: process.env.BAILIAN_WORKSPACE,
      model: process.env.ASR_MODEL || "qwen-audio-3.0-asr-flash-streaming",
      languageHints: job.language && job.language !== "auto" ? [job.language] : undefined,
      speed: 4,
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

/** 并发池：共享游标，按片推进 */
async function runPool(items, limit, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const current = items[cursor++];
      await worker(current);
    }
  });
  await Promise.all(runners);
}

/**
 * MIMO 通道：30 秒切片 + 并发 4 + 字率护栏。
 * 行为与改造前完全一致，开关关闭时只走这里。
 */
async function runMimoTranscribe(jobId, job, dir, wavPath, meta, resume) {
  setStage(jobId, "CHUNKING", 14);
  const totalSec = meta.durationSec;
  const silences = await audio.findSilences(wavPath, { noiseDb: -35, minDur: 0.6, totalSec });
  const cuts = audio.planCuts(totalSec, CHUNK_SEC, silences);
  const chunks = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const start = cuts[i];
    const end = cuts[i + 1];
    if (end - start < 2) continue;
    chunks.push({
      idx: i,
      start,
      end,
      silent: audio.isSilentRange(silences, start, end),
    });
  }
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
async function runDiarize(jobId, job, dir, wavPath, meta) {
  const opts = parseOptions(job);
  const totalSec = meta.durationSec;

  if (totalSec > MAX_DIARIZE_SEC) {
    throw new Error("开启说话人分离时音频上限 2 小时，请先裁剪或关闭开关");
  }

  updateJob(jobId, { engine: "bailian_filetrans", diarize_status: "running" });

  const guard = (stage, extra = {}) => {
    if (isCanceled(jobId)) {
      const err = new Error("__CANCELED__");
      err.code = "CANCELED";
      throw err;
    }
    setStage(jobId, stage, extra.progress ?? 20);
  };

  guard("UPLOAD_REMOTE", { progress: 15 });
  const { sentences, taskId } = await diarizeFile(wavPath, {
    speakerCount: opts.speakerCount,
    language: job.language,
    onStage: guard,
  });

  if (isCanceled(jobId)) {
    const err = new Error("__CANCELED__");
    err.code = "CANCELED";
    throw err;
  }

  setStage(jobId, "DIARIZING", 88);
  const analysis = analyzeDiarization(sentences, totalSec);

  // 结果拿到之后再清旧数据：中途失败时不能把上一次的转写也毁掉
  clearSegments(jobId);
  clearSpeakers(jobId);

  // 名册按首次出现时间排序，编号 S0/S1 与显示名解耦
  // 判定为「分离未生效」时不写说话人，避免全篇顶着「说话人1」假装修好了
  const useSpeaker = analysis.status !== "failed";
  const order = useSpeaker
    ? [...analysis.firstMs.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id)
    : [];

  const labels = new Map();
  order.forEach((id, i) => {
    const label = `说话人${i + 1}`;
    labels.set(id, label);
    upsertSpeaker({
      jobId,
      localId: id,
      label,
      color: SPEAKER_COLORS[i % SPEAKER_COLORS.length],
      firstMs: analysis.firstMs.get(id) || 0,
      talkMs: analysis.talkMs.get(id) || 0,
    });
  });

  sentences.forEach((s, idx) => {
    upsertSegment({
      jobId,
      idx,
      startMs: s.startMs,
      endMs: s.endMs,
      text: s.text,
      status: "done",
      engine: "bailian_filetrans",
      speaker: useSpeaker ? s.speaker : null,
      speakerLabel: useSpeaker && s.speaker ? labels.get(s.speaker) : null,
      speakerConf: useSpeaker ? (analysis.status === "ok" ? 1 : 0.5) : null,
    });
  });

  updateJob(jobId, {
    chunk_total: sentences.length,
    chunk_done: sentences.length,
    speaker_count: useSpeaker ? analysis.distinct : 0,
    diarize_status: analysis.status,
    error:
      analysis.status === "failed"
        ? "本次未能区分说话人（所有句子被识别为同一人），文本仍可用"
        : analysis.status === "suspect"
          ? "疑似过度聚类，可指定参会人数后重新标注"
          : null,
    progress: 90,
  });

  console.log(
    `[${jobId}] 离线分离完成 task=${taskId} 句数=${sentences.length} 人数=${analysis.distinct} 判定=${analysis.status}`
  );

  return { totalSec, chunkTotal: sentences.length, taskId };
}

/** 汇总文本、写记录 */
async function persistRecord(jobId, job, totalSec, segments) {
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

  let record = job.record_id ? getRecord(job.record_id) : null;
  if (!record) {
    record = createRecord({
      title: stripExt(job.filename),
      summary: transcript.replace(/\s+/g, " ").slice(0, 46),
      source: job.source_type === "recording" ? "recording" : "upload",
      template: job.output === "summary" ? "meeting" : "transcribe",
      filename: job.filename,
      size: job.size,
      duration: Math.round(totalSec),
      language: job.language,
      transcript,
      speakers_json: speakersJson,
      job_id: jobId,
    });
    updateJob(jobId, { record_id: record.id });
  } else {
    updateRecord(record.id, {
      transcript,
      summary: transcript.replace(/\s+/g, " ").slice(0, 46),
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
async function runJob(jobId, { resume = false } = {}) {
  let job = getJob(jobId);
  if (!job) throw new Error(`任务不存在: ${jobId}`);

  controls.set(jobId, { canceled: false });
  updateJob(jobId, { status: "running", error: null, stage: "PROBING", progress: 4 });
  job = getJob(jobId);

  const dir = jobDir(jobId);
  const opts = parseOptions(job);

  try {
    const srcPath = resume && job.audio_path ? job.audio_path : job.file_path;
    if (!srcPath || !fs.existsSync(srcPath)) {
      throw new Error("源文件已不存在（可能被清理），请重新上传");
    }

    // ---- 1. 探测 ----
    const meta = await audio.probe(srcPath);
    updateJob(jobId, { duration_ms: Math.round(meta.durationSec * 1000) });
    if (isCanceled(jobId)) return finishCanceled(jobId);

    // ---- 2. 抽音频 ----
    setStage(jobId, "EXTRACTING", 7);
    const wavPath = path.join(dir, "audio.wav");
    if (!resume || !fs.existsSync(wavPath)) {
      await audio.extractWav(srcPath, wavPath);
    }
    updateJob(jobId, { audio_path: wavPath });
    if (isCanceled(jobId)) return finishCanceled(jobId);

    // ---- 3. 分岔：离线分离 或 MIMO 切片 ----
    let failed = 0;
    let totalSec = meta.durationSec;

    if (opts.diarize) {
      const r = await runDiarize(jobId, job, dir, wavPath, meta);
      totalSec = r.totalSec;
    } else {
      updateJob(jobId, { diarize_status: "off" });
      const r = await runMimoTranscribe(jobId, job, dir, wavPath, meta, resume);
      failed = r.failed;
      totalSec = r.totalSec;
    }

    if (isCanceled(jobId)) return finishCanceled(jobId);

    // ---- 4. 合并文本、落记录 ----
    const segs = listSegments(jobId);
    const { record } = await persistRecord(jobId, job, totalSec, segs);

    // ---- 5. 纪要（可选） ----
    if (job.output === "summary") {
      setStage(jobId, "SUMMARIZING", 93);
      try {
        const summary = await generateSummary(segs, {
          markers: [],
          onProgress: (p) => {
            updateJob(jobId, { progress: Math.min(99, 93 + p * 6) });
          },
        });
        updateRecord(record.id, {
          summary_json: JSON.stringify(summary.json),
          summary_text: summary.markdown,
          summary: (summary.json.topic || "").slice(0, 46),
        });
      } catch (e) {
        // 纪要失败不影响转写结果，用户可在详情页重试
        console.error(`[${jobId}] 纪要生成失败: ${e.message}`);
        updateJob(jobId, { error: `纪要生成失败: ${e.message}` });
      }
    }

    // 保留分离阶段写入的告警（未能区分说话人 / 疑似过度聚类），不要被收尾覆盖
    const keepError = getJob(jobId)?.error || null;
    updateJob(jobId, {
      status: "done", stage: "DONE", progress: 100,
      chunk_done: segs.length,
      error: failed ? `有 ${failed} 片转写失败` : keepError,
    });
    controls.delete(jobId);
    return getJob(jobId);
  } catch (e) {
    if (e.code === "CANCELED" || e.message === "__CANCELED__") {
      return finishCanceled(jobId);
    }
    console.error(`[${jobId}] 任务失败: ${e.message}`);
    updateJob(jobId, {
      status: "failed",
      stage: "FAILED",
      error: e.message,
      ...(opts.diarize ? { diarize_status: "failed" } : {}),
    });
    controls.delete(jobId);
    return getJob(jobId);
  }
}

function finishCanceled(jobId) {
  updateJob(jobId, { status: "canceled", stage: "CANCELED", error: "已取消" });
  controls.delete(jobId);
  return getJob(jobId);
}

/** 串行队列：本机单用户，两个 ffmpeg + ASR 任务并行只会互相拖慢 */
let chain = Promise.resolve();
function enqueue(jobId, opts) {
  chain = chain
    .catch(() => {})
    .then(() => runJob(jobId, opts))
    .catch((e) => console.error(`[${jobId}] 队列执行异常: ${e.message}`));
  return chain;
}

function cancel(jobId) {
  const c = controls.get(jobId);
  if (c) c.canceled = true;
  else updateJob(jobId, { status: "canceled", stage: "CANCELED", error: "已取消" });
  return getJob(jobId);
}

module.exports = {
  JOBS_DIR, CHUNK_SEC, MAX_DIARIZE_SEC, SPEAKER_COLORS,
  enqueue, cancel, jobDir, detectSourceType, stripExt, runJob,
};
