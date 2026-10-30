/**
 * 模板域接口：列表、新建、修改、删除、批量删除、复制。
 */

const express = require("express");

const templates = require("../modules/templates");
const service = require("../modules/templates/service");
const { ok, bad, missing, fail } = require("../shared/http");

const { DEFAULT_TEMPLATE_ID } = templates;

const router = express.Router();

router.get("/api/templates", (req, res) => {
  return ok(res, { items: service.listTemplates(), defaultId: DEFAULT_TEMPLATE_ID });
});

router.post("/api/templates", (req, res) => {
  try {
    const template = service.serializeTemplate(service.createTemplate(req.body || {}));
    return ok(res, { template });
  } catch (e) {
    return fail(res, e);
  }
});

router.post("/api/templates/batch-delete", (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
  if (!ids.length) return bad(res, "请选择要删除的模板");
  try {
    return ok(res, service.deleteTemplates(ids));
  } catch (e) {
    return fail(res, e);
  }
});

router.post("/api/templates/:id/duplicate", (req, res) => {
  try {
    const row = service.duplicateTemplate(req.params.id);
    if (!row) return missing(res, "模板不存在");
    return ok(res, { template: service.serializeTemplate(row) });
  } catch (e) {
    return fail(res, e);
  }
});

router.patch("/api/templates/:id", (req, res) => {
  try {
    const row = service.updateTemplate(req.params.id, req.body || {});
    if (!row) return missing(res, "模板不存在");
    return ok(res, { template: service.serializeTemplate(row) });
  } catch (e) {
    return fail(res, e);
  }
});

router.delete("/api/templates/:id", (req, res) => {
  try {
    const deleted = service.deleteTemplate(req.params.id);
    if (!deleted) return missing(res, "模板不存在");
    return ok(res);
  } catch (e) {
    return fail(res, e);
  }
});

module.exports = { router };
