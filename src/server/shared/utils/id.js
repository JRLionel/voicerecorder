/** 主键生成：前缀 + 随机十六进制，与既有 id 形态保持一致。 */

const crypto = require("node:crypto");

function newId(prefix, bytes = 6) {
  return `${prefix}_${crypto.randomBytes(bytes).toString("hex")}`;
}

module.exports = { newId };
