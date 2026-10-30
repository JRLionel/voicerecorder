/**
 * 上传前置校验：时长超限要立刻拒绝，而不是等任务跑到一半才失败。
 *
 * 拒绝时顺手删掉临时文件，避免 uploads/ 里堆垃圾。
 */

const fs = require("node:fs");

const { probe } = require("../audio");
const { limits } = require("../../data");
const { AppError } = require("../../shared/errors");

const MAX_DURATION_SEC = limits.upload.maxDurationSec;
const MAX_DIARIZE_SEC = limits.diarize.maxDurationSec;
const MIN_DURATION_SEC = limits.upload.minDurationSec;

function reject(srcPath, message) {
  try {
    if (fs.existsSync(srcPath)) fs.unlinkSync(srcPath);
  } catch {}
  return new AppError(message, { status: 400 });
}

/**
 * @returns {Promise<object>} probe 结果
 * @throws {AppError} 400，文件已删除
 */
async function probeAndValidate(srcPath, { diarize = false } = {}) {
  const meta = await probe(srcPath);

  if (meta.durationSec > MAX_DURATION_SEC) {
    throw reject(
      srcPath,
      `音频时长 ${(meta.durationSec / 3600).toFixed(1)} 小时，超过 ${MAX_DURATION_SEC / 3600} 小时上限，请先裁剪`
    );
  }
  if (!meta.durationSec || meta.durationSec < MIN_DURATION_SEC) {
    throw reject(srcPath, "音频时长不足 1 秒，无法转写");
  }
  // 开启分离后官方建议 ≤2h，宁可前置拦截，也别让用户等十分钟再失败
  if (diarize && meta.durationSec > MAX_DIARIZE_SEC) {
    throw reject(srcPath, `开启说话人分离时音频上限 ${MAX_DIARIZE_SEC / 3600} 小时，请先裁剪或关闭开关`);
  }

  return meta;
}

module.exports = { probeAndValidate, MAX_DURATION_SEC, MAX_DIARIZE_SEC };
