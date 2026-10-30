/**
 * 模板管理页：系统模板与我的模板分组、单选/全选、批量删除。
 */

import { $ } from "../../core/dom.js";
import { API, jsonFetch, postJson } from "../../core/api.js";
import { BUS, emit, on } from "../../core/bus.js";
import { escapeAttr, escapeHtml } from "../../core/format.js";
import { showError } from "../../core/toast.js";
import { state } from "../../core/store.js";
import { switchView } from "../../core/router.js";
import { confirmDialog } from "../../components/modal.js";
import { loadTemplates, templateById, updateTemplateLabel } from "./picker.js";
import { openEditor } from "./editor.js";

const builtinList = $("#builtinList");
const mineList = $("#mineList");
const tplCheckAll = $("#tplCheckAll");
const tplSelCount = $("#tplSelCount");
const btnTplBatchDelete = $("#btnTplBatchDelete");

function tplCardHtml(t) {
  const chapters = (t.sections || []).map((x) => x.title).join(" · ");
  const check = t.builtin
    ? ""
    : `<input type="checkbox" class="tpl-sel" data-sel="${t.id}"${state.selectedTemplates.has(t.id) ? " checked" : ""} aria-label="选择「${escapeAttr(t.name)}」">`;
  const actions = t.builtin
    ? `<button class="tpl-act" data-act="duplicate" data-id="${t.id}">复制为我的模板</button>`
    : `<button class="tpl-act" data-act="edit" data-id="${t.id}">编辑</button>
       <button class="tpl-act" data-act="duplicate" data-id="${t.id}">复制</button>
       <button class="tpl-act tpl-act-danger" data-act="delete" data-id="${t.id}">删除</button>`;
  return `<article class="tpl-card${t.builtin ? " is-builtin" : ""}${state.selectedTemplates.has(t.id) ? " is-selected" : ""}">
    <div class="tpl-card-head">
      <span class="tpl-icon c-${escapeAttr(t.color || "blue")}" aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>
        </svg>
      </span>
      <span class="tpl-card-name">${escapeHtml(t.name)}${
        t.builtin ? '<em class="tpl-badge">内置</em>' : ""
      }</span>
      ${check}
    </div>
    <p class="tpl-card-desc">${escapeHtml(t.description || "无说明")}</p>
    <p class="tpl-card-chapters">${escapeHtml(chapters)}</p>
    <div class="tpl-card-foot">${actions}</div>
  </article>`;
}

export function renderTemplatesPage() {
  const builtins = state.templates.filter((t) => t.builtin);
  const mine = state.templates.filter((t) => !t.builtin);
  builtinList.innerHTML = builtins.map(tplCardHtml).join("") || '<p class="tpl-empty">暂无系统模板</p>';
  mineList.innerHTML =
    mine.map(tplCardHtml).join("") ||
    `<div class="tpl-empty tpl-empty-mine">
       <p>还没有自定义模板</p>
       <button class="btn btn-ghost" data-act="duplicate" data-id="${builtins[0] ? builtins[0].id : ""}">从系统模板复制一份</button>
     </div>`;
  syncTplSelection();
}

function syncTplSelection() {
  const mine = state.templates.filter((t) => !t.builtin);
  const picked = mine.filter((t) => state.selectedTemplates.has(t.id)).length;
  tplSelCount.textContent = `已选 ${picked} 项`;
  tplCheckAll.checked = mine.length > 0 && picked === mine.length;
  tplCheckAll.indeterminate = picked > 0 && picked < mine.length;
  btnTplBatchDelete.disabled = picked === 0;
  for (const card of document.querySelectorAll(".tpl-card")) {
    const box = card.querySelector("[data-sel]");
    if (box) card.classList.toggle("is-selected", box.checked);
  }
}

async function refresh() {
  await loadTemplates(true);
  renderTemplatesPage();
  updateTemplateLabel();
}

async function handleTplAction(act, id) {
  if (act === "edit") {
    const tpl = templateById(id);
    if (tpl) openEditor(tpl);
    return;
  }

  if (act === "duplicate") {
    if (!id) return;
    const data = await jsonFetch(API.templateDuplicate(id), { method: "POST" });
    if (!data.success) return showError(data.error || "复制失败");
    await refresh();
    return;
  }

  if (act === "delete") {
    const tpl = templateById(id);
    if (!tpl) return;
    const ok = await confirmDialog({
      title: "删除模板",
      body: `确定删除「${tpl.name}」吗？用它生成过的历史纪要不受影响。`,
      okText: "删除",
    });
    if (!ok) return;
    const data = await jsonFetch(API.template(id), { method: "DELETE" });
    if (!data.success) return showError(data.error || "删除失败");
    state.selectedTemplates.delete(id);
    await refresh();
  }
}

async function batchDeleteTemplates() {
  const ids = [...state.selectedTemplates];
  if (!ids.length) return;
  const ok = await confirmDialog({
    title: "删除所选模板",
    body: `将删除 ${ids.length} 个模板。用它们生成过的历史纪要不受影响，系统模板不会被删除。`,
    okText: "删除",
  });
  if (!ok) return;

  const data = await postJson(API.templatesBatchDelete, { ids });
  if (!data.success) return showError(data.error || "删除失败");
  state.selectedTemplates.clear();
  await refresh();
  if (data.skipped && data.skipped.length) showError("系统模板已跳过");
}

export function initTemplatesPage() {
  for (const list of [builtinList, mineList]) {
    list.addEventListener("click", (e) => {
      const actBtn = e.target.closest("[data-act]");
      if (actBtn) {
        handleTplAction(actBtn.dataset.act, actBtn.dataset.id);
        return;
      }
      const box = e.target.closest("[data-sel]");
      if (box) {
        if (box.checked) state.selectedTemplates.add(box.dataset.sel);
        else state.selectedTemplates.delete(box.dataset.sel);
        syncTplSelection();
      }
    });
  }

  tplCheckAll.addEventListener("change", () => {
    const mine = state.templates.filter((t) => !t.builtin);
    if (tplCheckAll.checked) mine.forEach((t) => state.selectedTemplates.add(t.id));
    else mine.forEach((t) => state.selectedTemplates.delete(t.id));
    renderTemplatesPage();
  });

  btnTplBatchDelete.addEventListener("click", batchDeleteTemplates);

  $("#btnTemplates").addEventListener("click", async () => {
    emit(BUS.STOP_UPLOAD_POLL);
    state.selectedTemplates.clear();
    await refresh();
    switchView("templates");
  });

  $("#btnBackTemplates").addEventListener("click", () => {
    switchView("home");
    emit(BUS.RECORDS_RELOAD);
  });

  $("#btnNewTemplate").addEventListener("click", () => openEditor(null));

  // 编辑保存后自动刷新列表
  on(BUS.TEMPLATES_CHANGED, () => renderTemplatesPage());
}
