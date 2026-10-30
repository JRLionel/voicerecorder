const fs = require("node:fs");

const config = require("../../config");
const { retry } = require("../../shared/utils/retry");
const { engines } = require("../../data");

/**
 * MIMO 语音识别适配层。
 *
 * 实测边界（见 docs/meeting-minutes-ui-plan.md 附录 A.3）：
 *   7s 正常 / 60s 只出 10 字 / 120s 正常 / 300s 出 4 字 / 600s 出 5 字
 * 所以调用方必须把音频切成 ≤90s 的片，且要用字率护栏兜底。
 */

const AUTH_FATAL = /401|403|InvalidApiKey|invalid_api_key|Forbidden/i;

/**
 * 转写单个音频文件（mp3/wav）。
 * @returns {{ text: string, seconds: number, audioTokens: number }}
 */
async function transcribeFile(filePath, opts = {}) {
  const {
    apiKey = config.mimo.apiKey,
    apiUrl = config.mimo.apiUrl,
    model = config.mimo.asrModel,
    language = engines.defaults.language,
  } = opts;

  if (!apiKey || !apiUrl || !model) {
    throw new Error("服务端未配置 MIMO_API_KEY / MIMO_API_URL / MIMO_ASR_MODEL");
  }

  const buf = fs.readFileSync(filePath);
  const mime = filePath.toLowerCase().endsWith(".wav") ? "audio/wav" : "audio/mpeg";
  const dataUri = `data:${mime};base64,${buf.toString("base64")}`;
  const retries = engines.timeouts.mimoRetries;

  return retry(
    async () => {
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
        throw new Error(data.error?.message || `MIMO 请求失败 (${resp.status})`);
      }

      const text = (data.choices?.[0]?.message?.content || "").trim();
      return {
        text,
        seconds: Number(data.usage?.seconds ?? 0),
        audioTokens: Number(data.usage?.audio_tokens ?? 0),
      };
    },
    {
      retries,
      baseMs: engines.timeouts.retryBaseMs,
      isFatal: (e) => AUTH_FATAL.test(e.message),
      onFail: (e) => new Error(`MIMO 重试 ${retries} 次仍失败: ${e.message}`),
    }
  );
}

module.exports = { transcribeFile };
