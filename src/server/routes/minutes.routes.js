/**
 * 纪要域接口：生成（只追加）、版本列表、详情、设为当前、删除。
 */

const express = require("express");

const repos = require("../data/db/repositories");
const minutesSvc = require("../modules/minutes");
const modelConfig = require("../modules/model-config");
const { ok, bad, missing, fail } = require("../shared/http");

const { getRecord } = repos.records;

const router = express.Router();

/** 生成一份纪要：可反复重跑，不会覆盖已有版本 */
router.post("/api/minutes", async (req, res) => {
  const { jobId, recordId, text, templateId } = req.body || {};
  if (!jobId && !recordId && !String(text || "").trim()) {
    return bad(res, "请提供 jobId、recordId 或文本");
  }
  // 浏览器配置优先，缺项回落到 .env
  let model;
  try {
    const overrides = modelConfig.parsePayload(req.body?.modelConfig);
    model = modelConfig.resolveFor("minutes", overrides.minutes);
  } catch (e) {
    return bad(res, e.message, "MODEL_NOT_CONFIGURED");
  }
  try {
    const result = await minutesSvc.generateMinutes({ jobId, recordId, text, templateId, model });
    return ok(res, result);
  } catch (e) {
    return fail(res, e);
  }
});

router.get("/api/records/:id/minutes", (req, res) => {
  const record = getRecord(req.params.id);
  if (!record) return missing(res, "记录不存在");
  return ok(res, {
    currentMinutesId: record.current_minutes_id,
    items: minutesSvc.listMinutes(record.id),
  });
});

router.get("/api/minutes/:id", (req, res) => {
  const detail = minutesSvc.getMinutesDetail(req.params.id);
  if (!detail) return missing(res, "纪要不存在");
  return ok(res, { minutes: detail });
});

router.patch("/api/minutes/:id", (req, res) => {
  const detail = minutesSvc.getMinutesDetail(req.params.id);
  if (!detail) return missing(res, "纪要不存在");
  if (!req.body || req.body.current !== true) {
    return bad(res, "目前只支持设为当前");
  }
  try {
    const items = minutesSvc.setCurrent(detail.recordId, detail.id);
    return ok(res, { currentMinutesId: detail.id, items });
  } catch (e) {
    return fail(res, e);
  }
});

router.delete("/api/minutes/:id", (req, res) => {
  try {
    const result = minutesSvc.removeMinutes(req.params.id);
    return ok(res, result);
  } catch (e) {
    return fail(res, e);
  }
});

module.exports = { router };
