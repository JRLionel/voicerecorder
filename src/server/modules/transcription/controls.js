/** 取消控制：jobId -> { canceled }。 */

const { jobs: jobsRepo } = require("../../data/db/repositories");

/** jobId -> { canceled: boolean } */
const controls = new Map();

function isCanceled(jobId) {
  return controls.get(jobId)?.canceled === true;
}

/** 从文件名推断 source_type */

function cancel(jobId) {
  const c = controls.get(jobId);
  if (c) c.canceled = true;
  else updateJob(jobId, { status: "canceled", stage: "CANCELED", error: "已取消" });
  return getJob(jobId);
}

module.exports = { controls, isCanceled, cancel };
