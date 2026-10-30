/**
 * 模板业务：校验、名称唯一、系统模板保护、复制、批量删除的事务编排。
 *
 * 这里不写 SQL —— 全部经 data/db/repositories/templates.repo.js。
 */

const tplLib = require("./index");
const { getDb } = require("../../data/db/connection");
const { withTransaction } = require("../../data/db/transaction");
const repos = require("../../data/db/repositories");
const { newId } = require("../../shared/utils/id");
const { nowIso } = require("../../shared/utils/time");
const { TemplateError } = require("../../shared/errors");
const { presets, limits } = require("../../data");

const { templates: tplRepo } = repos;

/** 给接口用的 DTO：只暴露前端需要的字段 */
function serializeTemplate(row) {
  const tpl = tplLib.fromRow(row);
  if (!tpl) return null;
  return {
    id: tpl.id,
    name: tpl.name,
    description: tpl.description,
    icon: tpl.icon,
    color: tpl.color,
    builtin: tpl.builtin,
    sections: tpl.sections,
    extras: tpl.extras,
    promptExtra: tpl.promptExtra,
    updatedAt: tpl.updatedAt || tpl.createdAt || null,
  };
}

function listTemplates() {
  return tplRepo.listTemplateRows().map(serializeTemplate).filter(Boolean);
}

function getTemplateRow(id) {
  return tplRepo.getTemplateRow(id);
}

/** 系统模板按固定 id upsert：升级只改定义，不影响用户复制出来的副本 */
function ensureBuiltinTemplates() {
  const ts = nowIso();
  for (const tpl of presets.minutesTemplates) tplRepo.upsertBuiltinTemplate(tpl, ts);
  return presets.minutesTemplates.length;
}

function assertNameFree(name, excludeId = null) {
  if (tplRepo.findUserTemplateByName(name, excludeId)) {
    throw new TemplateError("TEMPLATE_NAME_TAKEN", `已有同名模板「${name}」`);
  }
}

function createTemplate(input) {
  const data = tplLib.validateTemplateInput(input);
  assertNameFree(data.name);
  const id = newId("tpl", 5);
  const ts = nowIso();
  try {
    tplRepo.insertTemplate(getDb(), {
      id,
      name: data.name,
      description: data.description,
      icon: data.icon,
      color: data.color,
      builtin: 0,
      sectionsJson: JSON.stringify(data.sections),
      extrasJson: JSON.stringify(data.extras),
      promptExtra: data.promptExtra,
      ts,
    });
  } catch (err) {
    if (String(err.message || "").includes("UNIQUE")) {
      throw new TemplateError("TEMPLATE_NAME_TAKEN", `已有同名模板「${data.name}」`);
    }
    throw err;
  }
  return tplRepo.getTemplateRow(id);
}

function updateTemplate(id, input) {
  const row = tplRepo.getTemplateRow(id);
  if (!row) return null;
  if (row.builtin) {
    throw new TemplateError("TEMPLATE_BUILTIN_LOCKED", "系统模板不可修改，可复制后再改");
  }
  const data = tplLib.validateTemplateInput(input);
  assertNameFree(data.name, id);
  try {
    tplRepo.updateTemplateRow(getDb(), id, {
      name: data.name,
      description: data.description,
      icon: data.icon,
      color: data.color,
      sectionsJson: JSON.stringify(data.sections),
      extrasJson: JSON.stringify(data.extras),
      promptExtra: data.promptExtra,
      ts: nowIso(),
    });
  } catch (err) {
    if (String(err.message || "").includes("UNIQUE")) {
      throw new TemplateError("TEMPLATE_NAME_TAKEN", `已有同名模板「${data.name}」`);
    }
    throw err;
  }
  return tplRepo.getTemplateRow(id);
}

function deleteTemplate(id) {
  const row = tplRepo.getTemplateRow(id);
  if (!row) return false;
  if (row.builtin) {
    throw new TemplateError("TEMPLATE_BUILTIN_LOCKED", "系统模板不可删除");
  }
  return tplRepo.deleteTemplateRow(getDb(), id);
}

/** 批量删除：系统模板跳过而非整体失败 */
function deleteTemplates(ids) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).filter((x) => typeof x === "string" && x))];
  const skipped = [];
  let deleted = 0;

  withTransaction((db) => {
    for (const id of list) {
      const row = tplRepo.getTemplateRow(id);
      if (!row) continue;
      if (row.builtin) {
        skipped.push(id);
        continue;
      }
      if (tplRepo.deleteTemplateRow(db, id)) deleted += 1;
    }
  });

  return { deleted, skipped };
}

function duplicateTemplate(id) {
  const src = tplRepo.getTemplateRow(id);
  if (!src) return null;
  const base = String(src.name).trim();
  let name = `${base} 副本`.slice(0, limits.templates.maxName);
  let n = 2;
  while (tplRepo.findUserTemplateByName(name) && n <= limits.templates.maxCopySuffix) {
    name = `${base} 副本${n}`.slice(0, limits.templates.maxName);
    n += 1;
  }
  const newTemplateId = newId("tpl", 5);
  const ts = nowIso();
  tplRepo.insertTemplate(getDb(), {
    id: newTemplateId,
    name,
    description: src.description || "",
    icon: src.icon || "calendar",
    color: src.color || "blue",
    builtin: 0,
    sectionsJson: src.sections_json,
    extrasJson: src.extras_json || "{}",
    promptExtra: src.prompt_extra || "",
    ts,
  });
  return tplRepo.getTemplateRow(newTemplateId);
}

module.exports = {
  serializeTemplate,
  listTemplates,
  getTemplateRow,
  ensureBuiltinTemplates,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  deleteTemplates,
  duplicateTemplate,
};
