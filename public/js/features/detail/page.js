/**
 * 详情页：转写全文、说话人、音频播放、纪要卡片、收藏 / 导出 / 删除。
 */

import { $ } from "../../core/dom.js";
import { API, jsonFetch } from "../../core/api.js";
import { BUS, emit, on } from "../../core/bus.js";
import { formatDate, formatDuration, escapeHtml } from "../../core/format.js";
import { getFavorites, toggleFavorite } from "../../core/storage.js";
import { showError } from "../../core/toast.js";
import { state } from "../../core/store.js";
import { switchView } from "../../core/router.js";
import { confirmDialog } from "../../components/modal.js";
import { renderTranscriptRows } from "../../components/transcript-row.js";
import { hydrateMinutes, stopMinutesPoll } from "../minutes/panel.js";
import { autoGenerateMinutes, copyText } from "../minutes/actions.js";
import { watchJob } from "../upload/page.js";
import { seekTo, pausePlayer, playerBar, player, initPlayer } from "./player.js";
import { initTranscriptInteractions } from "./speaker-rename.js";
import { initExport } from "./export.js";

const detailTitle = $("#detailTitle");
const detailMeta = $("#detailMeta");
const jobBanner = $("#jobBanner");
const diarizeBanner = $("#diarizeBanner");
const btnFav = $("#btnFav");
const btnDelete = $("#btnDelete");
const btnBackDetail = $("#btnBackDetail");
const btnCopy = $("#btnCopy");
const segList = $("#segList");
const segCount = $("#segCount");
const resultText = $("#resultText");
const usageInfo = $("#usageInfo");
const summaryBody = $("#summaryBody");

export async function openDetail({ jobId = null, recordId = null, autoMinutes = false } = {}) {
  stopMinutesPoll();
  try {
    if (jobId) {
      const data = await jsonFetch(API.job(jobId));
      if (!data.success) return showError(data.error || "任务不存在");
      renderJobDetail(data);
      switchView("detail");
      if (autoMinutes && state.autoMinutes && !state.minutes.length) autoGenerateMinutes();
      return;
    }

    const data = await jsonFetch(API.record(recordId));
    if (!data.success) return showError(data.error || "记录不存在");
    const record = data.record;
    if (record.job_id) {
      await openDetail({ jobId: record.job_id });
      return;
    }
    renderLegacyDetail(record, data.minutes || []);
    switchView("detail");
  } catch {
    showError("网络错误，请检查后端是否启动");
  }
}

function setMeta(record, job) {
  const parts = [];
  if (job) parts.push(`<span>来源 <b>${record?.source === "recording" ? "实时录音" : "上传文件"}</b></span>`);
  parts.push(`<span>创建 <b>${formatDate(record?.created_at)}</b></span>`);
  const dur = job?.durationMs ? job.durationMs / 1000 : record?.duration;
  parts.push(`<span>时长 <b>${formatDuration(dur)}</b></span>`);
  if (job?.speakerCount) parts.push(`<span>说话人 <b>${job.speakerCount} 人</b></span>`);
  else if (job?.chunkTotal) parts.push(`<span>分段 <b>${job.chunkTotal}</b></span>`);
  detailMeta.innerHTML = parts.join("");
}

function renderDiarizeBanner(job) {
  const st = job?.diarizeStatus;
  if (!st || st === "off" || st === "ok") {
    diarizeBanner.hidden = true;
    return;
  }
  diarizeBanner.hidden = false;
  const msg =
    st === "suspect"
      ? "疑似过度聚类：说话人数量可能偏多，可指定参会人数后重新标注"
      : "本次未能区分说话人（所有句子被识别为同一人），文本与纪要仍可用";
  diarizeBanner.innerHTML = `<span>${escapeHtml(msg)}</span>
    <button class="btn btn-ghost" id="btnRediarize">重新标注</button>`;

  const btn = $("#btnRediarize");
  if (btn) {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "正在重新标注";
      const data = await jsonFetch(API.jobDiarize(job.id), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!data.success) {
        showError(data.error || "重新标注失败");
        btn.disabled = false;
        btn.textContent = "重新标注";
        return;
      }
      watchJob(job.id, "重新标注说话人");
    });
  }
}

function renderJobDetail(data) {
  const { job, segments, record } = data;
  state.job = job;
  state.record = record;
  state.segments = segments;
  state.markers = data.markers || [];
  state.speakers = data.speakers || [];

  detailTitle.textContent = record?.title || "处理结果";
  setMeta(record, job);
  btnFav.classList.toggle("active", record ? getFavorites().has(record.id) : false);

  jobBanner.hidden = true;
  if (job.status === "failed") {
    jobBanner.hidden = false;
    jobBanner.innerHTML = `<span>${escapeHtml(job.error || "任务中断")}</span>
      <button class="btn btn-ghost" id="btnResume">继续处理</button>`;
    const btnResume = $("#btnResume");
    if (btnResume) {
      btnResume.addEventListener("click", async () => {
        btnResume.disabled = true;
        btnResume.textContent = "正在续跑";
        await jsonFetch(API.jobResume(job.id), { method: "POST" });
        watchJob(job.id, "继续处理");
      });
    }
  }

  renderDiarizeBanner(job);

  if (data.hasAudio) {
    playerBar.hidden = false;
    player.src = API.jobAudio(job.id);
  } else {
    playerBar.hidden = true;
    player.removeAttribute("src");
  }

  const withText = segments.filter((s) => (s.text || "").trim());
  if (withText.length) {
    segList.hidden = false;
    resultText.hidden = true;
    const parts = [];
    if (state.speakers.length) parts.push(`${state.speakers.length} 人`);
    if (state.markers.length) parts.push(`${state.markers.length} 条标记`);
    segCount.textContent = parts.join(" · ") || `${withText.length} 段`;
    segList.innerHTML = renderTranscriptRows(withText, state.markers, state.speakers);
  } else {
    segList.hidden = true;
    resultText.hidden = false;
    resultText.textContent = record?.transcript || "（无识别结果）";
    segCount.textContent = "";
  }

  usageInfo.textContent = record
    ? `分段 ${segments.length} · 引擎 ${[...new Set(segments.map((s) => s.engine).filter(Boolean))].join(" / ") || "—"}`
    : "";

  hydrateMinutes(record?.minutes || []);
}

function renderLegacyDetail(record, minutes = []) {
  state.record = record;
  state.job = null;
  state.segments = [];
  state.markers = [];
  state.speakers = [];
  detailTitle.textContent = record.title;
  setMeta(record, null);
  btnFav.classList.toggle("active", getFavorites().has(record.id));
  jobBanner.hidden = true;
  diarizeBanner.hidden = true;
  playerBar.hidden = true;
  segList.hidden = true;
  resultText.hidden = false;
  resultText.textContent = record.transcript || "（无识别结果）";
  segCount.textContent = "";
  usageInfo.textContent = record.language ? `语言 ${record.language}` : "";
  hydrateMinutes(minutes);
}

export function initDetailPage() {
  initPlayer();
  initExport();
  initTranscriptInteractions({
    seekTo,
    onReload: () => openDetail({ jobId: state.job && state.job.id }),
  });

  // 纪要里的待办 / 标记时间点也能跳转
  summaryBody.addEventListener("click", (e) => {
    const btn = e.target.closest(".todo-at");
    if (btn) seekTo(Number(btn.dataset.ms));
  });

  $("#btnBackDetail").addEventListener("click", () => {
    pausePlayer();
    switchView("home");
    emit(BUS.RECORDS_RELOAD);
  });

  btnFav.addEventListener("click", () => {
    if (!state.record) return;
    btnFav.classList.toggle("active", toggleFavorite(state.record.id));
  });

  btnDelete.addEventListener("click", async () => {
    if (!state.record) return;
    const ok = await confirmDialog({
      title: "删除记录",
      body: `确定删除「${state.record.title}」吗？音频、转写文件和纪要会一并清除，无法恢复。`,
      okText: "删除",
    });
    if (!ok) return;

    const data = await jsonFetch(API.record(state.record.id), { method: "DELETE" });
    if (!data.success) return showError(data.error || "删除失败");
    state.selected.delete(state.record.id);
    switchView("home");
    state.page = 1;
    emit(BUS.RECORDS_RELOAD);
  });

  btnCopy.addEventListener("click", () => {
    const text = state.segments.length
      ? state.segments.map((s) => (s.text || "").trim()).filter(Boolean).join("\n")
      : resultText.textContent;
    copyText(text, btnCopy);
  });

  on(BUS.OPEN_DETAIL, (payload) => openDetail(payload));
}
