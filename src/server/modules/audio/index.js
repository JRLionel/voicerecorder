/**
 * 音频域门面：探测、转码、静音切点、录音落盘。
 *
 * 调用方只 require 本文件，内部文件可以继续细分。
 */

const { run } = require("./ffmpeg");
const { probe } = require("./probe");
const { extractWav, slicePcm, sliceMp3, toPcm } = require("./transcode");
const { findSilences, planCuts, isSilentRange } = require("./silence");
const { RecordingSink, HEADER_BYTES } = require("./wav-writer");
const { fmtTime } = require("../../shared/utils/time");

module.exports = {
  run, probe,
  extractWav, slicePcm, sliceMp3, toPcm,
  findSilences, planCuts, isSilentRange,
  RecordingSink, HEADER_BYTES,
  fmtTime,
};
