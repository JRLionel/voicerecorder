/**
 * ffmpeg/ffprobe 的执行封装。
 *
 * 统一三件事：不读 stdin、stderr 截断保护、非零退出码转成可读错误。
 */

const { spawn } = require("node:child_process");

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

module.exports = { run };
