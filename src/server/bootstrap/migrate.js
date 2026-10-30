/**
 * 表结构迁移：打开连接即幂等补齐（建表 + 补列），
 * 再把历史 summary_json 迁成独立纪要行。
 */

const { getDb } = require("../data/db/connection");
const { migrateLegacySummaries } = require("../modules/minutes/legacy-migration");

function migrate() {
  getDb(); // 触发 applySchema（CREATE TABLE IF NOT EXISTS + ALTER TABLE 补列）
  let migrated = 0;
  try {
    migrated = migrateLegacySummaries();
  } catch (err) {
    console.error("历史纪要迁移失败:", err.message);
  }
  return { migrated };
}

module.exports = { migrate };
