/**
 * 事件总线：只用于「反向依赖」。
 *
 * 例：记录列表要打开详情，但详情也要回列表刷新。
 * 正向依赖直接 import（detail → minutes → templates），
 * 反向依赖走事件，避免 ESM 循环。
 */

const handlers = new Map();

export function on(type, fn) {
  if (!handlers.has(type)) handlers.set(type, new Set());
  handlers.get(type).add(fn);
  return () => handlers.get(type)?.delete(fn);
}

export function emit(type, payload) {
  const set = handlers.get(type);
  if (!set) return;
  for (const fn of set) {
    try {
      fn(payload);
    } catch (e) {
      console.error(`[bus] ${type} 处理失败:`, e);
    }
  }
}

/** 事件名常量，避免字符串写错 */
export const BUS = {
  OPEN_DETAIL: "detail:open",
  RECORDS_RELOAD: "records:reload",
  WATCH_UPLOAD: "upload:watch",
  AUTO_MINUTES: "minutes:auto",
  TEMPLATES_CHANGED: "templates:changed",
  STOP_UPLOAD_POLL: "upload:stop-poll",
  RECORDS_RENDERED: "records:rendered",
};
