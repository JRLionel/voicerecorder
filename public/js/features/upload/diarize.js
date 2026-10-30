/**
 * 「区分说话人」开关：开启后走离线分离通道，超过上限直接拦住。
 *
 * 上限与文案来自 /api/meta（服务端 shared/constants/limits.json），前端不再写死 2 小时。
 */

import { $ } from "../../core/dom.js";
import { limits } from "../../core/meta.js";
import { state } from "../../core/store.js";
import { openModal } from "../../components/modal.js";

const diarizationCard = $("#diarizationCard");
const diarSwitch = $("#diarSwitch");
const diarExtra = $("#diarExtra");
const diarTips = $("#diarTips");
const speakerCountSel = $("#speakerCount");

const DEFAULT_TIP = "自动标出每句话由谁说出。开启后走离线分离，处理时间略长";

function maxDiarizeSec() {
  return (limits().diarize && limits().diarize.maxDurationSec) || 7200;
}

/** 超过上限就不能开：与其跑到一半失败，不如在选择文件后就拦住 */
export function diarizeBlocked() {
  return Boolean(state.fileDuration && state.fileDuration > maxDiarizeSec());
}

export function refreshDiarizeAvailability() {
  const blocked = diarizeBlocked();
  diarizationCard.classList.toggle("is-disabled", blocked);
  diarizationCard.setAttribute("aria-disabled", blocked ? "true" : "false");
  if (blocked && state.diarize) setDiarize(false, { silent: true });
  diarTips.textContent = blocked
    ? `文件超过 ${maxDiarizeSec() / 3600} 小时，开启分离前请先裁剪`
    : DEFAULT_TIP;
}

export function setDiarize(on, { silent = false } = {}) {
  if (on && diarizeBlocked()) {
    if (!silent) openModal("diarLimit");
    return;
  }
  state.diarize = Boolean(on);
  diarSwitch.classList.toggle("is-off", !state.diarize);
  diarSwitch.classList.toggle("is-on", state.diarize);
  diarizationCard.setAttribute("aria-pressed", state.diarize ? "true" : "false");
  diarExtra.hidden = !state.diarize;
  if (!state.diarize) {
    state.speakerCount = null;
    if (speakerCountSel) speakerCountSel.value = "";
  }
}

function toggleDiarize() {
  if (diarizeBlocked()) return openModal("diarLimit");
  setDiarize(!state.diarize);
}

export function initDiarize() {
  diarizationCard.addEventListener("click", toggleDiarize);
  diarizationCard.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggleDiarize();
    }
  });
  if (speakerCountSel) {
    speakerCountSel.addEventListener("click", (e) => e.stopPropagation());
    speakerCountSel.addEventListener("change", () => {
      state.speakerCount = Number(speakerCountSel.value) || null;
    });
  }
}
