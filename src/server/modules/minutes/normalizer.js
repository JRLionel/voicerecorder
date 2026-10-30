/**
 * 模型输出的归一化：把「五花八门的 JSON」收敛成模板约定的结构。
 *
 * 兼容两种历史结构：
 *   - 旧结构 { content, decisions, todos } → 标记 legacy，渲染时回落到默认模板
 *   - 新结构 { topic, sections[], attendees, markers, speakerPoints }
 */

const templates = require("../templates");

const DEFAULT_TEMPLATE = templates.DEFAULT_TEMPLATE;

const LEGACY_KEYS = ["content", "decisions", "todos"];
const USED_IN = new Set(["content", "decisions", "todos", "unused"]);

function hasLegacyKeys(json) {
  return Boolean(json) && LEGACY_KEYS.some((k) => Array.isArray(json[k]));
}

function legacyToRawSections(json) {
  return [
    { key: "s0", title: "会议内容", items: json.content },
    { key: "s1", title: "决议", items: json.decisions },
    { key: "s2", title: "待办", items: json.todos },
  ];
}

function normalizeTodo(t) {
  if (t == null) return null;
  if (typeof t === "string") {
    return String(t).trim() ? { text: String(t).trim(), owner: "未提及", at: "", ownerConfidence: "none" } : null;
  }
  const text = String(t.text || "").trim();
  if (!text) return null;
  const conf = String(t.ownerConfidence || "").toLowerCase();
  const owner = String(t.owner || "未提及").trim() || "未提及";
  return {
    text,
    owner,
    at: String(t.at || "").trim(),
    ownerConfidence: ["inferred", "text", "none"].includes(conf)
      ? conf
      : owner !== "未提及"
        ? "text"
        : "none",
  };
}

function normalizeItems(type, items) {
  const arr = Array.isArray(items) ? items : items == null ? [] : [items];
  if (type === "todos") return arr.map(normalizeTodo).filter(Boolean);
  return arr
    .map((x) => (typeof x === "string" ? x : x && typeof x === "object" ? x.text || "" : String(x == null ? "" : x)))
    .map((x) => String(x).trim())
    .filter(Boolean);
}

/** 按 key 对齐模板章节；缺 key 时用标题兜底 */

function alignSections(templateSections, rawSections) {
  const raws = Array.isArray(rawSections) ? rawSections : [];
  const byKey = new Map();
  const byTitle = new Map();
  for (const raw of raws) {
    if (!raw || typeof raw !== "object") continue;
    if (raw.key) byKey.set(String(raw.key), raw);
    if (raw.title) byTitle.set(String(raw.title).trim(), raw);
  }
  return templateSections.map((section) => {
    const hit = byKey.get(section.key) || byTitle.get(section.title) || null;
    return {
      key: section.key,
      title: section.title,
      type: section.type,
      items: normalizeItems(section.type, hit ? hit.items : []),
    };
  });
}

function normalizeStringList(value) {
  const arr = Array.isArray(value) ? value : [];
  return arr.map((x) => String(x == null ? "" : x).trim()).filter(Boolean);
}

function normalizeSummary(json, template = DEFAULT_TEMPLATE) {
  const tpl = template || DEFAULT_TEMPLATE;
  const src = json && typeof json === "object" ? json : {};
  const legacy = !(Array.isArray(src.sections) && src.sections.length) && hasLegacyKeys(src);

  const templateSections = legacy ? DEFAULT_TEMPLATE.sections : tpl.sections;
  const rawSections = legacy ? legacyToRawSections(src) : src.sections;

  const markers = Array.isArray(src.markers)
    ? src.markers
        .filter((m) => m && String(m.text || "").trim())
        .map((m) => {
          const usedIn = String(m.usedIn || "content").trim();
          return {
            at: String(m.at || "").trim(),
            text: String(m.text).trim(),
            usedIn: USED_IN.has(usedIn) ? usedIn : "content",
          };
        })
    : [];

  const speakerPoints = Array.isArray(src.speakerPoints)
    ? src.speakerPoints
        .filter((s) => s && String(s.speaker || "").trim())
        .map((s) => ({
          speaker: String(s.speaker).trim(),
          points: normalizeStringList(s.points),
        }))
    : [];

  return {
    topic: String(src.topic || "").trim(),
    sections: alignSections(templateSections, rawSections),
    attendees: normalizeStringList(src.attendees),
    markers,
    speakerPoints,
    legacy,
  };
}

/** 假纪要：模型彻底不返回可用结构时的兜底，保证页面不空白 */

function fallbackSummary(template, seedText) {
  const tpl = template || DEFAULT_TEMPLATE;
  const first = tpl.sections[0];
  const items = seedText ? [String(seedText).slice(0, 80)] : [];
  return {
    topic: "（模型未返回结构化结果）",
    sections: tpl.sections.map((s) => ({
      key: s.key,
      title: s.title,
      type: s.type,
      items: s.key === first.key ? (s.type === "todos" ? [] : items) : [],
    })),
    attendees: [],
    markers: [],
    speakerPoints: [],
    legacy: false,
  };
}

// ============ 展示 ============

/**
 * 标记去向标签。默认模板的章节名是固定的，可以点名；
 * 自定义模板没有对应章节，只能说「已纳入正文」，避免指向不存在的章节。
 */

module.exports = {
  LEGACY_KEYS, USED_IN,
  hasLegacyKeys, legacyToRawSections, normalizeTodo, normalizeItems, alignSections,
  normalizeStringList, normalizeSummary, fallbackSummary,
};
