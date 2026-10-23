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
`);

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
  client_id = null,
}) {
  if (!title || !String(title).trim()) {
    throw new Error("记录标题不能为空");
  }
  const id = "rec_" + crypto.randomBytes(6).toString("hex");
  const created = now();
  db.prepare(
    `INSERT INTO records
       (id, title, summary, source, template, filename, size, duration,
        language, transcript, summary_text, client_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, String(title).trim(), summary, source, template, filename, size, duration,
    language, transcript, summary_text, client_id, created, created
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
  const allowed = ["title", "summary", "summary_text", "template", "duration"];
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

function deleteRecord(id) {
  const info = db.prepare("DELETE FROM records WHERE id = ?").run(id);
  return info.changes > 0;
}

module.exports = { db, createRecord, listRecords, getRecord, updateRecord, deleteRecord };
