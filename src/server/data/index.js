/**
 * 数据层唯一入口。
 *
 * 三类数据在这里汇合：
 *   1) 静态常量（shared/constants）—— 阈值、枚举、格式
 *   2) 内置预设（data/presets）—— 系统模板等随版本发布的定义
 *   3) 持久化仓储（data/db/repositories）—— 由 P2 提供
 *
 * 上层只 require 本文件，不直接深引 shared/ 或 repositories/。
 */

const limits = require("../../../shared/constants/limits.json");
const media = require("../../../shared/constants/media.json");
const engines = require("../../../shared/constants/engines.json");
const protocol = require("../../../shared/constants/protocol.json");
const speakers = require("../../../shared/constants/speakers.json");
const stages = require("../../../shared/copy/stages.json");
const entries = require("../../../shared/copy/entries.json");
const modals = require("../../../shared/copy/modals.json");
const minuteLabels = require("../../../shared/copy/minute-labels.json");

const presets = require("./presets");

const constants = Object.freeze({ limits, media, engines, protocol, speakers });
const copy = Object.freeze({ stages, entries, modals, minuteLabels });

/** 给浏览器的一次性数据包（不含任何密钥） */
function clientMeta() {
  return {
    limits,
    media,
    engines: { languages: engines.languages, defaults: engines.defaults, jobStage: engines.jobStage },
    speakers,
    copy,
  };
}

module.exports = {
  constants,
  copy,
  presets,
  clientMeta,
  /** 仓储：用 getter 延迟 require，避免 data/index ↔ repositories 循环初始化 */
  get repositories() { return require("./db/repositories"); },
  get limits() { return limits; },
  get media() { return media; },
  get engines() { return engines; },
  get protocol() { return protocol; },
  get speakers() { return speakers; },
};
