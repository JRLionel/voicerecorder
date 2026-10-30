/** jobs 表：转写/录音任务。 */

const { getDb } = require("../connection");
const { newId } = require("../../../shared/utils/id");
const { nowIso } = require("../../../shared/utils/time");

function createJob({
  sourceType,
  filePath = null,
  audioPath = null,
  filename = null,
  size = null,
  durationMs = null,
  engine = "mimo",
  output = "summary",
  language = "auto",
  options = {},
  templateId = null,
  autoMinutes = false,
}) {
  const db = getDb();
  const id = newId("job", 6);
  const ts = nowIso();
  db.prepare(
    `INSERT INTO jobs
       (id, source_type, file_path, audio_path, filename, size, duration_ms,
        engine, output, language, status, stage, progress, chunk_total, chunk_done,
        options_json, template_id, auto_minutes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 'QUEUED', 0, 0, 0, ?, ?, ?, ?, ?)`
  ).run(
    id, sourceType, filePath, audioPath, filename, size, durationMs,
    engine, output, language, JSON.stringify(options || {}),
    templateId, autoMinutes ? 1 : 0, ts, ts
  );
  return getJob(id);
}

function getJob(id) {
  return getDb().prepare("SELECT * FROM jobs WHERE id = ?").get(id) || null;
}

const JOB_FIELDS = [
  "status", "stage", "progress", "engine", "error", "record_id",
  "duration_ms", "effective_ms", "audio_path", "file_path",
  "chunk_total", "chunk_done", "output", "diarize_status", "speaker_count",
  "template_id", "auto_minutes",
];

function updateJob(id, fields = {}) {
  const db = getDb();
  const sets = [];
  const values = [];
  for (const key of JOB_FIELDS) {
    if (key in fields) {
      sets.push(`${key} = ?`);
      values.push(fields[key]);
    }
  }
  if (!sets.length) return getJob(id);
  sets.push("updated_at = ?");
  values.push(nowIso(), id);
  db.prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  return getJob(id);
}

/** 进程重启后把残留的 running/queued 标为 failed，并保留已完成 segments 供续跑 */
function markInterruptedJobs() {
  const info = getDb()
    .prepare(
      `UPDATE jobs
          SET status = 'failed',
              error = '服务重启导致中断，可点「继续处理」从中断处续跑',
              updated_at = ?
        WHERE status IN ('queued', 'running')`
    )
    .run(nowIso());
  return info.changes;
}

/** 处于 running 的录音任务，供启动时清理半截音频 */
function listRunningRecordingJobs() {
  return getDb()
    .prepare("SELECT * FROM jobs WHERE source_type = 'recording' AND status = 'running'")
    .all();
}

/** 原始 options_json 覆盖（重新标注时写回分离参数） */
function setJobOptions(id, options) {
  getDb().prepare("UPDATE jobs SET options_json = ? WHERE id = ?").run(JSON.stringify(options), id);
}

module.exports = {
  createJob, getJob, updateJob, markInterruptedJobs,
  listRunningRecordingJobs, setJobOptions, JOB_FIELDS,
};
