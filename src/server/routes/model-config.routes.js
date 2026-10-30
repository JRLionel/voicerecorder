/**
 * 模型配置接口：把 .env 里的默认服务地址与模型 ID 交给浏览器做预填，
 * 以及「测试连接」的真检测。
 *
 * 密钥不下发：浏览器留空即表示沿用服务端 .env 的配置。
 */

const express = require("express");

const modelConfig = require("../modules/model-config");
const { probe } = require("../modules/model-config/probe");
const { ok, bad } = require("../shared/http");

const router = express.Router();

router.get("/api/model-config", (req, res) =>
  ok(res, {
    defaults: modelConfig.publicDefaults(),
    scopes: modelConfig.SCOPES.map((id) => ({ id, ...modelConfig.SCOPE_META[id] })),
  })
);

/**
 * 测试连接：拿表单里的当前值（可能还没保存）真发一次请求。
 * body: { scope, url?, key?, model? }
 */
router.post("/api/model-config/test", async (req, res) => {
  const { scope, url, key, model } = req.body || {};
  if (!modelConfig.SCOPES.includes(scope)) {
    return bad(res, "未知的配置项");
  }

  try {
    // 与正式调用同一套合并规则：浏览器填的优先，缺的回落 .env
    const overrides = modelConfig.normalize({ [scope]: { url, key, model } });
    const r = modelConfig.resolveFor(scope, overrides[scope]);
    const args =
      modelConfig.SCOPE_META[scope].engine === "bailian"
        ? { host: r.host, key: r.apiKey, model: r.model, workspace: r.workspace }
        : { url: r.url, key: r.key, model: r.model };

    const result = await probe(scope, args);
    return ok(res, { ok: true, latencyMs: result.latencyMs });
  } catch (e) {
    // 检测失败也是正常结果：把可读原因带回前端，不算接口错误
    return ok(res, { ok: false, error: e.message || "检测失败" });
  }
});

module.exports = { router };
