/**
 * 上传受理域门面。
 */

const { upload, ALLOWED_EXTENSIONS, ACCEPT, decodeFilename } = require("./upload.middleware");
const { probeAndValidate, MAX_DURATION_SEC, MAX_DIARIZE_SEC } = require("./validate-file");
const { createJobFromUpload } = require("./service");

module.exports = {
  upload,
  ALLOWED_EXTENSIONS,
  ACCEPT,
  decodeFilename,
  probeAndValidate,
  createJobFromUpload,
  MAX_DURATION_SEC,
  MAX_DIARIZE_SEC,
};
