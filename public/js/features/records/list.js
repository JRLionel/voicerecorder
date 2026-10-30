/**
 * 记录列表：拉取与渲染。
 *
 * 只负责「数据 → HTML」，交互绑在 page.js；
 * 打开详情通过事件总线，避免 records ↔ detail 互相 import。
 */

import { $ } from "../../core/dom.js";
import { API, jsonFetch } from "../../core/api.js";
import { BUS, emit } from "../../core/bus.js";
import { formatDate, formatDuration, formatSize, escapeAttr, escapeHtml } from "../../core/format.js";
import { getFavorites } from "../../core/storage.js";
import { showError } from "../../core/toast.js";
import { state } from "../../core/store.js";
import { recordThumb, waveIcon } from "../../components/icons.js";

const recordsBody = $("#recordsBody");
const listLoading = $("#listLoading");
const btnLoadMore = $("#btnLoadMore");

const SOURCE_LABEL = { upload: "上传文件", recording: "实时录音" };

export async function fetchRecords({ append = false } = {}) {
  listLoading.classList.add("show");
  try {
    const params = new URLSearchParams({ q: state.q, page: state.page, pageSize: state.pageSize });
    const data = await jsonFetch(`${API.records}?${params}`);
    if (!data.success) return showError(data.error || "获取记录列表失败");

    let items = data.items || [];
    if (state.tab === "fav") {
      const favs = getFavorites();
      items = items.filter((it) => favs.has(it.id));
    }
    state.total = data.total;
    state.items = append ? state.items.concat(items) : items;
    renderRecords();
  } catch {
    showError("网络错误，请检查后端是否启动");
  } finally {
    listLoading.classList.remove("show");
  }
}

export function renderRecords() {
  const grid = state.viewMode === "grid";
  recordsBody.classList.toggle("grid-mode", grid);
  const head = document.querySelector(".records-head");
  if (head) head.style.display = grid ? "none" : "";

  if (!state.items.length) {
    const hints = {
      recent: "上传录屏、音频，或直接开始录音",
      fav: "收藏的记录会出现在这里",
    };
    recordsBody.innerHTML = `
      <div class="empty-state">
        ${waveIcon}
        <span class="empty-title">暂无记录</span>
        <span class="empty-hint">${hints[state.tab] || hints.recent}</span>
      </div>`;
    btnLoadMore.style.display = "none";
    emit(BUS.RECORDS_RENDERED);
    return;
  }

  recordsBody.innerHTML = state.items
    .map((it, i) => {
      const metaLine = grid
        ? `<span class="rec-meta-line"><span>${formatDate(it.created_at)}</span><span>${formatDuration(it.duration)}</span><span>${formatSize(it.size)}</span></span>`
        : `
          <span class="rec-col rh-time">${formatDate(it.created_at)}</span>
          <span class="rec-col rh-dur">${formatDuration(it.duration)}</span>
          <span class="rec-src">${SOURCE_LABEL[it.source] || "上传文件"}</span>
          <span class="rec-col rh-size">${formatSize(it.size)}</span>`;
      const picked = state.selected.has(it.id);
      return `
        <div class="record-row${picked ? " is-selected" : ""}" data-id="${it.id}" style="animation-delay:${Math.min(i * 40, 320)}ms">
          <label class="rec-check">
            <input type="checkbox" class="sel-box row-sel" data-id="${it.id}" aria-label="选择「${escapeAttr(it.title)}」"${picked ? " checked" : ""}>
          </label>
          <button class="rec-open" type="button" data-id="${it.id}" aria-label="打开「${escapeAttr(it.title)}」">
            <span class="rec-main">
              ${recordThumb(it.template)}
              <span class="rec-text">
                <span class="rec-title">${escapeHtml(it.title)}</span>
                <span class="rec-summary">${escapeHtml(it.summary || "（暂无摘要）")}</span>
              </span>
            </span>
            ${metaLine}
          </button>
        </div>`;
    })
    .join("");

  btnLoadMore.style.display = state.items.length < state.total ? "inline-flex" : "none";
  emit(BUS.RECORDS_RENDERED);
}
