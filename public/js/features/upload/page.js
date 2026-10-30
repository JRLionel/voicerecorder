/**
 * 上传页：选文件、探测时长、开关分离、预设模板、开始处理。
 *
 * 入口卡片的点击由 main.js 统一分发（上传 / 录音是两个 feature）。
 */

import { $, $$ } from "../../core/dom.js";
import { API, jsonFetch } from "../../core/api.js";
import { BUS, emit, on } from "../../core/bus.js";
import { formatSize } from "../../core/format.js";
import { acceptOf, copy } from "../../core/meta.js";
import { showError } from "../../core/toast.js";
import { state } from "../../core/store.js";
import { switchView } from "../../core/router.js";
import { updateTemplateLabel } from "../templates/picker.js";
import { initDiarize, setDiarize, refreshDiarizeAvailability } from "./diarize.js";
import {
  resetProgress, renderProgress, pollJob, stopPolling, markProgressStart, initProgressBindings,
} from "./progress.js";

const uploadArea = $("#uploadArea");
const fileInput = $("#fileInput");
const uploadHint = $("#uploadHint");
const fileInfo = $("#fileInfo");
const fileName = $("#fileName");
const fileSize = $("#fileSize");
const btnRemove = $("#btnRemove");
const language = $("#language");
const btnStart = $("#btnStart");
const newViewTitle = $("#newViewTitle");
const progressCard = $("#progressCard");
const stageName = $("#stageName");
const stageDetail = $("#stageDetail");
const btnCancel = $("#btnCancel");
const autoMinutesCard = $("#autoMinutesCard");
const autoMinutesSwitch = $("#autoMinutesSwitch");
const templateField = $("#templateField");

/** 入口元信息：标题与提示来自 shared/copy/entries.json */
function entryMeta(entry) {
  const text = (copy().entries || {})[entry] || {};
  return {
    title: text.title || (entry === "video" ? "上传视频" : "上传音频"),
    hint: text.hint || "",
    accept: acceptOf(entry),
  };
}

export function openNew(entry) {
  state.entry = entry;
  const meta = entryMeta(entry);
  newViewTitle.textContent = meta.title;
  fileInput.accept = meta.accept;
  uploadHint.textContent = meta.hint;
  clearFile();
  resetProgress();
  setDiarize(false, { silent: true });
  refreshDiarizeAvailability();
  setAutoMinutes(state.autoMinutes);
  updateTemplateLabel();
  switchView("new");
  uploadArea.focus();
}

function setAutoMinutes(on) {
  state.autoMinutes = Boolean(on);
  localStorage.setItem("vs_auto_minutes", state.autoMinutes ? "1" : "0");
  autoMinutesSwitch.classList.toggle("is-on", state.autoMinutes);
  autoMinutesSwitch.classList.toggle("is-off", !state.autoMinutes);
  autoMinutesCard.setAttribute("aria-pressed", state.autoMinutes ? "true" : "false");
  templateField.hidden = !state.autoMinutes;
}

function setFile(file) {
  if (!file) return;
  fileName.textContent = file.name;
  fileSize.textContent = formatSize(file.size);
  fileInfo.classList.add("show");
  btnStart.disabled = false;
  state.fileDuration = null;
  probeFileDuration(file).then((sec) => {
    state.fileDuration = sec;
    refreshDiarizeAvailability();
  });
}

function clearFile() {
  fileInput.value = "";
  fileInfo.classList.remove("show");
  btnStart.disabled = true;
  state.fileDuration = null;
  refreshDiarizeAvailability();
}

/** 用 video 元素读元信息拿时长：音频也能被 video 解析 */
function probeFileDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const el = document.createElement("video");
    el.preload = "metadata";
    const done = (v) => {
      URL.revokeObjectURL(url);
      el.removeAttribute("src");
      resolve(v);
    };
    el.onloadedmetadata = () => done(Number.isFinite(el.duration) ? el.duration : null);
    el.onerror = () => done(null);
    el.src = url;
  });
}

async function startJob() {
  const file = fileInput.files[0];
  if (!file) return;

  btnStart.disabled = true;
  btnStart.textContent = "上传中…";
  markProgressStart();
  progressCard.hidden = false;
  stageName.textContent = "正在上传并读取文件";
  stageDetail.textContent = `${formatSize(file.size)} · 大文件需要一会儿`;
  btnCancel.hidden = true;

  const fd = new FormData();
  fd.append("file", file);
  fd.append("autoMinutes", state.autoMinutes ? "true" : "false");
  if (state.autoMinutes) fd.append("templateId", state.templateId || "");
  fd.append("language", language.value);
  fd.append("diarize", state.diarize ? "true" : "false");
  if (state.diarize && state.speakerCount) {
    fd.append("speakerCount", String(state.speakerCount));
  }

  const data = await jsonFetch(API.jobs, { method: "POST", body: fd });
  if (!data.success) {
    showError(data.error || "创建任务失败");
    btnStart.disabled = false;
    btnStart.textContent = "开始处理";
    resetProgress();
    return;
  }
  btnStart.textContent = "处理中 0%";
  markProgressStart();
  pollJob(data.jobId);
}

/** 详情页「继续处理 / 重新标注」：回到处理视图并接着轮询 */
export function watchJob(jobId, title = "继续处理") {
  switchView("new");
  newViewTitle.textContent = title;
  progressCard.hidden = false;
  markProgressStart();
  pollJob(jobId);
}

export function initUploadPage() {
  initProgressBindings();
  initDiarize();

  uploadArea.addEventListener("dragover", (e) => {
    e.preventDefault();
    uploadArea.classList.add("dragover");
  });
  uploadArea.addEventListener("dragleave", () => uploadArea.classList.remove("dragover"));
  uploadArea.addEventListener("drop", (e) => {
    e.preventDefault();
    uploadArea.classList.remove("dragover");
    const file = e.dataTransfer.files[0];
    if (file) setFile(file);
  });
  uploadArea.addEventListener("click", () => fileInput.click());
  uploadArea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInput.click();
    }
  });
  fileInput.addEventListener("change", () => {
    if (fileInput.files[0]) setFile(fileInput.files[0]);
  });
  btnRemove.addEventListener("click", (e) => {
    e.stopPropagation();
    clearFile();
  });

  autoMinutesCard.addEventListener("click", () => setAutoMinutes(!state.autoMinutes));

  btnStart.addEventListener("click", () => {
    if (btnStart.disabled) return;
    startJob();
  });

  $("#btnBackNew").addEventListener("click", () => {
    stopPolling();
    switchView("home");
    emit(BUS.RECORDS_RELOAD);
  });

  on(BUS.STOP_UPLOAD_POLL, stopPolling);
}

export { renderProgress, pollJob, stopPolling };
