/**
 * 事务：唯一允许发 BEGIN / COMMIT 的地方。
 *
 * node:sqlite 的 DatabaseSync 不支持嵌套事务，
 * 所以约定仓储层只接受外部传入的连接、绝不自己开事务。
 */

const { getDb } = require("./connection");

function withTransaction(fn, db = getDb()) {
  db.exec("BEGIN");
  try {
    const result = fn(db);
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw err;
  }
}

module.exports = { withTransaction };
