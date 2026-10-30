/**
 * 模态框：说明弹窗（openModal）与二次确认（confirmDialog）共用一套 DOM。
 */

import { $ } from "../core/dom.js";
import { escapeHtml } from "../core/format.js";
import { copy } from "../core/meta.js";
import { lockScroll } from "../core/scroll-lock.js";
import { state } from "../core/store.js";

const modalBackdrop = $("#modalBackdrop");
const modalTitle = $("#modalTitle");
const modalBody = $("#modalBody");
const modalOk = $("#modalOk");
const modalCancel = $("#modalCancel");

let modalResolve = null;

function isOpen() {
  return Boolean(document.querySelector(".modal-backdrop:not([hidden])"));
}

/** 说明弹窗：只有「知道了」一个按钮 */
export function openModal(kind) {
  const text = (copy().modals || {})[kind];
  if (!text) return;
  if (isOpen()) return; // 防重复实例

  modalTitle.textContent = text.title;
  modalBody.innerHTML = text.body
    .split("\n\n")
    .map((p) => `<span class="modal-p">${escapeHtml(p)}</span>`)
    .join("");
  modalCancel.hidden = true;
  modalOk.className = "btn btn-primary";
  modalOk.textContent = "知道了";
  state.lastFocus = document.activeElement;
  modalBackdrop.hidden = false;
  lockScroll(true);
  modalOk.focus();
}

/** 二次确认弹窗，返回 Promise<boolean> */
export function confirmDialog({ title, body, okText = "确定" }) {
  if (isOpen()) return Promise.resolve(false);

  modalTitle.textContent = title;
  modalBody.innerHTML = `<span class="modal-p">${escapeHtml(body)}</span>`;
  modalCancel.hidden = false;
  modalOk.className = "btn btn-danger";
  modalOk.textContent = okText;
  state.lastFocus = document.activeElement;
  modalBackdrop.hidden = false;
  lockScroll(true);
  modalCancel.focus();

  return new Promise((resolve) => {
    modalResolve = resolve;
  });
}

export function closeModal(result = false) {
  if (!modalBackdrop || modalBackdrop.hidden) return;
  modalBackdrop.hidden = true;
  lockScroll(false);
  modalCancel.hidden = true;
  if (state.lastFocus && typeof state.lastFocus.focus === "function") {
    state.lastFocus.focus();
  }
  state.lastFocus = null;

  const resolve = modalResolve;
  modalResolve = null;
  if (resolve) resolve(result);
}

/** 绑定默认交互：按钮、遮罩点击、Esc 关闭 */
export function initModal() {
  modalOk.addEventListener("click", () => closeModal(true));
  modalCancel.addEventListener("click", () => closeModal(false));
  modalBackdrop.addEventListener("click", (e) => {
    if (e.target === modalBackdrop) closeModal(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal(false);
  });
}
