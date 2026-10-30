/**
 * templates 表：纪要模板。
 *
 * 只做 SQL：校验、名称唯一、系统模板保护都在 modules/templates/service.js 里。
 */

const { getDb } = require("../connection");

/** 系统模板按固定 id upsert：升级只改定义，不影响用户复制出来的副本 */
function upsertBuiltinTemplate(tpl, ts) {
  getDb()
    .prepare(
      `INSERT INTO templates
         (id, name, description, icon, color, builtin, sections_json, extras_json,
          prompt_extra, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name          = excluded.name,
         description   = excluded.description,
         icon          = excluded.icon,
         color         = excluded.color,
         builtin       = 1,
         sections_json = excluded.sections_json,
         extras_json   = excluded.extras_json,
         prompt_extra  = excluded.prompt_extra,
         updated_at    = excluded.updated_at`
    )
    .run(
      tpl.id, tpl.name, tpl.description || "", tpl.icon || "calendar", tpl.color || "blue",
      JSON.stringify(tpl.sections), JSON.stringify(tpl.extras || {}),
      tpl.promptExtra || "", ts, ts
    );
}

function listTemplateRows() {
  return getDb()
    .prepare("SELECT * FROM templates ORDER BY builtin DESC, COALESCE(updated_at, created_at) DESC")
    .all();
}

function getTemplateRow(id) {
  return getDb().prepare("SELECT * FROM templates WHERE id = ?").get(id) || null;
}

/** 用户模板重名校验（系统模板可以同名） */
function findUserTemplateByName(name, excludeId = null) {
  return getDb()
    .prepare("SELECT id FROM templates WHERE builtin = 0 AND lower(name) = lower(?) AND id <> ?")
    .get(String(name || "").trim(), excludeId || "") || null;
}

function insertTemplate(db, { id, name, description, icon, color, builtin, sectionsJson, extrasJson, promptExtra, ts }) {
  db.prepare(
    `INSERT INTO templates
       (id, name, description, icon, color, builtin, sections_json, extras_json,
        prompt_extra, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, name, description, icon, color, builtin ? 1 : 0,
    sectionsJson, extrasJson, promptExtra, ts, ts
  );
}

function updateTemplateRow(db, id, { name, description, icon, color, sectionsJson, extrasJson, promptExtra, ts }) {
  db.prepare(
    `UPDATE templates
        SET name = ?, description = ?, icon = ?, color = ?,
            sections_json = ?, extras_json = ?, prompt_extra = ?, updated_at = ?
      WHERE id = ? AND builtin = 0`
  ).run(name, description, icon, color, sectionsJson, extrasJson, promptExtra, ts, id);
}

function deleteTemplateRow(db, id) {
  return db.prepare("DELETE FROM templates WHERE id = ? AND builtin = 0").run(id).changes > 0;
}

module.exports = {
  upsertBuiltinTemplate, listTemplateRows, getTemplateRow, findUserTemplateByName,
  insertTemplate, updateTemplateRow, deleteTemplateRow,
};
