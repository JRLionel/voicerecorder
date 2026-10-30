/**
 * 内置模板同步：把 data/presets/minutes-templates 下的定义按 id 幂等写入。
 *
 * 只改定义，不动用户复制出来的副本，所以升级后「我的模板」不会被覆盖。
 */

const { ensureBuiltinTemplates } = require("../modules/templates/service");

function syncBuiltinTemplates() {
  return ensureBuiltinTemplates();
}

module.exports = { syncBuiltinTemplates };
