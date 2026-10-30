/**
 * 音频播放：点时间戳跳转，播放时高亮当前分段。
 */

import { $, $$ } from "../../core/dom.js";

const playerBar = $("#playerBar");
const player = $("#player");

export function seekTo(ms) {
  if (playerBar.hidden || !player.src) return;
  player.currentTime = Math.max(0, ms / 1000);
  player.play().catch(() => {});
}

export function pausePlayer() {
  try {
    player.pause();
  } catch {}
}

export function initPlayer() {
  player.addEventListener("timeupdate", () => {
    const ms = player.currentTime * 1000;
    let active = null;
    for (const row of $$(".seg-row")) {
      if (Number(row.dataset.ms) <= ms) active = row;
      else break;
    }
    $$(".seg-row").forEach((r) => r.classList.toggle("is-active", r === active));
  });
}

export { playerBar, player };
