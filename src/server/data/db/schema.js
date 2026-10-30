/**
 * 表结构：声明式 DDL + 幂等补列。
 *
 * 老库升级不用手动迁移：新表 CREATE TABLE IF NOT EXISTS，
 * 新列用 PRAGMA table_info 判断后再 ALTER TABLE。
 */

const TABLES = `
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

  -- 纪要模板：builtin=1 为系统模板，随版本升级，不可改不可删
  CREATE TABLE IF NOT EXISTS templates (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    description   TEXT,
    icon          TEXT,
    color         TEXT,
    builtin       INTEGER NOT NULL DEFAULT 0,
    sections_json TEXT NOT NULL,
    extras_json   TEXT,
    prompt_extra  TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT
  );

  -- 纪要：一条记录可以有多份，只追加不覆盖
  CREATE TABLE IF NOT EXISTS minutes (
    id                TEXT PRIMARY KEY,
    record_id         TEXT NOT NULL,
    job_id            TEXT,
    template_id       TEXT,
    template_name     TEXT NOT NULL,
    template_snapshot TEXT NOT NULL,
    json              TEXT NOT NULL DEFAULT '',
    markdown          TEXT NOT NULL DEFAULT '',
    topic             TEXT,
    status            TEXT NOT NULL,        -- generating | done
    created_at        TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_minutes_record ON minutes(record_id, created_at);
`;

// 名称唯一只约束用户模板：允许与系统模板同名
const UNIQUE_INDEXES = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_templates_user_name
    ON templates(name COLLATE NOCASE) WHERE builtin = 0;
`;

/** 老库升级时补齐的新列 */
const EXTRA_COLUMNS = {
  records: {
    job_id: "TEXT",
    summary_json: "TEXT",
    speakers_json: "TEXT",
    template_id: "TEXT",          // 当前纪要所用模板
    template_name: "TEXT",
    current_minutes_id: "TEXT",   // 指向当前生效的那份纪要
  },
  jobs: {
    diarize_status: "TEXT",     // off | ok | failed | suspect
    speaker_count: "INTEGER",
    template_id: "TEXT",        // 只存意图，快照在纪要动作开始时取
    auto_minutes: "INTEGER",    // 转写完成后是否自动生成纪要
  },
  segments: {
    speaker: "TEXT",            // 'S0'，NULL = 无说话人
    speaker_label: "TEXT",      // 冗余快照，便于直接渲染
    speaker_conf: "REAL",
  },
};

function ensureColumns(db, table, columns) {
  const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  for (const [name, type] of Object.entries(columns)) {
    if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
}

/** 幂等：重复调用无副作用 */
function applySchema(db) {
  db.exec(TABLES);
  db.exec(UNIQUE_INDEXES);
  for (const [table, columns] of Object.entries(EXTRA_COLUMNS)) ensureColumns(db, table, columns);
}

module.exports = { applySchema, EXTRA_COLUMNS };
