/**
 * 记录列表页：搜索、tab、视图切换、分页、多选与批量删除。
 */

import { $, $$ } from "../../core/dom.js";
import { API, jsonFetch, postJson } from "../../core/api.js";
import { BUS, emit, on } from "../../core/bus.js";
import { getFavorites, saveFavorites, KEYS, write } from "../../core/storage.js";
import { showError } from "../../core/toast.js";
import { state } from "../../core/store.js";
import { onViewChange } from "../../core/router.js";
import { confirmDialog } from "../../components/modal.js";
import { fetchRecords, renderRecords } from "./list.js";

const recordsBody = $("#recordsBody");
const searchInput = $("#searchInput");
const checkAll = $("#checkAll");
const selBar = $("#selBar");
const selCount = $("#selCount");
const btnSelDelete = $("#btnSelDelete");
const btnSelCancel = $("#btnSelCancel");
const btnLoadMore = $("#btnLoadMore");

/* ---------------- 批量选择 ---------------- */

export function updateSelBar() {
  const n = state.selected.size;
  const show = n > 0 && state.view === "home";
  selBar.hidden = !show;
  document.body.classList.toggle("has-sel", show);
  if (!show) return;
  selCount.textContent = `已选择 ${n} 项`;
  btnSelDelete.textContent = "删除";
}

/** 把 state.selected 同步到复选框、行高亮和全选框 */
export function syncSelection() {
  for (const row of recordsBody.querySelectorAll(".record-row")) {
    row.classList.toggle("is-selected", state.selected.has(row.dataset.id));
  }
  for (const box of recordsBody.querySelectorAll(".row-sel")) {
    box.checked = state.selected.has(box.dataset.id);
  }

  const total = state.items.length;
  const picked = state.items.filter((it) => state.selected.has(it.id)).length;
  checkAll.checked = total > 0 && picked === total;
  checkAll.indeterminate = picked > 0 && picked < total;

  updateSelBar();
}

export function clearSelection() {
  state.selected.clear();
  syncSelection();
}

/* ---------------- 事件绑定 ---------------- */

export function initRecordsPage() {
  recordsBody.addEventListener("click", (e) => {
    // 勾选区不触发打开详情，交给 checkbox 自己处理
    if (e.target.closest(".rec-check")) return;
    const open = e.target.closest(".rec-open");
    if (open) emit(BUS.OPEN_DETAIL, { recordId: open.dataset.id });
  });

  recordsBody.addEventListener("change", (e) => {
    const box = e.target.closest(".row-sel");
    if (!box) return;
    if (box.checked) state.selected.add(box.dataset.id);
    else state.selected.delete(box.dataset.id);
    syncSelection();
  });

  // 键盘：Enter / Space 打开记录（焦点在复选框时不拦截）
  recordsBody.addEventListener("keydown", (e) => {
    if (e.target.closest(".row-sel")) return;
    if (e.key !== "Enter" && e.key !== " ") return;
    const open = e.target.closest(".rec-open");
    if (!open) return;
    e.preventDefault();
    emit(BUS.OPEN_DETAIL, { recordId: open.dataset.id });
  });

  checkAll.addEventListener("change", () => {
    if (checkAll.checked) {
      for (const it of state.items) state.selected.add(it.id);
    } else {
      state.selected.clear();
    }
    syncSelection();
  });

  btnSelCancel.addEventListener("click", clearSelection);

  btnSelDelete.addEventListener("click", async () => {
    const ids = [...state.selected];
    if (!ids.length) return;

    const ok = await confirmDialog({
      title: `删除 ${ids.length} 项记录`,
      body: "删除后，这些记录的音频、转写文本和会议纪要都会一并清除，无法恢复。",
      okText: "删除",
    });
    if (!ok) return;

    btnSelDelete.disabled = true;
    try {
      const data = await postJson(API.recordBatchDelete, { ids });
      if (!data.success) throw new Error(data.error || "删除失败");

      // 收藏列表里也要清掉，否则「收藏」页会残留空记录
      const favs = getFavorites();
      let favChanged = false;
      for (const id of ids) if (favs.delete(id)) favChanged = true;
      if (favChanged) saveFavorites(favs);

      state.selected.clear();
      if (state.items.length === ids.length && state.page > 1) state.page -= 1;
      await fetchRecords();
    } catch (err) {
      showError(err.message || "删除失败");
    } finally {
      btnSelDelete.disabled = false;
    }
  });

  btnLoadMore.addEventListener("click", () => {
    state.page += 1;
    fetchRecords({ append: true });
  });

  $("#tabs").addEventListener("click", (e) => {
    const tab = e.target.closest(".tab");
    if (!tab || tab.disabled) return;
    $$(".tab").forEach((t) => t.classList.toggle("active", t === tab));
    state.tab = tab.dataset.tab;
    state.page = 1;
    clearSelection();
    fetchRecords();
  });

  let searchTimer;
  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.q = searchInput.value.trim();
      state.page = 1;
      clearSelection();
      fetchRecords();
    }, 300);
  });

  $("#viewToggle").addEventListener("click", (e) => {
    const btn = e.target.closest(".vt-btn");
    if (!btn) return;
    $$(".vt-btn").forEach((b) => b.classList.toggle("active", b === btn));
    state.viewMode = btn.dataset.mode;
    write(KEYS.viewMode, state.viewMode);
    renderRecords();
  });

  // 切视图时同步批量操作条（录音/上传页不显示）
  onViewChange(() => updateSelBar());

  // 列表每次重渲染后同步全选框与批量操作条
  on(BUS.RECORDS_RENDERED, () => syncSelection());

  // 其他 feature 请求刷新列表
  on(BUS.RECORDS_RELOAD, () => {
    state.page = 1;
    fetchRecords();
  });
}

export { fetchRecords };
