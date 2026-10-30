/**
 * 输入解析：确定「用哪份模板」「用哪段转写」。
 *
 * 老记录可能没有 segments，这时按行构造伪分段，保证纪要保持可用。
 */

const repos = require("../../data/db/repositories");
const templates = require("../templates");

function resolveTemplate(templateId) {
  const wanted = templateId ? String(templateId) : null;
  if (wanted) {
    const row = repos.templates.getTemplateRow(wanted);
    if (row) return { template: templates.fromRow(row), fellBack: false };
  }
  const defRow = repos.templates.getTemplateRow(templates.DEFAULT_TEMPLATE_ID);
  return {
    template: defRow ? templates.fromRow(defRow) : templates.DEFAULT_TEMPLATE,
    fellBack: Boolean(wanted),
  };
}

/** 纯文本 → 伪分段，供没有 segments 的老记录使用 */

function pseudoSegments(text) {
  return String(text || "")
    .split(/\n+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t, i) => ({ text: t, start_ms: i * 60000, end_ms: (i + 1) * 60000 }));
}

function resolveSegments({ jobId, recordId, text }) {
  if (jobId) {
    const rows = repos.segments.listSegments(jobId);
    if (rows.length) return rows;
  }
  // 显式给了文本就以文本为准（老接口 POST /api/meeting-summary 的契约）
  if (String(text || "").trim()) return pseudoSegments(text);
  if (recordId) {
    const record = repos.records.getRecord(recordId);
    if (record?.job_id) {
      const rows = repos.segments.listSegments(record.job_id);
      if (rows.length) return rows;
    }
    if (record?.transcript) return pseudoSegments(record.transcript);
  }
  return pseudoSegments(text);
}

function projectionOf(json) {
  const topic = String(json?.topic || "").trim();
  if (topic) return topic.slice(0, 46);
  const first = (json?.sections || []).find((s) => Array.isArray(s.items) && s.items.length);
  if (!first) return null;
  const item = first.items[0];
  const line = typeof item === "string" ? item : item?.text || "";
  return String(line).slice(0, 46) || null;
}

function recordFallbackSummary(record) {
  const text = String(record?.transcript || "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 46) : null;
}

/** 纪要摘要列表，供详情页与记录详情接口使用 */

module.exports = {
  resolveTemplate, pseudoSegments, resolveSegments, projectionOf, recordFallbackSummary,
};
