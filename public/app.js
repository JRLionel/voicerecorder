/* ============================================================
   VoiceScribe 声记 — 工作台逻辑
   视图：home / new（上传处理）/ rec（实时录音）/ detail（详情）
   ============================================================ */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const views = {
  home: $("#viewHome"),
  new: $("#viewNew"),
  rec: $("#viewRec"),
  detail: $("#viewDetail"),
};

const errorEl = $("#error");
const recordsBody = $("#recordsBody");
const listLoading = $("#listLoading");
const btnLoadMore = $("#btnLoadMore");
const searchInput = $("#searchInput");
const checkAll = $("#checkAll");
const selBar = $("#selBar");
const selCount = $("#selCount");
const btnSelDelete = $("#btnSelDelete");
const btnSelCancel = $("#btnSelCancel");

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
const stagePct = $("#stagePct");
const stageDetail = $("#stageDetail");
const stageDot = $("#stageDot");
const barFill = $("#barFill");
const btnCancel = $("#btnCancel");

const diarizationCard = $("#diarizationCard");
const modalBackdrop = $("#modalBackdrop");
const modalOk = $("#modalOk");
const modalCancel = $("#modalCancel");
const modalTitle = $("#modalTitle");
const modalBody = $("#modalBody");

const detailTitle = $("#detailTitle");
const detailMeta = $("#detailMeta");
const jobBanner = $("#jobBanner");
const playerBar = $("#playerBar");
const player = $("#player");
const btnFav = $("#btnFav");
const btnDelete = $("#btnDelete");
const btnExport = $("#btnExport");
const segList = $("#segList");
const segCount = $("#segCount");
const resultText = $("#resultText");
const usageInfo = $("#usageInfo");
const btnCopy = $("#btnCopy");
const btnSummary = $("#btnSummary");
const summaryLoading = $("#summaryLoading");
const summaryLoadingText = $("#summaryLoadingText");
const summaryResult = $("#summaryResult");
const summaryBody = $("#summaryBody");
const btnCopySummary = $("#btnCopySummary");

const state = {
  view: "home",
  tab: "recent",
  q: "",
  page: 1,
  pageSize: 20,
  total: 0,
  items: [],
  selected: new Set(),
  viewMode: localStorage.getItem("vs_view_mode") || "list",
  entry: "audio",           // video | audio
  output: "summary",
  record: null,
  job: null,
  segments: [],
  pollTimer: null,
  lastFocus: null,
};

let clientId = localStorage.getItem("vs_client_id");
if (!clientId) {
  clientId = "cli_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  localStorage.setItem("vs_client_id", clientId);
}

const favKey = "vs_fav_ids";
function getFavs() {
  try { return new Set(JSON.parse(localStorage.getItem(favKey) || "[]")); }
  catch { return new Set(); }
}
function toggleFav(id) {
  const favs = getFavs();
  favs.has(id) ? favs.delete(id) : favs.add(id);
  localStorage.setItem(favKey, JSON.stringify([...favs]));
  return favs.has(id);
}

/* ---------------- 工具 ---------------- */

function formatSize(bytes) {
  if (bytes == null) return "—";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

function formatDuration(sec) {
  if (sec == null) return "—";
  const s = Math.round(sec);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${pad(m)}:${pad(r)}`;
}

function formatFrac(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(r)}`;
}

function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.classList.add("show");
  clearTimeout(showError.t);
  showError.t = setTimeout(() => errorEl.classList.remove("show"), 6000);
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  return div.innerHTML;
}

/** 用于放进 HTML 属性（双引号包裹）的转义 */
function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function switchView(name) {
  state.view = name;
  for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
  updateSelBar();
  window.scrollTo({ top: 0 });
}

/* ---------------- 记录列表 ---------------- */

async function fetchRecords({ append = false } = {}) {
  listLoading.classList.add("show");
  try {
    const params = new URLSearchParams({ q: state.q, page: state.page, pageSize: state.pageSize });
    const resp = await fetch(`/api/records?${params}`);
    const data = await resp.json();
    if (!data.success) return showError(data.error || "获取记录列表失败");

    let items = data.items;
    if (state.tab === "fav") {
      const favs = getFavs();
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

const SOURCE_LABEL = { upload: "上传文件", recording: "实时录音" };

function recordThumb(template) {
  const cls = template === "meeting" ? "t-blue" : "t-violet";
  return `<span class="rec-thumb ${cls}">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
      <line x1="5" y1="10" x2="5" y2="14"/><line x1="9" y1="7" x2="9" y2="17"/>
      <line x1="12" y1="4" x2="12" y2="20"/><line x1="15" y1="7" x2="15" y2="17"/>
      <line x1="19" y1="10" x2="19" y2="14"/>
    </svg>
  </span>`;
}

function renderRecords() {
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
        <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
          <line x1="5" y1="10" x2="5" y2="14"/><line x1="9" y1="7" x2="9" y2="17"/>
          <line x1="12" y1="4" x2="12" y2="20"/><line x1="15" y1="7" x2="15" y2="17"/>
          <line x1="19" y1="10" x2="19" y2="14"/>
        </svg>
        <span class="empty-title">暂无记录</span>
        <span class="empty-hint">${hints[state.tab] || hints.recent}</span>
      </div>`;
    btnLoadMore.style.display = "none";
    syncSelection();
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
  syncSelection();
}

/* ---------------- 批量选择 ---------------- */

function updateSelBar() {
  const n = state.selected.size;
  const show = n > 0 && state.view === "home";
  selBar.hidden = !show;
  document.body.classList.toggle("has-sel", show);
  if (!show) return;
  selCount.textContent = `已选择 ${n} 项`;
  btnSelDelete.textContent = "删除";
}

/** 把 state.selected 同步到复选框、行高亮和全选框 */
function syncSelection() {
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

function clearSelection() {
  state.selected.clear();
  syncSelection();
}


recordsBody.addEventListener("click", (e) => {
  // 勾选区不触发打开详情，交给 checkbox 自己处理
  if (e.target.closest(".rec-check")) return;
  const open = e.target.closest(".rec-open");
  if (open) openDetail({ recordId: open.dataset.id });
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
  openDetail({ recordId: open.dataset.id });
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
    const resp = await fetch("/api/records/batch-delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    const data = await resp.json();
    if (!data.success) throw new Error(data.error || "删除失败");

    // 收藏列表里也要清掉，否则「收藏」页会残留空记录
    const favs = getFavs();
    let favChanged = false;
    for (const id of ids) if (favs.delete(id)) favChanged = true;
    if (favChanged) localStorage.setItem(favKey, JSON.stringify([...favs]));

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
  localStorage.setItem("vs_view_mode", state.viewMode);
  renderRecords();
});

/* ---------------- 占位入口弹窗 ---------------- */

const MODAL_COPY = {
  diarization: {
    title: "区分说话人",
    body: "这个功能会自动标出每句话是谁说的，目前还在开发中，暂时不能开启。\n\n你可以先完成转写和纪要，点击时间戳可以回到音频的对应位置。",
  },
};

function openModal(kind) {
  const copy = MODAL_COPY[kind];
  if (!copy) return;
  if (document.querySelector(".modal-backdrop:not([hidden])")) return; // 防重复实例
  modalTitle.textContent = copy.title;
  modalBody.innerHTML = copy.body
    .split("\n\n")
    .map((p) => `<span class="modal-p">${escapeHtml(p)}</span>`)
    .join("");
  modalCancel.hidden = true;
  modalOk.className = "btn btn-primary";
  modalOk.textContent = "知道了";
  state.lastFocus = document.activeElement;
  modalBackdrop.hidden = false;
  document.body.style.overflow = "hidden";
  modalOk.focus();
}

let modalResolve = null;

/** 二次确认弹窗，返回 Promise<boolean> */
function confirmDialog({ title, body, okText = "确定" }) {
  if (document.querySelector(".modal-backdrop:not([hidden])")) return Promise.resolve(false);
  modalTitle.textContent = title;
  modalBody.innerHTML = `<span class="modal-p">${escapeHtml(body)}</span>`;
  modalCancel.hidden = false;
  modalOk.className = "btn btn-danger";
  modalOk.textContent = okText;
  state.lastFocus = document.activeElement;
  modalBackdrop.hidden = false;
  document.body.style.overflow = "hidden";
  modalCancel.focus();

  return new Promise((resolve) => {
    modalResolve = resolve;
  });
}

function closeModal(result = false) {
  if (modalBackdrop.hidden) return;
  modalBackdrop.hidden = true;
  document.body.style.overflow = "";
  modalCancel.hidden = true;
  if (state.lastFocus && typeof state.lastFocus.focus === "function") {
    state.lastFocus.focus();
  }
  state.lastFocus = null;

  const resolve = modalResolve;
  modalResolve = null;
  if (resolve) resolve(result);
}

diarizationCard.addEventListener("click", () => openModal("diarization"));
diarizationCard.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    openModal("diarization");
  }
});
modalOk.addEventListener("click", () => closeModal(true));
modalCancel.addEventListener("click", () => closeModal(false));
modalBackdrop.addEventListener("click", (e) => {
  if (e.target === modalBackdrop) closeModal(false);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeModal(false);
});

/* ---------------- 上传视图 ---------------- */

const ENTRY_META = {
  video: {
    title: "上传视频",
    accept: "video/*,.mp4,.mov,.mkv,.avi,.m4v,.webm",
    hint: "mp4 / mov / mkv / avi / webm · 最大 2GB · 4 小时以内",
  },
  audio: {
    title: "上传音频",
    accept: "audio/*,.mp3,.wav,.m4a,.aac,.ogg,.flac,.amr,.wma",
    hint: "mp3 / wav / m4a / ogg / flac · 最大 2GB · 4 小时以内",
  },
};

function openNew(entry) {
  state.entry = entry;
  const meta = ENTRY_META[entry];
  newViewTitle.textContent = meta.title;
  fileInput.accept = meta.accept;
  uploadHint.textContent = meta.hint;
  clearFile();
  resetProgress();
  switchView("new");
  uploadArea.focus();
}

$$(".entry-card").forEach((card) => {
  card.addEventListener("click", () => {
    if (card.dataset.entry === "record") return openRec();
    openNew(card.dataset.entry);
  });
});

$("#brandHome").addEventListener("click", () => {
  stopPolling();
  switchView("home");
  fetchRecords();
});
$("#btnBackNew").addEventListener("click", () => {
  stopPolling();
  switchView("home");
  fetchRecords();
});

function setFile(file) {
  if (!file) return;
  fileName.textContent = file.name;
  fileSize.textContent = formatSize(file.size);
  fileInfo.classList.add("show");
  btnStart.disabled = false;
}

function clearFile() {
  fileInput.value = "";
  fileInfo.classList.remove("show");
  btnStart.disabled = true;
}

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

$("#outputSeg").addEventListener("click", (e) => {
  const btn = e.target.closest(".seg-btn");
  if (!btn) return;
  $$("#outputSeg .seg-btn").forEach((b) => b.classList.toggle("active", b === btn));
  state.output = btn.dataset.value;
});

const STAGE_TEXT = {
  QUEUED: "排队中",
  PROBING: "正在读取文件信息",
  EXTRACTING: "正在抽取音频",
  CHUNKING: "正在规划分段",
  TRANSCRIBING: "正在转写",
  SUMMARIZING: "正在生成纪要",
  DONE: "完成",
  FAILED: "处理失败",
  CANCELED: "已取消",
};

function resetProgress() {
  progressCard.hidden = true;
  barFill.style.width = "0%";
  stagePct.textContent = "0%";
  stageName.textContent = "正在准备";
  stageDetail.textContent = "—";
  stageDot.className = "stage-dot";
  btnCancel.hidden = true;
}

let progressStart = 0;

function renderProgress(job) {
  progressCard.hidden = false;
  const pct = Math.max(0, Math.min(100, job.progress || 0));
  barFill.style.width = pct + "%";
  stagePct.textContent = Math.round(pct) + "%";
  stageName.textContent = STAGE_TEXT[job.stage] || "处理中";

  if (job.stage === "TRANSCRIBING") {
    const done = job.chunkDone || 0;
    const total = job.chunkTotal || 0;
    let eta = "";
    if (done > 0 && total > done) {
      const elapsed = (Date.now() - progressStart) / 1000;
      const per = elapsed / done;
      eta = ` · 预计还需 ${formatDuration(per * (total - done))}`;
    }
    stageDetail.textContent = `已转写 ${done}/${total} 段${eta}`;
  } else if (job.stage === "SUMMARIZING") {
    stageDetail.textContent = "分段摘要 → 合并成纪要，长会议需要几分钟";
  } else if (job.stage === "FAILED") {
    stageDetail.textContent = job.error || "处理失败";
  } else {
    stageDetail.textContent = job.durationMs
      ? `音频时长 ${formatDuration(job.durationMs / 1000)}`
      : "—";
  }

  stageDot.className = "stage-dot " + (job.status === "failed" ? "is-error" : job.status === "done" ? "is-done" : "is-live");
  btnCancel.hidden = !["queued", "running"].includes(job.status);
}

async function startJob() {
  const file = fileInput.files[0];
  if (!file) return;

  btnStart.disabled = true;
  btnStart.textContent = "上传中…";
  progressStart = Date.now();
  progressCard.hidden = false;
  stageName.textContent = "正在上传并读取文件";
  stageDetail.textContent = `${formatSize(file.size)} · 大文件需要一会儿`;
  btnCancel.hidden = true;

  const fd = new FormData();
  fd.append("file", file);
  fd.append("output", state.output);
  fd.append("language", language.value);

  try {
    const resp = await fetch("/api/jobs", { method: "POST", body: fd });
    const data = await resp.json();
    if (!data.success) {
      showError(data.error || "创建任务失败");
      btnStart.disabled = false;
      btnStart.textContent = "开始处理";
      resetProgress();
      return;
    }
    btnStart.textContent = "处理中 " + 0 + "%";
    progressStart = Date.now();
    pollJob(data.jobId);
  } catch (e) {
    showError("上传失败，请检查后端是否启动");
    btnStart.disabled = false;
    btnStart.textContent = "开始处理";
    resetProgress();
  }
}

function stopPolling() {
  if (state.pollTimer) {
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }
}

function pollJob(jobId) {
  stopPolling();
  state.pollTimer = setTimeout(async () => {
    try {
      const resp = await fetch(`/api/jobs/${jobId}`);
      const data = await resp.json();
      if (!data.success) {
        showError(data.error || "查询任务失败");
        btnStart.disabled = false;
        btnStart.textContent = "开始处理";
        return;
      }
      state.job = data.job;
      renderProgress(data.job);
      btnStart.textContent = `处理中 ${Math.round(data.job.progress)}%`;

      if (data.job.status === "done") {
        btnStart.disabled = false;
        btnStart.textContent = "开始处理";
        await openDetail({ jobId, recordId: data.job.recordId });
        return;
      }
      if (["failed", "canceled"].includes(data.job.status)) {
        btnStart.disabled = false;
        btnStart.textContent = "开始处理";
        if (data.job.status === "failed") showError(data.job.error || "任务失败");
        return;
      }
      pollJob(jobId);
    } catch {
      showError("网络中断，任务可能仍在后台运行");
      btnStart.disabled = false;
      btnStart.textContent = "开始处理";
    }
  }, 1200);
}

btnStart.addEventListener("click", () => {
  if (btnStart.disabled) return;
  startJob();
});

btnCancel.addEventListener("click", async () => {
  if (!state.job) return;
  btnCancel.disabled = true;
  btnCancel.textContent = "正在取消";
  try {
    await fetch(`/api/jobs/${state.job.id}/cancel`, { method: "POST" });
  } catch {}
  btnCancel.disabled = false;
  btnCancel.textContent = "取消任务";
});

/* ---------------- 详情 ---------------- */

async function openDetail({ jobId = null, recordId = null }) {
  try {
    if (jobId) {
      const resp = await fetch(`/api/jobs/${jobId}`);
      const data = await resp.json();
      if (!data.success) return showError(data.error || "任务不存在");
      renderJobDetail(data);
      switchView("detail");
      return;
    }

    const resp = await fetch(`/api/records/${recordId}`);
    const data = await resp.json();
    if (!data.success) return showError(data.error || "记录不存在");
    const record = data.record;
    if (record.job_id) {
      await openDetail({ jobId: record.job_id });
      return;
    }
    renderLegacyDetail(record);
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
  if (job?.chunkTotal) parts.push(`<span>分段 <b>${job.chunkTotal}</b></span>`);
  detailMeta.innerHTML = parts.join("");
}

function renderJobDetail(data) {
  const { job, segments, record } = data;
  state.job = job;
  state.record = record;
  state.segments = segments;

  detailTitle.textContent = record?.title || "处理结果";
  setMeta(record, job);
  btnFav.classList.toggle("active", record ? getFavs().has(record.id) : false);

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
        await fetch(`/api/jobs/${job.id}/resume`, { method: "POST" });
        switchView("new");
        newViewTitle.textContent = "继续处理";
        progressCard.hidden = false;
        pollJob(job.id);
      });
    }
  }

  if (data.hasAudio) {
    playerBar.hidden = false;
    player.src = `/api/jobs/${job.id}/audio`;
  } else {
    playerBar.hidden = true;
    player.removeAttribute("src");
  }

  const withText = segments.filter((s) => (s.text || "").trim());
  if (withText.length) {
    segList.hidden = false;
    resultText.hidden = true;
    segCount.textContent = `${withText.length} 段`;
    segList.innerHTML = withText
      .map(
        (s) => `<div class="seg-row" data-ms="${s.startMs}">
          <button class="seg-ts" data-ms="${s.startMs}" title="跳转到此处">${formatFrac(s.startMs / 1000)}</button>
          <p class="seg-text">${escapeHtml(s.text)}</p>
        </div>`
      )
      .join("");
  } else {
    segList.hidden = true;
    resultText.hidden = false;
    resultText.textContent = record?.transcript || "（无识别结果）";
    segCount.textContent = "";
  }

  usageInfo.textContent = record
    ? `分段 ${segments.length} · 引擎 ${[...new Set(segments.map((s) => s.engine).filter(Boolean))].join(" / ") || "—"}`
    : "";

  renderSummaryBlock(record?.summaryJson, record?.summary);
}

function renderLegacyDetail(record) {
  state.record = record;
  state.job = null;
  state.segments = [];
  detailTitle.textContent = record.title;
  setMeta(record, null);
  btnFav.classList.toggle("active", getFavs().has(record.id));
  jobBanner.hidden = true;
  playerBar.hidden = true;
  segList.hidden = true;
  resultText.hidden = false;
  resultText.textContent = record.transcript || "（无识别结果）";
  segCount.textContent = "";
  usageInfo.textContent = record.language ? `语言 ${record.language}` : "";
  renderSummaryBlock(record.summary_json ? JSON.parse(record.summary_json) : null, record.summary_text);
}

function renderSummaryBlock(json, markdown) {
  const has = (json && (json.topic || (json.content || []).length)) || (markdown && markdown.trim());
  if (!has) {
    summaryResult.hidden = true;
    btnSummary.style.display = state.record && (state.record.transcript || state.segments.length) ? "block" : "none";
    return;
  }
  btnSummary.style.display = "none";
  summaryResult.hidden = false;

  if (!json) {
    summaryBody.innerHTML = `<div class="card-body">${escapeHtml(markdown)}</div>`;
    return;
  }

  const list = (arr) =>
    arr && arr.length
      ? `<ul class="sum-list">${arr.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>`
      : `<p class="sum-empty">无</p>`;

  const todos =
    json.todos && json.todos.length
      ? `<ul class="todo-list">${json.todos
          .map((t) => {
            const sec = parseClock(t.at);
            const at = sec != null
              ? `<button class="todo-at" data-ms="${sec * 1000}">${escapeHtml(t.at)}</button>`
              : "";
            return `<li><span class="todo-box" aria-hidden="true"></span>
              <span class="todo-text">${escapeHtml(t.text)}</span>
              <span class="todo-owner">${escapeHtml(t.owner || "未提及")}</span>${at}</li>`;
          })
          .join("")}</ul>`
      : `<p class="sum-empty">无</p>`;

  summaryBody.innerHTML = `
    <div class="sum-section">
      <span class="sum-label">主题</span>
      <p class="sum-topic">${escapeHtml(json.topic || "（未提炼出主题）")}</p>
    </div>
    <div class="sum-section">
      <span class="sum-label">会议内容</span>
      ${list(json.content)}
    </div>
    <div class="sum-section">
      <span class="sum-label">决议</span>
      ${list(json.decisions)}
    </div>
    <div class="sum-section">
      <span class="sum-label">待办</span>
      ${todos}
    </div>
    ${
      json.attendees && json.attendees.length
        ? `<div class="sum-section"><span class="sum-label">参会人</span>
             <p class="sum-topic">${escapeHtml(json.attendees.join("、"))}</p></div>`
        : ""
    }`;
}

function parseClock(str) {
  if (!str) return null;
  const parts = String(str).trim().split(":").map((x) => Number(x));
  if (parts.some((n) => Number.isNaN(n))) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return null;
}

function seekTo(ms) {
  if (playerBar.hidden || !player.src) return;
  player.currentTime = Math.max(0, ms / 1000);
  player.play().catch(() => {});
}

segList.addEventListener("click", (e) => {
  const btn = e.target.closest(".seg-ts");
  if (btn) seekTo(Number(btn.dataset.ms));
});
summaryBody.addEventListener("click", (e) => {
  const btn = e.target.closest(".todo-at");
  if (btn) seekTo(Number(btn.dataset.ms));
});

player.addEventListener("timeupdate", () => {
  const ms = player.currentTime * 1000;
  let active = null;
  for (const row of $$(".seg-row")) {
    if (Number(row.dataset.ms) <= ms) active = row;
    else break;
  }
  $$(".seg-row").forEach((r) => r.classList.toggle("is-active", r === active));
});

$("#btnBackDetail").addEventListener("click", () => {
  player.pause();
  switchView("home");
  fetchRecords();
});

btnFav.addEventListener("click", () => {
  if (!state.record) return;
  btnFav.classList.toggle("active", toggleFav(state.record.id));
});

btnDelete.addEventListener("click", async () => {
  if (!state.record) return;
  const ok = await confirmDialog({
    title: "删除记录",
    body: `确定删除「${state.record.title}」吗？音频、转写文件和纪要会一并清除，无法恢复。`,
    okText: "删除",
  });
  if (!ok) return;
  try {
    const resp = await fetch(`/api/records/${state.record.id}`, { method: "DELETE" });
    const data = await resp.json();
    if (!data.success) return showError(data.error || "删除失败");
    state.selected.delete(state.record.id);
    switchView("home");
    state.page = 1;
    fetchRecords();
  } catch {
    showError("网络错误，请检查后端是否启动");
  }
});

btnExport.addEventListener("click", () => {
  const record = state.record;
  if (!record) return;
  const lines = [`# ${record.title}`, ""];
  if (record.summaryJson) {
    const j = record.summaryJson;
    if (j.topic) lines.push(`## 主题`, j.topic, "");
    if (j.content?.length) lines.push(`## 会议内容`, ...j.content.map((c) => `- ${c}`), "");
    if (j.decisions?.length) lines.push(`## 决议`, ...j.decisions.map((c) => `- ${c}`), "");
    if (j.todos?.length) {
      lines.push(`## 待办`);
      j.todos.forEach((t) => lines.push(`- [ ] ${t.text} — ${t.owner}${t.at ? " · " + t.at : ""}`));
      lines.push("");
    }
    if (j.attendees?.length) lines.push(`## 参会人`, j.attendees.join("、"), "");
  }
  lines.push(`## 转写全文`, "");
  if (state.segments.length) {
    state.segments.forEach((s) => {
      if (!(s.text || "").trim()) return;
      lines.push(`[${formatFrac(s.startMs / 1000)}] ${s.text}`);
    });
  } else {
    lines.push(record.transcript || "");
  }
  const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${record.title || "会议纪要"}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});

async function generateSummary() {
  if (!state.job) {
    return showError("这条记录没有分段数据，无法重新生成纪要");
  }
  btnSummary.style.display = "none";
  summaryLoading.classList.add("show");
  summaryLoadingText.textContent = "正在生成会议纪要（分段摘要 → 合并，长会议需要几分钟）";
  try {
    const resp = await fetch(`/api/jobs/${state.job.id}/summary`, { method: "POST" });
    const data = await resp.json();
    if (!data.success) {
      showError(data.error || "生成会议纪要失败");
      btnSummary.style.display = "block";
      return;
    }
    if (state.record) {
      state.record.summaryJson = data.summary;
      state.record.summary = data.markdown;
    }
    renderSummaryBlock(data.summary, data.markdown);
  } catch {
    showError("网络错误，请检查后端是否启动");
    btnSummary.style.display = "block";
  } finally {
    summaryLoading.classList.remove("show");
  }
}

btnSummary.addEventListener("click", generateSummary);

async function copyText(text, btn) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  }
  const original = btn.textContent;
  btn.textContent = "已复制";
  btn.classList.add("copied");
  setTimeout(() => {
    btn.textContent = original;
    btn.classList.remove("copied");
  }, 2000);
}

btnCopy.addEventListener("click", () => {
  const text = state.segments.length
    ? state.segments.map((s) => (s.text || "").trim()).filter(Boolean).join("\n")
    : resultText.textContent;
  copyText(text, btnCopy);
});

btnCopySummary.addEventListener("click", () => {
  copyText(summaryBody.innerText.trim(), btnCopySummary);
});

/* ---------------- 实时录音 ---------------- */

const rec = {
  ws: null,
  ctx: null,
  node: null,
  stream: null,
  scriptNode: null,
  active: false,
  paused: false,
  audioMs: 0,
  sentences: new Map(),
  bars: new Array(40).fill(0),
  timer: null,
  finalizing: false,
};

const recDot = $("#recDot");
const recStatus = $("#recStatus");
const recTimer = $("#recTimer");
const recWave = $("#recWave");
const recHint = $("#recHint");
const recSubCard = $("#recSubCard");
const recSubs = $("#recSubs");
const recActions = $("#recActions");
const btnMic = $("#btnMic");
const btnPause = $("#btnPause");
const btnStop = $("#btnStop");
const recMicWrap = $("#recMicWrap");

function openRec() {
  resetRec();
  switchView("rec");
}

function resetRec() {
  rec.active = false;
  rec.paused = false;
  rec.audioMs = 0;
  rec.sentences.clear();
  rec.bars = new Array(40).fill(0);
  rec.finalizing = false;
  recTimer.textContent = "00:00";
  recStatus.textContent = "未开始";
  recDot.className = "rec-dot";
  recHint.hidden = false;
  recMicWrap.hidden = false;
  recSubCard.hidden = true;
  recSubs.innerHTML = `<p class="sub-empty">开始说话，字幕会出现在这里</p>`;
  recActions.hidden = true;
  btnMic.disabled = false;
  btnMic.innerHTML = micIcon() + "开始录音";
  btnPause.textContent = "暂停";
  btnStop.disabled = true;
  btnStop.textContent = "结束并生成纪要";
  $("#liveTag").textContent = "识别中";
  renderWave();
}

function micIcon() {
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2.5" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3.5"/></svg>`;
}

function renderWave() {
  recWave.classList.toggle("is-idle", !rec.active);
  recWave.innerHTML = rec.bars
    .map((v) => `<i style="height:${Math.max(3, Math.round(v * 34))}px"></i>`)
    .join("");
}

function pushBar(rms) {
  rec.bars.push(Math.min(1, rms * 7));
  rec.bars.shift();
  renderWave();
}

function updateTimer() {
  recTimer.textContent = formatDuration(rec.audioMs / 1000);
}

async function startRecording() {
  if (rec.active) return;
  btnMic.disabled = true;
  btnMic.textContent = "正在连接…";
  recHint.hidden = true;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    rec.stream = stream;

    const wsProto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${wsProto}://${location.host}/ws/record`);
    ws.binaryType = "arraybuffer";
    rec.ws = ws;

    await new Promise((resolve, reject) => {
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "start", language: language.value, output: state.output }));
        resolve();
      };
      ws.onerror = () => reject(new Error("无法连接转写服务"));
    });

    ws.onmessage = onRecMessage;
    ws.onclose = () => {
      if (rec.active && !rec.finalizing) {
        recStatus.textContent = "连接已断开";
        recDot.className = "rec-dot is-error";
        stopAudioGraph();
        rec.active = false;
      }
    };

    await startAudioGraph();

    rec.active = true;
    recMicWrap.hidden = true;
    recActions.hidden = false;
    recSubCard.hidden = false;
    recStatus.textContent = "录音中";
    recDot.className = "rec-dot is-live";
    btnStop.disabled = false;
    btnPause.disabled = false;
  } catch (e) {
    showError(e.message || "无法启动录音");
    btnMic.disabled = false;
    btnMic.textContent = "重新请求麦克风";
    recMicWrap.hidden = false;
    stopAudioGraph();
  }
}

async function startAudioGraph() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  let ctx;
  try {
    ctx = new Ctx({ sampleRate: 16000 });
  } catch {
    ctx = new Ctx();
  }
  rec.ctx = ctx;
  if (ctx.state === "suspended") await ctx.resume();

  const source = ctx.createMediaStreamSource(rec.stream);

  try {
    await ctx.audioWorklet.addModule("/pcm-worklet.js");
    const node = new AudioWorkletNode(ctx, "pcm-capture", {
      processorOptions: { targetRate: 16000 },
    });
    node.port.onmessage = (ev) => handlePcm(ev.data);
    source.connect(node);
    // 必须连到 destination 才会被拉取，用 0 增益避免自听回授
    const sink = ctx.createGain();
    sink.gain.value = 0;
    node.connect(sink).connect(ctx.destination);
    rec.node = node;
  } catch (e) {
    // Safari 老版本没有 AudioWorklet：退回 ScriptProcessor，同样降采样到 16k
    const ratio = ctx.sampleRate / 16000;
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    let acc = 0, count = 0, frame = [];
    proc.onaudioprocess = (ev) => {
      const ch = ev.inputBuffer.getChannelData(0);
      for (let i = 0; i < ch.length; i++) {
        acc += ch[i];
        count += 1;
        if (count >= ratio) {
          frame.push(acc / count);
          acc = 0;
          count = 0;
          if (frame.length >= 1600) {
            const pcm = new Int16Array(1600);
            for (let j = 0; j < 1600; j++) {
              const v = Math.max(-1, Math.min(1, frame[j]));
              pcm[j] = v < 0 ? v * 0x8000 : v * 0x7fff;
            }
            handlePcm(pcm.buffer);
            frame = [];
          }
        }
      }
    };
    source.connect(proc);
    const sink = ctx.createGain();
    sink.gain.value = 0;
    proc.connect(sink).connect(ctx.destination);
    rec.scriptNode = proc;
  }
}

function handlePcm(buffer) {
  if (!rec.active || rec.paused) return;
  const pcm = new Int16Array(buffer);
  let sum = 0;
  for (let i = 0; i < pcm.length; i += 8) {
    const v = pcm[i] / 32768;
    sum += v * v;
  }
  pushBar(Math.sqrt(sum / Math.max(1, pcm.length / 8)));

  if (rec.ws && rec.ws.readyState === WebSocket.OPEN) {
    rec.ws.send(buffer);
  }
  rec.audioMs += 100;
  updateTimer();
}

function onRecMessage(ev) {
  let msg;
  try { msg = JSON.parse(ev.data); } catch { return; }

  if (msg.type === "ready") {
    recStatus.textContent = "录音中";
    recDot.className = "rec-dot is-live";
    return;
  }
  if (msg.type === "paused") {
    recStatus.textContent = "已暂停";
    recDot.className = "rec-dot is-idle";
    return;
  }
  if (msg.type === "resumed") {
    recStatus.textContent = "录音中";
    recDot.className = "rec-dot is-live";
    return;
  }
  if (msg.type === "sentence") {
    rec.sentences.set(msg.id ?? `s${msg.startMs}`, msg);
    renderSubs();
    return;
  }
  if (msg.type === "error") {
    showError(msg.message);
    return;
  }
  if (msg.type === "done") {
    finishRecordingFlow(msg);
  }
}

function renderSubs() {
  const list = [...rec.sentences.values()].sort((a, b) => a.startMs - b.startMs);
  if (!list.length) return;
  recSubs.innerHTML = list
    .map(
      (s) => `<p class="sub-line ${s.final ? "" : "is-partial"}">
        <span class="sub-ts">${formatDuration(s.startMs / 1000)}</span>
        <span class="sub-text">${escapeHtml(s.text)}</span>
      </p>`
    )
    .join("");
  recSubs.scrollTop = recSubs.scrollHeight;
}

function stopAudioGraph() {
  try { rec.node && rec.node.disconnect(); } catch {}
  try { rec.scriptNode && rec.scriptNode.disconnect(); } catch {}
  try { rec.stream && rec.stream.getTracks().forEach((t) => t.stop()); } catch {}
  try { rec.ctx && rec.ctx.state !== "closed" && rec.ctx.close(); } catch {}
  rec.node = null;
  rec.scriptNode = null;
  rec.stream = null;
  rec.ctx = null;
}

btnMic.addEventListener("click", startRecording);

btnPause.addEventListener("click", () => {
  if (!rec.active || !rec.ws) return;
  if (!rec.paused) {
    rec.paused = true;
    btnPause.textContent = "继续";
    rec.ws.send(JSON.stringify({ type: "pause" }));
    recStatus.textContent = "已暂停";
    recDot.className = "rec-dot is-idle";
  } else {
    rec.paused = false;
    btnPause.textContent = "暂停";
    rec.ws.send(JSON.stringify({ type: "resume" }));
    recStatus.textContent = "录音中";
    recDot.className = "rec-dot is-live";
  }
});

btnStop.addEventListener("click", () => {
  if (!rec.active || !rec.ws) return;
  if (rec.audioMs < 1000) {
    showError("录音不足 1 秒，再录一会儿吧");
    return;
  }
  rec.finalizing = true;
  btnStop.disabled = true;
  btnPause.disabled = true;
  btnStop.textContent = "正在收尾…";
  recStatus.textContent = "正在生成终稿";
  recDot.className = "rec-dot is-live";
  stopAudioGraph();
  rec.active = false;
  rec.ws.send(JSON.stringify({ type: "stop" }));
});

async function finishRecordingFlow(msg) {
  try { rec.ws && rec.ws.close(); } catch {}
  rec.ws = null;
  btnStop.textContent = "结束并生成纪要";

  if (!msg.recordId) {
    showError("没有识别到语音内容，本次录音未保存");
    resetRec();
    return;
  }

  await openDetail({ jobId: msg.jobId, recordId: msg.recordId });
  // 录音场景默认结束即出纪要，直接在这里触发，用户不用再点一次
  if (state.output === "summary" && state.job && !state.record?.summaryJson) {
    generateSummary();
  }
}

$("#btnBackRec").addEventListener("click", () => {
  if (rec.active) {
    if (!confirm("录音还在进行，确定离开吗？已录内容会丢失。")) return;
  }
  try { rec.ws && rec.ws.close(); } catch {}
  stopAudioGraph();
  resetRec();
  switchView("home");
  fetchRecords();
});

/* ---------------- 初始化 ---------------- */

$$(".vt-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === state.viewMode));
resetRec();
switchView("home");
fetchRecords();
