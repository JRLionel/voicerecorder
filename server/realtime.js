const crypto = require("node:crypto");
const WebSocket = require("ws");

const { createJob, updateJob, upsertSegment, createRecord } = require("./db");

const FRAME_MS = 100;
const BYTES_PER_SEC = 16000 * 2;      // 16k 单声道 s16le
const ROTATE_MS = 20 * 60 * 1000;     // 单任务 20 分钟轮转（上限未知，主动规避）
const MAX_BUFFER_BYTES = BYTES_PER_SEC * 30;
const BACKPRESSURE_BYTES = 4 * 1024 * 1024;

function nowTs() {
  return new Date().toISOString();
}

/**
 * 一路录音会话：浏览器 → 本机 WS → 百炼流式。
 * key 只在服务端，浏览器永远拿不到。
 *
 * 时间轴口径：音频时钟 = 已推入的 PCM 时长（不是墙钟），
 * 所以暂停只要「不推帧」，时间轴自然跳过，无需补偿。
 */
class RecordSession {
  constructor(client, opts) {
    this.client = client;
    this.opts = opts;                 // {language, output}
    this.ws = null;
    this.ready = false;
    this.stopped = false;
    this.rotating = false;
    this.audioMs = 0;                 // 全局音频时钟
    this.taskBaseMs = 0;              // 当前 task 的起点
    this.rotatedMs = 0;
    this.sentences = [];              // {idx,startMs,endMs,text}
    this.seq = 0;
    this.pending = [];                // 未 ready / 轮转期间的音频缓冲
    this.pendingBytes = 0;
    this.pendingStartMs = 0;
    this.taskId = null;
    this.taskResolve = null;
    this.taskTimer = null;
    this.keepalive = null;
  }

  send(obj) {
    if (this.client.readyState === WebSocket.OPEN) {
      this.client.send(JSON.stringify(obj));
    }
  }

  async start() {
    this.send({ type: "connecting" });
    try {
      await this.openTask();
    } catch (e) {
      this.send({ type: "error", message: e.message });
      this.close();
    }
  }

  wsUrl() {
    return `wss://${this.opts.host}/api-ws/v1/inference`;
  }

  openTask() {
    return new Promise((resolve, reject) => {
      const taskId = crypto.randomUUID();
      let started = false;
      let settled = false;

      const fail = (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(this.taskTimer);
        clearInterval(this.keepalive);
        reject(e);
      };

      let ws;
      try {
        ws = new WebSocket(this.wsUrl(), {
          headers: {
            Authorization: `bearer ${this.opts.apiKey}`,
            "X-DashScope-WorkSpace": this.opts.workspace,
          },
          handshakeTimeout: 15000,
        });
      } catch (e) {
        return fail(new Error(`WebSocket 创建失败: ${e.message}`));
      }

      this.ws = ws;
      this.ready = false;
      // 轮转期间缓存的音频属于「上一个任务的尾巴」，时间轴要对齐到它到达的时刻
      this.taskBaseMs = this.pending.length ? this.pendingStartMs : this.audioMs;
      this.taskId = taskId;

      // 单任务最长 5 小时，但这里 20 分钟就轮转；超时只是保护
      this.taskTimer = setTimeout(
        () => fail(new Error("识别任务超时未完成")),
        ROTATE_MS + 120000
      );

      ws.on("unexpected-response", (req, res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () =>
          fail(new Error(`握手被拒 (HTTP ${res.statusCode}): ${body.slice(0, 200)}`))
        );
      });

      ws.on("error", (e) => {
        if (!settled) fail(new Error(`识别连接错误: ${e.message}`));
        else this.send({ type: "error", message: `识别连接错误: ${e.message}` });
      });

      ws.on("open", () => {
        ws.send(JSON.stringify({
          header: { action: "run-task", task_id: taskId, streaming: "duplex" },
          payload: {
            task_group: "audio",
            task: "asr",
            function: "recognition",
            model: this.opts.model,
            parameters: Object.assign(
              { format: "pcm", sample_rate: 16000, max_sentence_silence: 800, heartbeat: true },
              this.opts.language && this.opts.language !== "auto"
                ? { language_hints: [this.opts.language] }
                : {}
            ),
            input: {},
          },
        }));
      });

      ws.on("message", (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        const event = msg.header?.event;

        if (event === "task-started") {
          started = true;
          this.ready = true;
          if (!settled) { settled = true; clearTimeout(this.taskTimer); }
          this.send({ type: "ready" });
          this.flushPending();
          this.keepalive = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
              this.ws.ping();
            }
          }, 20000);
          resolve();
          return;
        }

        if (event === "result-generated") {
          const s = msg.payload?.output?.sentence;
          if (!s || s.heartbeat) return;
          const text = (s.text || "").trim();
          if (!text) return;
          const startMs = this.taskBaseMs + Number(s.begin_time || 0);
          const endMs = this.taskBaseMs + Number(s.end_time || 0);
          this.send({
            type: "sentence",
            id: s.sentence_id,
            text,
            startMs,
            endMs,
            final: s.sentence_end === true,
          });
          if (s.sentence_end) {
            this.sentences.push({ startMs, endMs, text });
          }
          return;
        }

        if (event === "task-finished") {
          this.ready = false;
          clearInterval(this.keepalive);
          if (this.taskResolve) {
            const r = this.taskResolve;
            this.taskResolve = null;
            r();
          }
          return;
        }

        if (event === "task-failed") {
          const msgText = `任务失败 [${msg.header?.error_code || "UNKNOWN"}]: ${msg.header?.error_message || "无详情"}`;
          clearInterval(this.keepalive);
          if (started && this.taskResolve) {
            // 轮转期间失败：结束本次任务，让 stop 正常收尾
            const r = this.taskResolve;
            this.taskResolve = null;
            r();
          } else {
            fail(new Error(msgText));
          }
          this.send({ type: "error", message: msgText });
        }
      });

      ws.on("close", () => {
        if (!settled) fail(new Error("识别连接提前关闭"));
      });
    });
  }

  flushPending() {
    if (!this.ready || !this.ws) return;
    const queued = this.pending;
    this.pending = [];
    this.pendingBytes = 0;
    for (const buf of queued) this.rawSend(buf);
  }

  rawSend(buf) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.ws.bufferedAmount > BACKPRESSURE_BYTES) {
      // 背压：宁可丢最新一小段，也不让内存无限增长
      return;
    }
    this.ws.send(buf);
  }

  handleAudio(buf) {
    if (this.stopped) return;
    this.audioMs += (buf.length / BYTES_PER_SEC) * 1000;

    if (!this.ready || this.rotating) {
      if (this.pendingBytes < MAX_BUFFER_BYTES) {
        if (!this.pending.length) {
          this.pendingStartMs = Math.max(0, this.audioMs - (buf.length / BYTES_PER_SEC) * 1000);
        }
        this.pending.push(buf);
        this.pendingBytes += buf.length;
      }
      return;
    }

    this.rawSend(buf);

    if (this.audioMs - this.taskBaseMs > ROTATE_MS) {
      this.rotate();
    }
  }

  /** 满 20 分钟：结束当前 task，静默开一个，时间轴连续 */
  async rotate() {
    if (this.rotating) return;
    this.rotating = true;
    try {
      await this.finishTask();
      this.rotatedMs += this.audioMs - this.taskBaseMs;
      await this.openTask();
    } catch (e) {
      this.send({ type: "error", message: `轮转失败: ${e.message}` });
    } finally {
      this.rotating = false;
    }
  }

  finishTask() {
    return new Promise((resolve) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return resolve();
      this.ready = false;
      const timer = setTimeout(() => resolve(), 10000);
      this.taskResolve = () => {
        clearTimeout(timer);
        resolve();
      };
      try {
        this.ws.send(JSON.stringify({
          header: { action: "finish-task", task_id: this.taskId || "", streaming: "duplex" },
          payload: { input: {} },
        }));
      } catch {
        return resolve();
      }
    });
  }

  pause() {
    // 补 0.5s 静音促使当前句 sentence_end，否则跨暂停的两句会粘在一起
    if (this.ready && !this.rotating) {
      const silence = Buffer.alloc(BYTES_PER_SEC * 0.5);
      this.rawSend(silence);
    }
    this.send({ type: "paused", audioMs: Math.round(this.audioMs) });
  }

  resume() {
    this.send({ type: "resumed", audioMs: Math.round(this.audioMs) });
  }

  async stop() {
    if (this.stopped) return null;
    this.stopped = true;
    clearInterval(this.keepalive);
    await this.finishTask();
    try { this.ws && this.ws.close(); } catch {}

    const sentences = this.sentences.slice();
    if (!sentences.length) {
      this.send({ type: "done", jobId: null, recordId: null, empty: true });
      return null;
    }

    const job = createJob({
      sourceType: "recording",
      filename: `实时录音 ${new Date().toLocaleString("zh-CN")}`,
      durationMs: Math.round(this.audioMs),
      engine: "bailian_stream",
      output: this.opts.output,
      language: this.opts.language,
    });
    updateJob(job.id, {
      status: "done",
      stage: "DONE",
      progress: 100,
      effective_ms: Math.round(this.audioMs),
      chunk_total: sentences.length,
      chunk_done: sentences.length,
    });
    sentences.forEach((s, i) => {
      upsertSegment({
        jobId: job.id, idx: i,
        startMs: s.startMs, endMs: s.endMs,
        text: s.text, status: "done", engine: "bailian_stream",
      });
    });

    const transcript = sentences.map((s) => s.text).join("\n");
    const record = createRecord({
      title: `实时录音 ${new Date().toLocaleString("zh-CN")}`,
      summary: transcript.replace(/\s+/g, " ").slice(0, 46),
      source: "recording",
      template: this.opts.output === "summary" ? "meeting" : "transcribe",
      filename: null,
      size: null,
      duration: Math.round(this.audioMs / 1000),
      language: this.opts.language,
      transcript,
      job_id: job.id,
    });
    updateJob(job.id, { record_id: record.id });

    this.send({
      type: "done",
      jobId: job.id,
      recordId: record.id,
      durationMs: Math.round(this.audioMs),
      sentences: sentences.length,
    });
    return { job, record };
  }

  close() {
    this.stopped = true;
    clearInterval(this.keepalive);
    try { this.ws && this.ws.close(); } catch {}
  }
}

function attachRealtime(server) {
  const wss = new WebSocket.Server({ server, path: "/ws/record" });

  wss.on("connection", (client) => {
    let session = null;
    client.isAlive = true;
    client.on("pong", () => { client.isAlive = true; });

    client.on("message", async (data, isBinary) => {
      if (isBinary) {
        if (session) session.handleAudio(data);
        return;
      }
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      if (msg.type === "start") {
        if (session) return;
        const missing = ["DASHSCOPE_API_KEY", "BAILIAN_WS_HOST", "BAILIAN_WORKSPACE"]
          .filter((k) => !process.env[k]);
        if (missing.length) {
          client.send(JSON.stringify({
            type: "error",
            message: `服务端未配置 ${missing.join(" / ")}，实时转写不可用`,
          }));
          return;
        }
        session = new RecordSession(client, {
          apiKey: process.env.DASHSCOPE_API_KEY,
          host: process.env.BAILIAN_WS_HOST,
          workspace: process.env.BAILIAN_WORKSPACE,
          model: process.env.ASR_MODEL || "qwen-audio-3.0-asr-flash-streaming",
          language: msg.language || "auto",
          output: msg.output === "transcript" ? "transcript" : "summary",
        });
        await session.start();
        return;
      }

      if (msg.type === "pause") return session && session.pause();
      if (msg.type === "resume") return session && session.resume();
      if (msg.type === "stop") {
        if (!session) {
          client.send(JSON.stringify({ type: "error", message: "尚未开始录音" }));
          return;
        }
        await session.stop();
        return;
      }
    });

    client.on("close", () => {
      if (session) session.close();
      session = null;
    });
  });

  const ping = setInterval(() => {
    wss.clients.forEach((c) => {
      if (c.isAlive === false) return c.terminate();
      c.isAlive = false;
      try { c.ping(); } catch {}
    });
  }, 30000);

  wss.on("close", () => clearInterval(ping));
  return wss;
}

module.exports = { attachRealtime, RecordSession, FRAME_MS };
