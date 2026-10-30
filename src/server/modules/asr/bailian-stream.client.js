const fs = require("node:fs");
const crypto = require("node:crypto");
const WebSocket = require("ws");

const { engines, media, protocol } = require("../../data");
const { retry } = require("../../shared/utils/retry");

const FRAME_MS = protocol.frameMs;
const AUTH_FATAL = /401|403|InvalidApiKey|AccessDenied|ModelNotOpen/i;

function wsUrl(host) {
  return `wss://${host}/api-ws/v1/inference`;
}

function loadPcm(pcmPath) {
  const buf = fs.readFileSync(pcmPath);
  if (!buf.length) throw new Error(`PCM 文件为空: ${pcmPath}`);
  return buf;
}

/**
 * 单任务流式识别：连一次 WebSocket，run-task → 逐帧推 PCM → finish-task。
 * 服务端 VAD 负责断句，返回句级时间戳（ms）。
 */
function transcribeOnce(buf, opts) {
  const {
    apiKey,
    host,
    workspace,
    model,
    sampleRate = media.pcm.sampleRate,
    languageHints,
    maxSentenceSilence = protocol.sentenceSilenceMs,
    speed = protocol.streamSpeed,
    vocabulary,
    context,
    onSentence,
    connectTimeoutMs = protocol.handshakeMs,
  } = opts;

  const taskId = crypto.randomUUID();
  const startedAt = Date.now();
  const audioMs = (buf.length / (sampleRate * 2)) * 1000;
  const deadline = startedAt + Math.max(protocol.streamDeadline.minMs, audioMs / speed + protocol.streamDeadline.minMs);

  return new Promise((resolve, reject) => {
    const sentences = new Map();
    let usage = null;
    let settled = false;
    let sending = false;
    let sent = 0;
    let ws;

    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      clearTimeout(hardTimeout);
      try { ws && ws.removeAllListeners(); ws && ws.close(); } catch {}
      if (err) reject(err);
      else resolve(result);
    };

    const hardTimeout = setTimeout(
      () => finish(new Error(`识别超时（已发送 ${((sent / buf.length) * 100).toFixed(0)}% 音频）`)),
      deadline - Date.now()
    );

    const timer = setInterval(() => {
      if (!sending || settled) return;
      if (ws.bufferedAmount > protocol.backpressureBytes) return;
      if (sent >= buf.length) {
        clearInterval(timer);
        ws.send(JSON.stringify({
          header: { action: "finish-task", task_id: taskId, streaming: "duplex" },
          payload: { input: {} },
        }));
        return;
      }
      const end = Math.min(sent + (sampleRate * 2 * FRAME_MS) / 1000, buf.length);
      ws.send(buf.subarray(sent, end));
      sent = end;
    }, Math.max(5, Math.round(FRAME_MS / speed)));

    try {
      ws = new WebSocket(wsUrl(host), {
        headers: {
          Authorization: `bearer ${apiKey}`,
          "X-DashScope-WorkSpace": workspace,
        },
        handshakeTimeout: connectTimeoutMs,
      });
    } catch (e) {
      return finish(new Error(`WebSocket 创建失败: ${e.message}`));
    }

    ws.on("unexpected-response", (req, res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () =>
        finish(new Error(`握手被拒 (HTTP ${res.statusCode}): ${body.slice(0, 300)}`))
      );
    });

    ws.on("error", (e) => finish(new Error(`WebSocket 错误: ${e.message}`)));

    ws.on("open", () => {
      ws.send(JSON.stringify({
        header: { action: "run-task", task_id: taskId, streaming: "duplex" },
        payload: {
          task_group: "audio",
          task: "asr",
          function: "recognition",
          model,
          parameters: Object.assign(
            {
              format: "pcm",
              sample_rate: sampleRate,
              max_sentence_silence: maxSentenceSilence,
              heartbeat: true,
            },
            languageHints && languageHints.length ? { language_hints: languageHints } : {},
            vocabulary && Object.keys(vocabulary).length ? { vocabulary } : {}
          ),
          input: context && context.length ? { context } : {},
        },
      }));
    });

    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      const event = msg.header?.event;

      if (event === "task-started") {
        sending = true;
        return;
      }

      if (event === "result-generated") {
        const s = msg.payload?.output?.sentence;
        if (msg.payload?.usage) usage = msg.payload.usage;
        if (!s || s.heartbeat) return;
        if (!s.sentence_end) return;
        const item = {
          id: s.sentence_id,
          startMs: s.begin_time,
          endMs: s.end_time,
          text: (s.text || "").trim(),
          speaker: s.speaker_id ?? null,
        };
        if (!item.text) return;
        sentences.set(item.id, item);
        if (typeof onSentence === "function") onSentence(item);
        return;
      }

      if (event === "task-finished") {
        usage = msg.payload?.usage || usage;
        const list = [...sentences.values()].sort((a, b) => a.id - b.id);
        return finish(null, {
          sentences: list,
          usage,
          elapsedMs: Date.now() - startedAt,
          taskId,
        });
      }

      if (event === "task-failed") {
        return finish(
          new Error(
            `任务失败 [${msg.header?.error_code || "UNKNOWN"}]: ${msg.header?.error_message || "无详情"}`
          )
        );
      }
    });

    ws.on("close", (code, reason) => {
      if (!settled) finish(new Error(`连接提前关闭 (${code}) ${reason?.toString() || ""}`));
    });
  });
}

/** 带重试的封装：网络抖动 / 任务失败时整段重跑 */
async function transcribePcm(pcmPath, opts) {
  const buf = loadPcm(pcmPath);
  const retries = opts.retries ?? engines.timeouts.bailianRetries;
  return retry(() => transcribeOnce(buf, opts), {
    retries,
    baseMs: engines.timeouts.retryBaseMs,
    isFatal: (e) => AUTH_FATAL.test(e.message),
  });
}

module.exports = { transcribePcm, transcribeOnce };
