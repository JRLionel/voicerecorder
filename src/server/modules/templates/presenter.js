/**
 * 展示层转换：库行 → 模板对象 → 快照 / 接口 DTO。
 *
 * 快照只保留渲染需要的信息，不含模板 id 之类的易变引用。
 */

const { presets } = require("../../data");
const { normalizeExtras } = require("./schema");

const DEFAULT_TEMPLATE = presets.defaultMinutesTemplate;

function fromRow(row) {
  if (!row) return null;
  const parse = (raw, fallback) => {
    try {
      const v = JSON.parse(raw || "null");
      return v == null ? fallback : v;
    } catch {
      return fallback;
    }
  };
  const sections = parse(row.sections_json, []);
  return {
    id: row.id,
    name: row.name,
    description: row.description || "",
    icon: row.icon || "calendar",
    color: row.color || "blue",
    builtin: Boolean(row.builtin),
    sections: Array.isArray(sections) && sections.length ? sections : DEFAULT_TEMPLATE.sections,
    extras: normalizeExtras(parse(row.extras_json, {})),
    promptExtra: row.prompt_extra || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ============ 提示词 ============

function snapshotOf(template) {
  const tpl = template || DEFAULT_TEMPLATE;
  return {
    id: tpl.id,
    name: tpl.name,
    sections: (tpl.sections || []).map((s) => ({ key: s.key, title: s.title, type: s.type, hint: s.hint || "" })),
    extras: normalizeExtras(tpl.extras),
  };
}

module.exports = { fromRow, snapshotOf };
