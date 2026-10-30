/** records 表：记录主表。 */

const { getDb } = require("../connection");
const { newId } = require("../../../shared/utils/id");
const { nowIso } = require("../../../shared/utils/time");
const { limits } = require("../../../data");

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
  const db = getDb();
  if (!title || !String(title).trim()) {
    throw new Error("记录标题不能为空");
  }
  const id = newId("rec", 6);
  const created = nowIso();
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

function listRecords({ q = "", page = 1, pageSize = limits.records.pageSize } = {}) {
  const db = getDb();
  const limit = Math.min(
    Math.max(parseInt(pageSize, 10) || limits.records.pageSize, 1),
    limits.records.maxPageSize
  );
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
  return getDb().prepare("SELECT * FROM records WHERE id = ?").get(id) || null;
}

const UPDATABLE = [
  "title", "summary", "summary_text", "summary_json", "speakers_json",
  "template", "template_id", "template_name", "duration", "transcript", "job_id",
];

function updateRecord(id, fields = {}) {
  const db = getDb();
  const sets = [];
  const values = [];
  for (const key of UPDATABLE) {
    if (key in fields) {
      sets.push(`${key} = ?`);
      values.push(fields[key]);
    }
  }
  if (!sets.length) return getRecord(id);
  sets.push("updated_at = ?");
  values.push(nowIso(), id);
  const info = db.prepare(`UPDATE records SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  if (info.changes === 0) return null;
  return getRecord(id);
}

module.exports = { createRecord, listRecords, getRecord, updateRecord };
