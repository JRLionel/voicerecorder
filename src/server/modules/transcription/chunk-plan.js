/**
 * 切片规划：30 秒一片，切点对齐静音中点。
 *
 * 整段静音片单独标记，转写阶段直接落空文本，不调用模型。
 */

const audio = require("../audio");
const { limits } = require("../../data");

const CHUNK_SEC = limits.transcribe.chunkSec;

async function planChunks(wavPath, totalSec) {
  // 默认阈值来自 media.silence（-35dB / 0.6s），与改造前调用参数一致
  const silences = await audio.findSilences(wavPath, { totalSec });
  const cuts = audio.planCuts(totalSec, CHUNK_SEC, silences);
  const chunks = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const start = cuts[i];
    const end = cuts[i + 1];
    if (end - start < limits.transcribe.minChunkSec) continue;
    chunks.push({
      idx: i,
      start,
      end,
      silent: audio.isSilentRange(silences, start, end),
    });
  }
  return chunks;
}

module.exports = { planChunks, CHUNK_SEC };
