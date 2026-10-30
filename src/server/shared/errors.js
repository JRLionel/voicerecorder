/**
 * 统一错误类型。
 *
 * 路由层只认两件事：err.status（HTTP 码）与 err.code（给前端的稳定错误码）。
 * 具体的领域错误继承 AppError，保持各自的构造签名不变。
 */

class AppError extends Error {
  constructor(message, { code = undefined, status = 400, cause = undefined } = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    if (cause) this.cause = cause;
  }
}

/** 模板相关：重名 409，系统模板锁定 403，其余校验 400 */
class TemplateError extends AppError {
  constructor(code, message) {
    const status = code === "TEMPLATE_NAME_TAKEN" ? 409 : code === "TEMPLATE_BUILTIN_LOCKED" ? 403 : 400;
    super(message, { code, status });
  }
}

/** 纪要动作 */
class MinutesError extends AppError {
  constructor(code, message, status = 400) {
    super(message, { code, status });
  }
}

/** 参数不合法（400） */
function badRequest(message, code = undefined) {
  return new AppError(message, { code, status: 400 });
}

/** 资源不存在（404） */
function notFound(message = "资源不存在", code = undefined) {
  return new AppError(message, { code, status: 404 });
}

module.exports = { AppError, TemplateError, MinutesError, badRequest, notFound };
