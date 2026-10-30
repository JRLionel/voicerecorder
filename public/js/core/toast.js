/** 顶部错误条：全站唯一的轻量提示。 */

import { $ } from "./dom.js";

let errorEl = null;

function el() {
  if (!errorEl) errorEl = $("#error");
  return errorEl;
}

export function showError(msg) {
  const node = el();
  if (!node) return;
  node.textContent = msg;
  node.classList.add("show");
  clearTimeout(showError.timer);
  showError.timer = setTimeout(() => node.classList.remove("show"), 6000);
}

/* ============================================================
   轻提示 Toast：屏幕顶部居中滑入，2.6s 后自动消失
   ============================================================ */

const TOAST_MS = 2600;

let toastEl = null;
let toastTimer = null;

function toastNode() {
  if (!toastEl) toastEl = $("#toast");
  return toastEl;
}

/**
 * 顶部滑入一条提示。
 * @param {string} msg 文案
 * @param {{ icon?: string, duration?: number }} opts
 */
export function showToast(msg, opts = {}) {
  const node = toastNode();
  if (!node) return;
  const icon = opts.icon || checkIcon;
  node.innerHTML = `${icon}<span></span>`;
  node.querySelector("span").textContent = msg;
  node.hidden = false;
  node.classList.remove("is-out");
  // 重放入场动画：先摘掉离场态再强制回流
  void node.offsetWidth;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.classList.add("is-out");
    toastTimer = setTimeout(() => {
      node.hidden = true;
      node.classList.remove("is-out");
    }, 240);
  }, opts.duration || TOAST_MS);
}

const checkIcon =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m4 12.5 5 5L20 6.5"/></svg>';
