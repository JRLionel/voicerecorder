/**
 * 孤儿任务目录清理：无对应 job 行，或 7 天内没产生记录且已结束。
 *
 * 磁盘上 1 小时录音约 115MB，不清会一直堆着。
 */

const fs = require("node:fs");
const path = require("node:path");

const repos = require("../data/db/repositories");
const { JOBS_DIR } = require("../modules/transcription/workspace");
const { rmDirSafe } = require("../shared/utils/fs");

const { getJob } = repos.jobs;

const ORPHAN_TTL_MS = 7 * 24 * 3600 * 1000;

function cleanupOrphanJobs(now = Date.now()) {
  let removed = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(JOBS_DIR, { withFileTypes: true });
  } catch {
    return 0;
  }

  const cutoff = now - ORPHAN_TTL_MS;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(JOBS_DIR, entry.name);
    const job = getJob(entry.name);

    if (!job) {
      if (rmDirSafe(dir)) removed += 1;
      continue;
    }

    const finished = ["done", "failed", "canceled"].includes(job.status);
    const old = new Date(job.updated_at || job.created_at || 0).getTime() < cutoff;
    if (finished && !job.record_id && old && rmDirSafe(dir)) removed += 1;
  }
  return removed;
}

module.exports = { cleanupOrphanJobs, ORPHAN_TTL_MS };
