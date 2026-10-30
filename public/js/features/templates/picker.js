/**
 * 模板选择浮层：上传页预设模板、详情页首次生成、再生成一份，三处共用。
 *
 * openPicker() 返回 Promise<string|null>，null 表示取消。
 */

import { $, $$ } from "../../core/dom.js";
import { API, jsonFetch } from "../../core/api.js";
import { BUS, emit, on } from "../../core/bus.js";
import { escapeHtml } from "../../core/format.js";
import { showError } from "../../core/toast.js";
import { lockScroll } from "../../core/scroll-lock.js";
import { state } from "../../core/store.js";
import { KEYS, write } from "../../core/storage.js";

const tplPicker = $("#tplPicker");
const tplPickerList = $("#tplPickerList");
const tplSearch = $("#tplSearch");
const tplPickerOk = $("#tplPickerOk");
const tplPickerNote = $("#tplPickerNote");
const templateName = $("#templateName");

let pickerResolve = null;
let pickerSelected = null;

export async function loadTemplates(force = false) {
  if (state.templates.length && !force) return state.templates;
  const data = await jsonFetch(API.templates);
  if (data.success) {
    state.templates = data.items || [];
    state.defaultTemplateId = data.defaultId || (state.templates[0] && state.templates[0].id) || null;
    if (!state.templates.some((t) => t.id === state.templateId)) {
      state.templateId = state.defaultTemplateId;
    }
  } else {
    showError("模板加载失败，请检查后端是否启动");
  }
  return state.templates;
}

export function templateById(id) {
  return state.templates.find((t) => t.id === id) || null;
}

export function updateTemplateLabel() {
  const tpl = templateById(state.templateId) || state.templates.find((t) => t.builtin);
  if (templateName) templateName.textContent = tpl ? tpl.name : "默认模板";
}

function filteredTemplates() {
  const q = tplSearch.value.trim().toLowerCase();
  return state.templates.filter(
    (t) =>
      !q ||
      t.name.toLowerCase().includes(q) ||
      (t.description || "").toLowerCase().includes(q)
  );
}

function renderPickerList() {
  const rows = filteredTemplates();
  if (!rows.length) {
    tplPickerList.innerHTML = '<p class="tpl-empty">没有匹配的模板</p>';
    return;
  }
  tplPickerList.innerHTML = rows
    .map((t) => {
      const chapters = (t.sections || []).map((x) => x.title).join(" · ");
      return `<button class="tpl-opt${t.id === pickerSelected ? " is-selected" : ""}" data-id="${t.id}" role="radio" aria-checked="${t.id === pickerSelected}">
        <span class="tpl-opt-dot" aria-hidden="true"></span>
        <span class="tpl-opt-main">
          <span class="tpl-opt-name">${escapeHtml(t.name)}${
            t.builtin ? '<em class="tpl-badge">内置</em>' : ""
          }</span>
          <span class="tpl-opt-desc">${escapeHtml(t.description || chapters || "无说明")}</span>
        </span>
      </button>`;
    })
    .join("");
}

export async function openPicker({ selectedId = null, note = "" } = {}) {
  await loadTemplates();
  if (!state.templates.length) {
    showError("还没有可用模板");
    return null;
  }
  return new Promise((resolve) => {
    pickerResolve = resolve;
    const fallback = state.templates.find((t) => t.builtin) || state.templates[0];
    pickerSelected = selectedId || state.templateId || fallback.id;
    if (!state.templates.some((t) => t.id === pickerSelected)) pickerSelected = fallback.id;
    tplPickerNote.textContent = note;
    tplSearch.value = "";
    tplSearch.hidden = state.templates.length <= 5;
    renderPickerList();
    lockScroll(true);
    tplPicker.hidden = false;
    tplPickerOk.focus();
  });
}

export function closePicker(result) {
  if (!tplPicker || tplPicker.hidden) return;
  tplPicker.hidden = true;
  lockScroll(false);
  const resolve = pickerResolve;
  pickerResolve = null;
  if (resolve) resolve(result || null);
}

export function isPickerOpen() {
  return Boolean(tplPicker) && !tplPicker.hidden;
}

/** 上传页的「选择模板」按钮 */
export function initUploadTemplateButton(btn) {
  if (!btn) return;
  btn.addEventListener("click", async () => {
    const id = await openPicker({ note: "选定后，转写完成即用该模板生成纪要" });
    if (!id) return;
    state.templateId = id;
    write(KEYS.lastTemplateId, id);
    updateTemplateLabel();
  });
}

export function initPicker() {
  tplPickerList.addEventListener("click", (e) => {
    const opt = e.target.closest(".tpl-opt");
    if (!opt) return;
    pickerSelected = opt.dataset.id;
    renderPickerList();
  });

  tplSearch.addEventListener("input", renderPickerList);

  tplPicker.addEventListener("keydown", (e) => {
    const rows = filteredTemplates();
    if (!rows.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const i = rows.findIndex((t) => t.id === pickerSelected);
      const next =
        e.key === "ArrowDown"
          ? Math.min(rows.length - 1, i < 0 ? 0 : i + 1)
          : Math.max(0, i <= 0 ? 0 : i - 1);
      pickerSelected = rows[next].id;
      renderPickerList();
      const el = tplPickerList.querySelector(`.tpl-opt[data-id="${pickerSelected}"]`);
      if (el) el.focus();
      return;
    }
    if (e.key === "Enter" && document.activeElement !== tplSearch) {
      e.preventDefault();
      closePicker(pickerSelected);
    }
  });

  tplPickerOk.addEventListener("click", () => closePicker(pickerSelected));
  tplPicker.addEventListener("click", (e) => {
    if (e.target === tplPicker || e.target.closest("[data-close-picker]")) closePicker(null);
  });

  on(BUS.TEMPLATES_CHANGED, () => updateTemplateLabel());
}
