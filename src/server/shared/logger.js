/** 极简日志：统一前缀，便于启动/任务日志一眼分辨。 */

function line(level, args) {
  const stamp = new Date().toISOString().slice(11, 19);
  console[level](`[${stamp}]`, ...args);
}

module.exports = {
  info: (...args) => line("log", args),
  warn: (...args) => line("warn", args),
  error: (...args) => line("error", args),
  /** 带任务/会话前缀的日志器 */
  scope(prefix) {
    return {
      info: (...args) => line("log", [`[${prefix}]`, ...args]),
      warn: (...args) => line("warn", [`[${prefix}]`, ...args]),
      error: (...args) => line("error", [`[${prefix}]`, ...args]),
    };
  },
};
