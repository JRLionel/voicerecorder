/**
 * 离线分离通道：整文件一次任务。
 *
 * 失败时不再重跑 MIMO —— 文本已经在返回里了，没必要再识别一遍。
 * 结果拿到之后才清旧数据：中途失败不会把上一次的转写毁掉。
 */

const { diarizeFile, analyzeDiarization } = require("../asr");
const repos = require("../../data/db/repositories");
const { limits, speakers: speakerRules } = require("../../data");
const { setStage } = require("./progress");
const { isCanceled } = require("./controls");
const { parseOptions } = require("./options");

const MAX_DIARIZE_SEC = limits.diarize.maxDurationSec;
const SPEAKER_COLORS = speakerRules.palette;

const { upsertSpeaker, clearSpeakers } = repos.speakers;
const { upsertSegment, clearSegments } = repos.segments;
const { updateJob } = repos.jobs;

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
    const label = `${speakerRules.labelPrefix}${i + 1}`;
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

module.exports = { runDiarize, MAX_DIARIZE_SEC, SPEAKER_COLORS };
