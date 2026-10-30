/**
 * 弹层滚动锁：支持多层叠加（模态框上再开浮层）。
 */

let layerCount = 0;

export function lockScroll(on) {
  layerCount = Math.max(0, layerCount + (on ? 1 : -1));
  document.body.style.overflow = layerCount ? "hidden" : "";
}
