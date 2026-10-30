/** speakers 表：一次任务内的说话人名册。 */

const { getDb } = require("../connection");
const { newId } = require("../../../shared/utils/id");

function upsertSpeaker({ jobId, localId, label, color = null, firstMs = null, talkMs = 0 }) {
  getDb()
    .prepare(
      `INSERT INTO speakers (id, job_id, local_id, label, color, first_ms, talk_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(job_id, local_id) DO UPDATE SET
         label    = excluded.label,
         color    = COALESCE(excluded.color, speakers.color),
         first_ms = COALESCE(excluded.first_ms, speakers.first_ms),
         talk_ms  = excluded.talk_ms`
    )
    .run(newId("spk", 6), jobId, localId, label, color, firstMs, talkMs);
}

function listSpeakers(jobId) {
  return getDb()
    .prepare("SELECT * FROM speakers WHERE job_id = ? ORDER BY first_ms ASC, local_id ASC")
    .all(jobId);
}

/** 重命名说话人，并同步该任务下所有段落的冗余显示名 */
function renameSpeaker(jobId, localId, label) {
  const db = getDb();
  const clean = String(label || "").trim();
  if (!clean) throw new Error("说话人名称不能为空");
  const info = db
    .prepare("UPDATE speakers SET label = ? WHERE job_id = ? AND local_id = ?")
    .run(clean, jobId, localId);
  if (info.changes === 0) return { changed: 0, speakers: listSpeakers(jobId) };
  db.prepare("UPDATE segments SET speaker_label = ? WHERE job_id = ? AND speaker = ?")
    .run(clean, jobId, localId);
  return { changed: info.changes, speakers: listSpeakers(jobId) };
}

function clearSpeakers(jobId) {
  getDb().prepare("DELETE FROM speakers WHERE job_id = ?").run(jobId);
}

module.exports = { upsertSpeaker, listSpeakers, renameSpeaker, clearSpeakers };
