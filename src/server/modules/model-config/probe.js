/**
 * 连通性检测：真发一次最小请求，看服务到底通不通。
 *
 * 三种引擎各用各的「最轻的一次真实交互」——只有真的调一次，
 * 才能同时验出地址、密钥、模型三件事：
 *   - MIMO（纪要 / 非实时转写）：发一条极短的 chat completion
 *   - 百炼离线分离：取一次上传凭证（GET，带模型参数）
 *   - 百炼实时：连一次 WebSocket 并发起一个空任务，模型不对会被服务端当场拒掉
 *
 * 失败一律转成可读文案，不把堆栈抛给前端。
 */

const crypto = require("node:crypto");
const WebSocket = require("ws");

const { readJson } = require("../asr/http");

const PROBE_TIMEOUT_MS = 10000;

/** 把服务端的错误体压成一句话 */
function errText(resp, data) {
  const raw = typeof data?.raw === "string" ? data.raw.slice(0, 200) : "";
  return (
    data?.error?.message ||
    data?.message ||
    data?.code ||
    raw ||
    resp.statusText ||
    "未知错误"
  );
}

/**
 * 生成 0.25 秒静音 WAV（16k 单声道），用作 ASR 探测的输入。
 * ASR 模型不接纯文本，只认 input_audio，所以探测也得按真实格式发。
 */
function silentWavDataUri() {
  const sampleRate = 16000;
  const samples = Math.floor(sampleRate * 0.25);
  const dataSize = samples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);            // PCM
  buf.writeUInt16LE(1, 22);            // 单声道
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);            // 16bit
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  return `data:audio/wav;base64,${buf.toString("base64")}`;
}

/**
 * MIMO：一次最小请求，验地址 + 密钥 + 模型。
 * kind=chat 走文本（纪要模型）；kind=asr 走音频（识别模型）。
 */
async function probeMimo({ url, key, model }, { kind = "chat" } = {}) {
  const body =
    kind === "asr"
      ? {
          model,
          messages: [
            {
              role: "user",
              content: [{ type: "input_audio", input_audio: { data: silentWavDataUri() } }],
            },
          ],
          asr_options: { language: "auto" },
        }
      : {
          model,
          messages: [{ role: "user", content: "ping" }],
          max_completion_tokens: 16,
          temperature: 0.1,
          stream: false,
        };

  const started = Date.now();
  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`无法连接：${e.message}`);
  }

  const data = await readJson(resp);
  if (!resp.ok) {
    throw new Error(`服务返回 ${resp.status}：${errText(resp, data)}`);
  }
  if (!Array.isArray(data?.choices) || !data.choices.length) {
    throw new Error("服务有响应但不是对话格式，请确认地址是 chat/completions 端点");
  }
  return { latencyMs: Date.now() - started };
}

/** 百炼离线识别：取一次上传凭证（不产生任何文件） */
async function probeBailianPolicy({ host, key, model }) {
  const started = Date.now();
  const url = `https://${host}/api/v1/uploads?action=getPolicy&model=${encodeURIComponent(model)}`;
  let resp;
  try {
    resp = await fetch(url, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`无法连接：${e.message}`);
  }

  const data = await readJson(resp);
  if (!resp.ok) {
    throw new Error(`服务返回 ${resp.status}：${errText(resp, data)}`);
  }
  const policy = data.data || data;
  if (!policy?.policy || !policy?.signature) {
    throw new Error("服务有响应但缺少上传凭证，请确认地址是否指向百炼接口");
  }
  return { latencyMs: Date.now() - started };
}

/** 百炼实时：连一次 WebSocket，发一个空任务，等它说 task-started */
function probeBailianRealtime({ host, key, model, workspace }) {
  const started = Date.now();
  const headers = { Authorization: `bearer ${key}` };
  if (workspace) headers["X-DashScope-WorkSpace"] = workspace;

  return new Promise((resolve, reject) => {
    let settled = false;
    let ws;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws && ws.removeAllListeners();
        ws && ws.close();
      } catch {}
      if (err) reject(err);
      else resolve({ latencyMs: Date.now() - started });
    };

    const timer = setTimeout(
      () => finish(new Error("连接超时，服务没有回应")),
      PROBE_TIMEOUT_MS
    );

    try {
      ws = new WebSocket(`wss://${host}/api-ws/v1/inference`, {
        headers,
        handshakeTimeout: PROBE_TIMEOUT_MS,
      });
    } catch (e) {
      return finish(new Error(`无法连接：${e.message}`));
    }

    ws.on("unexpected-response", (req, res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () =>
        finish(
          new Error(
            `握手被拒 (HTTP ${res.statusCode})：${body.slice(0, 200) || res.statusMessage}`
          )
        )
      );
    });

    ws.on("error", (e) => finish(new Error(`无法连接：${e.message}`)));

    ws.on("open", () => {
      // 发起一个空任务：模型没开通的话，服务端会在这里直接回 task-failed
      ws.send(
        JSON.stringify({
          header: { action: "run-task", task_id: crypto.randomUUID(), streaming: "duplex" },
          payload: {
            task_group: "audio",
            task: "asr",
            function: "recognition",
            model,
            parameters: { format: "pcm", sample_rate: 16000, heartbeat: true },
            input: {},
          },
        })
      );
    });

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const event = msg.header?.event;
      if (event === "task-started") return finish(null);
      if (event === "task-failed") {
        return finish(
          new Error(
            `服务拒绝了这个任务：${msg.header?.error_message || msg.header?.error_code || "模型不可用"}`
          )
        );
      }
    });

    ws.on("close", (code) => {
      if (!settled) finish(new Error(`连接提前关闭 (${code})`));
    });
  });
}

/**
 * 按作用域分发到对应的探法。
 * @param {string} scope minutes | batch | diar | realtime
 * @param {object} resolved 已合并好的生效配置
 */
async function probe(scope, resolved) {
  if (scope === "minutes") {
    return probeMimo(resolved, { kind: "chat" });
  }
  if (scope === "batch") {
    // 识别模型只认音频，探测也得按真实格式发
    return probeMimo(resolved, { kind: "asr" });
  }
  if (scope === "diar") {
    return probeBailianPolicy(resolved);
  }
  if (scope === "realtime") {
    return probeBailianRealtime(resolved);
  }
  throw new Error(`未知的配置项：${scope}`);
}

module.exports = { probe, probeMimo, silentWavDataUri, PROBE_TIMEOUT_MS };
