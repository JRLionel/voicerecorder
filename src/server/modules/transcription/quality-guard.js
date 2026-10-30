/**
 * 字率护栏：实测 MIMO 截断时只会吐 5~10 个字，与音频长短无关。
 * 低于正常语速的片改走百炼流式兜底，而不是直接把空文本落库。
 */

const { limits } = require("../../data");
const { charCount } = require("../../shared/utils/text");

const MIN_CHAR_RATE = limits.transcribe.minCharRate;

function looksDegenerate(text, sec) {
  const chars = charCount(text);
  const { degenerateMinSec, degenerateMaxChars } = limits.transcribe;
  if (!chars) return true;
  if (sec >= degenerateMinSec && chars <= degenerateMaxChars) return true; // 典型截断
  if (sec >= degenerateMinSec && chars / sec < MIN_CHAR_RATE) return true;  // 明显低于正常语速
  return false;
}

module.exports = { looksDegenerate, MIN_CHAR_RATE };
