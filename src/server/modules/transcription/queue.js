/**
 * 串行队列：本机单用户，两个 ffmpeg + ASR 任务并行只会互相拖慢。
 */

const { runJob } = require("./job-runner");

let chain = Promise.resolve();

/** 追加到串行链尾；失败不会阻断后续任务 */
function enqueue(jobId, opts) {
  chain = chain
    .catch(() => {})
    .then(() => runJob(jobId, opts))
    .catch((e) => console.error(`[${jobId}] 队列执行异常: ${e.message}`));
  return chain;
}

module.exports = { enqueue };
