/** DOM 便捷方法：全站唯一的查询入口。 */

export const $ = (sel) => document.querySelector(sel);
export const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/** 绑定事件，返回解绑函数 */
export function on(el, type, handler, options) {
  if (!el) return () => {};
  el.addEventListener(type, handler, options);
  return () => el.removeEventListener(type, handler, options);
}

/** 事件委托：只在容器上绑一次 */
export function delegate(el, type, selector, handler) {
  return on(el, type, (event) => {
    const target = event.target.closest(selector);
    if (target && el.contains(target)) handler(event, target);
  });
}

/** 短暂高亮某个元素（录音页跳转定位用） */
export function flash(el, className = "is-hit", ms = 900) {
  if (!el) return;
  el.classList.add(className);
  setTimeout(() => el.classList.remove(className), ms);
}
