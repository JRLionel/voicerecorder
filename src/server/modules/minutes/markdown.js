/**
 * Markdown 渲染：默认模板的输出与改造前逐字一致
 * （主题 → 各章节，空行分隔、末章不带尾空行 → 参会人 / 现场标记 / 按人要点）。
 */

const templates = require("../templates");
const { minuteLabels } = require("../../data").copy;

const DEFAULT_TEMPLATE = templates.DEFAULT_TEMPLATE;
const DEFAULT_TEMPLATE_ID = templates.DEFAULT_TEMPLATE_ID;
const { normalizeExtras } = templates;

function usedLabel(usedIn, template) {
  if (usedIn === "unused") return minuteLabels.unused;
  if (usedIn === "todos") return minuteLabels.todos;
  const isDefault = !template || template.id === DEFAULT_TEMPLATE_ID;
  if (isDefault) return usedIn === "decisions" ? minuteLabels.markdown.decisions : minuteLabels.markdown.content;
  return minuteLabels.custom;
}

/**
 * 渲染 Markdown。默认模板的输出与改造前逐字一致：
 * 主题 → 各章节（空行分隔、末章不带尾空行）→ 参会人 / 现场标记 / 按人要点。
 */

function toMarkdown(template, summary) {
  const tpl = template || DEFAULT_TEMPLATE;
  const data = summary || {};
  const extras = normalizeExtras(tpl.extras);
  const sections = Array.isArray(data.sections) ? data.sections : [];
  const lines = [];

  lines.push("## 主题");
  lines.push(data.topic || "（未提炼出主题）");
  lines.push("");

  sections.forEach((section, i) => {
    lines.push(`## ${section.title}`);
    const items = Array.isArray(section.items) ? section.items : [];
    if (!items.length) {
      lines.push(section.type === "text" ? "（无）" : "- 无");
    } else if (section.type === "todos") {
      items.forEach((t) => {
        const tail = [t.owner, t.at].filter(Boolean).join(" · ");
        lines.push(`- [ ] ${t.text}${tail ? ` — ${tail}` : ""}`);
      });
    } else if (section.type === "text") {
      items.forEach((t) => lines.push(String(t)));
    } else {
      items.forEach((t) => lines.push(`- ${t}`));
    }
    if (i < sections.length - 1) lines.push("");
  });

  if (extras.attendees && data.attendees && data.attendees.length) {
    lines.push("");
    lines.push("## 参会人");
    lines.push(data.attendees.join("、"));
  }
  if (data.markers && data.markers.length) {
    lines.push("");
    lines.push("## 现场标记");
    data.markers.forEach((m) => {
      lines.push(`- ${m.at ? `${m.at} ` : ""}${m.text} → ${usedLabel(m.usedIn, tpl)}`);
    });
  }
  if (extras.speakerPoints && data.speakerPoints && data.speakerPoints.length) {
    lines.push("");
    lines.push("## 按人要点");
    data.speakerPoints.forEach((s) => {
      lines.push(`- ${s.speaker}：${(s.points || []).join("；") || "—"}`);
    });
  }

  return lines.join("\n");
}

/** 给前端/导出用的快照：只保留渲染需要的信息，不含模板 id 之类的易变引用 */

module.exports = { usedLabel, toMarkdown };
