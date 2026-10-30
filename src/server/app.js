/**
 * Express 装配：只做「挂载」，不碰磁盘、不读环境变量、不启动服务。
 *
 * 这样 app 可以被测试直接 require，也可以被自定义入口复用。
 */

const express = require("express");

const config = require("./config");
const routes = require("./routes");

function createApp() {
  const app = express();

  app.use(express.json({ limit: config.http.jsonLimit }));
  app.use(express.static(config.paths.publicDir));

  routes.register(app);

  // 错误中间件必须最后挂
  app.use(routes.errorHandler);

  return app;
}

module.exports = { createApp };
