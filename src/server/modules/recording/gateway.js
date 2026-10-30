/**
 * /ws/record 网关：连接生命周期、心跳、消息分发。
 *
 * 起始就建 job：标记需要归属，录音也需要回放。
 */

const crypto = require("node:crypto");
const path = require("node:path");
const WebSocket = require("ws");

const modelConfig = require("../model-config");
const { protocol } = require("../../data");
const repos = require("../../data/db/repositories");
const { RecordingSink } = require("../audio");
const { JOBS_DIR } = require("../transcription/workspace");
const { RecordSession } = require("./session");
const { nowIso } = require("../../shared/utils/time");

const { createJob, updateJob, getJob } = repos.jobs;
const { insertMarker, deleteMarker } = repos.markers;

function attachRealtime(server) {
  const wss = new WebSocket.Server({ server, path: "/ws/record" });

  wss.on("connection", (client) => {
    let session = null;
    let jobId = null;
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
        // 浏览器里配的实时服务优先，缺项回落到 .env
        const overrides = modelConfig.parsePayload(msg.modelConfig);
        let realtime;
        try {
          realtime = modelConfig.resolveBailian("realtime", overrides.realtime);
        } catch (e) {
          client.send(JSON.stringify({ type: "error", message: e.message }));
          return;
        }

        // 起始就建 job：标记需要归属，录音也需要回放
        const job = createJob({
          sourceType: "recording",
          filename: `实时录音 ${new Date().toLocaleString("zh-CN")}`,
          durationMs: null,
          engine: "bailian_stream",
          output: msg.output === "transcript" ? "transcript" : "summary",
          language: msg.language || "auto",
          options: { diarize: false, modelConfig: overrides },
        });
        jobId = job.id;
        updateJob(jobId, { status: "running", stage: "RECORDING", progress: 0 });

        const dir = path.join(JOBS_DIR, jobId);
        const sink = new RecordingSink(path.join(dir, "audio.wav")).open();

        session = new RecordSession(client, {
          jobId,
          sink,
          apiKey: realtime.apiKey,
          host: realtime.host,
          workspace: realtime.workspace,
          model: realtime.model,
          language: msg.language || "auto",
          output: msg.output === "transcript" ? "transcript" : "summary",
        });
        await session.start();
        return;
      }

      if (msg.type === "mark") {
        if (!jobId) {
          client.send(JSON.stringify({ type: "marker-nack", id: msg.id, message: "尚未开始录音" }));
          return;
        }
        try {
          const text = String(msg.text || "").trim();
          if (!text) throw new Error("标记内容为空");
          insertMarker({
            id: String(msg.id || crypto.randomUUID()),
            jobId,
            seq: Number(msg.seq) || 0,
            startMs: Number(msg.startMs) || 0,
            endMs: msg.endMs == null ? null : Number(msg.endMs),
            text,
            duringPause: msg.duringPause ? 1 : 0,
            createdAt: nowIso(),
          });
          client.send(JSON.stringify({ type: "marker-ack", id: msg.id }));
        } catch (e) {
          client.send(JSON.stringify({ type: "marker-nack", id: msg.id, message: e.message }));
        }
        return;
      }

      if (msg.type === "mark-delete") {
        if (!jobId || !msg.id) return;
        try {
          deleteMarker(String(msg.id));
          client.send(JSON.stringify({ type: "marker-ack", id: msg.id, deleted: true }));
        } catch (e) {
          client.send(JSON.stringify({ type: "marker-nack", id: msg.id, message: e.message }));
        }
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
      if (session) {
        // 已经正常 stop 过的会话不再处理
        session.abort("录音中断（页面已关闭），已保存的标记不受影响");
        session = null;
      }
      jobId = null;
    });
  });

  const ping = setInterval(() => {
    wss.clients.forEach((c) => {
      if (c.isAlive === false) return c.terminate();
      c.isAlive = false;
      try { c.ping(); } catch {}
    });
  }, protocol.pingIntervalMs);

  wss.on("close", () => clearInterval(ping));
  return wss;
}

module.exports = { attachRealtime };
