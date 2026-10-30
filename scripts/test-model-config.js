#!/usr/bin/env node
/**
 * 模型配置解析层单元测试：不联网，只验证「浏览器优先、.env 兜底」的合并规则。
 * 运行：node scripts/test-model-config.js
 */
const assert = require("node:assert");

const modelConfig = require("../src/server/modules/model-config");
const { probe, silentWavDataUri } = require("../src/server/modules/model-config/probe");
const config = require("../src/server/config");

// 「.env 什么都没配」的一份独立配置，用来验证报错路径
const emptyApi = modelConfig.createApi(config.build({}));

let passed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (e) {
    console.error(`✗ ${name}\n  ${e.message}`);
    process.exitCode = 1;
  }
}

test("normalize: 非对象输入返回空壳", () => {
  for (const bad of [null, undefined, 42, "x"]) {
    const out = modelConfig.normalize(bad);
    assert.deepEqual(Object.keys(out).sort(), ["batch", "diar", "minutes", "realtime"]);
    assert.deepEqual(out.minutes, { url: "", key: "", model: "" });
  }
});

test("normalize: 只保留字符串字段并裁剪空白", () => {
  const out = modelConfig.normalize({
    minutes: { url: "  https://a.example.com  ", key: " k ", model: 123 },
    evil: { url: "x" },
  });
  assert.equal(out.minutes.url, "https://a.example.com");
  assert.equal(out.minutes.key, "k");
  assert.equal(out.minutes.model, "");
  assert.equal(out.evil, undefined);
});

test("parsePayload: 字符串 JSON 与对象都能收，坏 JSON 回落空壳", () => {
  const fromString = modelConfig.parsePayload(JSON.stringify({ minutes: { model: "m" } }));
  assert.equal(fromString.minutes.model, "m");
  const fromObject = modelConfig.parsePayload({ minutes: { model: "m" } });
  assert.equal(fromObject.minutes.model, "m");
  const broken = modelConfig.parsePayload("{不是 json");
  assert.deepEqual(broken.minutes, { url: "", key: "", model: "" });
});

test("merge: 新值只覆盖非空字段", () => {
  const base = modelConfig.normalize({
    minutes: { url: "https://old", key: "old-key", model: "old-model" },
  });
  const merged = modelConfig.merge(base, { minutes: { model: "new-model" } });
  assert.equal(merged.minutes.model, "new-model");
  assert.equal(merged.minutes.url, "https://old");
  assert.equal(merged.minutes.key, "old-key");
});

test("resolve: 浏览器填的优先，没填的回落 .env", () => {
  const env = modelConfig.envDefaults();
  const onlyModel = modelConfig.resolve("minutes", { model: "browser-model" });
  assert.equal(onlyModel.model, "browser-model");
  assert.equal(onlyModel.url, env.minutes.url);
  assert.equal(onlyModel.key, env.minutes.key);
});

test("resolve: 浏览器填了空的字段 = 沿用 .env", () => {
  const env = modelConfig.envDefaults();
  const out = modelConfig.resolve("batch", { url: "", key: "", model: "" });
  assert.equal(out.url, env.batch.url);
  assert.equal(out.key, env.batch.key);
  assert.equal(out.model, env.batch.model);
});

test("publicDefaults: 有地址与模型，但绝不下发密钥", () => {
  const def = modelConfig.publicDefaults();
  for (const scope of modelConfig.SCOPES) {
    assert.ok("url" in def[scope]);
    assert.ok("model" in def[scope]);
    assert.ok(!("key" in def[scope]), `${scope} 不应带 key`);
    assert.equal(typeof def[scope].hasKey, "boolean");
  }
});

test("hostOf: 裸 host 与带协议的地址都能取到 host", () => {
  assert.equal(modelConfig.hostOf("llm-abc.cn-beijing.maas.aliyuncs.com"), "llm-abc.cn-beijing.maas.aliyuncs.com");
  assert.equal(modelConfig.hostOf("https://llm-abc.cn-beijing.maas.aliyuncs.com"), "llm-abc.cn-beijing.maas.aliyuncs.com");
  assert.equal(modelConfig.hostOf("https://a.example.com:8443/x"), "a.example.com:8443");
});

test("hostOf: 非白名单协议一律取不到", () => {
  for (const bad of ["file:///etc/passwd", "ftp://a.com", "javascript:alert(1)"]) {
    assert.equal(modelConfig.hostOf(bad), "", bad);
  }
});

test("isUsableUrl: 只认 http/https/ws/wss", () => {
  assert.equal(modelConfig.isUsableUrl("https://a.example.com"), true);
  assert.equal(modelConfig.isUsableUrl("http://a.example.com"), true);
  assert.equal(modelConfig.isUsableUrl("wss://a.example.com"), true);
  assert.equal(modelConfig.isUsableUrl("ftp://a.example.com"), false);
  assert.equal(modelConfig.isUsableUrl("file:///etc/passwd"), false);
  assert.equal(modelConfig.isUsableUrl("不是地址"), false);
});

test("resolveMimo: .env 与浏览器都没配时给出可读报错", () => {
  assert.throws(
    () => emptyApi.resolveMimo("minutes", { url: "https://a", key: "", model: "" }),
    /模型配置/
  );
  // .env 配全时，浏览器只填一半也不报错（缺的字段回落 .env）
  const out = modelConfig.resolveMimo("minutes", { model: "browser-model" });
  assert.equal(out.model, "browser-model");
  assert.equal(out.key, modelConfig.envDefaults().minutes.key);
});

test("resolveBailian: 换成别的 host 就不带工作区头", () => {
  const out = modelConfig.resolveBailian("diar", {
    url: "https://other.example.com",
    key: "k",
    model: "m",
  });
  assert.equal(out.host, "other.example.com");
  assert.equal(out.apiKey, "k");
  assert.equal(out.model, "m");
  assert.equal(out.workspace, "");
});

test("resolveFor: minutes 走 MIMO 形状，diar 走百炼形状", () => {
  const mimo = modelConfig.resolveFor("minutes", { url: "https://a", key: "k", model: "m" });
  assert.equal(mimo.url, "https://a");
  assert.equal(mimo.key, "k");
  const bailian = modelConfig.resolveFor("realtime", { url: "https://b.example.com", key: "k", model: "m" });
  assert.equal(bailian.host, "b.example.com");
  assert.equal(bailian.workspace, "");
});

test("isReady: 三项齐了才算就绪", () => {
  const env = modelConfig.envDefaults();
  assert.equal(modelConfig.isReady("minutes", { url: env.minutes.url, key: env.minutes.key, model: env.minutes.model }), true);
  // .env 什么都没有时，光有地址和模型也不算就绪
  assert.equal(emptyApi.isReady("minutes", { url: env.minutes.url, model: env.minutes.model }), false);
  assert.equal(emptyApi.isReady("minutes", { url: env.minutes.url, key: "k", model: env.minutes.model }), true);
});

test("silentWavDataUri: 是能解析的 16k 单声道 16bit WAV", () => {
  const uri = silentWavDataUri();
  assert.ok(uri.startsWith("data:audio/wav;base64,"));
  const buf = Buffer.from(uri.split(",")[1], "base64");
  assert.equal(buf.toString("ascii", 0, 4), "RIFF");
  assert.equal(buf.toString("ascii", 8, 12), "WAVE");
  assert.equal(buf.readUInt16LE(20), 1);        // PCM
  assert.equal(buf.readUInt16LE(22), 1);        // 单声道
  assert.equal(buf.readUInt32LE(24), 16000);    // 采样率
  assert.equal(buf.readUInt16LE(34), 16);       // 位深
  assert.equal(buf.readUInt32LE(4), buf.length - 8); // RIFF 长度自洽
  assert.equal(buf.toString("ascii", 36, 40), "data");
});

test("probe: 未知作用域直接报错", async () => {
  await assert.rejects(() => probe("nope", {}), /未知的配置项/);
});

console.log(`\n${passed} 项通过`);
