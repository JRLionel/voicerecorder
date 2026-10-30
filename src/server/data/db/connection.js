/**
 * SQLite 连接（单例）。
 *
 * node:sqlite 的 DatabaseSync 是同步 API，本机单用户场景不需要连接池。
 * 首次取连接时建立文件并幂等补齐表结构：这样任何入口（服务、脚本、测试）
 * 都不需要额外记着「先建表」。
 */

const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");

const config = require("../../config");
const schema = require("./schema");

let handle = null;

function open() {
  fs.mkdirSync(config.paths.dataDir, { recursive: true });
  const db = new DatabaseSync(config.paths.dbFile);
  db.exec("PRAGMA journal_mode = WAL;");
  schema.applySchema(db);
  return db;
}

function getDb() {
  if (!handle) handle = open();
  return handle;
}

/** 仅供测试/迁移脚本：关闭并释放单例 */
function closeDb() {
  if (!handle) return;
  try {
    handle.close();
  } catch {}
  handle = null;
}

module.exports = { getDb, closeDb };
