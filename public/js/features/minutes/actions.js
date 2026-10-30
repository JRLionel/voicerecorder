/**
 * 纪要动作：生成新版本（只追加）、自动生成、复制。
 *
 * 点「生成」时先放一个占位胶囊，避免用户以为没反应。
 */

import { API, postJson } from "../../core/api.js";
import { BUS, emit } from "../../core/bus.js";
import { state } from "../../core/store.js";
import { showError } from "../../core/toast.js";
import { openPicker } from "../templates/picker.js";
import {
  btnSummary, btnMinuteAdd, summaryLoading, summaryLoadingText, summaryBody, btnCopySummary,
} from "./refs.js";
import { hydrateMinutes, renderMinutesCard } from "./panel.js";

/** 复制文本：优先 Clipboard API，失败退回 execCommand */
export async function copyText(text, btn) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  }
  const original = btn.textContent;
  btn.textContent = "已复制";
  btn.classList.add("copied");
  setTimeout(() => {
    btn.textContent = original;
    btn.classList.remove("copied");
  }, 2000);
}

/**
 * 生成一份新纪要：只追加，不覆盖既有结果。
 */
export async function generateMinutesFlow(templateId) {
  if (!state.record) return showError("这条记录还没有转写结果");
  if (state.minutesBusy) return showError("正在生成纪要，请稍候");

  const tpl = state.templates.find((t) => t.id === templateId);
  const label = tpl ? tpl.name : "默认模板";
  const placeholder = {
    id: "__pending__",
    templateName: label,
    status: "generating",
    isCurrent: true,
    createdAt: new Date().toISOString(),
  };
  const had = state.minutes.length > 0;

  state.minutesBusy = true;
  if (had) {
    state.minutes = state.minutes.map((m) => ({ ...m, isCurrent: false })).concat(placeholder);
    state.minutesCurrent = { templateName: label, status: "generating" };
    renderMinutesCard();
  } else {
    summaryLoading.classList.add("show");
    summaryLoadingText.textContent = "正在生成会议纪要（分段摘要 → 合并，长会议需要几分钟）";
  }

  try {
    const data = await postJson(API.minutes, { recordId: state.record.id, templateId: templateId || null });
    if (!data.success) throw new Error(data.error || "生成纪要失败");

    state.minutes = state.minutes
      .filter((m) => m.id !== "__pending__")
      .map((m) => ({ ...m, isCurrent: false }));
    state.minutes.push({ ...data.minutes, isCurrent: true });
    state.minutesCurrent = {
      ...data.minutes,
      json: data.json,
      markdown: data.markdown,
      template: data.template,
    };
    if (data.minutes.templateId) {
      state.templateId = data.minutes.templateId;
      localStorage.setItem("vs_last_template_id", data.minutes.templateId);
    }
    if (state.record) {
      state.record.template_name = data.minutes.templateName;
      state.record.templateId = data.minutes.templateId;
    }
    renderMinutesCard();
    if (data.templateFellBack) {
      showError("所选模板已不存在，已改用默认模板生成");
    }
    emit(BUS.RECORDS_RELOAD);
  } catch (e) {
    state.minutes = state.minutes.filter((m) => m.id !== "__pending__");
    state.minutesCurrent = null;
    renderMinutesCard();
    if (state.minutes.length) hydrateMinutes(state.minutes);
    showError(e.message || "生成纪要失败");
  } finally {
    state.minutesBusy = false;
    summaryLoading.classList.remove("show");
  }
}

/** 首次生成：先选模板 */
export async function generateSummary() {
  if (!state.record) return showError("这条记录还没有转写结果");
  const tplId = await openPicker({
    selectedId: state.minutesCurrent?.templateId || state.record?.template_id || null,
    note: "会新增一份纪要，已有内容不会被覆盖",
  });
  if (!tplId) return;
  await generateMinutesFlow(tplId);
}

/** 录音结束等自动场景：不弹选择器，沿用上次使用的模板 */
export async function autoGenerateMinutes() {
  if (!state.record || state.minutes.length) return;
  await generateMinutesFlow(state.templateId || null);
}

export function initMinutesActions() {
  btnSummary.addEventListener("click", generateSummary);
  btnMinuteAdd.addEventListener("click", async () => {
    const tplId = await openPicker({
      selectedId: state.minutesCurrent?.templateId || state.record?.template_id || null,
      note: "新增一份，已有的纪要保持不变",
    });
    if (tplId) await generateMinutesFlow(tplId);
  });
  btnCopySummary.addEventListener("click", () => {
    const detail = state.minutesCurrent;
    copyText(detail?.markdown ? detail.markdown.trim() : summaryBody.innerText.trim(), btnCopySummary);
  });
}
