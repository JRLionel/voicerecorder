/**
 * 记录业务：删除记录时级联清理任务、分段、说话人、标记与纪要版本。
 *
 * 为什么要级联：这些表用 job_id / record_id 做逻辑关联，没有外键约束，
 * 不主动清会留下孤儿行（磁盘目录由调用方按返回的 jobIds 清理）。
 */

const { withTransaction } = require("../../data/db/transaction");

/**
 * 批量删除记录。
 * @returns {{deleted:number, jobIds:string[]}} jobIds 供调用方清理磁盘目录
 */
function deleteRecords(ids) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).filter((x) => typeof x === "string" && x))];
  if (!list.length) return { deleted: 0, jobIds: [] };

  const jobIds = [];
  let deleted = 0;

  withTransaction((db) => {
    const select = db.prepare("SELECT id, job_id FROM records WHERE id = ?");
    const dropSegments = db.prepare("DELETE FROM segments WHERE job_id = ?");
    const dropSpeakers = db.prepare("DELETE FROM speakers WHERE job_id = ?");
    const dropMarkers = db.prepare("DELETE FROM markers WHERE job_id = ?");
    const dropMinutes = db.prepare("DELETE FROM minutes WHERE record_id = ?");
    const dropJob = db.prepare("DELETE FROM jobs WHERE id = ?");
    const dropRecord = db.prepare("DELETE FROM records WHERE id = ?");

    for (const id of list) {
      const record = select.get(id);
      if (!record) continue;
      dropMinutes.run(id);
      if (record.job_id) {
        dropSegments.run(record.job_id);
        dropSpeakers.run(record.job_id);
        dropMarkers.run(record.job_id);
        dropJob.run(record.job_id);
        jobIds.push(record.job_id);
      }
      deleted += dropRecord.run(id).changes;
    }
  });

  return { deleted, jobIds };
}

function deleteRecord(id) {
  return deleteRecords([id]).deleted > 0;
}

module.exports = { deleteRecord, deleteRecords };
