/**
 * 客户端元数据：阈值、枚举、文案统一从 /api/meta 取一次。
 *
 * 与服务端共用 shared/ 下的同一批 JSON，避免前后端各写一份常量。
 * 拉取失败时退化为内置兜底，页面仍可用（只是文案与阈值取默认）。
 */

import { API, jsonFetch } from "./api.js";
import { state } from "./store.js";

const FALLBACK = {
  limits: {
    diarize: { maxDurationSec: 7200 },
    upload: { maxBytes: 2147483648, maxDurationSec: 14400 },
    records: { pageSize: 20 },
  },
  media: { accept: { audio: "audio/*", video: "video/*" } },
  copy: { stages: {}, entries: {}, modals: {}, minuteLabels: {} },
};

export async function loadMeta() {
  if (state.meta) return state.meta;
  const data = await jsonFetch(API.meta);
  state.meta = data && data.success && data.meta ? data.meta : FALLBACK;
  return state.meta;
}

export function meta() {
  return state.meta || FALLBACK;
}

export function limits() {
  return meta().limits || FALLBACK.limits;
}

export function copy() {
  return meta().copy || FALLBACK.copy;
}

/** 阶段文案：未知阶段回落到「处理中」 */
export function stageText(stage) {
  const table = copy().stages || {};
  return table[stage] || table.fallback || "处理中";
}

export function acceptOf(entry) {
  const table = (meta().media && meta().media.accept) || {};
  return table[entry] || FALLBACK.media.accept[entry] || "";
}
