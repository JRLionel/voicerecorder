/**
 * HTTP 响应的唯一出口。
 *
 * 全站成功响应统一为 { success: true, ...payload }，失败为 { success: false, error, code }。
 */

function ok(res, payload = {}) {
  return res.json({ success: true, ...payload });
}

/** 统一错误出口：客户端只看到可读文案与错误码，不打堆栈 */
function fail(res, err) {
  const status = err && err.status ? err.status : 500;
  if (status >= 500) console.error("接口失败:", err && err.message);
  return res.status(status).json({
    success: false,
    error: (err && err.message) || "服务异常",
    code: (err && err.code) || undefined,
  });
}

/** 简单的失败响应（参数校验这类就地返回） */
function bad(res, message, code = undefined) {
  return res.status(400).json({ success: false, error: message, code });
}

function missing(res, message = "资源不存在") {
  return res.status(404).json({ success: false, error: message });
}

/** 包一层 Promise，异常交给 express 错误中间件 */
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

module.exports = { ok, fail, bad, missing, asyncHandler };
