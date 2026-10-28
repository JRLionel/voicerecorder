const fs = require("node:fs");

/**
 * MIMO 语音识别适配层。
 *
 * 实测边界（见 docs/meeting-minutes-ui-plan.md 附录 A.3）：
 *   7s 正常 / 60s 只出 10 字 / 120s 正常 / 300s 出 4 字 / 600s 出 5 字
 * 所以调用方必须把音频切成 ≤90s 的片，且要用字率护栏兜底。
 */

function withRetry(fn, { retries = 2, label = "MIMO" } = {}) {
  return (async () => {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        // 凭证/权限类错误重试没有意义，直接抛出
        if (/401|403|InvalidApiKey|invalid_api_key|Forbidden/i.test(e.message)) throw e;
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        }
      }
    }
    throw new Error(`${label} 重试 ${retries} 次仍失败: ${lastErr.message}`);
  })();
}

/**
 * 转写单个音频文件（mp3/wav）。
 * @returns {{ text: string, seconds: number, audioTokens: number }}
 */
async function transcribeFile(filePath, opts = {}) {
  const {
    apiKey = process.env.MIMO_API_KEY,
    apiUrl = process.env.MIMO_API_URL,
    model = process.env.MIMO_ASR_MODEL,
    language = "auto",
  } = opts;

  if (!apiKey || !apiUrl || !model) {
    throw new Error("服务端未配置 MIMO_API_KEY / MIMO_API_URL / MIMO_ASR_MODEL");
  }

  const buf = fs.readFileSync(filePath);
  const mime = filePath.toLowerCase().endsWith(".wav") ? "audio/wav" : "audio/mpeg";
  const dataUri = `data:${mime};base64,${buf.toString("base64")}`;

  return withRetry(async () => {
    const resp = await fetch(apiUrl, {
      method: "POST",
      headers: { "api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content: [{ type: "input_audio", input_audio: { data: dataUri } }],
          },
        ],
        asr_options: { language },
      }),
    });

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error(
        data.error?.message || `MIMO 请求失败 (${resp.status})`
      );
    }

    const text = (data.choices?.[0]?.message?.content || "").trim();
    return {
      text,
      seconds: Number(data.usage?.seconds ?? 0),
      audioTokens: Number(data.usage?.audio_tokens ?? 0),
    };
  });
}

module.exports = { transcribeFile };
