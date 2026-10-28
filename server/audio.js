const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function run(cmd, args, { captureStdout = false } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", captureStdout ? "pipe" : "ignore", "pipe"] });
    let out = "";
    let err = "";
    if (captureStdout) p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => {
      err += d;
      if (err.length > 4e6) err = err.slice(-1e6);
    });
    p.on("error", (e) => reject(new Error(`无法执行 ${cmd}: ${e.message}`)));
    p.on("close", (code) => {
      if (code === 0) return resolve({ out, err });
      reject(new Error(`${cmd} 退出码 ${code}: ${err.slice(-600).trim()}`));
    });
  });
}

/** 读取媒体元信息，无音轨直接抛错（录屏静音录制是常见坑） */
async function probe(file) {
  if (!fs.existsSync(file)) throw new Error(`文件不存在: ${file}`);
  const { out } = await run(
    "ffprobe",
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file],
    { captureStdout: true }
  );
  const info = JSON.parse(out || "{}");
  const audio = (info.streams || []).find((s) => s.codec_type === "audio");
  if (!audio) throw new Error("该文件没有音轨，无法转写");

  return {
    path: path.resolve(file),
    size: Number(info.format?.size || 0),
    durationSec: Number(info.format?.duration || audio.duration || 0),
    audioCodec: audio.codec_name,
    sampleRate: Number(audio.sample_rate || 0),
    channels: Number(audio.channels || 0),
    bitRate: Number(info.format?.bit_rate || 0),
  };
}

/** 抽取为 16k 单声道 wav，并做高通 + 响度归一化（远端会议音量普遍偏小） */
async function extractWav(input, outWav, { sampleRate = 16000, normalize = true } = {}) {
  fs.mkdirSync(path.dirname(outWav), { recursive: true });
  const filters = ["highpass=f=80"];
  if (normalize) filters.push("loudnorm=I=-16:TP=-2:LRA=11");

  await run("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-i", input,
    "-vn", "-sn", "-dn",
    "-map", "0:a:0",
    "-ac", "1",
    "-ar", String(sampleRate),
    "-c:a", "pcm_s16le",
    "-af", filters.join(","),
    outWav,
  ]);

  return { path: outWav, bytes: fs.statSync(outWav).size };
}

/** 解析 silencedetect 输出，返回静音区间 [{start,end}] */
async function findSilences(wavPath, { noiseDb = -35, minDur = 0.6, totalSec = 0 } = {}) {
  const { err } = await run("ffmpeg", [
    "-hide_banner", "-nostats",
    "-i", wavPath,
    "-af", `silencedetect=noise=${noiseDb}dB:d=${minDur}`,
    "-f", "null", "-",
  ]);

  const re = /silence_(start|end):\s*(-?\d+(?:\.\d+)?)/g;
  const silences = [];
  let cur = null;
  let m;
  while ((m = re.exec(err)) !== null) {
    const val = parseFloat(m[2]);
    if (m[1] === "start") {
      cur = { start: val, end: null };
    } else if (cur) {
      cur.end = val;
      silences.push(cur);
      cur = null;
    }
  }
  if (cur) silences.push({ start: cur.start, end: totalSec || cur.start });
  return silences.filter((s) => s.end - s.start >= minDur * 0.8);
}

/**
 * 在静音点附近选切分位置，避免硬切切断词。
 * 每片目标时长 targetSec，允许在 ±targetSec*0.35 窗口内找最近的静音中点。
 * 最小间距按 targetSec 的比例算，不写死秒数（否则 30s 目标永远找不到合用的静音点）。
 */
function planCuts(totalSec, targetSec, silences = []) {
  if (totalSec <= targetSec * 1.2) return [0, totalSec];

  const cuts = [0];
  const window = targetSec * 0.35;
  const minGap = Math.max(3, targetSec * 0.6);
  let target = targetSec;

  while (target < totalSec - Math.max(5, targetSec * 0.5)) {
    let best = null;
    for (const s of silences) {
      const mid = (s.start + (s.end ?? s.start)) / 2;
      if (mid <= cuts[cuts.length - 1] + minGap) continue;
      if (mid < target - window || mid > target + window) continue;
      const dist = Math.abs(mid - target);
      if (!best || dist < best.dist) best = { mid, dist };
    }
    const cut = best ? best.mid : target;
    if (cut > cuts[cuts.length - 1] + minGap * 0.6) cuts.push(cut);
    target = cut + targetSec;
  }

  cuts.push(totalSec);
  return cuts;
}

/** 从 wav 切片出裸 PCM（s16le），供流式接口直接发送 */
async function slicePcm(wavPath, outPcm, startSec, durSec, sampleRate = 16000) {
  await run("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-ss", startSec.toFixed(3),
    "-t", durSec.toFixed(3),
    "-i", wavPath,
    "-f", "s16le",
    "-acodec", "pcm_s16le",
    "-ac", "1",
    "-ar", String(sampleRate),
    outPcm,
  ]);
  return fs.statSync(outPcm).size;
}

/** 从 wav 切片出 mp3（给 MIMO 用：同样 90s，mp3 体积只有 wav 的 1/4） */
async function sliceMp3(wavPath, outMp3, startSec, durSec, { bitrate = "64k" } = {}) {
  await run("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-ss", startSec.toFixed(3),
    "-t", durSec.toFixed(3),
    "-i", wavPath,
    "-ac", "1",
    "-ar", "16000",
    "-c:a", "libmp3lame",
    "-b:a", bitrate,
    outMp3,
  ]);
  return fs.statSync(outMp3).size;
}

/** 任意音频转裸 PCM（护栏触发时把 mp3 片转回 PCM 给百炼） */
async function toPcm(input, outPcm, sampleRate = 16000) {
  await run("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-i", input,
    "-f", "s16le",
    "-acodec", "pcm_s16le",
    "-ac", "1",
    "-ar", String(sampleRate),
    outPcm,
  ]);
  return fs.statSync(outPcm).size;
}

/**
 * 判断 [start,end] 是否整段落在静音里（共享屏幕片段常见）。
 * 用已算出的静音区间判定，比再跑一遍 volumedetect 便宜。
 */
function isSilentRange(silences, start, end, toleranceSec = 1.0) {
  return silences.some(
    (s) => s.start <= start + toleranceSec && (s.end ?? end) >= end - toleranceSec
  );
}

function fmtTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = String(Math.floor(s / 3600)).padStart(2, "0");
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${h}:${m}:${ss}`;
}

module.exports = {
  probe, extractWav, findSilences, planCuts,
  slicePcm, sliceMp3, toPcm, isSilentRange, fmtTime,
};
