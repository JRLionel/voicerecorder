/**
 * 模板 Schema：类型枚举、容量上限、校验与归一。
 *
 * key 一律按顺序重生成：key 只在「生成 → 回填」单次生命周期内有效，不跨次。
 */

const data = require("../../data");
const { TemplateError } = require("../../shared/errors");

const SECTION_TYPES = new Set(["list", "text", "todos"]);
const ICONS = new Set(["calendar", "note", "person", "book", "camera"]);
const COLORS = new Set(["blue", "violet", "green", "amber", "red"]);

const LIMIT_SRC = data.limits.templates;
const LIMITS = {
  name: LIMIT_SRC.maxName,
  description: LIMIT_SRC.maxDescription,
  title: LIMIT_SRC.maxSectionTitle,
  hint: LIMIT_SRC.maxSectionHint,
  promptExtra: LIMIT_SRC.maxPromptExtra,
  sections: LIMIT_SRC.maxSections,
};

function cleanText(value, max, field) {
  const str = value == null ? "" : String(value).trim();
  if (str.length > max) {
    throw new TemplateError("TEMPLATE_INVALID", `${field}不能超过 ${max} 字`);
  }
  return str;
}

function normalizeExtras(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    attendees: src.attendees !== false,
    speakerPoints: src.speakerPoints !== false,
  };
}

/**
 * 校验并归一客户端提交的模板。
 * key 一律按顺序重生成：key 只在「生成 → 回填」单次生命周期内有效，不跨次。
 */

function normalizeSections(rawSections) {
  if (!Array.isArray(rawSections) || !rawSections.length) {
    throw new TemplateError("TEMPLATE_INVALID", "模板至少需要一个章节");
  }
  if (rawSections.length > LIMITS.sections) {
    throw new TemplateError("TEMPLATE_INVALID", `模板最多 ${LIMITS.sections} 个章节`);
  }
  return rawSections.map((raw, i) => {
    const src = raw && typeof raw === "object" ? raw : {};
    const title = cleanText(src.title, LIMITS.title, `第 ${i + 1} 个章节的标题`);
    if (!title) throw new TemplateError("TEMPLATE_INVALID", `第 ${i + 1} 个章节缺少标题`);
    const type = String(src.type || "list").trim();
    if (!SECTION_TYPES.has(type)) {
      throw new TemplateError(
        "TEMPLATE_INVALID",
        `第 ${i + 1} 个章节的类型不合法：${type}，仅支持 list / text / todos`
      );
    }
    return {
      key: `s${i}`,
      title,
      type,
      hint: cleanText(src.hint, LIMITS.hint, `第 ${i + 1} 个章节的提示`),
    };
  });
}

function validateTemplateInput(input = {}) {
  const name = cleanText(input.name, LIMITS.name, "模板名称");
  if (!name) throw new TemplateError("TEMPLATE_INVALID", "模板名称不能为空");

  const icon = ICONS.has(input.icon) ? input.icon : "calendar";
  const color = COLORS.has(input.color) ? input.color : "blue";

  return {
    name,
    description: cleanText(input.description, LIMITS.description, "模板说明"),
    icon,
    color,
    sections: normalizeSections(input.sections),
    extras: normalizeExtras(input.extras),
    promptExtra: cleanText(input.promptExtra, LIMITS.promptExtra, "补充要求"),
  };
}

/** 把库里的行还原成模板对象（sections_json / extras_json 是字符串） */

module.exports = {
  SECTION_TYPES, ICONS, COLORS, LIMITS, TemplateError,
  cleanText, normalizeExtras, normalizeSections, validateTemplateInput,
};
