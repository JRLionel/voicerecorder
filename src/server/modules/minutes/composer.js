/**
 * 会议纪要 map-reduce。
 *
 * 为什么不一次塞全文：2 小时会议是 2~3 万字（3~5 万 token），
 * 一次性输入既容易超限，也会让模型只总结开头。
 * 做法：每 ~1800 字出一个分片摘要，再把摘要合成结构化 JSON。
 */

const config = require("../../config");
const { limits } = require("../../data");
const { parseJsonLoose } = require("../../shared/utils/json");
const { runPool } = require("../../shared/utils/pool");
const { fmtTime } = require("../../shared/utils/time");
const templates = require("../templates");
const { buildEvents, buildBlocks } = require("./event-stream");
const { normalizeSummary, fallbackSummary } = require("./normalizer");
const { toMarkdown } = require("./markdown");

const DEFAULT_TEMPLATE = templates.DEFAULT_TEMPLATE;
const { buildSummaryPrompt, templateFocusLine, speakerSection, markerSection } = templates;

const MINUTES = limits.minutes;
const MAP_MAX_TOKENS = MINUTES.mapMaxTokens;
const REDUCE_MAX_TOKENS = MINUTES.reduceMaxTokens;
const MAP_CONCURRENCY = MINUTES.mapConcurrency;

async function chat(messages, { maxTokens = 1024, temperature = MINUTES.temperature.reduce, apiKey, apiUrl, model } = {}) {
  const key = apiKey || config.mimo.apiKey;
  const url = apiUrl || config.mimo.apiUrl;
  const mdl = model || config.mimo.summaryModel;
  if (!key || !url || !mdl) {
    throw new Error("服务端未配置 MIMO_API_KEY / MIMO_API_URL / MIMO_SUMMARY_MODEL");
  }
  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: mdl,
        messages,
        max_completion_tokens: maxTokens,
        temperature,
        stream: false,
      }),
    });
  } catch {
    // 直接把 TypeError 抛给用户没有意义，换成能指导排查的文案
    throw new Error("纪要模型连接失败，请检查网络与模型配置里的服务地址");
  }
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(data.error?.message || `纪要模型请求失败 (${resp.status})`);
  }
  return (data.choices?.[0]?.message?.content || "").trim();
}

// ============ 事件流 ============

/**
 * 把 segments 与 markers 归并成按时间排序的事件。
 * 同一毫秒时标记优先（它是对该时刻的注解，应出现在对应发言之前）。
 */

function mapPrompt(hasSpeakers, hasMarkers, template) {
  return `你是会议记录助手。下面是一段会议转写（每行以 [时:分:秒] 开头）。
${speakerSection(hasSpeakers)}${markerSection(hasMarkers)}
${templateFocusLine(template)}

请输出两部分，不要输出其他内容：
1) 摘要：150~250 字，客观记录讨论了什么、得出了什么结论，并保留上面模板要求的信息点。
2) 待办：每行一条，格式为「- 事项 | 负责人 | 时间戳」。负责人或时间戳在原文中没有就写「未提及」。
   原文里没有待办就写「无」。

禁止编造原文没有的信息。`;
}

/**
 * @param {Array} segments  segments 表行（含 start_ms / text / speaker_label）
 * @param {{markers?: Array, template?: object, onProgress?: (p:number)=>void, model?: {url:string,key:string,model:string}}} opts
 * @returns {{ json: object, markdown: string, template: object, blocks: number }}
 */

async function generateSummary(segments, { markers = [], template = DEFAULT_TEMPLATE, onProgress, model = null } = {}) {
  const events = buildEvents(segments, markers);
  const blocks = buildBlocks(events);
  if (!blocks.length) throw new Error("没有可总结的文本");

  const hasSpeakers = events.some((e) => e.kind === "segment" && e.speaker);
  const hasMarkers = events.some((e) => e.kind === "marker");

  let tpl = template || DEFAULT_TEMPLATE;
  const system = buildSummaryPrompt(tpl, { hasSpeakers, hasMarkers });

  /** 浏览器配置优先：调用方传了就用它，没传才走 .env */
  const chatOpts = model ? { apiKey: model.key, apiUrl: model.url, model: model.model } : {};

  /** 归一；模型返回旧结构时回落到默认模板，保证渲染与快照自洽 */
  const settle = (parsed, seedText) => {
    if (!parsed) {
      return { data: fallbackSummary(tpl, seedText), used: tpl };
    }
    const data = normalizeSummary(parsed, tpl);
    if (data.legacy) {
      tpl = DEFAULT_TEMPLATE;
      return { data: normalizeSummary(parsed, DEFAULT_TEMPLATE), used: DEFAULT_TEMPLATE };
    }
    return { data, used: tpl };
  };

  // 短会议（单块）没必要走 map：省掉一次往返，13 秒的录音不必等 40 秒
  if (blocks.length === 1) {
    const parsed = parseJsonLoose(
      await chat(
        [
          { role: "system", content: system },
          { role: "user", content: blocks[0] },
        ],
        { ...chatOpts, maxTokens: REDUCE_MAX_TOKENS, temperature: MINUTES.temperature.single }
      )
    );
    const { data, used } = settle(parsed, blocks[0]);
    if (onProgress) onProgress(1);
    return { json: data, markdown: toMarkdown(used, data), template: used, blocks: 1 };
  }

  // ---- map：并发 4，控制并发避免限流 ----
  const digests = new Array(blocks.length);
  let finished = 0;
  const mapSystem = mapPrompt(hasSpeakers, hasMarkers, tpl);
  await runPool(blocks, MAP_CONCURRENCY, async (block, i) => {
    try {
      digests[i] = await chat(
        [
          { role: "system", content: mapSystem },
          { role: "user", content: block },
        ],
        { ...chatOpts, maxTokens: MAP_MAX_TOKENS, temperature: MINUTES.temperature.map }
      );
    } catch (e) {
      digests[i] = `（本段摘要失败：${e.message}）`;
    }
    finished += 1;
    if (onProgress) onProgress((finished / blocks.length) * MINUTES.progress.mapWeight);
  });

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
      { role: "system", content: system },
      { role: "user", content: `${material}${markerList}` },
    ],
    { ...chatOpts, maxTokens: REDUCE_MAX_TOKENS, temperature: MINUTES.temperature.reduce }
  );
  if (onProgress) onProgress(MINUTES.progress.beforeReduce);

  let parsed = parseJsonLoose(raw);
  if (!parsed) {
    // 一次纠正重试：明确要求只输出 JSON
    raw = await chat(
      [
        { role: "system", content: system },
        { role: "user", content: `${material}${markerList}\n\n上次输出不是合法 JSON，请只输出 JSON 对象本身。` },
      ],
      { ...chatOpts, maxTokens: REDUCE_MAX_TOKENS, temperature: MINUTES.temperature.retry }
    );
    parsed = parseJsonLoose(raw);
  }

  const seed = parsed ? "" : digests.map((d) => d.split("\n")[0]).filter(Boolean).join("；");
  const { data, used } = settle(parsed, seed);

  // 兜底补漏：模型漏掉的标记按原文补回去，标为未纳入，至少让用户看到它没被处理
  if (hasMarkers) {
    const seen = new Set(data.markers.map((m) => `${m.at}|${m.text}`));
    for (const m of markers) {
      const text = (m.text || "").trim();
      if (!text) continue;
      const at = fmtTime((m.start_ms || 0) / 1000);
      if (seen.has(`${at}|${text}`)) continue;
      data.markers.push({ at, text, usedIn: "unused" });
    }
    data.markers.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  }

  if (onProgress) onProgress(1);
  return { json: data, markdown: toMarkdown(used, data), template: used, blocks: blocks.length };
}

module.exports = { generateSummary, chat, mapPrompt };
