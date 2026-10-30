/**
 * 上传受理：multer 落盘 + 扩展名白名单 + 中文文件名还原。
 */

const multer = require("multer");
const path = require("node:path");
const crypto = require("node:crypto");

const config = require("../../config");
const { limits, media } = require("../../data");
const { decodeFilename } = require("../../shared/utils/text");

const ALLOWED_EXTENSIONS = new Set([
  ...media.acceptedExtensions.audio,
  ...media.acceptedExtensions.video,
]);

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, config.paths.uploadsDir),
    filename: (req, file, cb) => {
      const ext = path.extname(decodeFilename(file.originalname)).toLowerCase() || ".bin";
      cb(null, `up_${Date.now()}_${crypto.randomBytes(4).toString("hex")}${ext}`);
    },
  }),
  limits: { fileSize: limits.upload.maxBytes },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(decodeFilename(file.originalname)).toLowerCase();
    if (ALLOWED_EXTENSIONS.has(ext)) return cb(null, true);
    cb(new Error(`不支持的文件格式：${ext || "(无扩展名)"}。支持 ${[...ALLOWED_EXTENSIONS].join(" / ")}`));
  },
});

/** file input 的 accept 串（前端也用这份定义） */
const ACCEPT = media.accept;

module.exports = { upload, ALLOWED_EXTENSIONS, ACCEPT, decodeFilename };
