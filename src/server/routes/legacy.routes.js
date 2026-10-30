/**
 * 已废弃接口：只为兼容旧版前端/书签保留，新代码请用 POST /api/minutes。
 */

const express = require("express");

const minutesSvc = require("../modules/minutes");
const { ok, bad, missing, fail } = require("../shared/http");
const { getJob } = require("../data/db/repositories").jobs;

const router = express.Router();

/** @deprecated 用 POST /api/minutes { jobId } 替代 */
router.post("/api/jobs/:id/summary", async (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return missing(res, "任务不存在");
  try {
    const r = await minutesSvc.generateMinutes({
      jobId: job.id,
      templateId: req.body ? req.body.templateId : null,
    });
    // 注意：这里的 summary 是结构化 JSON，markdown 单独给 —— 历史契约如此
    return ok(res, { summary: r.json, markdown: r.markdown, minutes: r.minutes, template: r.template });
  } catch (e) {
    return fail(res, e);
  }
});

/** @deprecated 用 POST /api/minutes { recordId, text } 替代 */
router.post("/api/meeting-summary", async (req, res) => {
  const { text, recordId, templateId } = req.body || {};
  if (!String(text || "").trim() && !recordId) {
    return bad(res, "请提供转写文本");
  }
  try {
    const r = await minutesSvc.generateMinutes({ recordId: recordId || null, text, templateId });
    return ok(res, {
      summary: r.markdown,
      json: r.json,
      recordId: recordId || null,
      minutes: r.minutes,
      template: r.template,
    });
  } catch (e) {
    return fail(res, e);
  }
});

module.exports = { router };
