/** 百炼接口的响应处理：非 2xx 统一转成可读错误。 */

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

module.exports = { readJson, assertOk };
