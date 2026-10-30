/** minutes 表：纪要版本（只追加不覆盖，records.current_minutes_id 指向当前一份）。 */

const { getDb } = require("../connection");
const { newId } = require("../../../shared/utils/id");
const { nowIso } = require("../../../shared/utils/time");

function insertMinutes({ recordId, jobId = null, templateId = null, templateName, templateSnapshot }) {
  const id = newId("min", 6);
  getDb()
    .prepare(
      `INSERT INTO minutes
         (id, record_id, job_id, template_id, template_name, template_snapshot,
          json, markdown, topic, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, '', '', NULL, 'generating', ?)`
    )
    .run(id, recordId, jobId, templateId, templateName, JSON.stringify(templateSnapshot || {}), nowIso());
  return getMinutes(id);
}

function getMinutes(id) {
  return getDb().prepare("SELECT * FROM minutes WHERE id = ?").get(id) || null;
}

function finishMinutes(id, { json, markdown, topic, templateId, templateName, templateSnapshot } = {}) {
  const sets = ["status = 'done'", "json = ?", "markdown = ?", "topic = ?"];
  const values = [JSON.stringify(json || {}), markdown || "", topic || null];
  if (templateId != null) { sets.push("template_id = ?"); values.push(templateId); }
  if (templateName != null) { sets.push("template_name = ?"); values.push(templateName); }
  if (templateSnapshot != null) { sets.push("template_snapshot = ?"); values.push(JSON.stringify(templateSnapshot)); }
  values.push(id);
  getDb().prepare(`UPDATE minutes SET ${sets.join(", ")} WHERE id = ? AND status = 'generating'`).run(...values);
  return getMinutes(id);
}

function deleteMinutes(id) {
  const db = getDb();
  const row = getMinutes(id);
  if (!row) return null;
  db.prepare("DELETE FROM minutes WHERE id = ?").run(id);
  return row;
}

function listMinutesByRecord(recordId) {
  return getDb()
    .prepare(
      `SELECT id, record_id, job_id, template_id, template_name, template_snapshot,
              topic, status, created_at
         FROM minutes WHERE record_id = ?
        ORDER BY created_at ASC, rowid ASC`
    )
    .all(recordId);
}

function countMinutes(recordId) {
  return getDb().prepare("SELECT COUNT(*) AS n FROM minutes WHERE record_id = ?").get(recordId).n;
}

/** 10 分钟内仍处于 generating 视为正在进行；超时视为僵尸，允许接管 */
function hasRecentGenerating(recordId, withinMs) {
  const cutoff = new Date(Date.now() - withinMs).toISOString();
  return Boolean(
    getDb()
      .prepare(
        "SELECT id FROM minutes WHERE record_id = ? AND status = 'generating' AND created_at >= ? LIMIT 1"
      )
      .get(recordId, cutoff)
  );
}

function clearStaleGenerating() {
  return getDb().prepare("DELETE FROM minutes WHERE status = 'generating'").run().changes;
}

/** 切换当前纪要，同时更新记录列表的摘要投影（跨表，但语义属于「当前指针」） */
function setCurrentMinutes(recordId, minutesId, summaryText) {
  getDb()
    .prepare(
      "UPDATE records SET current_minutes_id = ?, summary = COALESCE(?, summary), updated_at = ? WHERE id = ?"
    )
    .run(minutesId, summaryText == null ? null : summaryText, nowIso(), recordId);
}

/** 迁移用：直接写入一条已完成的纪要 */
function insertFinishedMinutes(db, { id, recordId, jobId, templateId, templateName, snapshot, json, markdown, topic, createdAt }) {
  db.prepare(
    `INSERT INTO minutes
       (id, record_id, job_id, template_id, template_name, template_snapshot,
        json, markdown, topic, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'done', ?)`
  ).run(id, recordId, jobId, templateId, templateName, snapshot, json, markdown, topic, createdAt);
}

module.exports = {
  insertMinutes, getMinutes, finishMinutes, deleteMinutes, listMinutesByRecord,
  countMinutes, hasRecentGenerating, clearStaleGenerating, setCurrentMinutes,
  insertFinishedMinutes,
};
