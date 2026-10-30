/**
 * 任务工作目录：每个 job 一个目录，存放源文件、抽出的 wav、切片临时文件。
 */

const fs = require("node:fs");
const path = require("node:path");

const config = require("../../config");

const JOBS_DIR = config.paths.jobsDir;
fs.mkdirSync(JOBS_DIR, { recursive: true });

function jobDir(jobId) {
  const dir = path.join(JOBS_DIR, jobId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = { JOBS_DIR, jobDir };
