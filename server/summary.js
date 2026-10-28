const { fmtTime } = require("./audio");

/**
 * 会议纪要 map-reduce。
 *
 * 为什么不一次塞全文：2 小时会议是 2~3 万字（3~5 万 token），
 * 一次性输入既容易超限，也会让模型只总结开头。
 * 做法：每 ~1800 字出一个分片摘要，再把摘要合成结构化 JSON。
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

/** 把 segments 按字数切成若干块，每行带时间戳，便于模型引用 */
function buildBlocks(segments) {
  const blocks = [];
  let cur = [];
  let curChars = 0;
  for (const s of segments) {
    const text = (s.text || "").trim();
    if (!text) continue;
    const line = `[${fmtTime(s.start_ms / 1000)}] ${text}`;
    cur.push(line);
    curChars += text.length;
    if (curChars >= BLOCK_CHARS) {
      blocks.push(cur.join("\n"));
      cur = [];
      curChars = 0;
    }
  }
  if (cur.length) blocks.push(cur.join("\n"));
  return blocks;
}

const MAP_PROMPT = `你是会议记录助手。下面是一段会议转写（每行以 [时:分:秒] 开头）。

请输出两部分，不要输出其他内容：
1) 摘要：150~250 字，客观记录讨论了什么、得出了什么结论。
2) 待办：每行一条，格式为「- 事项 | 负责人 | 时间戳」。负责人或时间戳在原文中没有就写「未提及」。
   原文里没有待办就写「无」。

禁止编造原文没有的信息。`;

const REDUCE_PROMPT = `你是资深会议秘书。下面是一场会议各段落的摘要与待办候选。

请合并成一份完整纪要，**只输出 JSON**，不要 markdown 代码块、不要解释文字。结构：
{
  "topic": "一句话主题，不超过 30 字",
  "content": ["会议内容要点，3~8 条，每条 20~60 字"],
  "decisions": ["明确达成的决议，没有就给空数组"],
  "todos": [{"text": "具体可执行的事项", "owner": "负责人或未提及", "at": "原文中的时间戳，如 00:14:32，没有就给空字符串"}],
  "attendees": ["文中出现的人名，没有就给空数组"]
}

规则：
- 只用给定材料，不得编造；材料里没有的字段给空数组或空字符串
- content 按时间顺序，合并重复内容
- todos 只保留真正的行动项，不要把讨论过程写成待办
- at 必须来自材料中出现的 [时:分:秒] 标记，不要自己估算`;

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

function normalize(json) {
  const arr = (v) => (Array.isArray(v) ? v.filter((x) => x != null && String(x).trim()) : []);
  const todos = Array.isArray(json.todos)
    ? json.todos
        .filter((t) => t && String(t.text || "").trim())
        .map((t) => ({
          text: String(t.text).trim(),
          owner: String(t.owner || "未提及").trim() || "未提及",
          at: String(t.at || "").trim(),
        }))
    : [];
  return {
    topic: String(json.topic || "").trim(),
    content: arr(json.content).map(String),
    decisions: arr(json.decisions).map(String),
    todos,
    attendees: arr(json.attendees).map(String),
  };
}

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
  return lines.join("\n");
}

/**
 * @param {Array} segments  segments 表行（含 start_ms / text）
 * @param {{onProgress?: (p:number)=>void}} opts
 * @returns {{ json: object, markdown: string, blocks: number }}
 */
async function generateSummary(segments, { onProgress } = {}) {
  const blocks = buildBlocks(segments);
  if (!blocks.length) throw new Error("没有可总结的文本");

  // 短会议（单块）没必要走 map：省掉一次往返，13 秒的录音不必等 40 秒
  if (blocks.length === 1) {
    let parsed = parseJsonLoose(
      await chat(
        [
          { role: "system", content: REDUCE_PROMPT },
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
            { role: "system", content: MAP_PROMPT },
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

  // ---- reduce ----
  let raw = await chat(
    [
      { role: "system", content: REDUCE_PROMPT },
      { role: "user", content: material },
    ],
    { maxTokens: REDUCE_MAX_TOKENS, temperature: 0.2 }
  );
  if (onProgress) onProgress(0.92);

  let parsed = parseJsonLoose(raw);
  if (!parsed) {
    // 一次纠正重试：明确要求只输出 JSON
    raw = await chat(
      [
        { role: "system", content: REDUCE_PROMPT },
        { role: "user", content: `${material}\n\n上次输出不是合法 JSON，请只输出 JSON 对象本身。` },
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
  if (onProgress) onProgress(1);
  return { json, markdown: toMarkdown(json), blocks: blocks.length };
}

module.exports = { generateSummary, buildBlocks, toMarkdown, normalize };
