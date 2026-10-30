/**
 * 记录域接口：列表、详情、新建、更新、删除、批量删除。
 */

const express = require("express");
const path = require("node:path");

const repos = require("../data/db/repositories");
const { deleteRecords } = require("../modules/records/service");
const minutesSvc = require("../modules/minutes");
const { ok, bad, missing, fail } = require("../shared/http");
const { JOBS_DIR } = require("../modules/transcription/workspace");
const { rmDirSafe } = require("../shared/utils/fs");

const { listRecords, getRecord, createRecord, updateRecord } = repos.records;

const router = express.Router();

router.get("/api/records", (req, res) => {
  const { q, page, pageSize } = req.query;
  return ok(res, listRecords({ q, page, pageSize }));
});

router.get("/api/records/:id", (req, res) => {
  const record = getRecord(req.params.id);
  if (!record) return missing(res, "记录不存在");
  return ok(res, { record, minutes: minutesSvc.listMinutes(record.id) });
});

router.post("/api/records", (req, res) => {
  try {
    const b = req.body || {};
    const record = createRecord({
      title: b.title,
      summary: b.summary,
      source: b.source,
      template: b.template,
      filename: b.filename,
      size: b.size,
      duration: b.duration,
      language: b.language,
      transcript: b.transcript,
      summary_text: b.summaryText,
      client_id: b.clientId,
    });
    return ok(res, { record });
  } catch (err) {
    return bad(res, err.message);
  }
});

router.patch("/api/records/:id", (req, res) => {
  try {
    const record = updateRecord(req.params.id, req.body || {});
    if (!record) return missing(res, "记录不存在");
    return ok(res, { record });
  } catch (err) {
    return bad(res, err.message);
  }
});

// 批量删除（列表页多选）：事务内清关联行，随后清磁盘目录
router.post("/api/records/batch-delete", (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
  if (!ids.length) return bad(res, "请选择要删除的记录");

  try {
    const { deleted, jobIds } = deleteRecords(ids);
    for (const jobId of jobIds) rmDirSafe(path.join(JOBS_DIR, jobId));
    return ok(res, { deleted });
  } catch (err) {
    return fail(res, Object.assign(new Error(err.message || "删除失败"), { status: 500 }));
  }
});

router.delete("/api/records/:id", (req, res) => {
  const record = getRecord(req.params.id);
  if (!record) return missing(res, "记录不存在");

  const deleted = deleteRecords([record.id]);
  if (!deleted.deleted) return missing(res, "记录不存在");

  // 顺手清掉任务目录，避免 1.5 小时录屏的 wav 一直堆着
  if (record.job_id) rmDirSafe(path.join(JOBS_DIR, record.job_id));
  return ok(res);
});

module.exports = { router };
