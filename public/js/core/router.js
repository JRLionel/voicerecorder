/**
 * 视图路由：控制 5 个 <main> 的显隐，并提供切换钩子。
 *
 * 钩子替代了改造前散落的「切视图时顺手做点别的」：
 * 记录列表注册 updateSelBar，纪要面板注册 stopMinutesPoll。
 */

import { $ } from "./dom.js";
import { state } from "./store.js";

const views = {
  home: $("#viewHome"),
  new: $("#viewNew"),
  rec: $("#viewRec"),
  detail: $("#viewDetail"),
  templates: $("#viewTemplates"),
};

const listeners = new Set();
let beforeLeave = null;

/** 注册视图切换钩子，返回解绑函数 */
export function onViewChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 离开前拦截（目前只有「录音中离开」用到） */
export function setBeforeLeave(fn) {
  beforeLeave = fn;
}

/**
 * @param {string} name
 * @param {{force?: boolean, scroll?: boolean}} opts force=true 时跳过 beforeLeave
 * @returns {boolean} 是否完成切换
 */
export function switchView(name, { force = false, scroll = true } = {}) {
  if (!force && beforeLeave && beforeLeave(name) === false) return false;

  state.view = name;
  for (const [key, el] of Object.entries(views)) {
    if (el) el.hidden = key !== name;
  }
  for (const fn of listeners) fn(name);
  if (scroll) window.scrollTo({ top: 0 });
  return true;
}

/** 当前可见视图 */
export function currentView() {
  return state.view;
}
