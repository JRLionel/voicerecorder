#!/usr/bin/env node
/**
 * 接口契约冒烟：重构每个阶段复跑，确保对外行为零回归。
 *
 * 用法：
 *   node scripts/smoke-http.js                 # 默认 http://127.0.0.1:3000
 *   node scripts/smoke-http.js http://127.0.0.1:3100
 *
 * 只创建/删除自己造的数据，不动既有记录与模板。
 */

const BASE = (process.argv[2] || process.env.SMOKE_BASE || "http://127.0.0.1:3000").replace(/\/$/, "");

// 断言要用 .env 里的模型名做对照，服务端读的是同一份 .env
require("dotenv").config();

let pass = 0;
const failures = [];

function check(name, cond, detail = "") {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function req(method, path, body, extraHeaders = {}) {
  const init = { method, headers: { ...extraHeaders } };
  if (body !== undefined) {
    if (typeof body === "string") {
      init.headers["Content-Type"] = "application/json";
      init.body = body;
    } else {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
  }
  const resp = await fetch(BASE + path, init);
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: resp.status, json, text, headers: resp.headers };
}

const hasKeys = (obj, keys) => Boolean(obj) && keys.every((k) => k in obj);

async function main() {
  console.log(`== 静态资源 ==`);
  for (const p of ["/", "/js/main.js", "/styles/tokens.css", "/styles/components.css", "/styles/views.css", "/styles/recording.css", "/styles/templates.css", "/pcm-worklet.js"]) {
    const r = await req("GET", p);
    check(`GET ${p} → 200`, r.status === 200, `实际 ${r.status}`);
  }
  const html = (await req("GET", "/")).text;
  for (const id of ["viewHome", "viewNew", "viewRec", "viewDetail", "viewTemplates", "tplPicker", "tplEditor", "selBar", "modalBackdrop"]) {
    check(`index.html 含 #${id}`, html.includes(`id="${id}"`));
  }

  console.log(`== 模型配置 ==`);
  const cfg = await req("GET", "/api/model-config");
  check("GET /api/model-config success", cfg.json?.success === true);
  const defaults = cfg.json?.defaults || {};
  for (const scope of ["minutes", "batch", "diar", "realtime"]) {
    check(`${scope} 默认配置字段完整`, hasKeys(defaults[scope], ["url", "model", "hasKey"]));
    check(`${scope} 不下发密钥`, !("key" in (defaults[scope] || {})));
  }
  check(
    "纪要默认模型取自 MIMO_SUMMARY_MODEL",
    defaults.minutes?.model === process.env.MIMO_SUMMARY_MODEL,
    defaults.minutes?.model
  );
  check(
    "非实时转写默认模型取自 MIMO_ASR_MODEL",
    defaults.batch?.model === process.env.MIMO_ASR_MODEL,
    defaults.batch?.model
  );

  const badScope = await req("POST", "/api/model-config/test", { scope: "nope" });
  check("未知作用域被拒 → 400", badScope.status === 400, `实际 ${badScope.status}`);
  const noScope = await req("POST", "/api/model-config/test", {});
  check("缺作用域被拒 → 400", noScope.status === 400, `实际 ${noScope.status}`);

  console.log(`== 模板 ==`);
  const tplList = await req("GET", "/api/templates");
  check("GET /api/templates success", tplList.json?.success === true);
  check("模板列表返回 defaultId", typeof tplList.json?.defaultId === "string" && tplList.json.defaultId.length > 0);
  const firstTpl = tplList.json?.items?.[0];
  check(
    "模板项字段完整",
    hasKeys(firstTpl, ["id", "name", "description", "icon", "color", "builtin", "sections", "extras", "promptExtra", "updatedAt"]),
    JSON.stringify(Object.keys(firstTpl || {}))
  );
  const builtin = (tplList.json?.items || []).find((t) => t.builtin);
  check("存在系统模板", Boolean(builtin));

  const stamp = Date.now().toString(36);
  const created = await req("POST", "/api/templates", {
    name: `冒烟模板-${stamp}`,
    description: "smoke",
    sections: [{ title: "要点", type: "list", hint: "h" }, { title: "待办", type: "todos" }],
  });
  const tplId = created.json?.template?.id;
  check("POST /api/templates 新建成功", created.json?.success === true && Boolean(tplId), created.text.slice(0, 120));
  check("新建模板 key 被服务端重排", created.json?.template?.sections?.map((s) => s.key).join(",") === "s0,s1");
  check("新建模板非内置", created.json?.template?.builtin === false);

  const renamed = await req("PATCH", `/api/templates/${tplId}`, { name: `冒烟模板-${stamp}-改`, sections: [{ title: "要点", type: "list" }] });
  check("PATCH 模板改名成功", renamed.json?.success === true && renamed.json.template.name.endsWith("-改"));

  const dup = await req("POST", `/api/templates/${tplId}/duplicate`);
  const dupId = dup.json?.template?.id;
  check("复制模板成功", dup.json?.success === true && Boolean(dupId) && dup.json.template.name.includes("副本"));

  const dupDel = await req("POST", "/api/templates/batch-delete", { ids: [dupId] });
  check("批量删除返回 deleted=1", dupDel.json?.success === true && dupDel.json.deleted === 1);

  const batchEmpty = await req("POST", "/api/templates/batch-delete", { ids: [] });
  check("批量删除空数组 → 400", batchEmpty.status === 400);

  if (builtin) {
    const lockPatch = await req("PATCH", `/api/templates/${builtin.id}`, { name: "x", sections: [{ title: "x", type: "list" }] });
    check("系统模板不可改 → 403", lockPatch.status === 403, `实际 ${lockPatch.status}`);
    const lockDel = await req("DELETE", `/api/templates/${builtin.id}`);
    check("系统模板不可删 → 403", lockDel.status === 403, `实际 ${lockDel.status}`);
  }

  const badTpl = await req("POST", "/api/templates", { name: "" });
  check("空名模板 → 400", badTpl.status === 400);

  const delTpl = await req("DELETE", `/api/templates/${tplId}`);
  check("删除模板成功", delTpl.json?.success === true);
  const delTplAgain = await req("DELETE", `/api/templates/${tplId}`);
  check("重复删除模板 → 404", delTplAgain.status === 404);

  console.log(`== 记录 ==`);
  const recList = await req("GET", "/api/records?page=1&pageSize=5");
  check("GET /api/records success", recList.json?.success === true);
  check("列表返回 total/page/pageSize/items", hasKeys(recList.json, ["total", "page", "pageSize", "items"]));
  const listItem = recList.json?.items?.[0];
  if (listItem) {
    check("列表项字段完整", hasKeys(listItem, ["id", "title", "summary", "source", "template", "filename", "size", "duration", "language", "created_at"]));
  }
  const searchMiss = await req("GET", "/api/records?q=__smoke_no_such__");
  check("搜索无结果 total=0", searchMiss.json?.total === 0);

  const rec = await req("POST", "/api/records", { title: `冒烟记录-${stamp}`, summary: "s", source: "upload", transcript: "第一行\n第二行" });
  const recId = rec.json?.record?.id;
  check("POST /api/records 新建成功", rec.json?.success === true && Boolean(recId));

  const recGet = await req("GET", `/api/records/${recId}`);
  check("GET /api/records/:id 返回 record + minutes", hasKeys(recGet.json, ["record", "minutes"]) && recGet.json.record.id === recId);

  const recPatch = await req("PATCH", `/api/records/${recId}`, { title: `冒烟记录-${stamp}-改` });
  check("PATCH 记录改名成功", recPatch.json?.record?.title.endsWith("-改"));

  const rec404 = await req("GET", "/api/records/nope");
  check("GET 不存在记录 → 404", rec404.status === 404);

  const recDel = await req("DELETE", `/api/records/${recId}`);
  check("DELETE 记录成功", recDel.json?.success === true);

  console.log(`== 任务与纪要 ==`);

  const jobs404 = await req("GET", "/api/jobs/nope");
  check("GET 不存在任务 → 404", jobs404.status === 404);
  const cancel404 = await req("POST", "/api/jobs/nope/cancel");
  check("取消不存在任务 → 404", cancel404.status === 404);
  const noFile = await req("POST", "/api/jobs", {});
  check("无文件上传 → 400", noFile.status === 400, `实际 ${noFile.status}`);

  // 用库里已有的完成任务做详情与音频契约检查（只读）
  const recWithJob = (recList.json?.items || []).find((it) => it.source === "recording");
  let jobTested = false;
  if (recWithJob) {
    const rd = await req("GET", `/api/records/${recWithJob.id}`);
    const jobId = rd.json?.record?.job_id;
    if (jobId) {
      const job = await req("GET", `/api/jobs/${jobId}`);
      const j = job.json?.job;
      check("GET /api/jobs/:id 返回 job", job.json?.success === true && Boolean(j));
      check(
        "job 字段完整",
        hasKeys(j, ["id", "status", "stage", "progress", "chunkTotal", "chunkDone", "durationMs", "output", "recordId", "sourceType", "diarizeStatus", "autoMinutes", "templateId"]),
        JSON.stringify(Object.keys(j || {}))
      );
      check("详情返回 segments/markers/speakers/hasAudio", hasKeys(job.json, ["segments", "markers", "speakers", "hasAudio"]));
      check("详情含 record 与 minutes", hasKeys(job.json, ["record"]) && Array.isArray(job.json.record?.minutes));

      if (job.json.hasAudio) {
        const rangeResp = await fetch(`${BASE}/api/jobs/${jobId}/audio`, { headers: { Range: "bytes=0-99" } });
        const buf = Buffer.from(await rangeResp.arrayBuffer());
        check("音频支持 Range → 206 且 100 字节", rangeResp.status === 206 && buf.length === 100, `实际 ${rangeResp.status} / ${buf.length}B`);
      } else {
        console.log("  --   该任务无音频，跳过 Range 检查");
      }

      const mins = await req("GET", `/api/records/${recWithJob.id}/minutes`);
      check("纪要列表 success + items", mins.json?.success === true && Array.isArray(mins.json.items));
      if (mins.json.items?.length) {
        const mid = mins.json.items[0].id;
        const detail = await req("GET", `/api/minutes/${mid}`);
        check("GET /api/minutes/:id 返回 markdown/json/template", hasKeys(detail.json?.minutes, ["markdown", "json", "template", "recordId", "status"]));
        const setCur = await req("PATCH", `/api/minutes/${mid}`, { current: true });
        check("PATCH 设为当前成功", setCur.json?.success === true && setCur.json.currentMinutesId === mid);
      }
      jobTested = true;
    }
  }
  if (!jobTested) console.log("  --   库里没有带 job 的记录，跳过任务详情检查");

  const min404 = await req("GET", "/api/minutes/nope");
  check("GET 不存在纪要 → 404", min404.status === 404);
  const minBad = await req("POST", "/api/minutes", {});
  check("POST /api/minutes 空参数 → 400", minBad.status === 400);
  const legacyBad = await req("POST", "/api/meeting-summary", {});
  check("POST /api/meeting-summary 空参数 → 400", legacyBad.status === 400);

  console.log("");
  if (failures.length) {
    console.error(`✗ ${failures.length} 项失败 / ${pass} 项通过`);
    for (const f of failures) console.error(`   - ${f}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ 全部 ${pass} 项通过`);
  }
}

main().catch((e) => {
  console.error("冒烟脚本异常:", e.message);
  process.exitCode = 1;
});
