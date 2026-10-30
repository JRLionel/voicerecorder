/**
 * 进程入口：读配置 → 启动自检 → 装配 app → 挂 WS → 监听。
 *
 * 顺序不能颠倒：bootstrap 必须在 listen 之前完成，否则首个请求可能撞上还没建好的表。
 */

require("dotenv").config();

const http = require("node:http");

const config = require("./config");
const { createApp } = require("./app");
const { runBootstrap } = require("./bootstrap");
const { attachRealtime } = require("./modules/recording");

function logBootstrap(report) {
  if (report.interrupted) {
    console.log(`发现 ${report.interrupted} 个上次未完成的任务，可在详情页点「继续处理」续跑`);
  }
  if (report.runningRecordings) {
    console.log(`清理了 ${report.runningRecordings} 个中断的录音会话（半截音频已删除，标记保留）`);
  }
  if (report.staleMinutes) {
    console.log(`清理了 ${report.staleMinutes} 条中断的纪要生成`);
  }
  if (report.migrated) {
    console.log(`迁移了 ${report.migrated} 条历史纪要为独立记录`);
  }
  if (report.orphans) {
    console.log(`清理了 ${report.orphans} 个无用任务目录`);
  }
}

function main() {
  logBootstrap(runBootstrap());

  const server = http.createServer(createApp());
  attachRealtime(server);

  server.listen(config.port, "127.0.0.1", () => {
    console.log(`服务器运行在 http://127.0.0.1:${config.port}`);
    for (const line of config.warningLines()) console.warn(line);
  });

  return server;
}

if (require.main === module) main();

module.exports = { main };
