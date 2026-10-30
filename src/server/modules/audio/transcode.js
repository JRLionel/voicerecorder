const fs = require("node:fs");
const path = require("node:path");

const { media } = require("../../data");
const { run } = require("./ffmpeg");

const PCM = media.pcm;
const FFMPEG = media.ffmpeg;

/** 转码：抽出 16k 单声道 wav、切出 PCM/MP3 片段。 */

async function extractWav(input, outWav, { sampleRate = PCM.sampleRate, normalize = true } = {}) {
  fs.mkdirSync(path.dirname(outWav), { recursive: true });
  const filters = [`highpass=f=${FFMPEG.highpassHz}`];
  if (normalize) filters.push(`loudnorm=${FFMPEG.loudnorm}`);

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

async function slicePcm(wavPath, outPcm, startSec, durSec, sampleRate = PCM.sampleRate) {
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

async function sliceMp3(wavPath, outMp3, startSec, durSec, { bitrate = FFMPEG.mp3Bitrate } = {}) {
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

async function toPcm(input, outPcm, sampleRate = PCM.sampleRate) {
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

module.exports = { extractWav, slicePcm, sliceMp3, toPcm };
