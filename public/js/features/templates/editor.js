/**
 * 模板编辑浮层：新建 / 编辑，章节可增删排序。
 */

import { $ } from "../../core/dom.js";
import { API, postJson } from "../../core/api.js";
import { BUS, emit } from "../../core/bus.js";
import { escapeAttr } from "../../core/format.js";
import { showError } from "../../core/toast.js";
import { lockScroll } from "../../core/scroll-lock.js";
import { confirmDialog } from "../../components/modal.js";
import { loadTemplates } from "./picker.js";

const tplEditor = $("#tplEditor");
const edName = $("#edName");
const edDesc = $("#edDesc");
const edExtra = $("#edExtra");
const edSectionList = $("#edSectionList");
const edError = $("#edError");
const edSave = $("#edSave");
const edTitle = $("#tplEditorTitle");

let editingTemplate = null;
let editorSections = [];
let editorBase = "";

const MAX_SECTIONS = 8;

function sectionRowHtml(section, i) {
  const typeOpts = [
    ["list", "列表"],
    ["text", "段落"],
    ["todos", "待办"],
  ]
    .map(([v, label]) => `<option value="${v}"${section.type === v ? " selected" : ""}>${label}</option>`)
    .join("");
  return `<div class="ed-sec" data-i="${i}">
    <div class="ed-sec-top">
      <input class="ed-sec-title" maxlength="20" value="${escapeAttr(section.title || "")}" placeholder="章节标题">
      <select class="ed-sec-type">${typeOpts}</select>
      <button class="ed-sec-btn" data-move="up" title="上移"${i === 0 ? " disabled" : ""}>↑</button>
      <button class="ed-sec-btn" data-move="down" title="下移"${i === editorSections.length - 1 ? " disabled" : ""}>↓</button>
      <button class="ed-sec-btn ed-sec-del" data-remove="1" title="删除">×</button>
    </div>
    <input class="ed-sec-hint" maxlength="200" value="${escapeAttr(section.hint || "")}" placeholder="写作提示（可选，会写进提示词）">
  </div>`;
}

function renderEditorSections() {
  edSectionList.innerHTML = editorSections.map(sectionRowHtml).join("");
}

function readEditorSections() {
  return Array.from(edSectionList.querySelectorAll(".ed-sec")).map((row) => ({
    title: row.querySelector(".ed-sec-title").value.trim(),
    type: row.querySelector(".ed-sec-type").value,
    hint: row.querySelector(".ed-sec-hint").value.trim(),
  }));
}

function editorSnapshot() {
  return JSON.stringify({
    name: edName.value.trim(),
    desc: edDesc.value.trim(),
    extra: edExtra.value.trim(),
    sections: readEditorSections(),
  });
}

export function openEditor(tpl = null) {
  editingTemplate = tpl;
  edTitle.textContent = tpl ? "编辑模板" : "新建模板";
  edName.value = tpl ? tpl.name : "";
  edDesc.value = tpl ? tpl.description || "" : "";
  edExtra.value = tpl ? tpl.promptExtra || "" : "";
  editorSections =
    tpl && tpl.sections.length ? tpl.sections.map((s) => ({ ...s })) : [{ title: "会议内容", type: "list", hint: "" }];
  edError.textContent = "";
  renderEditorSections();
  editorBase = editorSnapshot();
  lockScroll(true);
  tplEditor.hidden = false;
  edName.focus();
}

export async function closeEditor(force = false) {
  if (!tplEditor || tplEditor.hidden) return;
  if (!force && editorSnapshot() !== editorBase) {
    const ok = await confirmDialog({
      title: "放弃修改",
      body: "模板还没保存，关闭后这次改动会丢失。",
      okText: "放弃修改",
    });
    if (!ok) return;
  }
  tplEditor.hidden = true;
  lockScroll(false);
}

export function isEditorOpen() {
  return Boolean(tplEditor) && !tplEditor.hidden;
}

async function save() {
  const payload = {
    name: edName.value.trim(),
    description: edDesc.value.trim(),
    promptExtra: edExtra.value.trim(),
    sections: readEditorSections(),
  };
  if (!payload.name) {
    edError.textContent = "模板名称不能为空";
    return;
  }
  if (payload.sections.some((s) => !s.title)) {
    edError.textContent = "每个章节都需要标题";
    return;
  }

  edSave.disabled = true;
  edError.textContent = "";
  try {
    const url = editingTemplate ? API.template(editingTemplate.id) : API.templates;
    const data = await postJson(url, payload, editingTemplate ? "PATCH" : "POST");
    if (!data.success) {
      edError.textContent = data.error || "保存失败";
      return;
    }
    await closeEditor(true);
    await loadTemplates(true);
    emit(BUS.TEMPLATES_CHANGED);
  } catch {
    edError.textContent = "网络错误，请稍后重试";
  } finally {
    edSave.disabled = false;
  }
}

export function initEditor() {
  edSectionList.addEventListener("click", (e) => {
    const row = e.target.closest(".ed-sec");
    if (!row) return;
    const i = Number(row.dataset.i);

    if (e.target.closest("[data-remove]")) {
      if (editorSections.length <= 1) return showError("至少保留一个章节");
      editorSections.splice(i, 1);
      renderEditorSections();
      return;
    }

    const move = e.target.closest("[data-move]");
    if (move) {
      const j = move.dataset.move === "up" ? i - 1 : i + 1;
      if (j < 0 || j >= editorSections.length) return;
      editorSections = readEditorSections();
      const [item] = editorSections.splice(i, 1);
      editorSections.splice(j, 0, item);
      renderEditorSections();
    }
  });

  $("#edAddSection").addEventListener("click", () => {
    if (editorSections.length >= MAX_SECTIONS) return showError(`最多 ${MAX_SECTIONS} 个章节`);
    editorSections = readEditorSections();
    editorSections.push({ title: "", type: "list", hint: "" });
    renderEditorSections();
  });

  edSave.addEventListener("click", save);

  tplEditor.addEventListener("click", (e) => {
    if (e.target === tplEditor || e.target.closest("[data-close-editor]")) closeEditor();
  });
}
