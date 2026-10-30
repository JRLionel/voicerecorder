/**
 * 任务状态机：探测 → 抽音频 → 分岔（分离 / 切片）→ 落记录 → 自动纪要。
 *
 * 切点由 wav + 固定目标时长 + 静音分布决定，重跑能复现同一组切点，
 * 所以「跳过已完成片」就是续跑的全部逻辑。
 */

const fs = require("node:fs");
const path = require("node:path");

const audio = require("../audio");
const repos = require("../../data/db/repositories");
const { controls, isCanceled } = require("./controls");
const { setStage } = require("./progress");
const { parseOptions } = require("./options");
const { jobDir } = require("./workspace");
const { runMimoTranscribe } = require("./mimo-runner");
const { runDiarize } = require("./diarize-runner");
const { persistRecord } = require("./persist-record");

const { getJob, updateJob } = repos.jobs;
const { listSegments } = repos.segments;
const { countMinutes } = repos.minutes;
const minutesSvc = require("../minutes");

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
    await persistRecord(jobId, job, totalSec, segs);

    // ---- 5. 纪要：不在任务里做 ----
    // 转写结束即任务结束；纪要由独立动作 POST /api/minutes 执行，
    // 这样纪要失败不污染任务状态，也可以反复用不同模板生成。
    const keepError = getJob(jobId)?.error || null;
    updateJob(jobId, {
      status: "done", stage: "DONE", progress: 100,
      chunk_done: segs.length,
      error: failed ? `有 ${failed} 片转写失败` : keepError,
    });
    controls.delete(jobId);

    // 自动生成：不 await，避免拖慢队列里的下一个任务。
    // 幂等：续跑/重跑时已有纪要就跳过，否则每次续跑都会多堆一份。
    const done = getJob(jobId);
    if (done?.auto_minutes && done.record_id && countMinutes(done.record_id) === 0) {
      minutesSvc
        .generateMinutes({ jobId })
        .catch((e) => console.error(`[${jobId}] 自动生成纪要失败: ${e.message}`));
    }

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

module.exports = { runJob, finishCanceled };
