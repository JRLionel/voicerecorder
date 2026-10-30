/** segments 表：转写分段（每片的起止时间、文本、引擎、说话人快照）。 */

const { getDb } = require("../connection");
const { newId } = require("../../../shared/utils/id");

function upsertSegment({
  jobId, idx, startMs, endMs, text = null, status = "done", engine = null,
  retry = 0, speaker = null, speakerLabel = null, speakerConf = null,
}) {
  getDb()
    .prepare(
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
    )
    .run(
      newId("seg", 6),
      jobId, idx, Math.round(startMs), Math.round(endMs), text, status, engine, retry,
      speaker, speakerLabel, speakerConf
    );
}

function listSegments(jobId) {
  return getDb()
    .prepare("SELECT * FROM segments WHERE job_id = ? ORDER BY idx ASC")
    .all(jobId);
}

/** 已完成的片号集合，用于续跑时跳过 */
function doneSegmentIndexes(jobId) {
  return new Set(
    getDb()
      .prepare("SELECT idx FROM segments WHERE job_id = ? AND status IN ('done','fallback')")
      .all(jobId)
      .map((r) => r.idx)
  );
}

function clearSegments(jobId) {
  getDb().prepare("DELETE FROM segments WHERE job_id = ?").run(jobId);
}

module.exports = { upsertSegment, listSegments, doneSegmentIndexes, clearSegments };
