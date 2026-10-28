#!/usr/bin/env node
require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const { probe, extractWav, findSilences, planCuts, slicePcm, fmtTime } = require("../server/audio");
const { transcribePcm } = require("../server/asr-bailian");

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) args[key] = true;
      else { args[key] = next; i++; }
    } else args._.push(a);
  }
  return args;
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = args._[0];
  if (!input) {
    console.error("用法: node scripts/transcribe.js <音频或录屏文件> [--out 目录] [--chunk 900] [--concurrency 3]");
    process.exit(1);
  }

  const apiKey = process.env.DASHSCOPE_API_KEY;
  const host = process.env.BAILIAN_WS_HOST;
  const workspace = process.env.BAILIAN_WORKSPACE;
  const model = args.model || process.env.ASR_MODEL || "qwen-audio-3.0-asr-flash-streaming";

  if (!apiKey || !host || !workspace) {
    console.error("缺少 DASHSCOPE_API_KEY / BAILIAN_WS_HOST / BAILIAN_WORKSPACE，请检查 .env");
    process.exit(1);
  }

  const chunkSec = Number(args.chunk || 900);
  const concurrency = Math.max(1, Number(args.concurrency || 3));
  const speed = Number(args.speed || 4);
  const lang = args.lang === "auto" ? [] : [args.lang || "zh"];
  const vocab = args.vocab
    ? Object.fromEntries(String(args.vocab).split(/[,，]/).map((w) => [w.trim(), 4]).filter(([w]) => w))
    : {};

  const t0 = Date.now();
  const meta = await probe(input);
  console.log(`[probe] ${path.basename(input)}  时长 ${fmtTime(meta.durationSec)}  音轨 ${meta.audioCodec} ${meta.sampleRate}Hz ${meta.channels}ch`);

  const base = path.basename(input, path.extname(input));
  const outDir = path.resolve(args.out || path.join(__dirname, "..", "workspace", `${base}-${Date.now()}`));
  fs.mkdirSync(outDir, { recursive: true });

  const wavPath = path.join(outDir, "audio.wav");
  console.log("[1/4] 抽取音频 → 16k 单声道 wav");
  await extractWav(input, wavPath, { normalize: args["no-normalize"] ? false : true });
  console.log(`      ${(fs.statSync(wavPath).size / 1024 / 1024).toFixed(1)} MB`);

  let cuts = [0, meta.durationSec];
  if (meta.durationSec > chunkSec * 1.2) {
    console.log("[2/4] 检测静音点，规划切分");
    const silences = await findSilences(wavPath, { totalSec: meta.durationSec });
    cuts = planCuts(meta.durationSec, chunkSec, silences);
    console.log(`      静音段 ${silences.length} 个 → 切成 ${cuts.length - 1} 片：${cuts.map((c) => fmtTime(c)).join(" | ")}`);
  } else {
    console.log("[2/4] 时长较短，单片处理");
  }

  const chunkDir = path.join(outDir, "chunks");
  fs.mkdirSync(chunkDir, { recursive: true });
  const total = cuts.length - 1;
  let doneCount = 0;

  console.log(`[3/4] 流式识别（${total} 片，并发 ${concurrency}，推送速度 ${speed}x）`);
  const results = await mapLimit(
    Array.from({ length: total }, (_, i) => i),
    concurrency,
    async (i) => {
      const startSec = cuts[i];
      const endSec = cuts[i + 1];
      const pcmPath = path.join(chunkDir, `chunk_${String(i).padStart(3, "0")}.pcm`);
      await slicePcm(wavPath, pcmPath, startSec, endSec - startSec);

      const r = await transcribePcm(pcmPath, {
        apiKey, host, workspace, model,
        sampleRate: 16000,
        languageHints: lang,
        vocabulary: vocab,
        speed,
        retries: 2,
      });

      if (!args["keep-temp"]) fs.unlinkSync(pcmPath);

      doneCount++;
      const pct = ((doneCount / total) * 100).toFixed(0).padStart(3);
      console.log(
        `      [${pct}%] ${String(i + 1).padStart(2)}/${total} ${fmtTime(startSec)}-${fmtTime(endSec)} ` +
        `${r.sentences.length} 句 / ${(r.elapsedMs / 1000).toFixed(1)}s`
      );

      return {
        idx: i,
        startSec,
        endSec,
        sentences: r.sentences.map((s) => ({
          startMs: Math.round(startSec * 1000) + s.startMs,
          endMs: Math.round(startSec * 1000) + s.endMs,
          text: s.text,
          speaker: s.speaker,
        })),
        usage: r.usage,
      };
    }
  );

  const sentences = results
    .sort((a, b) => a.idx - b.idx)
    .flatMap((r) => r.sentences)
    .filter((s) => s.text);

  const billable = results.reduce((acc, r) => acc + (r.usage?.duration || 0), 0);
  const payload = {
    source: path.resolve(input),
    model,
    durationSec: meta.durationSec,
    language: lang[0] || "auto",
    createdAt: new Date().toISOString(),
    elapsedMs: Date.now() - t0,
    usage: { billableSeconds: billable },
    chunks: results.map((r) => ({ idx: r.idx, startSec: r.startSec, endSec: r.endSec, sentences: r.sentences.length })),
    sentences,
    text: sentences.map((s) => s.text).join(""),
  };

  const jsonPath = path.join(outDir, "transcript.json");
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2));

  const txtPath = path.join(outDir, "transcript.txt");
  fs.writeFileSync(txtPath, sentences.map((s) => `[${fmtTime(s.startMs / 1000)}] ${s.text}`).join("\n") + "\n");

  console.log("[4/4] 完成");
  console.log(`      句子 ${sentences.length} 条，计费时长 ${billable}s，总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`      输出 ${jsonPath}`);
  console.log(`      输出 ${txtPath}`);
}

main().catch((e) => {
  console.error("[error]", e.message);
  process.exit(1);
});
