/**
 * 纪要面板：版本胶囊、正文渲染、轮询、切换与删除。
 *
 * 一份记录可以有多份纪要，只追加不覆盖；切版本不重新调模型。
 */

import { $ } from "../../core/dom.js";
import { API, jsonFetch } from "../../core/api.js";
import { copy } from "../../core/meta.js";
import { escapeAttr, escapeHtml, formatDate, parseClock } from "../../core/format.js";
import { showError } from "../../core/toast.js";
import { state } from "../../core/store.js";
import { confirmDialog } from "../../components/modal.js";
import { btnSummary, summaryResult, summaryBody, minuteTabs } from "./refs.js";

let minutesPollTimer = null;

export function stopMinutesPoll() {
  if (minutesPollTimer) {
    clearTimeout(minutesPollTimer);
    minutesPollTimer = null;
  }
}

/** 现场标记去向文案：与后端 Markdown 渲染共用 shared/copy/minute-labels.json */
function usedLabel(usedIn, templateId) {
  const labels = copy().minuteLabels || {};
  if (usedIn === "unused") return labels.unused || "未纳入";
  if (usedIn === "todos") return labels.todos || "已转为待办";
  const isDefault = !templateId || templateId === state.defaultTemplateId;
  if (isDefault) {
    return usedIn === "decisions"
      ? (labels.ui && labels.ui.decisions) || "已纳入决议"
      : (labels.ui && labels.ui.content) || "已纳入内容";
  }
  return labels.custom || "已纳入正文";
}

/** 用服务端返回的摘要列表重建卡片，并按需拉取当前份的正文 */
export async function hydrateMinutes(items) {
  state.minutes = Array.isArray(items) ? items : [];
  state.minutesCurrent = null;
  if (!state.minutes.length) {
    renderMinutesCard();
    return;
  }
  const current = state.minutes.find((m) => m.isCurrent) || state.minutes.find((m) => m.status === "done");
  if (current && current.status !== "generating") {
    const data = await jsonFetch(API.minute(current.id));
    if (data.success) state.minutesCurrent = data.minutes;
  }
  renderMinutesCard();
  if (state.minutes.some((m) => m.status === "generating")) pollMinutes(state.record && state.record.id);
}

/** 自动生成是异步触发的：轮询到没有 generating 为止 */
export function pollMinutes(recordId) {
  stopMinutesPoll();
  if (!recordId) return;
  const started = Date.now();
  const tick = async () => {
    if (Date.now() - started > 180000) return;
    const data = await jsonFetch(API.recordMinutes(recordId));
    if (data.success) {
      const list = data.items || [];
      if (!list.some((m) => m.status === "generating")) {
        await hydrateMinutes(list);
        return;
      }
      state.minutes = list;
      renderMinuteTabs();
    }
    minutesPollTimer = setTimeout(tick, 2500);
  };
  minutesPollTimer = setTimeout(tick, 2500);
}

export function renderMinutesCard() {
  if (!state.minutes.length) {
    summaryResult.hidden = true;
    btnSummary.style.display = state.record || state.job ? "block" : "none";
    return;
  }
  summaryResult.hidden = false;
  btnSummary.style.display = "none";
  renderMinuteTabs();
  renderMinuteBody();
}

export function renderMinuteTabs() {
  const seen = new Map();
  minuteTabs.innerHTML = state.minutes
    .map((m) => {
      const n = (seen.get(m.templateName) || 0) + 1;
      seen.set(m.templateName, n);
      const label = n > 1 ? `${m.templateName} ${n}` : m.templateName;
      const cls = ["minute-tab"];
      if (m.isCurrent) cls.push("is-active");
      if (m.status === "generating") cls.push("is-generating");
      if (m.templateMissing) cls.push("is-orphan");
      const del =
        m.isCurrent && m.status !== "generating"
          ? `<span class="minute-del" data-del="${m.id}" title="删除这一份">&times;</span>`
          : "";
      return `<button class="${cls.join(" ")}" data-id="${m.id}" role="tab"
        aria-selected="${m.isCurrent ? "true" : "false"}"
        title="${escapeAttr(`${formatDate(m.createdAt)} · ${label}${m.templateMissing ? "（模板已删除）" : ""}`)}"
        >${escapeHtml(label)}${m.status === "generating" ? '<i class="minute-spin" aria-hidden="true"></i>' : ""}${del}</button>`;
    })
    .join("");
}

export function renderMinuteBody() {
  const detail = state.minutesCurrent;
  if (!detail) {
    summaryBody.innerHTML = '<div class="minute-empty"><p>正在读取纪要…</p></div>';
    return;
  }
  if (detail.status === "generating") {
    summaryBody.innerHTML = `<div class="minute-generating">
      <div class="loading-track"><div class="loading-fill"></div></div>
      <p>正在用「${escapeHtml(detail.templateName)}」生成，长会议需要几分钟</p>
    </div>`;
    return;
  }

  const json = detail.json || {};
  const snap = detail.template || {};
  const extras = snap.extras || {};
  const sections =
    Array.isArray(json.sections) && json.sections.length
      ? json.sections
      : (snap.sections || []).map((s) => ({ ...s, items: [] }));

  const listHtml = (arr) =>
    arr && arr.length
      ? `<ul class="sum-list">${arr.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>`
      : '<p class="sum-empty">无</p>';

  const todoHtml = (items) =>
    items && items.length
      ? `<ul class="todo-list">${items
          .map((t) => {
            const sec = parseClock(t.at);
            const at =
              sec != null
                ? `<button class="todo-at" data-ms="${sec * 1000}">${escapeHtml(t.at)}</button>`
                : "";
            return `<li><span class="todo-box" aria-hidden="true"></span>
              <span class="todo-text">${escapeHtml(t.text)}</span>
              <span class="todo-owner">${escapeHtml(t.owner || "未提及")}</span>${at}</li>`;
          })
          .join("")}</ul>`
      : '<p class="sum-empty">无</p>';

  const sectionHtml = sections
    .map((section) => {
      let body;
      if (section.type === "todos") body = todoHtml(section.items);
      else if (section.type === "text") {
        body =
          section.items && section.items.length
            ? section.items.map((x) => `<p class="sum-topic">${escapeHtml(x)}</p>`).join("")
            : '<p class="sum-empty">（无）</p>';
      } else body = listHtml(section.items);
      return `<div class="sum-section"><span class="sum-label">${escapeHtml(section.title)}</span>${body}</div>`;
    })
    .join("");

  const attendees =
    extras.attendees !== false && json.attendees && json.attendees.length
      ? `<div class="sum-section"><span class="sum-label">参会人</span>
           <p class="sum-topic">${escapeHtml(json.attendees.join("、"))}</p></div>`
      : "";

  const markers =
    json.markers && json.markers.length
      ? `<div class="sum-section"><span class="sum-label">现场标记</span><ul class="sum-list">${json.markers
          .map((m) => {
            const sec = parseClock(m.at);
            const at =
              sec != null
                ? `<button class="todo-at" data-ms="${sec * 1000}">${escapeHtml(m.at)}</button>`
                : "";
            return `<li><span class="todo-text">${escapeHtml(m.text)}</span>
              <span class="todo-owner">${escapeHtml(usedLabel(m.usedIn, detail.templateId))}</span>${at}</li>`;
          })
          .join("")}</ul></div>`
      : "";

  const speakerPoints =
    extras.speakerPoints !== false && json.speakerPoints && json.speakerPoints.length
      ? `<div class="sum-section"><span class="sum-label">按人要点</span><ul class="sum-list">${json.speakerPoints
          .map((s) => `<li><b>${escapeHtml(s.speaker)}</b>：${escapeHtml((s.points || []).join("；"))}</li>`)
          .join("")}</ul></div>`
      : "";

  const orphan = detail.templateMissing
    ? '<p class="sum-orphan">生成时使用的模板已被删除，以下按当时的快照展示</p>'
    : "";

  summaryBody.innerHTML = `
    ${orphan}
    <div class="sum-section">
      <span class="sum-label">主题</span>
      <p class="sum-topic">${escapeHtml(json.topic || "（未提炼出主题）")}</p>
    </div>
    ${sectionHtml}
    ${attendees}
    ${markers}
    ${speakerPoints}`;
}

/** 点胶囊只切「当前」，不重新调模型 */
export async function switchMinute(id) {
  if (state.minutesBusy || !id || id === "__pending__") return;
  const [patched, detail] = await Promise.all([
    jsonFetch(API.minute(id), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ current: true }),
    }),
    jsonFetch(API.minute(id)),
  ]);
  if (!patched.success) return showError(patched.error || "切换失败");
  if (!detail.success) return showError(detail.error || "读取纪要失败");
  state.minutes = patched.items || state.minutes;
  state.minutesCurrent = detail.minutes;
  renderMinutesCard();
}

export async function deleteMinute(id) {
  const target = state.minutes.find((m) => m.id === id);
  if (!target) return;
  const ok = await confirmDialog({
    title: "删除这一份纪要",
    body: `「${target.templateName}」这份纪要将被删除，无法恢复。同一记录的其他纪要不受影响。`,
    okText: "删除",
  });
  if (!ok) return;

  const data = await jsonFetch(API.minute(id), { method: "DELETE" });
  if (!data.success) return showError(data.error || "删除失败");
  await hydrateMinutes(data.minutes || []);
}

export function initMinutesPanel() {
  minuteTabs.addEventListener("click", (e) => {
    const del = e.target.closest("[data-del]");
    if (del) {
      e.stopPropagation();
      deleteMinute(del.dataset.del);
      return;
    }
    const pill = e.target.closest(".minute-tab");
    if (pill && !pill.classList.contains("is-generating")) switchMinute(pill.dataset.id);
  });

}
