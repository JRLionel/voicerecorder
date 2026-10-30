/** 文件系统小工具：容错优先，清理类操作失败不阻断主流程。 */

const fs = require("node:fs");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function exists(file) {
  return Boolean(file) && fs.existsSync(file);
}

function unlinkSafe(file) {
  try {
    if (file && fs.existsSync(file)) fs.unlinkSync(file);
  } catch {}
}

function rmDirSafe(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

module.exports = { ensureDir, exists, unlinkSafe, rmDirSafe };
