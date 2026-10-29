#!/usr/bin/env node
/**
 * 纯本地单元测试：不联网、不读音频，只验证离线结果的归一化与质量判定。
 * 运行：node scripts/test-offline.js
 */
const assert = require("node:assert");
const { normalizeSentences, analyzeDiarization } = require("../server/bailian-offline");
const { buildEvents, buildBlocks, normalize, toMarkdown } = require("../server/summary");

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

test("normalizeSentences: 标准结构", () => {
  const out = normalizeSentences({
    transcripts: [{
      sentences: [
        { begin_time: 760, end_time: 3800, text: " 你好 ", speaker_id: 0 },
        { begin_time: 4000, end_time: 6000, text: "在的", speaker_id: 1 },
      ],
    }],
  });
  assert.equal(out.length, 2);
  assert.equal(out[0].text, "你好");
  assert.equal(out[0].speaker, "S0");
  assert.equal(out[1].speaker, "S1");
  assert.equal(out[0].startMs, 760);
});

test("normalizeSentences: 跳过空文本与缺字段", () => {
  const out = normalizeSentences({
    sentences: [
      { begin_time: 0, end_time: 100, text: "   " },
      { begin_time: 100, end_time: 200, text: "有效" },
      null,
    ],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].text, "有效");
  assert.equal(out[0].speaker, null);
  assert.equal(out[0].endMs, 200);
});

test("normalizeSentences: 输出按时间升序", () => {
  const out = normalizeSentences({
    sentences: [
      { begin_time: 5000, end_time: 6000, text: "后" },
      { begin_time: 1000, end_time: 2000, text: "前" },
    ],
  });
  assert.deepEqual(out.map((s) => s.text), ["前", "后"]);
});

test("normalizeSentences: 空结果不抛错", () => {
  assert.deepEqual(normalizeSentences({}), []);
  assert.deepEqual(normalizeSentences(null), []);
});

test("analyzeDiarization: 全同判失败", () => {
  const sentences = Array.from({ length: 8 }, (_, i) => ({
    startMs: i * 1000, endMs: i * 1000 + 900, text: "x", speaker: "S0",
  }));
  assert.equal(analyzeDiarization(sentences, 60).status, "failed");
});

test("analyzeDiarization: 两人正常", () => {
  const sentences = Array.from({ length: 8 }, (_, i) => ({
    startMs: i * 1000, endMs: i * 1000 + 900, text: "x", speaker: `S${i % 2}`,
  }));
  const r = analyzeDiarization(sentences, 60);
  assert.equal(r.status, "ok");
  assert.equal(r.distinct, 2);
});

test("analyzeDiarization: 短音频编号过多判疑似", () => {
  const sentences = Array.from({ length: 12 }, (_, i) => ({
    startMs: i * 1000, endMs: i * 1000 + 900, text: "x", speaker: `S${i}`,
  }));
  assert.equal(analyzeDiarization(sentences, 600).status, "suspect");
});

test("buildEvents: 标记插到正确时间点", () => {
  const events = buildEvents(
    [
      { start_ms: 0, end_ms: 1000, text: "第一句" },
      { start_ms: 5000, end_ms: 6000, text: "第二句" },
    ],
    [{ start_ms: 3000, end_ms: 4000, text: "这里要跟进" }]
  );
  assert.deepEqual(events.map((e) => e.kind), ["segment", "marker", "segment"]);
});

test("buildEvents: 说话人标签优先", () => {
  const events = buildEvents(
    [{ start_ms: 0, end_ms: 1000, text: "hi", speaker: "S0", speaker_label: "张总" }],
    []
  );
  assert.equal(events[0].speaker, "张总");
});

test("buildBlocks: 标记不落在块边界被孤立", () => {
  const segments = [];
  for (let i = 0; i < 40; i++) {
    segments.push({ start_ms: i * 1000, end_ms: i * 1000 + 900, text: "这是一段用于撑满字数的会议发言内容" });
  }
  const markers = [{ start_ms: 20000, end_ms: 21000, text: "重点标记" }];
  const blocks = buildBlocks(buildEvents(segments, markers));
  const idx = blocks.findIndex((b) => b.includes("【现场标记】"));
  assert.ok(idx >= 0, "标记应出现在某个块里");
  const lines = blocks[idx].split("\n");
  const at = lines.findIndex((l) => l.includes("【现场标记】"));
  assert.ok(at < lines.length - 1 || lines.length === 1, "标记后应还有上下文（或本身是末块）");
});

test("normalize: 缺省字段不炸", () => {
  const j = normalize({});
  assert.deepEqual(j.todos, []);
  assert.deepEqual(j.markers, []);
  assert.deepEqual(j.speakerPoints, []);
});

test("normalize: usedIn 非法值回落为 content", () => {
  const j = normalize({ markers: [{ at: "00:01:00", text: "x", usedIn: "bogus" }] });
  assert.equal(j.markers[0].usedIn, "content");
});

test("toMarkdown: 两种附加节按数据出现", () => {
  const md = toMarkdown(
    normalize({
      topic: "t",
      content: ["c"],
      markers: [{ at: "00:12:43", text: "客户下周来", usedIn: "decisions" }],
      speakerPoints: [{ speaker: "张总", points: ["进度"] }],
    })
  );
  assert.ok(md.includes("## 现场标记"));
  assert.ok(md.includes("## 按人要点"));
  assert.ok(md.includes("已纳入「决议」"));
});

console.log(`\n${passed} 项通过`);
