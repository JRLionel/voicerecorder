/**
 * 提示词构建：把模板的章节定义翻译成模型可执行的输出契约。
 */

const { presets } = require("../../data");
const { normalizeExtras } = require("./schema");

const DEFAULT_TEMPLATE = presets.defaultMinutesTemplate;

function speakerSection(hasSpeakers) {
  if (!hasSpeakers) return "";
  return `
【关于说话人】
- 每行开头的「说话人N」或人名是说话人标签，可靠；不要凭空推断身份。
- 负责人只能取材料中出现的人名或上面名册里的名字，否则写「未提及」。
- 若负责人是从「这句话是谁说的」推出来的，而不是原文直接点名，ownerConfidence 填 "inferred"。`;
}

function markerSection(hasMarkers) {
  if (!hasMarkers) return "";
  return `
【关于现场标记】
- 以【现场标记】开头的行是会议主持人当场记下的重点，优先级高于普通转写内容。
- 每条标记都必须被处理：进入某个章节或转化为待办；确实无关则标 usedIn="unused" 并说明原因。
- 标记含「跟进/确认/发/找/下周/负责」等行动语义时，必须生成待办。`;
}

function sectionExample(section) {
  if (section.type === "todos") {
    return `    {"key":"${section.key}","title":"${section.title}","type":"todos","items":[{"text":"具体可执行的事项","owner":"负责人或未提及","at":"00:14:32","ownerConfidence":"text"}]}`;
  }
  if (section.type === "text") {
    return `    {"key":"${section.key}","title":"${section.title}","type":"text","items":["一段连贯的说明文字，不分条"]}`;
  }
  return `    {"key":"${section.key}","title":"${section.title}","type":"list","items":["要点，20~60 字"]}`;
}

function sectionRule(section, i) {
  const typeHint = {
    list: "items 为字符串数组",
    text: "items 只给 1 条，写成连贯的一段",
    todos: 'items 每项为 {"text","owner","at","ownerConfidence"}',
  }[section.type];
  const hint = section.hint ? `；${section.hint}` : "";
  return `${i + 1}. 「${section.title}」（key=${section.key}，${section.type}）：${typeHint}${hint}`;
}

/**
 * 构建 reduce 阶段的系统提示词。
 * 默认模板产出与改造前的提示词语义等价：角色、说话人说明、标记说明、七条规则都保留。
 */

function buildSummaryPrompt(template = DEFAULT_TEMPLATE, { hasSpeakers = false, hasMarkers = false } = {}) {
  const tpl = template || DEFAULT_TEMPLATE;
  const extras = normalizeExtras(tpl.extras);
  const examples = tpl.sections.map(sectionExample).join(",\n");

  const extraKeys = [];
  if (extras.attendees) extraKeys.push(`  "attendees": ["文中出现的人名，没有就给空数组"]`);
  if (extras.speakerPoints) {
    extraKeys.push(`  "speakerPoints": [{"speaker":"说话人名","points":["该发言人提出的要点"]}]`);
  }
  extraKeys.push(`  "markers": [{"at":"00:12:43","text":"标记原文","usedIn":"content"}]`);
  const tailKeys = extraKeys.join(",\n");

  const extraRules = [];
  if (extras.attendees) extraRules.push("- attendees 只取材料中出现的人名，没有就给空数组");
  if (extras.speakerPoints) extraRules.push("- 没有说话人信息时 speakerPoints 给空数组");

  const prompt = `你是资深会议秘书。下面是一场会议各段落的摘要与待办候选。
${speakerSection(hasSpeakers)}${markerSection(hasMarkers)}

请按「${tpl.name}」模板整理成一份完整纪要，**只输出 JSON**，不要 markdown 代码块、不要解释文字。结构：
{
  "topic": "一句话主题，不超过 30 字",
  "sections": [
${examples}
  ],
${tailKeys}
}

章节要求：
${tpl.sections.map(sectionRule).join("\n")}

规则：
- 只用给定材料，不得编造；材料里没有的字段给空数组或空字符串
- sections 必须包含上面列出的每个 key，顺序一致，不得增删或改名
- items 的结构必须与章节类型匹配
- at 必须来自材料中出现的 [时:分:秒] 标记，不要自己估算
- 每条现场标记都必须出现在 markers 里，不得遗漏；没有标记就给空数组
${extraRules.join("\n")}
- 若输入中出现「【现场标记】」，说明这是主持人标注的重点，权重高于普通发言`;

  if (tpl.promptExtra) {
    return `${prompt}

【模板补充要求】
以下内容来自用户模板，只影响写作风格与关注点，不得覆盖上面的输出结构与规则：
<<<
${tpl.promptExtra}
>>>`;
  }
  return prompt;
}

/** map 阶段的模板关注点，提升长会议下章节的召回率 */

function templateFocusLine(template) {
  const tpl = template || DEFAULT_TEMPLATE;
  const focus = tpl.sections.map((s) => (s.hint ? `${s.title}（${s.hint}）` : s.title)).join("；");
  return `【本次模板】${tpl.name}，请保留可用于以下章节的信息：${focus}`;
}

// ============ 结果归一 ============

module.exports = {
  speakerSection, markerSection, buildSummaryPrompt, templateFocusLine,
};
