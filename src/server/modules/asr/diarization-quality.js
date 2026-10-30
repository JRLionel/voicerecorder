/**
 * 说话人分离质量判定。
 *
 * 全 0 是最坏情况 —— 不是报错，而是「所有人都叫说话人1」，必须显式暴露。
 */

const { speakers: speakerRules } = require("../../data");

function normalizeSentences(result) {
  const transcripts = Array.isArray(result?.transcripts)
    ? result.transcripts
    : Array.isArray(result?.data?.transcripts)
      ? result.data.transcripts
      : null;

  let raw = [];
  if (transcripts) {
    for (const t of transcripts) {
      if (Array.isArray(t?.sentences)) raw.push(...t.sentences);
    }
  } else if (Array.isArray(result?.sentences)) {
    raw = result.sentences;
  }

  const out = [];
  for (const s of raw) {
    if (!s) continue;
    const text = String(s.text || "").trim();
    if (!text) continue;
    const start = Number(s.begin_time ?? s.start_time ?? 0);
    const end = Number(s.end_time ?? s.endTime ?? start);
    const sid = s.speaker_id;
    out.push({
      startMs: Number.isFinite(start) ? start : 0,
      endMs: Number.isFinite(end) ? Math.max(end, start) : start,
      text,
      speaker: sid === null || sid === undefined ? null : `S${sid}`,
    });
  }
  out.sort((a, b) => a.startMs - b.startMs);
  return out;
}

/**
 * 判定分离质量。
 * 全 0 是最坏情况——不是报错，而是「所有人都叫说话人1」，必须显式暴露。
 */

function analyzeDiarization(sentences, durationSec = 0) {
  const ids = new Set(sentences.map((s) => s.speaker).filter(Boolean));
  const distinct = ids.size;
  const usable = sentences.length;

  const q = speakerRules.quality;
  let status = "ok";
  if (usable > q.failedMinSentences && distinct <= q.failedMaxDistinct) status = "failed";
  else if (durationSec > 0 && durationSec <= q.suspectMaxDurationSec && distinct > q.suspectMaxDistinct) status = "suspect";

  const talk = new Map();
  for (const s of sentences) {
    if (!s.speaker) continue;
    talk.set(s.speaker, (talk.get(s.speaker) || 0) + Math.max(0, s.endMs - s.startMs));
  }

  return {
    status,
    distinct,
    talkMs: talk,
    firstMs: new Map(
      [...ids].map((id) => [id, sentences.find((s) => s.speaker === id)?.startMs ?? 0])
    ),
  };
}

/** 带退避的重试包装：只对凭证/上传这类瞬时故障重试 */

module.exports = { normalizeSentences, analyzeDiarization };
