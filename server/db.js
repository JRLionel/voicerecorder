const { DatabaseSync } = require("node:sqlite");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const DATA_DIR = path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "voicerecorder.db");

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");

db.exec(`
  CREATE TABLE IF NOT EXISTS records (
    id            TEXT PRIMARY KEY,
    title         TEXT NOT NULL,
    summary       TEXT,
    source        TEXT NOT NULL DEFAULT 'upload',
    template      TEXT,
    filename      TEXT,
    size          INTEGER,
    duration      INTEGER,
    language      TEXT DEFAULT 'auto',
    transcript    TEXT,
    summary_text  TEXT,
    client_id     TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_records_created ON records(created_at);
  CREATE INDEX IF NOT EXISTS idx_records_client  ON records(client_id);

  CREATE TABLE IF NOT EXISTS jobs (
    id            TEXT PRIMARY KEY,
    source_type   TEXT NOT NULL,            -- video | audio | recording
    file_path     TEXT,
    audio_path    TEXT,
    filename      TEXT,
    size          INTEGER,
    duration_ms   INTEGER,
    effective_ms  INTEGER,                  -- 录音=有效时长（跳过暂停）
    engine        TEXT,                     -- mimo | bailian_stream | bailian_filetrans
    output        TEXT,                     -- summary | transcript
    language      TEXT DEFAULT 'auto',
    status        TEXT NOT NULL,            -- queued|running|done|failed|canceled
    stage         TEXT,
    progress      REAL DEFAULT 0,
    chunk_total   INTEGER DEFAULT 0,
    chunk_done    INTEGER DEFAULT 0,
    record_id     TEXT,
    error         TEXT,
    options_json  TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at);
  CREATE INDEX IF NOT EXISTS idx_jobs_status  ON jobs(status);

  CREATE TABLE IF NOT EXISTS segments (
    id          TEXT PRIMARY KEY,
    job_id      TEXT NOT NULL,
    idx         INTEGER NOT NULL,
    start_ms    INTEGER NOT NULL,
    end_ms      INTEGER NOT NULL,
    speaker_fk  TEXT,                       -- 预留，恒 NULL
    text        TEXT,
    status      TEXT,                       -- pending|done|failed|fallback
    engine      TEXT,
    retry       INTEGER DEFAULT 0,
    UNIQUE(job_id, idx)
  );
  CREATE INDEX IF NOT EXISTS idx_segments_job ON segments(job_id, start_ms);

  -- 说话人名册：一次任务内全局唯一，支持重命名
  CREATE TABLE IF NOT EXISTS speakers (
    id          TEXT PRIMARY KEY,
    job_id      TEXT NOT NULL,
    local_id    TEXT NOT NULL,              -- S0 / S1 ...
    label       TEXT NOT NULL,              -- 说话人1 / 张总
    color       TEXT,
    first_ms    INTEGER,
    talk_ms     INTEGER DEFAULT 0,
    UNIQUE(job_id, local_id)
  );
  CREATE INDEX IF NOT EXISTS idx_speakers_job ON speakers(job_id, first_ms);

  -- 用户标记：与转写共用音频时钟
  CREATE TABLE IF NOT EXISTS markers (
    id            TEXT PRIMARY KEY,
    job_id        TEXT NOT NULL,
    seq           INTEGER NOT NULL DEFAULT 0,
    start_ms      INTEGER NOT NULL,         -- 首次键入时的音频时钟
    end_ms        INTEGER,                  -- 回车时的音频时钟
    text          TEXT NOT NULL,
    during_pause  INTEGER DEFAULT 0,
    created_at    TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_markers_job ON markers(job_id, start_ms);
`);

/** 幂等加列：老库升级时补齐新字段 */
function ensureColumns(table, columns) {
  const existing = new Set(
    db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)
  );
  for (const [name, type] of Object.entries(columns)) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
  }
}

ensureColumns("records", {
  job_id: "TEXT",
  summary_json: "TEXT",
  speakers_json: "TEXT",
});

ensureColumns("jobs", {
  diarize_status: "TEXT",     // off | ok | failed | suspect
  speaker_count: "INTEGER",
});

ensureColumns("segments", {
  speaker: "TEXT",            // 'S0'，NULL = 无说话人
  speaker_label: "TEXT",      // 冗余快照，便于直接渲染
  speaker_conf: "REAL",
});

function now() {
  return new Date().toISOString();
}

function createRecord({
  title,
  summary = null,
  source = "upload",
  template = null,
  filename = null,
  size = null,
  duration = null,
  language = "auto",
  transcript = null,
  summary_text = null,
  summary_json = null,
  speakers_json = null,
  client_id = null,
  job_id = null,
}) {
  if (!title || !String(title).trim()) {
    throw new Error("记录标题不能为空");
  }
  const id = "rec_" + crypto.randomBytes(6).toString("hex");
  const created = now();
  db.prepare(
    `INSERT INTO records
       (id, title, summary, source, template, filename, size, duration,
        language, transcript, summary_text, summary_json, speakers_json,
        client_id, job_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, String(title).trim(), summary, source, template, filename, size, duration,
    language, transcript, summary_text, summary_json, speakers_json,
    client_id, job_id, created, created
  );
  return getRecord(id);
}

function listRecords({ q = "", page = 1, pageSize = 20 } = {}) {
  const limit = Math.min(Math.max(parseInt(pageSize, 10) || 20, 1), 100);
  const offset = Math.max((parseInt(page, 10) || 1) - 1, 0) * limit;
  const params = [];
  let where = "";
  if (q && String(q).trim()) {
    where = "WHERE title LIKE ?";
    params.push(`%${String(q).trim()}%`);
  }
  const total = db.prepare(`SELECT COUNT(*) AS n FROM records ${where}`).get(...params).n;
  const rows = db
    .prepare(
      `SELECT id, title, summary, source, template, filename, size, duration,
              language, created_at
         FROM records ${where}
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset);
  return { total, page: parseInt(page, 10) || 1, pageSize: limit, items: rows };
}

function getRecord(id) {
  return db.prepare("SELECT * FROM records WHERE id = ?").get(id) || null;
}

function updateRecord(id, fields = {}) {
  const allowed = [
    "title", "summary", "summary_text", "summary_json", "speakers_json",
    "template", "duration", "transcript", "job_id",
  ];
  const sets = [];
  const values = [];
  for (const key of allowed) {
    if (key in fields) {
      sets.push(`${key} = ?`);
      values.push(fields[key]);
    }
  }
  if (!sets.length) return getRecord(id);
  sets.push("updated_at = ?");
  values.push(now(), id);
  const info = db.prepare(`UPDATE records SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  if (info.changes === 0) return null;
  return getRecord(id);
}

// ============ jobs ============

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
}) {
  const id = "job_" + crypto.randomBytes(6).toString("hex");
  const ts = now();
  db.prepare(
    `INSERT INTO jobs
       (id, source_type, file_path, audio_path, filename, size, duration_ms,
        engine, output, language, status, stage, progress, chunk_total, chunk_done,
        options_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 'QUEUED', 0, 0, 0, ?, ?, ?)`
  ).run(
    id, sourceType, filePath, audioPath, filename, size, durationMs,
    engine, output, language, JSON.stringify(options || {}), ts, ts
  );
  return getJob(id);
}

function getJob(id) {
  return db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) || null;
}

const JOB_FIELDS = [
  "status", "stage", "progress", "engine", "error", "record_id",
  "duration_ms", "effective_ms", "audio_path", "file_path",
  "chunk_total", "chunk_done", "output", "diarize_status", "speaker_count",
];

function updateJob(id, fields = {}) {
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
  values.push(now(), id);
  db.prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  return getJob(id);
}

/** 进程重启后把残留的 running/queued 标为 failed，并保留已完成 segments 供续跑 */
function markInterruptedJobs() {
  const info = db
    .prepare(
      `UPDATE jobs
          SET status = 'failed',
              error = '服务重启导致中断，可点「继续处理」从中断处续跑',
              updated_at = ?
        WHERE status IN ('queued', 'running')`
    )
    .run(now());
  return info.changes;
}

/** 处于 running 的录音任务，供启动时清理半截音频 */
function listRunningRecordingJobs() {
  return db
    .prepare("SELECT * FROM jobs WHERE source_type = 'recording' AND status = 'running'")
    .all();
}

// ============ segments ============

function upsertSegment({
  jobId, idx, startMs, endMs, text = null, status = "done", engine = null,
  retry = 0, speaker = null, speakerLabel = null, speakerConf = null,
}) {
  db.prepare(
    `INSERT INTO segments
       (id, job_id, idx, start_ms, end_ms, speaker_fk, text, status, engine, retry,
        speaker, speaker_label, speaker_conf)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(job_id, idx) DO UPDATE SET
       start_ms      = excluded.start_ms,
       end_ms        = excluded.end_ms,
       text          = excluded.text,
       status        = excluded.status,
       engine        = excluded.engine,
       retry         = excluded.retry,
       speaker       = excluded.speaker,
       speaker_label = excluded.speaker_label,
       speaker_conf  = excluded.speaker_conf`
  ).run(
    "seg_" + crypto.randomBytes(6).toString("hex"),
    jobId, idx, Math.round(startMs), Math.round(endMs), text, status, engine, retry,
    speaker, speakerLabel, speakerConf
  );
}

function listSegments(jobId) {
  return db
    .prepare("SELECT * FROM segments WHERE job_id = ? ORDER BY idx ASC")
    .all(jobId);
}

/** 已完成的片号集合，用于续跑时跳过 */
function doneSegmentIndexes(jobId) {
  return new Set(
    db
      .prepare("SELECT idx FROM segments WHERE job_id = ? AND status IN ('done','fallback')")
      .all(jobId)
      .map((r) => r.idx)
  );
}

function clearSegments(jobId) {
  db.prepare("DELETE FROM segments WHERE job_id = ?").run(jobId);
}

// ============ speakers ============

function upsertSpeaker({ jobId, localId, label, color = null, firstMs = null, talkMs = 0 }) {
  db.prepare(
    `INSERT INTO speakers (id, job_id, local_id, label, color, first_ms, talk_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(job_id, local_id) DO UPDATE SET
       label    = excluded.label,
       color    = COALESCE(excluded.color, speakers.color),
       first_ms = COALESCE(excluded.first_ms, speakers.first_ms),
       talk_ms  = excluded.talk_ms`
  ).run(
    "spk_" + crypto.randomBytes(6).toString("hex"),
    jobId, localId, label, color, firstMs, talkMs
  );
}

function listSpeakers(jobId) {
  return db
    .prepare("SELECT * FROM speakers WHERE job_id = ? ORDER BY first_ms ASC, local_id ASC")
    .all(jobId);
}

/** 重命名说话人，并同步该任务下所有段落的冗余显示名 */
function renameSpeaker(jobId, localId, label) {
  const clean = String(label || "").trim();
  if (!clean) throw new Error("说话人名称不能为空");
  const info = db
    .prepare("UPDATE speakers SET label = ? WHERE job_id = ? AND local_id = ?")
    .run(clean, jobId, localId);
  if (info.changes === 0) return { changed: 0, speakers: listSpeakers(jobId) };
  db.prepare(
    "UPDATE segments SET speaker_label = ? WHERE job_id = ? AND speaker = ?"
  ).run(clean, jobId, localId);
  return { changed: info.changes, speakers: listSpeakers(jobId) };
}

function clearSpeakers(jobId) {
  db.prepare("DELETE FROM speakers WHERE job_id = ?").run(jobId);
}

// ============ markers ============

/** 幂等写入：同一个 id 重复上行只保留一条，内容以最后一次为准 */
function insertMarker({
  id, jobId, seq = 0, startMs, endMs = null, text, duringPause = 0, createdAt = null,
}) {
  const clean = String(text || "").trim();
  if (!id || !jobId || !clean) throw new Error("标记缺少必要字段");
  db.prepare(
    `INSERT INTO markers (id, job_id, seq, start_ms, end_ms, text, during_pause, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       seq          = excluded.seq,
       start_ms     = excluded.start_ms,
       end_ms       = excluded.end_ms,
       text         = excluded.text,
       during_pause = excluded.during_pause`
  ).run(
    id, jobId, seq, Math.round(startMs), endMs == null ? null : Math.round(endMs),
    clean, duringPause ? 1 : 0, createdAt || now()
  );
  return db.prepare("SELECT * FROM markers WHERE id = ?").get(id) || null;
}

function listMarkers(jobId) {
  return db
    .prepare("SELECT * FROM markers WHERE job_id = ? ORDER BY start_ms ASC, seq ASC")
    .all(jobId);
}

function updateMarker(id, { text, startMs, endMs } = {}) {
  const sets = [];
  const values = [];
  if (text != null) { sets.push("text = ?"); values.push(String(text).trim()); }
  if (startMs != null) { sets.push("start_ms = ?"); values.push(Math.round(startMs)); }
  if (endMs != null) { sets.push("end_ms = ?"); values.push(Math.round(endMs)); }
  if (!sets.length) return null;
  values.push(id);
  db.prepare(`UPDATE markers SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  return db.prepare("SELECT * FROM markers WHERE id = ?").get(id) || null;
}

function deleteMarker(id) {
  return db.prepare("DELETE FROM markers WHERE id = ?").run(id).changes > 0;
}

function clearMarkers(jobId) {
  db.prepare("DELETE FROM markers WHERE job_id = ?").run(jobId);
}

// ============ 删除级联 ============

/**
 * 批量删除记录：同时清掉关联的 jobs / segments / speakers / markers，避免孤儿行。
 * 返回 { deleted, jobIds }，jobIds 供调用方清理磁盘目录。
 */
function deleteRecords(ids) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).filter((x) => typeof x === "string" && x))];
  if (!list.length) return { deleted: 0, jobIds: [] };

  const select = db.prepare("SELECT id, job_id FROM records WHERE id = ?");
  const dropSegments = db.prepare("DELETE FROM segments WHERE job_id = ?");
  const dropSpeakers = db.prepare("DELETE FROM speakers WHERE job_id = ?");
  const dropMarkers = db.prepare("DELETE FROM markers WHERE job_id = ?");
  const dropJob = db.prepare("DELETE FROM jobs WHERE id = ?");
  const dropRecord = db.prepare("DELETE FROM records WHERE id = ?");
  const jobIds = [];
  let deleted = 0;

  // node:sqlite 的 DatabaseSync 没有 transaction() 包装，手写事务
  db.exec("BEGIN");
  try {
    for (const id of list) {
      const record = select.get(id);
      if (!record) continue;
      if (record.job_id) {
        dropSegments.run(record.job_id);
        dropSpeakers.run(record.job_id);
        dropMarkers.run(record.job_id);
        dropJob.run(record.job_id);
        jobIds.push(record.job_id);
      }
      deleted += dropRecord.run(id).changes;
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  return { deleted, jobIds };
}

function deleteRecord(id) {
  return deleteRecords([id]).deleted > 0;
}

module.exports = {
  db,
  createRecord, listRecords, getRecord, updateRecord, deleteRecord, deleteRecords,
  createJob, getJob, updateJob, markInterruptedJobs, listRunningRecordingJobs,
  upsertSegment, listSegments, doneSegmentIndexes, clearSegments,
  upsertSpeaker, listSpeakers, renameSpeaker, clearSpeakers,
  insertMarker, listMarkers, updateMarker, deleteMarker, clearMarkers,
};
