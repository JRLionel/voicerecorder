/** 带指数退避的重试：三份重复实现合并后的唯一版本。 */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {(attempt:number)=>Promise<any>} fn
 * @param {object} opts
 * @param {number} [opts.retries=2]        额外重试次数（总尝试 = retries + 1）
 * @param {number} [opts.baseMs=1000]      退避基数
 * @param {(err:Error)=>boolean} [opts.isFatal] 命中则立即抛出，不重试（凭证/权限类错误）
 * @param {(lastErr:Error)=>Error} [opts.onFail] 用尽重试后的错误包装
 */
async function retry(fn, { retries = 2, baseMs = 1000, isFatal, onFail } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (isFatal && isFatal(err)) throw err;
      if (attempt < retries) await sleep(baseMs * 2 ** attempt);
    }
  }
  if (onFail) throw onFail(lastErr);
  throw lastErr;
}

/** 凭证/权限类错误重试没有意义 */
const AUTH_FATAL = /401|403|InvalidApiKey|invalid_api_key|Forbidden|AccessDenied|ModelNotOpen/i;

module.exports = { retry, sleep, AUTH_FATAL };
