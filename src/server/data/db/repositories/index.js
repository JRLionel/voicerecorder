/** 仓储聚合：按表导出，供 data/index.js 与业务层使用。 */

module.exports = {
  records: require("./records.repo"),
  jobs: require("./jobs.repo"),
  segments: require("./segments.repo"),
  speakers: require("./speakers.repo"),
  markers: require("./markers.repo"),
  templates: require("./templates.repo"),
  minutes: require("./minutes.repo"),
};
