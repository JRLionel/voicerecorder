/**
 * 模板域门面：定义、校验、提示词、展示转换。
 *
 * 本域是纯逻辑，不触碰数据库与网络，便于单测；
 * 内置模板的「定义」在 data/presets/minutes-templates/ 下。
 */

const { presets } = require("../../data");
const schema = require("./schema");
const prompt = require("./prompt");
const presenter = require("./presenter");

module.exports = {
  DEFAULT_TEMPLATE_ID: presets.defaultMinutesTemplateId,
  DEFAULT_TEMPLATE: presets.defaultMinutesTemplate,
  BUILTIN_TEMPLATES: presets.minutesTemplates,
  ...schema,
  ...prompt,
  ...presenter,
};
