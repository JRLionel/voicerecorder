#!/usr/bin/env node
require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const audio = require("../server/audio");
const { diarizeFile, analyzeDiarization } = require("../server/bailian-offline");

/**
 * P0 门禁：验证 filetrans 的说话人分离是否真的生效。
 *
 * 用法：
 *   node scripts/verify-diarization.js <音频路径> [--speakers 2] [--keep]
 *
 * 判定标准：出现 ≥2 个不同的 speaker_id，且与人工听感的轮次对应。
 * 恒为 1 个说明该模型在当前 workspace 下 speaker_id 是空实现，
 * 需要把 DIAR_MODEL 换成 paraformer-v2（调用序列不变）。
 */

function parseArgs(argv) {
  const args = { file: null, speakers: null, keep: false };
  const rest = [];
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--speakers") args.speakers = Number(argv[++i]) || null;
    else if (a === "--keep") args.keep = true;
    else rest.push(a);
  }
  args.file = rest[0] || null;
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.file) {
    console.error("用法: node scripts/verify-diarization.js <音频路径> [--speakers 2] [--keep]");
    process.exit(2);
  }
  if (!fs.existsSync(args.file)) {
    console.error(`文件不存在: ${args.file}`);
    process.exit(2);
  }
  if (!process.env.DASHSCOPE_API_KEY || !process.env.BAILIAN_WS_HOST) {
    console.error("缺少 DASHSCOPE_API_KEY / BAILIAN_WS_HOST，请检查 .env");
    process.exit(2);
  }

  const model = process.env.DIAR_MODEL || "qwen-audio-3.0-asr-flash-filetrans";
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "diar-verify-"));
  const wav = path.join(tmpDir, "probe.wav");

  console.log(`模型: ${model}`);
  console.log(`输入: ${args.file}`);

  const t0 = Date.now();
  const meta = await audio.probe(args.file);
  console.log(`时长: ${meta.durationSec.toFixed(1)}s · ${meta.channels}ch · ${meta.sampleRate}Hz`);

  await audio.extractWav(args.file, wav);
  const sizeMb = fs.statSync(wav).size / 1024 / 1024;
  console.log(`已转 16k 单声道 WAV: ${sizeMb.toFixed(2)}MB`);

  const result = await diarizeFile(wav, {
    speakerCount: args.speakers,
    onStage: (stage) => console.log(`  · ${stage}`),
  });

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const analysis = analyzeDiarization(result.sentences, meta.durationSec);

  const dist = new Map();
  for (const s of result.sentences) {
    dist.set(s.speaker || "null", (dist.get(s.speaker || "null") || 0) + 1);
  }

  console.log("\n===== 结果 =====");
  console.log(`句数: ${result.sentences.length}`);
  console.log(`耗时: ${elapsed}s`);
  console.log(`人数: ${analysis.distinct}`);
  console.log(`分布: ${JSON.stringify(Object.fromEntries(dist))}`);
  console.log(`判定: ${analysis.status}`);

  console.log("\n----- 前 20 句 -----");
  result.sentences.slice(0, 20).forEach((s) => {
    const t = `${String(Math.floor(s.startMs / 60000)).padStart(2, "0")}:${String(
      Math.floor((s.startMs % 60000) / 1000)
    ).padStart(2, "0")}`;
    console.log(`[${t}] ${s.speaker || "-"}  ${s.text}`);
  });

  if (!args.keep) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  } else {
    console.log(`\n中间文件保留在: ${tmpDir}`);
  }

  console.log("\n===== 结论 =====");
  if (analysis.distinct >= 2 && analysis.status === "ok") {
    console.log("✅ 分离生效，可继续按 v2 方案实施");
    process.exit(0);
  }
  if (analysis.distinct <= 1) {
    console.log("❌ 只有 1 个说话人，判定为分离未生效");
    console.log("   下一步：把 .env 的 DIAR_MODEL 改为 paraformer-v2 后重跑本脚本");
    process.exit(1);
  }
  console.log("⚠️ 分离出了多个编号但被判为疑似过度聚类，建议指定 --speakers 后重跑");
  process.exit(1);
}

main().catch((e) => {
  console.error(`\n验证失败: ${e.message}`);
  process.exit(1);
});
