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
