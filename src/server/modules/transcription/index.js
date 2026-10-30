/**
 * 转写域门面。
 */

const { JOBS_DIR, jobDir } = require("./workspace");
const { enqueue } = require("./queue");
const { cancel } = require("./controls");
const { runJob } = require("./job-runner");
const { detectSourceType } = require("./source-type");
const { planChunks, CHUNK_SEC } = require("./chunk-plan");
const { MAX_DIARIZE_SEC, SPEAKER_COLORS } = require("./diarize-runner");
const { persistRecord } = require("./persist-record");
const { stripExt } = require("../../shared/utils/text");

module.exports = {
  JOBS_DIR, CHUNK_SEC, MAX_DIARIZE_SEC, SPEAKER_COLORS,
  enqueue, cancel, jobDir, detectSourceType, stripExt, runJob,
  planChunks, persistRecord,
};
