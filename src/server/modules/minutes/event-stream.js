/**
 * 事件流：把转写分段与用户标记合并到同一条时间轴。
 *
 * 同一毫秒时标记优先 —— 它是对该时刻的注解，应出现在对应发言之前。
 * 分块以字数为准，但保证标记行不被切散。
 */

const { fmtTime } = require("../../shared/utils/time");
const { limits } = require("../../data");

const BLOCK_CHARS = limits.minutes.blockChars;

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

module.exports = { buildEvents, formatEvent, buildBlocks, BLOCK_CHARS };
