/**
 * 百炼 OSS 直传：取上传凭证 → 表单直传。
 *
 * 为什么必须走 OSS：识别接口只接受公网 URL 或 oss://，本地路径传不进去。
 * 凭证有效期约 48 小时，仅用于本次任务。
 */

const fs = require("node:fs");
const crypto = require("node:crypto");

const config = require("../../config");
const { engines } = require("../../data");
const { readJson, assertOk } = require("./http");

function hostOf(opts = {}) {
  return opts.host || config.bailian.wsHost;
}

function apiKeyOf(opts = {}) {
  return opts.apiKey || config.bailian.apiKey;
}

function modelOf(opts = {}) {
  return opts.model || config.bailian.diarModel || DEFAULT_MODEL;
}

async function getUploadPolicy({ model, host, apiKey } = {}) {
  const h = hostOf({ host });
  const key = apiKeyOf({ apiKey });
  if (!h) throw new Error("未配置 BAILIAN_WS_HOST，无法走离线识别");
  if (!key) throw new Error("未配置 DASHSCOPE_API_KEY，无法走离线识别");

  const url =
    `https://${h}/api/v1/uploads?action=getPolicy&model=${encodeURIComponent(modelOf({ model }))}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(engines.timeouts.ossPolicyMs),
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
    signal: AbortSignal.timeout(engines.timeouts.ossUploadMs),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`上传音频失败 (HTTP ${resp.status}): ${body.slice(0, 200) || resp.statusText}`);
  }
  return `oss://${key}`;
}

/** 第三步：提交异步识别任务 */

module.exports = { hostOf, apiKeyOf, modelOf, getUploadPolicy, uploadToOss };
