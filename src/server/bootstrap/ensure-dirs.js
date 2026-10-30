/**
 * 启动目录准备：数据库、上传暂存、任务工作目录。
 *
 * 三者都在 server/ 下，位置不能随源码搬迁而漂移（老用户的音频与库都在那里）。
 */

const fs = require("node:fs");

const config = require("../config");

function ensureDirs() {
  const dirs = [config.paths.dataDir, config.paths.uploadsDir, config.paths.jobsDir];
  for (const dir of dirs) fs.mkdirSync(dir, { recursive: true });
  return dirs;
}

module.exports = { ensureDirs };
