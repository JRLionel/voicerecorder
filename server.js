require("dotenv").config();
const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const ffmpeg = require("fluent-ffmpeg");
const { createRecord, listRecords, getRecord, updateRecord, deleteRecord } = require("./server/db");

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.MIMO_API_KEY;

const ALLOWED_TYPES = [
  "audio/mpeg", "audio/wav", "audio/x-wav", "audio/mp4",
  "audio/x-m4a", "audio/ogg", "audio/flac", "audio/webm", "video/mp4",
];
const ALLOWED_EXTENSIONS = [".mp3", ".wav", ".m4a", ".ogg", ".flac", ".webm", ".mp4"];
const MAX_SIZE = 25 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIZE },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXTENSIONS.includes(ext) || ALLOWED_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("不支持的音频格式，请上传 mp3/wav/m4a/ogg/flac/webm/mp4 文件"));
    }
  },
});

function convertToMp3(inputBuffer, ext) {
  return new Promise((resolve, reject) => {
    const tmpIn = path.join("/tmp", `mimo_in_${Date.now()}${ext}`);
    const tmpOut = tmpIn.replace(ext, ".mp3");

    fs.writeFileSync(tmpIn, inputBuffer);

    ffmpeg(tmpIn)
      .toFormat("mp3")
      .on("end", () => {
        const mp3Buffer = fs.readFileSync(tmpOut);
        fs.unlinkSync(tmpIn);
        fs.unlinkSync(tmpOut);
        resolve(mp3Buffer);
      })
      .on("error", (err) => {
        try { fs.unlinkSync(tmpIn); } catch {}
        try { fs.unlinkSync(tmpOut); } catch {}
        reject(err);
      })
      .save(tmpOut);
  });
}

function getExtFromMime(mimetype, originalName) {
  const ext = path.extname(originalName).toLowerCase();
  if (ext) return ext;
  const map = {
    "audio/mpeg": ".mp3", "audio/mp3": ".mp3", "audio/wav": ".wav",
    "audio/x-wav": ".wav", "audio/wave": ".wav", "audio/mp4": ".m4a",
    "audio/x-m4a": ".m4a", "audio/ogg": ".ogg", "audio/flac": ".flac",
    "audio/webm": ".webm",
  };
  return map[mimetype] || ".mp3";
}

app.use(express.static(path.join(__dirname, "public")));

app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: "请上传音频文件" });
  }

  if (!API_KEY) {
    return res.status(500).json({ success: false, error: "服务端未配置 API Key" });
  }

  const language = req.body.language || "auto";
  const ext = getExtFromMime(req.file.mimetype, req.file.originalname);
  const isSupported = [".mp3", ".wav"].includes(ext);

  let audioBuffer;
  let mimeType;

  try {
    if (isSupported) {
      audioBuffer = req.file.buffer;
      mimeType = ext === ".wav" ? "audio/wav" : "audio/mpeg";
    } else {
      audioBuffer = await convertToMp3(req.file.buffer, ext);
      mimeType = "audio/mpeg";
    }
  } catch (err) {
    console.error("音频转码失败:", err);
    return res.status(400).json({ success: false, error: `音频转码失败: ${err.message}` });
  }

  const base64Audio = audioBuffer.toString("base64");
  const dataUri = `data:${mimeType};base64,${base64Audio}`;

  try {
    const response = await fetch("https://api.xiaomimimo.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "api-key": API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "mimo-v2.5-asr",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "input_audio",
                input_audio: { data: dataUri },
              },
            ],
          },
        ],
        asr_options: { language },
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      const msg = data.error?.message || `API 请求失败 (${response.status})`;
      return res.status(response.status).json({ success: false, error: msg });
    }

    const text = data.choices?.[0]?.message?.content || "";
    const usage = data.usage || {};

    let recordId = null;
    try {
      const record = createRecord({
        title: req.file.originalname,
        summary: text ? text.slice(0, 100) : null,
        source: "upload",
        template: "transcribe",
        filename: req.file.originalname,
        size: req.file.size,
        duration: usage.seconds ?? null,
        language,
        transcript: text,
        client_id: req.body.clientId || null,
      });
      recordId = record.id;
    } catch (dbErr) {
      console.error("转写结果落库失败:", dbErr);
    }

    res.json({ success: true, text, usage, recordId });
  } catch (err) {
    console.error("转写请求失败:", err);
    res.status(500).json({ success: false, error: `转写请求失败: ${err.message}` });
  }
});

app.use(express.json());

app.post("/api/meeting-summary", async (req, res) => {
  const { text, recordId } = req.body;

  if (!text || !text.trim()) {
    return res.status(400).json({ success: false, error: "请提供转写文本" });
  }

  if (!API_KEY) {
    return res.status(500).json({ success: false, error: "服务端未配置 API Key" });
  }

  const systemPrompt = `你是一个专业的会议纪要整理助手。请根据用户提供的会议转写文本，按照以下模板生成结构化的会议纪要：

主题：（根据会议内容提炼一个简洁的主题）
会议内容：（将会议讨论的核心内容整理为结构化的要点，分条列出）
待办事项：（从会议内容中提取所有待办事项和行动项，明确责任人和截止时间（如有），以列表形式呈现）

要求：
- 使用中文输出
- 主题要简洁准确
- 会议内容要提炼重点，不要逐字复述
- 待办事项要具体可执行
- 如果转写文本中没有明确的待办事项，请写"无"`;

  try {
    const response = await fetch("https://api.xiaomimimo.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "api-key": API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "mimo-v2.5-pro",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: text },
        ],
        max_completion_tokens: 2048,
        temperature: 0.3,
        stream: false,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      const msg = data.error?.message || `API 请求失败 (${response.status})`;
      return res.status(response.status).json({ success: false, error: msg });
    }

    const summary = data.choices?.[0]?.message?.content || "";
    const usage = data.usage || {};

    if (recordId) {
      try {
        const updated = updateRecord(recordId, {
          summary_text: summary,
          summary: summary ? summary.slice(0, 100) : null,
        });
        if (!updated) console.warn(`纪要回写失败: 记录 ${recordId} 不存在`);
      } catch (dbErr) {
        console.error("纪要结果落库失败:", dbErr);
      }
    }

    res.json({ success: true, summary, usage, recordId });
  } catch (err) {
    console.error("生成会议纪要失败:", err);
    res.status(500).json({ success: false, error: `生成会议纪要失败: ${err.message}` });
  }
});

// ---- Records API ----

app.get("/api/records", (req, res) => {
  const { q, page, pageSize } = req.query;
  res.json({ success: true, ...listRecords({ q, page, pageSize }) });
});

app.get("/api/records/:id", (req, res) => {
  const record = getRecord(req.params.id);
  if (!record) {
    return res.status(404).json({ success: false, error: "记录不存在" });
  }
  res.json({ success: true, record });
});

app.post("/api/records", (req, res) => {
  try {
    const b = req.body || {};
    const record = createRecord({
      title: b.title,
      summary: b.summary,
      source: b.source,
      template: b.template,
      filename: b.filename,
      size: b.size,
      duration: b.duration,
      language: b.language,
      transcript: b.transcript,
      summary_text: b.summaryText,
      client_id: b.clientId,
    });
    res.json({ success: true, record });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.patch("/api/records/:id", (req, res) => {
  try {
    const record = updateRecord(req.params.id, req.body || {});
    if (!record) {
      return res.status(404).json({ success: false, error: "记录不存在" });
    }
    res.json({ success: true, record });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.delete("/api/records/:id", (req, res) => {
  const ok = deleteRecord(req.params.id);
  if (!ok) {
    return res.status(404).json({ success: false, error: "记录不存在" });
  }
  res.json({ success: true });
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ success: false, error: "文件大小不能超过 25MB" });
    }
    return res.status(400).json({ success: false, error: err.message });
  }
  if (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
  next();
});

app.listen(PORT, () => {
  console.log(`服务器运行在 http://localhost:${PORT}`);
  if (!API_KEY) {
    console.warn("警告: 未设置 MIMO_API_KEY，请在 .env 文件中配置");
  }
});
