/**
 * 说话人改名：就地编辑 chip，Enter 保存 / Esc 取消。
 *
 * 改名会同步到该任务的所有分段（服务端做），前端重新拉一次详情即可。
 */

import { $ } from "../../core/dom.js";
import { API, jsonFetch, postJson } from "../../core/api.js";
import { showError } from "../../core/toast.js";
import { state } from "../../core/store.js";

const segList = $("#segList");

/**
 * @param {HTMLElement} chip
 * @param {{onSaved?: Function}} opts onSaved：改名成功后重新加载详情
 */
export function startSpeakerRename(chip, { onSaved } = {}) {
  const localId = chip.dataset.local;
  if (!localId || !state.job) return;

  const old = chip.textContent;
  const input = document.createElement("input");
  input.className = "spk-input";
  input.value = old;
  input.setAttribute("aria-label", "修改说话人名称");
  chip.replaceWith(input);
  input.focus();
  input.select();

  let settled = false;
  const finish = async (save) => {
    if (settled) return;
    settled = true;
    const value = input.value.trim();
    if (!save || !value || value === old) {
      input.replaceWith(chip);
      return;
    }

    const data = await postJson(API.jobSpeakers(state.job.id), { localId, label: value }, "PATCH");
    if (!data.success) {
      showError(data.error || "改名失败");
      input.replaceWith(chip);
      return;
    }
    if (onSaved) await onSaved();
    showError("名称已更新，已有纪要需要重新生成才会用上新名字");
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));
}

/** 转写区点击：时间戳跳转 / 点 chip 改名 */
export function initTranscriptInteractions({ seekTo, onReload }) {
  segList.addEventListener("click", (e) => {
    const ts = e.target.closest(".seg-ts") || e.target.closest(".marker-ts");
    if (ts) return seekTo(Number(ts.dataset.ms));

    const chip = e.target.closest(".spk-chip");
    if (chip) return startSpeakerRename(chip, { onSaved: onReload });
  });
}

export { segList };
