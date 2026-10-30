/**
 * 录音时间轴：波形、分钟刻度、标记钉、播放头。
 *
 * 纯绘制，不持有状态：所有数据从传入的 rec 读取，
 * 这样「时间轴」与「录音会话」互不依赖。
 */

import { $ } from "../../core/dom.js";
import { escapeAttr } from "../../core/format.js";

const recPins = $("#recPins");
const recCanvas = $("#recCanvas");
const recPlayhead = $("#recPlayhead");

export const TIMELINE_SPAN_MS = 5 * 60 * 1000; // 超过 5 分钟就滚动窗口
export const WAVE_BUCKET_MS = 2000;

export function timelineWindow(rec) {
  const total = Math.max(TIMELINE_SPAN_MS, rec.audioMs + 1000);
  if (total <= TIMELINE_SPAN_MS) return { start: 0, end: TIMELINE_SPAN_MS };
  return { start: total - TIMELINE_SPAN_MS, end: total };
}

export function updatePlayhead(rec) {
  if (!recPlayhead) return;
  const { start, end } = timelineWindow(rec);
  const pct = Math.max(0, Math.min(100, ((rec.audioMs - start) / (end - start)) * 100));
  recPlayhead.style.left = pct + "%";
}

/** 每 2 秒一个桶，值为 0~1 的幅度 */
export function pushLevel(rec, rms) {
  const i = Math.floor(rec.audioMs / WAVE_BUCKET_MS);
  const v = Math.min(1, rms * 7);
  rec.wave[i] = Math.max(rec.wave[i] || 0, v);
}

export function drawTimeline(rec, workspaceHidden) {
  if (!recCanvas || workspaceHidden) return;
  const rect = recCanvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;

  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(rect.width);
  const h = Math.round(rect.height);
  if (recCanvas.width !== w * dpr || recCanvas.height !== h * dpr) {
    recCanvas.width = w * dpr;
    recCanvas.height = h * dpr;
  }

  const ctx = recCanvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const { start, end } = timelineWindow(rec);
  const span = Math.max(1, end - start);

  // 分钟刻度
  ctx.strokeStyle = "#e4e0d6";
  ctx.lineWidth = 1;
  const firstTick = Math.ceil(start / 60000) * 60000;
  for (let t = firstTick; t < end; t += 60000) {
    const x = Math.round(((t - start) / span) * w) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }

  // 波形：2 秒一柱
  const first = Math.floor(start / WAVE_BUCKET_MS);
  const last = Math.ceil(end / WAVE_BUCKET_MS);
  const bw = Math.max(1.5, w / (span / WAVE_BUCKET_MS) - 1);
  ctx.fillStyle = "#d84a35";
  ctx.globalAlpha = 0.5;
  for (let i = first; i <= last; i += 1) {
    const v = rec.wave[i] || 0;
    if (!v) continue;
    const x = ((i * WAVE_BUCKET_MS - start) / span) * w;
    const bh = Math.max(2, v * (h - 6));
    ctx.fillRect(x, (h - bh) / 2, bw, bh);
  }
  ctx.globalAlpha = 1;
}

let drawTimer = null;
export function scheduleDraw(rec, workspaceHidden) {
  if (drawTimer) return;
  drawTimer = requestAnimationFrame(() => {
    drawTimer = null;
    drawTimeline(rec, workspaceHidden);
  });
}

export function renderPins(rec) {
  if (!recPins) return;
  const { start, end } = timelineWindow(rec);
  recPins.innerHTML = rec.marks
    .filter((m) => m.startMs >= start && m.startMs <= end)
    .map((m) => {
      const pct = ((m.startMs - start) / (end - start)) * 100;
      return `<button class="rec-pin" style="left:${pct}%" data-id="${escapeAttr(m.id)}"
        title="${escapeAttr(m.text.slice(0, 60))}" aria-label="标记：${escapeAttr(m.text.slice(0, 30))}"></button>`;
    })
    .join("");
}

export { recPins, recCanvas, recPlayhead };
