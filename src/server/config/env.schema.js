/**
 * 环境变量的声明式定义。
 *
 * 这里是「哪些配置存在、缺了会怎样」的唯一事实来源：
 * 运行期取值、启动期告警、README 的配置表都由它派生。
 */

const engines = require("../../../shared/constants/engines.json");

/** 分组决定告警文案：缺任意一项即整组不可用 */
const GROUPS = {
  mimo: { label: "转写与纪要会失败" },
  bailianRealtime: { label: "实时录音不可用" },
};

const FIELDS = [
  { key: "PORT", group: "server", type: "int", fallback: engines.defaults.port, secret: false },

  { key: "MIMO_API_KEY", group: "mimo", required: true, secret: true },
  { key: "MIMO_API_URL", group: "mimo", required: true },
  { key: "MIMO_ASR_MODEL", group: "mimo", required: true },
  { key: "MIMO_SUMMARY_MODEL", group: "mimo", required: true },

  { key: "DASHSCOPE_API_KEY", group: "bailianRealtime", required: true, secret: true },
  { key: "BAILIAN_WS_HOST", group: "bailianRealtime", required: true },
  { key: "BAILIAN_WORKSPACE", group: "bailianRealtime", required: true },

  { key: "ASR_MODEL", group: "bailianOptional", fallback: engines.defaults.asrModel },
  { key: "DIAR_MODEL", group: "bailianOptional", fallback: engines.defaults.diarModel },
];

/** 按分组列出缺失的变量，供启动告警用 */
function missingByGroup(env = process.env) {
  const result = new Map();
  for (const field of FIELDS) {
    if (!field.required) continue;
    if (env[field.key]) continue;
    if (!result.has(field.group)) result.set(field.group, []);
    result.get(field.group).push(field.key);
  }
  return result;
}

/** 生成与原实现逐字一致的告警行 */
function warningLines(env = process.env) {
  const lines = [];
  for (const [group, keys] of missingByGroup(env)) {
    lines.push(`警告: 未设置 ${keys.join(", ")}，${GROUPS[group]?.label || "相关功能不可用"}`);
  }
  return lines;
}

/** 该能力当前是否可用（不抛错，供路由/WS 做前置判断） */
function hasGroup(group, env = process.env) {
  for (const field of FIELDS) {
    if (field.group !== group || !field.required) continue;
    if (!env[field.key]) return false;
  }
  return true;
}

module.exports = { GROUPS, FIELDS, missingByGroup, warningLines, hasGroup };
