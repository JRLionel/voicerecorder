/**
 * 模板纯逻辑自检：node scripts/test-templates.js
 *
 * 核心是「等价性」：默认模板必须复现改造前的 Markdown 与提示词语义。
 * 改造前的渲染逻辑在这里保留一份副本（legacyMarkdown），作为对照基线。
 */

const assert = require("node:assert");
const {
  DEFAULT_TEMPLATE,
  validateTemplateInput,
  normalizeSections,
  buildSummaryPrompt,
  snapshotOf,
  TemplateError,
} = require("../src/server/modules/templates");
const { normalizeSummary } = require("../src/server/modules/minutes/normalizer");
const { toMarkdown } = require("../src/server/modules/minutes/markdown");

let passed = 0;
function it(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}`);
    console.error(`       ${e.message}`);
    process.exitCode = 1;
  }
}

/** 改造前 server/summary.js 的 toMarkdown，逐行保留作为基线 */
function legacyMarkdown(json) {
  const lines = [];
  lines.push("## 主题");
  lines.push(json.topic || "（未提炼出主题）");
  lines.push("");
  lines.push("## 会议内容");
  if (json.content.length) json.content.forEach((c) => lines.push(`- ${c}`));
  else lines.push("- 无");
  lines.push("");
  lines.push("## 决议");
  if (json.decisions.length) json.decisions.forEach((d) => lines.push(`- ${d}`));
  else lines.push("- 无");
  lines.push("");
  lines.push("## 待办");
  if (json.todos.length) {
    json.todos.forEach((t) => {
      const tail = [t.owner, t.at].filter(Boolean).join(" · ");
      lines.push(`- [ ] ${t.text}${tail ? ` — ${tail}` : ""}`);
    });
  } else lines.push("- 无");
  if (json.attendees.length) {
    lines.push("");
    lines.push("## 参会人");
    lines.push(json.attendees.join("、"));
  }
  if (json.markers && json.markers.length) {
    lines.push("");
    lines.push("## 现场标记");
    json.markers.forEach((m) => {
      const label = { content: "已纳入「会议内容」", decisions: "已纳入「决议」", todos: "已转为待办", unused: "未纳入" }[m.usedIn] || "已纳入";
      lines.push(`- ${m.at ? `${m.at} ` : ""}${m.text} → ${label}`);
    });
  }
  if (json.speakerPoints && json.speakerPoints.length) {
    lines.push("");
    lines.push("## 按人要点");
    json.speakerPoints.forEach((s) => {
      lines.push(`- ${s.speaker}：${(s.points || []).join("；") || "—"}`);
    });
  }
  return lines.join("\n");
}

const LEGACY_FULL = {
  topic: "Q3 预算评审",
  content: ["财务汇报了 Q3 支出", "讨论了市场投放的节奏"],
  decisions: ["追加 20 万投放预算"],
  todos: [
    { text: "补充投放明细", owner: "张伟", at: "00:12:30", ownerConfidence: "text" },
    { text: "约下周复盘", owner: "未提及", at: "", ownerConfidence: "none" },
  ],
  attendees: ["张伟", "李娜"],
  markers: [
    { at: "00:03:12", text: "预算口径要统一", usedIn: "decisions" },
    { at: "00:09:40", text: "问一下法务", usedIn: "unused" },
  ],
  speakerPoints: [{ speaker: "张伟", points: ["主张先小步试投", "关注 ROI"] }],
};

const LEGACY_MINIMAL = {
  topic: "",
  content: [],
  decisions: [],
  todos: [],
  attendees: [],
  markers: [],
  speakerPoints: [],
};

console.log("\n[1] 默认模板 Markdown 等价性");

it("含参会人 / 标记 / 按人要点的纪要逐字一致", () => {
  const next = toMarkdown(DEFAULT_TEMPLATE, normalizeSummary(LEGACY_FULL, DEFAULT_TEMPLATE));
  assert.strictEqual(next, legacyMarkdown(LEGACY_FULL));
});

it("全空纪要（各章节输出「无」）逐字一致", () => {
  const next = toMarkdown(DEFAULT_TEMPLATE, normalizeSummary(LEGACY_MINIMAL, DEFAULT_TEMPLATE));
  assert.strictEqual(next, legacyMarkdown(LEGACY_MINIMAL));
});

it("模型返回新结构时，默认模板渲染结果与旧结构一致", () => {
  const modern = {
    topic: LEGACY_FULL.topic,
    sections: [
      { key: "s0", title: "会议内容", type: "list", items: LEGACY_FULL.content },
      { key: "s1", title: "决议", type: "list", items: LEGACY_FULL.decisions },
      { key: "s2", title: "待办", type: "todos", items: LEGACY_FULL.todos },
    ],
    attendees: LEGACY_FULL.attendees,
    markers: LEGACY_FULL.markers,
    speakerPoints: LEGACY_FULL.speakerPoints,
  };
  const next = toMarkdown(DEFAULT_TEMPLATE, normalizeSummary(modern, DEFAULT_TEMPLATE));
  assert.strictEqual(next, legacyMarkdown(LEGACY_FULL));
});

console.log("\n[2] 提示词");

it("保留角色、输出契约与七条规则的关键句", () => {
  const prompt = buildSummaryPrompt(DEFAULT_TEMPLATE, { hasSpeakers: true, hasMarkers: true });
  for (const must of [
    "你是资深会议秘书",
    "只输出 JSON",
    "只用给定材料，不得编造",
    "每条现场标记都必须出现在 markers 里",
    "at 必须来自材料中出现的 [时:分:秒] 标记",
    "【关于说话人】",
    "【关于现场标记】",
    "会议内容",
    "决议",
    "待办",
  ]) {
    assert.ok(prompt.includes(must), `提示词缺少：${must}`);
  }
});

it("无说话人 / 无标记时不注入对应段落", () => {
  const prompt = buildSummaryPrompt(DEFAULT_TEMPLATE, {});
  assert.ok(!prompt.includes("【关于说话人】"));
  assert.ok(!prompt.includes("【关于现场标记】"));
});

it("模板补充要求被分隔符包裹", () => {
  const tpl = { ...DEFAULT_TEMPLATE, promptExtra: "语气克制，每条不超过 30 字" };
  const prompt = buildSummaryPrompt(tpl, {});
  assert.ok(prompt.includes("<<<"));
  assert.ok(prompt.includes("语气克制，每条不超过 30 字"));
});

it("自定义章节按顺序出现在契约与要求里", () => {
  const tpl = validateTemplateInput({
    name: "周会模板",
    sections: [
      { title: "本周进展", type: "list", hint: "按人列出" },
      { title: "风险", type: "text" },
      { title: "下周计划", type: "todos" },
    ],
  });
  const prompt = buildSummaryPrompt(tpl, {});
  assert.ok(prompt.indexOf("本周进展") < prompt.indexOf("风险"));
  assert.ok(prompt.includes("周会模板"));
  assert.ok(!prompt.includes("会议内容"));
});

console.log("\n[3] 校验");

it("章节数量为 0 被拒", () => {
  assert.throws(() => normalizeSections([]), (e) => e instanceof TemplateError);
});

it("章节数量超过 8 被拒", () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ title: `章节${i}` }));
  assert.throws(() => normalizeSections(many), (e) => e.code === "TEMPLATE_INVALID");
});

it("非法章节类型被拒", () => {
  assert.throws(() => normalizeSections([{ title: "x", type: "grid" }]), (e) => e.code === "TEMPLATE_INVALID");
});

it("空标题被拒", () => {
  assert.throws(() => normalizeSections([{ title: "   " }]), (e) => e.code === "TEMPLATE_INVALID");
});

it("客户端传入的 key 被忽略并重排", () => {
  const out = normalizeSections([
    { key: "hack", title: "A" },
    { key: "hack", title: "B" },
  ]);
  assert.deepStrictEqual(out.map((s) => s.key), ["s0", "s1"]);
});

it("名称超长被拒", () => {
  assert.throws(
    () => validateTemplateInput({ name: "x".repeat(31), sections: [{ title: "A" }] }),
    (e) => e.code === "TEMPLATE_INVALID"
  );
});

console.log("\n[4] 归一");

it("自定义模板缺某个 key 时该章节为空而非错位", () => {
  const tpl = validateTemplateInput({
    name: "t",
    sections: [{ title: "进展" }, { title: "风险" }],
  });
  const out = normalizeSummary({ sections: [{ key: "s1", title: "风险", items: ["只有这一段"] }] }, tpl);
  assert.deepStrictEqual(out.sections[0].items, []);
  assert.deepStrictEqual(out.sections[1].items, ["只有这一段"]);
});

it("模型改写标题时按 key 回填仍不错位", () => {
  const out = normalizeSummary(
    { sections: [{ key: "s1", title: "被改过的标题", items: ["内容"] }] },
    DEFAULT_TEMPLATE
  );
  assert.deepStrictEqual(out.sections[1].items, ["内容"]);
});

it("旧结构被识别为 legacy", () => {
  const out = normalizeSummary(LEGACY_FULL, DEFAULT_TEMPLATE);
  assert.strictEqual(out.legacy, true);
  assert.strictEqual(out.sections.length, 3);
});

it("待办字符串项被规整为对象", () => {
  const out = normalizeSummary({ sections: [{ key: "s2", items: ["补一份材料"] }] }, DEFAULT_TEMPLATE);
  assert.deepStrictEqual(out.sections[2].items[0], {
    text: "补一份材料",
    owner: "未提及",
    at: "",
    ownerConfidence: "none",
  });
});

console.log("\n[5] 快照");

it("快照只含渲染所需字段", () => {
  const snap = snapshotOf(DEFAULT_TEMPLATE);
  assert.deepStrictEqual(Object.keys(snap).sort(), ["extras", "id", "name", "sections"]);
  assert.strictEqual(snap.sections.length, 3);
});

console.log(`\n${passed} 项通过${process.exitCode ? "，存在失败" : ""}\n`);
