/** 媒体探测：读取时长与音轨信息，无音轨直接抛错（录屏静音录制是常见坑）。 */

const fs = require("node:fs");
const path = require("node:path");

const { run } = require("./ffmpeg");

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

module.exports = { probe };
