/**
 * 启动流程：按固定顺序把「磁盘 → 表结构 → 内置数据 → 中断恢复 → 清理」跑一遍。
 *
 * 为什么集中在这里：require 期副作用会让测试与脚本无法控制时序；
 * 现在只有调用 runBootstrap() 才会动磁盘与数据库。
 */

const { ensureDirs } = require("./ensure-dirs");
const { migrate } = require("./migrate");
const { syncBuiltinTemplates } = require("./sync-builtin-templates");
const { recoverInterrupted } = require("./recover-interrupted");
const { cleanupOrphanJobs } = require("./cleanup-orphan-jobs");
const repos = require("../data/db/repositories");

function runBootstrap() {
  ensureDirs();

  const { migrated } = migrate();
  const builtinTemplates = syncBuiltinTemplates();

  const { runningRecordings, interrupted } = recoverInterrupted();
  const staleMinutes = repos.minutes.clearStaleGenerating();
  const orphans = cleanupOrphanJobs();

  return { migrated, builtinTemplates, runningRecordings, interrupted, staleMinutes, orphans };
}

module.exports = { runBootstrap };
