/**
 * 转写渲染：连续同一说话人的句子合并成一个发言块，
 * 标记按时间插入同一列 —— 两套内容共用一个时间轴才读得顺。
 */

import { escapeHtml, escapeAttr, formatFrac } from "../core/format.js";

const SPEAKER_FALLBACK_COLORS = ["#3565d9", "#7c4dd4", "#1f9a62", "#c97a12", "#d84a35", "#5f6b7a"];

export function speakerColor(speakers, localId) {
  const found = (speakers || []).find((s) => s.localId === localId);
  if (found && found.color) return found.color;
  const i = Math.max(0, (speakers || []).findIndex((s) => s.localId === localId));
  return SPEAKER_FALLBACK_COLORS[i % SPEAKER_FALLBACK_COLORS.length];
}

/**
 * @param {Array} segments 服务端分段（含 speaker / speakerLabel）
 * @param {Array} markers  现场标记
 * @param {Array} speakers 说话人名册（取色）
 */
export function renderTranscriptRows(segments, markers, speakers = []) {
  const items = [];
  let turn = null;

  for (const s of segments) {
    const text = (s.text || "").trim();
    if (!text) continue;
    const spk = s.speakerLabel || s.speaker || null;
    if (turn && spk === turn.speaker) {
      turn.parts.push(text);
      turn.endMs = s.endMs;
    } else {
      turn = {
        kind: "turn",
        speaker: spk,
        localId: s.speaker || null,
        startMs: s.startMs,
        endMs: s.endMs,
        parts: [text],
      };
      items.push(turn);
    }
  }

  for (const m of markers) {
    items.push({
      kind: "marker",
      startMs: m.startMs,
      endMs: m.endMs,
      text: m.text,
      duringPause: m.duringPause,
    });
  }

  items.sort((a, b) => a.startMs - b.startMs);

  return items
    .map((it) => {
      if (it.kind === "marker") {
        return `<div class="marker-row" data-ms="${it.startMs}">
          <span class="marker-badge">标记</span>
          <p class="marker-text">${escapeHtml(it.text)}${it.duringPause ? '<span class="marker-pause">暂停时</span>' : ""}</p>
          <button class="marker-ts" data-ms="${it.startMs}" title="跳转到此处">${formatFrac(it.startMs / 1000)}</button>
        </div>`;
      }
      const chip = it.speaker
        ? `<button class="spk-chip" data-local="${escapeAttr(it.localId || "")}"
             style="--spk:${speakerColor(speakers, it.localId)}" title="点击改名">${escapeHtml(it.speaker)}</button>`
        : "";
      return `<div class="seg-row${chip ? " is-turn" : ""}" data-ms="${it.startMs}">
        <button class="seg-ts" data-ms="${it.startMs}" title="跳转到此处">${formatFrac(it.startMs / 1000)}</button>
        ${chip}
        <p class="seg-text">${escapeHtml(it.parts.join(" "))}</p>
      </div>`;
    })
    .join("");
}
