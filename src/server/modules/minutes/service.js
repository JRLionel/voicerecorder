/**
 * 纪要动作：独立于转写的一次可重复执行。
 *
 * 一份记录可以有多份纪要，只追加不覆盖；records.current_minutes_id 指向当前生效的一份。
 * 生成期间用 minutes 行本身作锁（status='generating'），LLM 调用放在事务之外。
 */

const repos = require("../../data/db/repositories");
const { limits } = require("../../data");
const templates = require("../templates");
const { MinutesError } = require("../../shared/errors");
const { generateSummary } = require("./composer");
const {
  resolveTemplate, resolveSegments, projectionOf, recordFallbackSummary,
} = require("./selection");

const LOCK_WINDOW_MS = limits.minutes.lockWindowMs;

function listMinutes(recordId) {
  const record = repos.records.getRecord(recordId);
  if (!record) return [];
  return repos.minutes.listMinutesByRecord(recordId).map((m) => {
    let snapshot = {};
    try { snapshot = JSON.parse(m.template_snapshot || "{}"); } catch {}
    return {
      id: m.id,
      templateId: m.template_id,
      templateName: m.template_name,
      templateMissing: Boolean(m.template_id) && !repos.templates.getTemplateRow(m.template_id),
      topic: m.topic || "",
      status: m.status,
      createdAt: m.created_at,
      isCurrent: m.id === record.current_minutes_id,
      sections: Array.isArray(snapshot.sections) ? snapshot.sections : [],
      extras: snapshot.extras || {},
    };
  });
}

function getMinutesDetail(id) {
  const row = repos.minutes.getMinutes(id);
  if (!row) return null;
  let json = null;
  let snapshot = {};
  try { json = JSON.parse(row.json || "null"); } catch {}
  try { snapshot = JSON.parse(row.template_snapshot || "{}"); } catch {}
  return {
    id: row.id,
    recordId: row.record_id,
    jobId: row.job_id,
    templateId: row.template_id,
    templateName: row.template_name,
    templateMissing: Boolean(row.template_id) && !repos.templates.getTemplateRow(row.template_id),
    topic: row.topic || "",
    status: row.status,
    createdAt: row.created_at,
    markdown: row.markdown || "",
    json,
    template: snapshot,
  };
}

/**
 * 生成一份纪要。
 * 有记录时落库并切换当前指针；没有记录（纯文本调用）时只生成不落库。
 */

async function generateMinutes({ jobId = null, recordId = null, text = null, templateId = null, model = null, onProgress } = {}) {
  let job = null;
  let record = null;

  if (jobId) {
    job = repos.jobs.getJob(jobId);
    if (!job) throw new MinutesError("JOB_NOT_FOUND", "任务不存在", 404);
    record = job.record_id ? repos.records.getRecord(job.record_id) : null;
    if (!record) throw new MinutesError("RECORD_NOT_FOUND", "该任务还没有转写结果，无法生成纪要", 400);
  } else if (recordId) {
    record = repos.records.getRecord(recordId);
    if (!record) throw new MinutesError("RECORD_NOT_FOUND", "记录不存在", 404);
  }

  const segments = resolveSegments({ jobId, recordId: record?.id, text });
  if (!segments.length) {
    throw new MinutesError("NO_TRANSCRIPT", "这条记录没有可用的转写内容", 400);
  }

  const picked = resolveTemplate(templateId || record?.template_id || job?.template_id || null);
  const effectiveJobId = jobId || record?.job_id || null;

  // 无记录：纯文本生成，不落库
  if (!record) {
    const result = await generateSummary(segments, {
      markers: [],
      template: picked.template,
      model,
      onProgress,
    });
    return {
      minutes: null,
      json: result.json,
      markdown: result.markdown,
      template: templates.snapshotOf(result.template),
      templateFellBack: picked.fellBack,
    };
  }

  if (repos.minutes.hasRecentGenerating(record.id, LOCK_WINDOW_MS)) {
    throw new MinutesError("MINUTES_IN_PROGRESS", "这条记录正在生成纪要，请稍候", 409);
  }

  const markers = effectiveJobId ? repos.markers.listMarkers(effectiveJobId) : [];
  const row = repos.minutes.insertMinutes({
    recordId: record.id,
    jobId: effectiveJobId,
    templateId: picked.template.id,
    templateName: picked.template.name,
    templateSnapshot: templates.snapshotOf(picked.template),
  });

  try {
    const result = await generateSummary(segments, {
      markers,
      template: picked.template,
      model,
      onProgress,
    });
    // 模型返回旧结构时 generateSummary 会回落到默认模板，快照要跟着改
    const used = result.template || picked.template;
    const snapshot = templates.snapshotOf(used);
    const finished = repos.minutes.finishMinutes(row.id, {
      json: result.json,
      markdown: result.markdown,
      topic: result.json.topic,
      templateId: used.id,
      templateName: used.name,
      templateSnapshot: snapshot,
    });
    repos.minutes.setCurrentMinutes(record.id, row.id, projectionOf(result.json));
    repos.records.updateRecord(record.id, {
      template_id: used.id,
      template_name: used.name,
      template: "meeting",
    });
    return {
      minutes: {
        id: finished.id,
        templateId: finished.template_id,
        templateName: finished.template_name,
        topic: finished.topic || "",
        status: finished.status,
        createdAt: finished.created_at,
        isCurrent: true,
        sections: snapshot.sections,
        extras: snapshot.extras,
      },
      json: result.json,
      markdown: result.markdown,
      template: snapshot,
      templateFellBack: picked.fellBack,
    };
  } catch (err) {
    // 失败不留脏行，错误由调用方直接带回前端
    repos.minutes.deleteMinutes(row.id);
    throw err;
  }
}

/** 把某份纪要设为当前 */

function setCurrent(recordId, minutesId) {
  const record = repos.records.getRecord(recordId);
  if (!record) throw new MinutesError("RECORD_NOT_FOUND", "记录不存在", 404);
  const row = repos.minutes.getMinutes(minutesId);
  if (!row || row.record_id !== recordId) {
    throw new MinutesError("MINUTES_NOT_FOUND", "纪要不存在", 404);
  }
  repos.minutes.setCurrentMinutes(recordId, minutesId, projectionOf(JSON.parse(row.json || "null")));
  return listMinutes(recordId);
}

/** 删除一份纪要；删当前项时指针回落到右邻，再退左邻，都没有则清空 */

function removeMinutes(minutesId) {
  const row = repos.minutes.getMinutes(minutesId);
  if (!row) throw new MinutesError("MINUTES_NOT_FOUND", "纪要不存在", 404);

  const record = repos.records.getRecord(row.record_id);
  const wasCurrent = record?.current_minutes_id === minutesId;

  repos.minutes.deleteMinutes(minutesId);

  if (!record) return { deleted: true, currentId: null };

  if (wasCurrent) {
    const rest = repos.minutes.listMinutesByRecord(record.id);
    const next = rest.find((m) => m.created_at > row.created_at) || rest[rest.length - 1] || null;
    if (next) {
      let json = null;
      try { json = JSON.parse(next.json || "null"); } catch {}
      repos.minutes.setCurrentMinutes(record.id, next.id, projectionOf(json));
    } else {
      repos.minutes.setCurrentMinutes(record.id, null, recordFallbackSummary(record));
      repos.records.updateRecord(record.id, { template: "transcribe" });
    }
  }

  const updated = repos.records.getRecord(record.id);
  return { deleted: true, currentId: updated?.current_minutes_id || null, minutes: listMinutes(record.id) };
}

module.exports = {
  MinutesError,
  generateMinutes,
  listMinutes,
  getMinutesDetail,
  setCurrent,
  removeMinutes,
  resolveTemplate,
  resolveSegments,
};
