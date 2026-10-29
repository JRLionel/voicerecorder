const { fmtTime } = require("./audio");

/**
 * 会议纪要 map-reduce。
 *
 * 为什么不一次塞全文：2 小时会议是 2~3 万字（3~5 万 token），
 * 一次性输入既容易超限，也会让模型只总结开头。
 * 做法：每 ~1800 字出一个分片摘要，再把摘要合成结构化 JSON。
 *
 * v2 起输入不再是「段落数组」，而是「事件流」：
 * 转写句（可带说话人）与用户标记共用同一条时间轴，靠 kind 区分。
 * 这样「有说话人没标记」「有标记没说话人」「两者都有」三种场景共用一套 prompt。
 */

const BLOCK_CHARS = 1800;
const MAP_MAX_TOKENS = 700;
const REDUCE_MAX_TOKENS = 2400;

function chat(messages, { maxTokens = 1024, temperature = 0.2 } = {}) {
  const apiKey = process.env.MIMO_API_KEY;
  const apiUrl = process.env.MIMO_API_URL;
  const model = process.env.MIMO_SUMMARY_MODEL;
  if (!apiKey || !apiUrl || !model) {
    throw new Error("服务端未配置 MIMO_API_KEY / MIMO_API_URL / MIMO_SUMMARY_MODEL");
  }
  return fetch(apiUrl, {
    method: "POST",
    headers: { "api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      max_completion_tokens: maxTokens,
      temperature,
      stream: false,
    }),
  }).then(async (resp) => {
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error(data.error?.message || `纪要模型请求失败 (${resp.status})`);
    }
    return (data.choices?.[0]?.message?.content || "").trim();
  });
}

// ============ 事件流 ============

/**
 * 把 segments 与 markers 归并成按时间排序的事件。
 * 同一毫秒时标记优先（它是对该时刻的注解，应出现在对应发言之前）。
 */
function buildEvents(segments = [], markers = []) {
  const events = [];

  for (const s of segments) {
    const text = (s.text || "").trim();
    if (!text) continue;
    events.push({
      start_ms: Number(s.start_ms) || 0,
      end_ms: Number(s.end_ms) || 0,
      kind: "segment",
      speaker: s.speaker_label || s.speaker || null,
      text,
    });
  }

  for (const m of markers) {
    const text = (m.text || "").trim();
    if (!text) continue;
    events.push({
      start_ms: Number(m.start_ms) || 0,
      end_ms: m.end_ms == null ? null : Number(m.end_ms),
      kind: "marker",
      speaker: null,
      text,
      duringPause: Boolean(m.during_pause),
    });
  }

  events.sort((a, b) => {
    if (a.start_ms !== b.start_ms) return a.start_ms - b.start_ms;
    return (a.kind === "marker" ? 0 : 1) - (b.kind === "marker" ? 0 : 1);
  });
  return events;
}

function formatEvent(ev) {
  const ts = `[${fmtTime(ev.start_ms / 1000)}]`;
  if (ev.kind === "marker") {
    return `${ts} 【现场标记】${ev.text}${ev.duringPause ? "（暂停时记录）" : ""}`;
  }
  return `${ts} ${ev.speaker ? `${ev.speaker}：` : ""}${ev.text}`;
}

/**
 * 按字数分块，但保证标记行不被切散：
 * - 标记遇到「当前块已满」时，先结束当前块，让标记成为下一块的开头；
 * - 若刚压入的就是标记且块已满，不在这里收尾，等下一行一起走。
 */
function buildBlocks(events) {
  const blocks = [];
  let cur = [];
  let curChars = 0;

  const flush = () => {
    if (cur.length) blocks.push(cur.join("\n"));
    cur = [];
    curChars = 0;
  };

  for (const ev of events) {
    if (ev.kind === "marker" && curChars >= BLOCK_CHARS) flush();

    const line = formatEvent(ev);
    cur.push(line);
    curChars += ev.text.length;

    if (curChars >= BLOCK_CHARS && ev.kind !== "marker") flush();
  }
  flush();
  return blocks;
}

// ============ Prompt ============

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
- 每条标记都必须被处理：进入 content/decisions，或转化为 todo；确实无关则标 usedIn="unused" 并说明原因。
- 标记含「跟进/确认/发/找/下周/负责」等行动语义时，必须生成 todo。`;
}

function mapPrompt(hasSpeakers, hasMarkers) {
  return `你是会议记录助手。下面是一段会议转写（每行以 [时:分:秒] 开头）。
${speakerSection(hasSpeakers)}${markerSection(hasMarkers)}

请输出两部分，不要输出其他内容：
1) 摘要：150~250 字，客观记录讨论了什么、得出了什么结论。
2) 待办：每行一条，格式为「- 事项 | 负责人 | 时间戳」。负责人或时间戳在原文中没有就写「未提及」。
   原文里没有待办就写「无」。

禁止编造原文没有的信息。`;
}

function reducePrompt(hasSpeakers, hasMarkers) {
  return `你是资深会议秘书。下面是一场会议各段落的摘要与待办候选。
${speakerSection(hasSpeakers)}${markerSection(hasMarkers)}

请合并成一份完整纪要，**只输出 JSON**，不要 markdown 代码块、不要解释文字。结构：
{
  "topic": "一句话主题，不超过 30 字",
  "content": ["会议内容要点，3~8 条，每条 20~60 字"],
  "decisions": ["明确达成的决议，没有就给空数组"],
  "todos": [{"text": "具体可执行的事项", "owner": "负责人或未提及", "at": "原文中的时间戳，如 00:14:32，没有就给空字符串", "ownerConfidence": "inferred 或 text 或 none"}],
  "attendees": ["文中出现的人名，没有就给空数组"],
  "markers": [{"at": "00:12:43", "text": "标记原文", "usedIn": "content 或 decisions 或 todos 或 unused"}],
  "speakerPoints": [{"speaker": "说话人名", "points": ["该发言人提出的要点"]}]
}

规则：
- 只用给定材料，不得编造；材料里没有的字段给空数组或空字符串
- content 按时间顺序，合并重复内容
- todos 只保留真正的行动项，不要把讨论过程写成待办
- at 必须来自材料中出现的 [时:分:秒] 标记，不要自己估算
- 每条现场标记都必须出现在 markers 里，不得遗漏；没有标记就给空数组
- 没有说话人信息时 speakerPoints 给空数组
- 若输入中出现「【现场标记】」，说明这是主持人标注的重点，权重高于普通发言`;
}

function stripFence(s) {
  return s
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
}

function parseJsonLoose(text) {
  const cleaned = stripFence(text);
  try {
    return JSON.parse(cleaned);
  } catch {}
  // 模型偶尔会在 JSON 前后加话，截取第一个平衡的大括号块
  const start = cleaned.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < cleaned.length; i++) {
    if (cleaned[i] === "{") depth++;
    else if (cleaned[i] === "}") {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(cleaned.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

const USED_IN = new Set(["content", "decisions", "todos", "unused"]);

function normalize(json) {
  const arr = (v) => (Array.isArray(v) ? v.filter((x) => x != null && String(x).trim()) : []);

  const todos = Array.isArray(json.todos)
    ? json.todos
        .filter((t) => t && String(t.text || "").trim())
        .map((t) => {
          const conf = String(t.ownerConfidence || "").toLowerCase();
          return {
            text: String(t.text).trim(),
            owner: String(t.owner || "未提及").trim() || "未提及",
            at: String(t.at || "").trim(),
            ownerConfidence: ["inferred", "text", "none"].includes(conf)
              ? conf
              : String(t.owner || "").trim() && String(t.owner).trim() !== "未提及"
                ? "text"
                : "none",
          };
        })
    : [];

  const markers = Array.isArray(json.markers)
    ? json.markers
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

  const speakerPoints = Array.isArray(json.speakerPoints)
    ? json.speakerPoints
        .filter((s) => s && String(s.speaker || "").trim())
        .map((s) => ({
          speaker: String(s.speaker).trim(),
          points: arr(s.points).map(String),
        }))
    : [];

  return {
    topic: String(json.topic || "").trim(),
    content: arr(json.content).map(String),
    decisions: arr(json.decisions).map(String),
    todos,
    attendees: arr(json.attendees).map(String),
    markers,
    speakerPoints,
  };
}

const USED_LABEL = {
  content: "已纳入「会议内容」",
  decisions: "已纳入「决议」",
  todos: "已转为待办",
  unused: "未纳入",
};

function toMarkdown(json) {
  const lines = [];
  lines.push(`## 主题`);
  lines.push(json.topic || "（未提炼出主题）");
  lines.push("");
  lines.push(`## 会议内容`);
  if (json.content.length) json.content.forEach((c) => lines.push(`- ${c}`));
  else lines.push("- 无");
  lines.push("");
  lines.push(`## 决议`);
  if (json.decisions.length) json.decisions.forEach((d) => lines.push(`- ${d}`));
  else lines.push("- 无");
  lines.push("");
  lines.push(`## 待办`);
  if (json.todos.length) {
    json.todos.forEach((t) => {
      const tail = [t.owner, t.at].filter(Boolean).join(" · ");
      lines.push(`- [ ] ${t.text}${tail ? ` — ${tail}` : ""}`);
    });
  } else lines.push("- 无");
  if (json.attendees.length) {
    lines.push("");
    lines.push(`## 参会人`);
    lines.push(json.attendees.join("、"));
  }
  if (json.markers && json.markers.length) {
    lines.push("");
    lines.push(`## 现场标记`);
    json.markers.forEach((m) => {
      lines.push(`- ${m.at ? `${m.at} ` : ""}${m.text} → ${USED_LABEL[m.usedIn] || "已纳入"}`);
    });
  }
  if (json.speakerPoints && json.speakerPoints.length) {
    lines.push("");
    lines.push(`## 按人要点`);
    json.speakerPoints.forEach((s) => {
      lines.push(`- ${s.speaker}：${(s.points || []).join("；") || "—"}`);
    });
  }
  return lines.join("\n");
}

/**
 * @param {Array} segments  segments 表行（含 start_ms / text / speaker_label）
 * @param {{markers?: Array, onProgress?: (p:number)=>void}} opts
 * @returns {{ json: object, markdown: string, blocks: number }}
 */
async function generateSummary(segments, { markers = [], onProgress } = {}) {
  const events = buildEvents(segments, markers);
  const blocks = buildBlocks(events);
  if (!blocks.length) throw new Error("没有可总结的文本");

  const hasSpeakers = events.some((e) => e.kind === "segment" && e.speaker);
  const hasMarkers = events.some((e) => e.kind === "marker");

  // 短会议（单块）没必要走 map：省掉一次往返，13 秒的录音不必等 40 秒
  if (blocks.length === 1) {
    let parsed = parseJsonLoose(
      await chat(
        [
          { role: "system", content: reducePrompt(hasSpeakers, hasMarkers) },
          { role: "user", content: blocks[0] },
        ],
        { maxTokens: REDUCE_MAX_TOKENS, temperature: 0.1 }
      )
    );
    if (!parsed) {
      parsed = {
        topic: "（模型未返回结构化结果）",
        content: [blocks[0].slice(0, 80)],
        decisions: [],
        todos: [],
        attendees: [],
      };
    }
    const json = normalize(parsed);
    if (onProgress) onProgress(1);
    return { json, markdown: toMarkdown(json), blocks: 1 };
  }

  // ---- map：并发 4，控制并发避免限流 ----
  const digests = new Array(blocks.length);
  let finished = 0;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(4, blocks.length) }, async () => {
    while (cursor < blocks.length) {
      const i = cursor++;
      try {
        digests[i] = await chat(
          [
            { role: "system", content: mapPrompt(hasSpeakers, hasMarkers) },
            { role: "user", content: blocks[i] },
          ],
          { maxTokens: MAP_MAX_TOKENS, temperature: 0.1 }
        );
      } catch (e) {
        digests[i] = `（本段摘要失败：${e.message}）`;
      }
      finished += 1;
      if (onProgress) onProgress((finished / blocks.length) * 0.7);
    }
  });
  await Promise.all(workers);

  const material = digests
    .map((d, i) => `### 第 ${i + 1} 段\n${d}`)
    .join("\n\n");

  // reduce 阶段额外附上标记清单，保证一条都不漏（map 分块可能把上下文的要点弱化）
  const markerList = hasMarkers && markers.length
    ? `\n\n### 现场标记清单（必须逐条处理）\n${markers
        .map((m) => `- ${fmtTime((m.start_ms || 0) / 1000)} ${(m.text || "").trim()}`)
        .join("\n")}`
    : "";

  // ---- reduce ----
  let raw = await chat(
    [
      { role: "system", content: reducePrompt(hasSpeakers, hasMarkers) },
      { role: "user", content: `${material}${markerList}` },
    ],
    { maxTokens: REDUCE_MAX_TOKENS, temperature: 0.2 }
  );
  if (onProgress) onProgress(0.92);

  let parsed = parseJsonLoose(raw);
  if (!parsed) {
    // 一次纠正重试：明确要求只输出 JSON
    raw = await chat(
      [
        { role: "system", content: reducePrompt(hasSpeakers, hasMarkers) },
        { role: "user", content: `${material}${markerList}\n\n上次输出不是合法 JSON，请只输出 JSON 对象本身。` },
      ],
      { maxTokens: REDUCE_MAX_TOKENS, temperature: 0 }
    );
    parsed = parseJsonLoose(raw);
  }
  if (!parsed) {
    // 兜底：把分片摘要直接当内容，不丢结果
    parsed = {
      topic: "（模型未返回结构化结果）",
      content: digests.map((d) => d.split("\n")[0].slice(0, 80)).filter(Boolean),
      decisions: [],
      todos: [],
      attendees: [],
    };
  }

  const json = normalize(parsed);

  // 兜底补漏：模型漏掉的标记按原文补回去，标为未纳入，至少让用户看到它没被处理
  if (hasMarkers) {
    const seen = new Set(json.markers.map((m) => `${m.at}|${m.text}`));
    for (const m of markers) {
      const text = (m.text || "").trim();
      if (!text) continue;
      const at = fmtTime((m.start_ms || 0) / 1000);
      if (seen.has(`${at}|${text}`)) continue;
      json.markers.push({ at, text, usedIn: "unused" });
    }
    json.markers.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  }

  if (onProgress) onProgress(1);
  return { json, markdown: toMarkdown(json), blocks: blocks.length };
}

module.exports = {
  generateSummary, buildEvents, buildBlocks, formatEvent,
  toMarkdown, normalize,
};
