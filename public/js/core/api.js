/**
 * 接口访问：路径常量 + 统一的 JSON 请求。
 *
 * 只负责「发出去、解析回 JSON」，业务错误分支留在各 feature 里，
 * 避免把不同接口的错误文案压成一句通用的。
 */

export const API = {
  meta: "/api/meta",
  records: "/api/records",
  record: (id) => `/api/records/${id}`,
  recordMinutes: (id) => `/api/records/${id}/minutes`,
  job: (id) => `/api/jobs/${id}`,
  jobs: "/api/jobs",
  jobCancel: (id) => `/api/jobs/${id}/cancel`,
  jobResume: (id) => `/api/jobs/${id}/resume`,
  jobDiarize: (id) => `/api/jobs/${id}/diarize`,
  jobSpeakers: (id) => `/api/jobs/${id}/speakers`,
  jobAudio: (id) => `/api/jobs/${id}/audio`,
  recordBatchDelete: "/api/records/batch-delete",
  minutes: "/api/minutes",
  minute: (id) => `/api/minutes/${id}`,
  templates: "/api/templates",
  template: (id) => `/api/templates/${id}`,
  templateDuplicate: (id) => `/api/templates/${id}/duplicate`,
  templatesBatchDelete: "/api/templates/batch-delete",
};

/** 发请求并解析 JSON；网络异常返回 { success:false, error } 而不是抛错 */
export async function jsonFetch(path, init) {
  try {
    const resp = await fetch(path, init);
    return await resp.json();
  } catch {
    return { success: false, error: "网络错误，请检查后端是否启动" };
  }
}

export function postJson(path, body, method = "POST") {
  return jsonFetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}
