/** 任务参数：options_json 的容错解析。 */

function parseOptions(job) {
  try {
    return JSON.parse(job.options_json || "{}") || {};
  } catch {
    return {};
  }
}

/**
 * 转写单个切片：先 MIMO，退化则用百炼流式兜底。
 * 两条路都不通才判失败，避免一片失败拖垮整个任务。
 */

module.exports = { parseOptions };
