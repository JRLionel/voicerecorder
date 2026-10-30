/**
 * 百炼离线识别（异步任务）通道。
 *
 * 为什么不用同步 flash 接口：单次上限 5 分钟 / 10MB（base64 后约 3.9 分钟），
 * 长会议要切十几片，且每片返回的是「片内编号」，跨片认人需要额外的聚类。
 * filetrans 一次任务覆盖 12 小时，说话人编号全局稳定。
 */

const fs = require("node:fs");

const { engines } = require("../../data");
const { retry } = require("../../shared/utils/retry");
const { sleep } = require("../../shared/utils/time");
const { readJson, assertOk } = require("./http");
const { hostOf, apiKeyOf, modelOf, getUploadPolicy, uploadToOss } = require("./oss-uploader");
const { normalizeSentences } = require("./diarization-quality");

const DEFAULT_MODEL = engines.defaults.diarModel;
const TASK_TIMEOUT_MS = engines.timeouts.bailianTaskMs;
const POLL_INTERVAL_MS = engines.timeouts.bailianPollMs;

async function submitTranscription({ ossUrl, model, host, apiKey, speakerCount, language } = {}) {
  const h = hostOf({ host });
  const key = apiKeyOf({ apiKey });
  const params = { diarization_enabled: true };
  if (speakerCount && Number(speakerCount) >= 2) {
    params.speaker_count = Number(speakerCount);
  }
  if (language && language !== "auto") {
    params.language_hints = [language];
  }

  const body = {
    model: modelOf({ model }),
    input: { file_urls: [ossUrl] },
    parameters: params,
  };

  const resp = await fetch(`https://${h}/api/v1/services/audio/asr/transcription`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "X-DashScope-Async": "enable",
      "X-DashScope-OssResourceResolve": "enable",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(engines.timeouts.submitTaskMs),
  });
  const data = await readJson(resp);
  assertOk(resp, data, "提交识别任务");

  const taskId = data?.output?.task_id || data?.task_id;
  if (!taskId) throw new Error("提交识别任务失败：未返回 task_id");
  return taskId;
}

/** 第四步：轮询任务状态 */

async function pollTask(taskId, { host, apiKey, timeoutMs = TASK_TIMEOUT_MS, intervalMs = POLL_INTERVAL_MS } = {}) {
  const h = hostOf({ host });
  const key = apiKeyOf({ apiKey });
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const resp = await fetch(`https://${h}/api/v1/tasks/${encodeURIComponent(taskId)}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(engines.timeouts.pollTaskMs),
    });
    const data = await readJson(resp);
    assertOk(resp, data, "查询识别任务");

    const out = data.output || {};
    const status = String(out.task_status || "").toUpperCase();

    if (status === "SUCCEEDED") return out;
    if (status === "FAILED" || status === "CANCELED") {
      throw new Error(
        `识别任务失败 [${out.code || out.task_status}]: ${out.message || "无详情"}`
      );
    }
    await sleep(intervalMs);
  }
  throw new Error(`识别任务轮询超时（${Math.round(timeoutMs / 1000)} 秒），task_id=${taskId}`);
}

/** 下载转写结果 JSON */

async function fetchTranscription(url) {
  if (!url) throw new Error("任务结果中没有 transcription_url");
  const resp = await fetch(url, { signal: AbortSignal.timeout(engines.timeouts.fetchResultMs) });
  if (!resp.ok) throw new Error(`下载转写结果失败 (HTTP ${resp.status})`);
  return readJson(resp);
}

/**
 * 归一化：统一成 { startMs, endMs, text, speaker, words }
 * 兼容 transcripts[].sentences[] 与顶层 sentences[] 两种结构。
 */

async function withRetry(fn, { retries = engines.timeouts.bailianRetries, baseMs = engines.timeouts.retryBaseMs, label = "操作" } = {}) {
  return retry(fn, {
    retries,
    baseMs,
    onFail: (last) => new Error(`${label}失败（已重试 ${retries} 次）: ${last?.message || "未知错误"}`),
  });
}

/**
 * 完整流程：本地 WAV → 句子数组（含说话人）。
 * @param {string} wavPath 16k 单声道 WAV
 * @param {{model?:string, host?:string, apiKey?:string, speakerCount?:number, language?:string, onStage?:(stage:string,extra?:object)=>void}} opts
 */

async function diarizeFile(wavPath, opts = {}) {
  const { onStage } = opts;
  const model = modelOf(opts);

  if (!fs.existsSync(wavPath)) throw new Error(`音频不存在: ${wavPath}`);

  if (onStage) onStage("UPLOAD_REMOTE", { progress: 20 });
  const policy = await withRetry(() => getUploadPolicy({ model, host: opts.host, apiKey: opts.apiKey }), {
    label: "获取上传凭证",
  });
  const ossUrl = await withRetry(() => uploadToOss(wavPath, policy), { label: "上传音频" });

  if (onStage) onStage("DIARIZING", { progress: 35 });
  const taskId = await submitTranscription({
    ossUrl,
    model,
    host: opts.host,
    apiKey: opts.apiKey,
    speakerCount: opts.speakerCount,
    language: opts.language,
  });

  const out = await pollTask(taskId, {
    host: opts.host,
    apiKey: opts.apiKey,
    timeoutMs: opts.timeoutMs || TASK_TIMEOUT_MS,
  });

  const url = out?.results?.[0]?.transcription_url;
  const json = await fetchTranscription(url);
  const sentences = normalizeSentences(json);
  if (!sentences.length) throw new Error("识别结果为空，可能是音频中没有语音");

  return { sentences, taskId, model, ossUrl, raw: json };
}

module.exports = {
  DEFAULT_MODEL,
  submitTranscription,
  pollTask,
  fetchTranscription,
  withRetry,
  diarizeFile,
};
