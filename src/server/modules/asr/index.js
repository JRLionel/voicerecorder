/**
 * 识别域门面：三条通道 + OSS 直传 + 分离质量判定。
 *
 * 通道之间互不依赖，调度（切片/兜底/整文件）在 transcription 模块里。
 */

const { transcribeFile } = require("./mimo.client");
const { transcribePcm, transcribeOnce } = require("./bailian-stream.client");
const {
  DEFAULT_MODEL, submitTranscription, pollTask, fetchTranscription, withRetry, diarizeFile,
} = require("./bailian-filetrans.client");
const { getUploadPolicy, uploadToOss } = require("./oss-uploader");
const { normalizeSentences, analyzeDiarization } = require("./diarization-quality");

module.exports = {
  transcribeFile,
  transcribePcm, transcribeOnce,
  diarizeFile,
  getUploadPolicy, uploadToOss,
  submitTranscription, pollTask, fetchTranscription,
  normalizeSentences, analyzeDiarization,
  withRetry, DEFAULT_MODEL,
};
