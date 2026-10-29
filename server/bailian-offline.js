const fs = require("node:fs");
const crypto = require("node:crypto");

/**
 * 百炼离线识别（异步任务）通道。
 *
 * 为什么不用同步 flash 接口：单次上限 5 分钟 / 10MB（base64 后约 3.9 分钟），
 * 长会议要切十几片，且每片返回的是「片内编号」，跨片认人需要额外的聚类。
 * filetrans 一次任务覆盖 12 小时，说话人编号全局稳定。
 *
 * 四步：取上传凭证 → 直传 OSS → 提交异步任务 → 轮询取结果。
 * 上传必须走 OSS：接口只接受公网 URL 或 oss://，本地路径传不进去。
 */

const DEFAULT_MODEL = "qwen-audio-3.0-asr-flash-filetrans";
const TASK_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 2000;

function hostOf(opts = {}) {
  return opts.host || process.env.BAILIAN_WS_HOST;
}

function apiKeyOf(opts = {}) {
  return opts.apiKey || process.env.DASHSCOPE_API_KEY;
}

function modelOf(opts = {}) {
  return opts.model || process.env.DIAR_MODEL || DEFAULT_MODEL;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function readJson(resp) {
  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function assertOk(resp, data, label) {
  if (!resp.ok) {
    const msg =
      data?.message || data?.error?.message || data?.code ||
      (typeof data?.raw === "string" ? data.raw.slice(0, 200) : "") || resp.statusText;
    throw new Error(`${label}失败 (HTTP ${resp.status}): ${msg}`);
  }
}

/** 第一步：取 OSS 直传凭证（有效期 48h，仅用于本次任务） */
async function getUploadPolicy({ model, host, apiKey } = {}) {
  const h = hostOf({ host });
  const key = apiKeyOf({ apiKey });
  if (!h) throw new Error("未配置 BAILIAN_WS_HOST，无法走离线识别");
  if (!key) throw new Error("未配置 DASHSCOPE_API_KEY，无法走离线识别");

  const url =
    `https://${h}/api/v1/uploads?action=getPolicy&model=${encodeURIComponent(modelOf({ model }))}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(20000),
  });
  const data = await readJson(resp);
  assertOk(resp, data, "获取上传凭证");

  const policy = data.data || data;
  if (!policy?.policy || !policy?.signature || !policy?.upload_host) {
    throw new Error("上传凭证返回结构异常，缺少 policy / signature / upload_host");
  }
  return policy;
}

/** 第二步：表单直传 OSS，返回 oss:// 地址 */
async function uploadToOss(filePath, policy) {
  const stat = fs.statSync(filePath);
  const maxMb = Number(policy.max_file_size_mb || 0);
  if (maxMb && stat.size > maxMb * 1024 * 1024) {
    throw new Error(`音频体积 ${(stat.size / 1024 / 1024).toFixed(1)}MB 超过上传上限 ${maxMb}MB`);
  }

  const dir = String(policy.upload_dir || "").replace(/\/+$/, "");
  const name = `up_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.wav`;
  const key = dir ? `${dir}/${name}` : name;

  // 字段顺序不能改：OSS 要求签名相关字段出现在 file 之前
  const form = new FormData();
  form.append("OSSAccessKeyId", policy.oss_access_key_id || "");
  form.append("Signature", policy.signature);
  form.append("policy", policy.policy);
  form.append("key", key);
  form.append("success_action_status", "200");
  if (policy.x_oss_object_acl) form.append("x-oss-object-acl", policy.x_oss_object_acl);
  if (policy.x_oss_forbid_overwrite) {
    form.append("x-oss-forbid-overwrite", String(policy.x_oss_forbid_overwrite));
  }
  form.append("file", new Blob([fs.readFileSync(filePath)], { type: "audio/wav" }), name);

  const resp = await fetch(policy.upload_host, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(180000),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`上传音频失败 (HTTP ${resp.status}): ${body.slice(0, 200) || resp.statusText}`);
  }
  return `oss://${key}`;
}

/** 第三步：提交异步识别任务 */
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
    signal: AbortSignal.timeout(30000),
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
      signal: AbortSignal.timeout(20000),
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
  const resp = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!resp.ok) throw new Error(`下载转写结果失败 (HTTP ${resp.status})`);
  return readJson(resp);
}

/**
 * 归一化：统一成 { startMs, endMs, text, speaker, words }
 * 兼容 transcripts[].sentences[] 与顶层 sentences[] 两种结构。
 */
function normalizeSentences(result) {
  const transcripts = Array.isArray(result?.transcripts)
    ? result.transcripts
    : Array.isArray(result?.data?.transcripts)
      ? result.data.transcripts
      : null;

  let raw = [];
  if (transcripts) {
    for (const t of transcripts) {
      if (Array.isArray(t?.sentences)) raw.push(...t.sentences);
    }
  } else if (Array.isArray(result?.sentences)) {
    raw = result.sentences;
  }

  const out = [];
  for (const s of raw) {
    if (!s) continue;
    const text = String(s.text || "").trim();
    if (!text) continue;
    const start = Number(s.begin_time ?? s.start_time ?? 0);
    const end = Number(s.end_time ?? s.endTime ?? start);
    const sid = s.speaker_id;
    out.push({
      startMs: Number.isFinite(start) ? start : 0,
      endMs: Number.isFinite(end) ? Math.max(end, start) : start,
      text,
      speaker: sid === null || sid === undefined ? null : `S${sid}`,
    });
  }
  out.sort((a, b) => a.startMs - b.startMs);
  return out;
}

/**
 * 判定分离质量。
 * 全 0 是最坏情况——不是报错，而是「所有人都叫说话人1」，必须显式暴露。
 */
function analyzeDiarization(sentences, durationSec = 0) {
  const ids = new Set(sentences.map((s) => s.speaker).filter(Boolean));
  const distinct = ids.size;
  const usable = sentences.length;

  let status = "ok";
  if (usable > 5 && distinct <= 1) status = "failed";
  else if (durationSec > 0 && durationSec <= 15 * 60 && distinct > 8) status = "suspect";

  const talk = new Map();
  for (const s of sentences) {
    if (!s.speaker) continue;
    talk.set(s.speaker, (talk.get(s.speaker) || 0) + Math.max(0, s.endMs - s.startMs));
  }

  return {
    status,
    distinct,
    talkMs: talk,
    firstMs: new Map(
      [...ids].map((id) => [id, sentences.find((s) => s.speaker === id)?.startMs ?? 0])
    ),
  };
}

/** 带退避的重试包装：只对凭证/上传这类瞬时故障重试 */
async function withRetry(fn, { retries = 2, baseMs = 1000, label = "操作" } = {}) {
  let last;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i === retries) break;
      await sleep(baseMs * 2 ** i);
    }
  }
  throw new Error(`${label}失败（已重试 ${retries} 次）: ${last?.message || "未知错误"}`);
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
  getUploadPolicy,
  uploadToOss,
  submitTranscription,
  pollTask,
  fetchTranscription,
  normalizeSentences,
  analyzeDiarization,
  diarizeFile,
  withRetry,
};
