/** 阶段推进：写 stage + progress。 */

const { jobs: jobsRepo } = require("../../data/db/repositories");

function setStage(jobId, stage, progress) {
  updateJob(jobId, { stage, progress });
}

module.exports = { setStage };
