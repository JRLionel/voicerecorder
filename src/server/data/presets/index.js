/**
 * 内置静态数据总入口。
 *
 * 这些内容随版本发布，不来自数据库、不来自环境变量；
 * 启动时按 id 幂等写入数据库（见 bootstrap/sync-builtin-templates.js）。
 */

const minutesTemplates = require("./minutes-templates");

const defaultMinutesTemplate = minutesTemplates.find((tpl) => tpl.builtin && tpl.id === "tpl_default") || minutesTemplates[0];

module.exports = Object.freeze({
  minutesTemplates,
  defaultMinutesTemplate,
  defaultMinutesTemplateId: defaultMinutesTemplate.id,
});
