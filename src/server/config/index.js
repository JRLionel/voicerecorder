/**
 * 运行配置：整个进程只在启动时读一次 process.env，之后全部走这个对象。
 *
 * 约定：
 * - 业务模块不得直接读 process.env（重构前的 26 处读取点全部收敛到这里）；
 * - 配置对象本身只读，测试可以用 build(env) 造一份独立配置。
 */

// 进程序入口会再调用一次，dotenv 幂等且默认不覆盖已有变量，
// 这样脚本/测试直接 require 本模块也能拿到 .env 的值。
require("dotenv").config();

const paths = require("./paths");
const engines = require("../../../shared/constants/engines.json");
const limits = require("../../../shared/constants/limits.json");
const schema = require("./env.schema");

function toInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function build(env = process.env) {
  return {
    env: env.NODE_ENV || "development",
    port: toInt(env.PORT, engines.defaults.port),
    http: { jsonLimit: limits.http.jsonBodyLimit },
    paths,

    mimo: Object.freeze({
      apiKey: env.MIMO_API_KEY || "",
      apiUrl: env.MIMO_API_URL || "",
      asrModel: env.MIMO_ASR_MODEL || "",
      summaryModel: env.MIMO_SUMMARY_MODEL || "",
      get configured() {
        return Boolean(env.MIMO_API_KEY && env.MIMO_API_URL && env.MIMO_ASR_MODEL && env.MIMO_SUMMARY_MODEL);
      },
    }),

    bailian: Object.freeze({
      apiKey: env.DASHSCOPE_API_KEY || "",
      wsHost: env.BAILIAN_WS_HOST || "",
      workspace: env.BAILIAN_WORKSPACE || "",
      asrModel: env.ASR_MODEL || engines.defaults.asrModel,
      diarModel: env.DIAR_MODEL || engines.defaults.diarModel,
      get realtimeConfigured() {
        return Boolean(env.DASHSCOPE_API_KEY && env.BAILIAN_WS_HOST && env.BAILIAN_WORKSPACE);
      },
    }),
  };
}

const config = build();

// 工具挂在导出对象上（配置字段本身保持只读）
config.build = build;
config.warningLines = schema.warningLines;
config.missingByGroup = schema.missingByGroup;
config.hasGroup = schema.hasGroup;

module.exports = config;
