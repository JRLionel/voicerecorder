const { media } = require("../../data");
const { run } = require("./ffmpeg");

const SILENCE = media.silence;

/** 静音检测与切点规划：把硬切改成「切在静音中点」，避免切断词。 */

async function findSilences(wavPath, { noiseDb = SILENCE.noiseDb, minDur = SILENCE.minDurSec, totalSec = 0 } = {}) {
  const { err } = await run("ffmpeg", [
    "-hide_banner", "-nostats",
    "-i", wavPath,
    "-af", `silencedetect=noise=${noiseDb}dB:d=${minDur}`,
    "-f", "null", "-",
  ]);

  const re = /silence_(start|end):\s*(-?\d+(?:\.\d+)?)/g;
  const silences = [];
  let cur = null;
  let m;
  while ((m = re.exec(err)) !== null) {
    const val = parseFloat(m[2]);
    if (m[1] === "start") {
      cur = { start: val, end: null };
    } else if (cur) {
      cur.end = val;
      silences.push(cur);
      cur = null;
    }
  }
  if (cur) silences.push({ start: cur.start, end: totalSec || cur.start });
  return silences.filter((s) => s.end - s.start >= minDur * 0.8);
}

/**
 * 在静音点附近选切分位置，避免硬切切断词。
 * 每片目标时长 targetSec，允许在 ±targetSec*0.35 窗口内找最近的静音中点。
 * 最小间距按 targetSec 的比例算，不写死秒数（否则 30s 目标永远找不到合用的静音点）。
 */

function planCuts(totalSec, targetSec, silences = []) {
  if (totalSec <= targetSec * 1.2) return [0, totalSec];

  const cuts = [0];
  const window = targetSec * SILENCE.cutWindowRatio;
  const minGap = Math.max(SILENCE.minCutGapSec, targetSec * SILENCE.minCutGapRatio);
  let target = targetSec;

  while (target < totalSec - Math.max(5, targetSec * 0.5)) {
    let best = null;
    for (const s of silences) {
      const mid = (s.start + (s.end ?? s.start)) / 2;
      if (mid <= cuts[cuts.length - 1] + minGap) continue;
      if (mid < target - window || mid > target + window) continue;
      const dist = Math.abs(mid - target);
      if (!best || dist < best.dist) best = { mid, dist };
    }
    const cut = best ? best.mid : target;
    if (cut > cuts[cuts.length - 1] + minGap * 0.6) cuts.push(cut);
    target = cut + targetSec;
  }

  cuts.push(totalSec);
  return cuts;
}

/** 从 wav 切片出裸 PCM（s16le），供流式接口直接发送 */

function isSilentRange(silences, start, end, toleranceSec = SILENCE.toleranceSec) {
  return silences.some(
    (s) => s.start <= start + toleranceSec && (s.end ?? end) >= end - toleranceSec
  );
}

module.exports = { findSilences, planCuts, isSilentRange };
