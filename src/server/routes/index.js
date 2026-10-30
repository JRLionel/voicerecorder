/**
 * 路由注册表：新增一个接口域只需要在这里加一行。
 */

const { router: jobsRouter, errorHandler } = require("./jobs.routes");
const { router: recordsRouter } = require("./records.routes");
const { router: minutesRouter } = require("./minutes.routes");
const { router: templatesRouter } = require("./templates.routes");
const { router: legacyRouter } = require("./legacy.routes");
const { router: metaRouter } = require("./meta.routes");

const ROUTERS = [
  metaRouter,
  // 模板与纪要要先于记录注册：/api/records/:id/minutes 需要独立匹配
  templatesRouter,
  minutesRouter,
  legacyRouter,
  jobsRouter,
  recordsRouter,
];

function register(app) {
  for (const router of ROUTERS) app.use(router);
  return app;
}

module.exports = { register, ROUTERS, errorHandler };
