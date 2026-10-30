/**
 * 重启恢复：重启意味着录音会话已死。
 *
 * 顺序很重要：先拿到「正在录音」的名单，再把残留 running/queued 标为失败，
 * 最后按名单清掉半截音频（标记保留，用户还能看到当时记了什么）。
 */

const path = require("node:path");

const repos = require("../data/db/repositories");
const { JOBS_DIR } = require("../modules/transcription/workspace");
const { rmDirSafe } = require("../shared/utils/fs");

const { listRunningRecordingJobs, markInterruptedJobs } = repos.jobs;

function recoverInterrupted() {
  const runningRecordings = listRunningRecordingJobs();
  const interrupted = markInterruptedJobs();
  for (const job of runningRecordings) rmDirSafe(path.join(JOBS_DIR, job.id));
  return { runningRecordings: runningRecordings.length, interrupted };
}

module.exports = { recoverInterrupted };
