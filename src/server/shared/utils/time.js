/** 时间与时长格式化。 */

function nowIso() {
  return new Date().toISOString();
}

/** 秒 → hh:mm:ss（用于时间轴、提示词里的 [时:分:秒]） */
function fmtTime(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = String(Math.floor(s / 3600)).padStart(2, "0");
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${h}:${m}:${ss}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { nowIso, fmtTime, sleep };
