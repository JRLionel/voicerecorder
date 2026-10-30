/** markers 表：录音现场标记。 */

const { getDb } = require("../connection");
const { nowIso } = require("../../../shared/utils/time");

/** 幂等写入：同一个 id 重复上行只保留一条，内容以最后一次为准 */
function insertMarker({
  id, jobId, seq = 0, startMs, endMs = null, text, duringPause = 0, createdAt = null,
}) {
  const db = getDb();
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
    clean, duringPause ? 1 : 0, createdAt || nowIso()
  );
  return db.prepare("SELECT * FROM markers WHERE id = ?").get(id) || null;
}

function listMarkers(jobId) {
  return getDb()
    .prepare("SELECT * FROM markers WHERE job_id = ? ORDER BY start_ms ASC, seq ASC")
    .all(jobId);
}

function deleteMarker(id) {
  return getDb().prepare("DELETE FROM markers WHERE id = ?").run(id).changes > 0;
}

function clearMarkers(jobId) {
  getDb().prepare("DELETE FROM markers WHERE job_id = ?").run(jobId);
}

module.exports = { insertMarker, listMarkers, deleteMarker, clearMarkers };
