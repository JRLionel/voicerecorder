/**
 * 路径解析：全部以仓库根为锚。
 *
 * 为什么不用 __dirname 直接拼：源码会随重构下沉到 src/server/**，
 * 而 data / uploads / jobs 三个目录必须固定在 server/ 下，
 * 否则用户升级后会以为「历史记录丢了」。
 */

const path = require("node:path");

const ROOT = path.resolve(__dirname, "../../..");

const SERVER_RUNTIME_DIR = path.join(ROOT, "server");

module.exports = {
  ROOT,
  publicDir: path.join(ROOT, "public"),
  serverRuntimeDir: SERVER_RUNTIME_DIR,
  dataDir: path.join(SERVER_RUNTIME_DIR, "data"),
  dbFile: path.join(SERVER_RUNTIME_DIR, "data", "voicerecorder.db"),
  uploadsDir: path.join(SERVER_RUNTIME_DIR, "uploads"),
  jobsDir: path.join(SERVER_RUNTIME_DIR, "jobs"),
};
