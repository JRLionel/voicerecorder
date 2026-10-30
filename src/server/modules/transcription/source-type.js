/** 从文件名推断 source_type（与扩展名白名单同源）。 */

const path = require("node:path");
const { media } = require("../../data");

function detectSourceType(filename) {
  const ext = path.extname(filename || "").toLowerCase();
  if (media.videoDetection.includes(ext)) return "video";
  return "audio";
}

/** 字率护栏：实测 MIMO 截断时只会吐 5~10 个字，与音频长短无关 */

module.exports = { detectSourceType };
