/**
 * 前端状态：单一状态树。
 *
 * 字段名与改造前保持一致，减少迁移时的认知负担；
 * 写入仍然分散在各 feature，但读只有一个来源，便于排查。
 */

import { KEYS, read } from "./storage.js";

export const state = {
  view: "home",

  // 记录列表
  tab: "recent",
  q: "",
  page: 1,
  pageSize: 20,
  total: 0,
  items: [],
  selected: new Set(),
  viewMode: read(KEYS.viewMode) || "list",

  // 上传
  entry: "audio", // video | audio
  autoMinutes: read(KEYS.autoMinutes) !== "0",
  templateId: read(KEYS.lastTemplateId) || null,
  file: null,
  fileDuration: null, // 选中文件的时长（秒），用于 >2h 置灰
  diarize: false,
  speakerCount: null,
  job: null,
  pollTimer: null,

  // 模板
  templates: [],
  defaultTemplateId: null,
  selectedTemplates: new Set(),

  // 详情
  record: null,
  segments: [],
  markers: [],
  speakers: [],

  // 纪要
  minutes: [], // 当前记录的纪要摘要列表
  minutesCurrent: null, // 当前纪要详情（含 json / template）
  minutesBusy: false,
  minutesPollTimer: null,

  // 通用
  lastFocus: null,
  meta: null,
};
