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
const diarSwitch = $("#diarSwitch");
const diarExtra = $("#diarExtra");
const diarTips = $("#diarTips");
const speakerCountSel = $("#speakerCount");
const diarizeBanner = $("#diarizeBanner");
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
  diarize: false,           // 上传时是否开启说话人分离
  speakerCount: null,
  fileDuration: null,       // 选中文件的时长（秒），用于 >2h 置灰
  record: null,
  job: null,
  segments: [],
  markers: [],
  speakers: [],
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

/* ---------------- 弹窗 ---------------- */

const MODAL_COPY = {
  recDiarization: {
    title: "实时录音暂不支持区分说话人",
    body: "实时转写用的是流式模型，它不返回说话人信息，所以录音过程中无法标出「谁说的」。\n\n需要分离时，可以把同一段录音在结束后作为音频文件上传处理；录音文件已在本地保存，详情页可以直接下载回放。",
  },
  diarLimit: {
    title: "文件超过 2 小时",
    body: "开启说话人分离后，官方建议音频不超过 2 小时，否则可能识别失败或超时。\n\n请先裁剪，或关闭开关按普通方式转写——普通方式支持到 4 小时。",
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

const MAX_DIARIZE_SEC = 2 * 3600;

/** 超过 2 小时就不能开：与其跑到一半失败，不如在选择文件后就拦住 */
function diarizeBlocked() {
  return Boolean(state.fileDuration && state.fileDuration > MAX_DIARIZE_SEC);
}

function refreshDiarizeAvailability() {
  const blocked = diarizeBlocked();
  diarizationCard.classList.toggle("is-disabled", blocked);
  diarizationCard.setAttribute("aria-disabled", blocked ? "true" : "false");
  if (blocked && state.diarize) setDiarize(false, { silent: true });
  diarTips.textContent = blocked
    ? "文件超过 2 小时，开启分离前请先裁剪"
    : "自动标出每句话由谁说出。开启后走离线分离，处理时间略长";
}

function setDiarize(on, { silent = false } = {}) {
  if (on && diarizeBlocked()) {
    if (!silent) openModal("diarLimit");
    return;
  }
  state.diarize = Boolean(on);
  diarSwitch.classList.toggle("is-off", !state.diarize);
  diarSwitch.classList.toggle("is-on", state.diarize);
  diarizationCard.setAttribute("aria-pressed", state.diarize ? "true" : "false");
  diarExtra.hidden = !state.diarize;
  if (!state.diarize) {
    state.speakerCount = null;
    if (speakerCountSel) speakerCountSel.value = "";
  }
}

function toggleDiarize() {
  if (diarizeBlocked()) return openModal("diarLimit");
  setDiarize(!state.diarize);
}

diarizationCard.addEventListener("click", toggleDiarize);
diarizationCard.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    toggleDiarize();
  }
});
if (speakerCountSel) {
  speakerCountSel.addEventListener("click", (e) => e.stopPropagation());
  speakerCountSel.addEventListener("change", () => {
    state.speakerCount = Number(speakerCountSel.value) || null;
  });
}
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
  setDiarize(false, { silent: true });
  refreshDiarizeAvailability();
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
  UPLOAD_REMOTE: "正在上传用于分离",
  DIARIZING: "正在识别说话人",
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
  } else if (job.stage === "UPLOAD_REMOTE") {
    stageDetail.textContent = "正在把音频传到分离服务，长文件需要一会儿";
  } else if (job.stage === "DIARIZING") {
    const waited = Math.round((Date.now() - progressStart) / 1000);
    stageDetail.textContent = `离线识别与说话人分离中 · 已等待 ${formatDuration(waited)}`;
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
  fd.append("diarize", state.diarize ? "true" : "false");
  if (state.diarize && state.speakerCount) {
    fd.append("speakerCount", String(state.speakerCount));
  }

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
  if (job?.speakerCount) parts.push(`<span>说话人 <b>${job.speakerCount} 人</b></span>`);
  else if (job?.chunkTotal) parts.push(`<span>分段 <b>${job.chunkTotal}</b></span>`);
  detailMeta.innerHTML = parts.join("");
}

const SPEAKER_FALLBACK_COLORS = ["#3565d9", "#7c4dd4", "#1f9a62", "#c97a12", "#d84a35", "#5f6b7a"];

function speakerColor(localId) {
  const found = state.speakers.find((s) => s.localId === localId);
  if (found?.color) return found.color;
  const i = Math.max(0, state.speakers.findIndex((s) => s.localId === localId));
  return SPEAKER_FALLBACK_COLORS[i % SPEAKER_FALLBACK_COLORS.length];
}

/**
 * 转写渲染：连续同一说话人的句子合并成一个发言块，
 * 标记按时间插入同一列——两套内容共用一个时间轴才读得顺。
 */
function renderTranscriptRows(segments, markers) {
  const items = [];
  let turn = null;

  for (const s of segments) {
    const text = (s.text || "").trim();
    if (!text) continue;
    const spk = s.speakerLabel || s.speaker || null;
    if (turn && spk === turn.speaker) {
      turn.parts.push(text);
      turn.endMs = s.endMs;
    } else {
      turn = { kind: "turn", speaker: spk, localId: s.speaker || null, startMs: s.startMs, endMs: s.endMs, parts: [text] };
      items.push(turn);
    }
  }

  for (const m of markers) {
    items.push({
      kind: "marker",
      startMs: m.startMs,
      endMs: m.endMs,
      text: m.text,
      duringPause: m.duringPause,
    });
  }

  items.sort((a, b) => a.startMs - b.startMs);

  return items
    .map((it) => {
      if (it.kind === "marker") {
        return `<div class="marker-row" data-ms="${it.startMs}">
          <span class="marker-badge">标记</span>
          <p class="marker-text">${escapeHtml(it.text)}${it.duringPause ? `<span class="marker-pause">暂停时</span>` : ""}</p>
          <button class="marker-ts" data-ms="${it.startMs}" title="跳转到此处">${formatFrac(it.startMs / 1000)}</button>
        </div>`;
      }
      const chip = it.speaker
        ? `<button class="spk-chip" data-local="${escapeAttr(it.localId || "")}"
             style="--spk:${speakerColor(it.localId)}" title="点击改名">${escapeHtml(it.speaker)}</button>`
        : "";
      return `<div class="seg-row${chip ? " is-turn" : ""}" data-ms="${it.startMs}">
        <button class="seg-ts" data-ms="${it.startMs}" title="跳转到此处">${formatFrac(it.startMs / 1000)}</button>
        ${chip}
        <p class="seg-text">${escapeHtml(it.parts.join(" "))}</p>
      </div>`;
    })
    .join("");
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
      try {
        const resp = await fetch(`/api/jobs/${job.id}/diarize`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        const data = await resp.json();
        if (!data.success) {
          showError(data.error || "重新标注失败");
          btn.disabled = false;
          btn.textContent = "重新标注";
          return;
        }
        switchView("new");
        newViewTitle.textContent = "重新标注说话人";
        progressCard.hidden = false;
        progressStart = Date.now();
        pollJob(job.id);
      } catch {
        showError("网络错误，请检查后端是否启动");
        btn.disabled = false;
        btn.textContent = "重新标注";
      }
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

  renderDiarizeBanner(job);

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
    const parts = [];
    if (state.speakers.length) parts.push(`${state.speakers.length} 人`);
    if (state.markers.length) parts.push(`${state.markers.length} 条标记`);
    segCount.textContent = parts.join(" · ") || `${withText.length} 段`;
    segList.innerHTML = renderTranscriptRows(withText, state.markers);
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
  state.markers = [];
  state.speakers = [];
  detailTitle.textContent = record.title;
  setMeta(record, null);
  btnFav.classList.toggle("active", getFavs().has(record.id));
  jobBanner.hidden = true;
  diarizeBanner.hidden = true;
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

  const markerRows =
    json.markers && json.markers.length
      ? `<ul class="sum-list">${json.markers
          .map((m) => {
            const sec = parseClock(m.at);
            const at = sec != null
              ? `<button class="todo-at" data-ms="${sec * 1000}">${escapeHtml(m.at)}</button>`
              : "";
            const used = { content: "已纳入内容", decisions: "已纳入决议", todos: "已转待办", unused: "未纳入" }[m.usedIn] || "";
            return `<li><span class="todo-text">${escapeHtml(m.text)}</span>
              <span class="todo-owner">${escapeHtml(used)}</span>${at}</li>`;
          })
          .join("")}</ul>`
      : "";

  const speakerRows =
    json.speakerPoints && json.speakerPoints.length
      ? `<ul class="sum-list">${json.speakerPoints
          .map((s) => `<li><b>${escapeHtml(s.speaker)}</b>：${escapeHtml((s.points || []).join("；"))}</li>`)
          .join("")}</ul>`
      : "";

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
    }
    ${
      markerRows
        ? `<div class="sum-section"><span class="sum-label">现场标记</span>${markerRows}</div>`
        : ""
    }
    ${
      speakerRows
        ? `<div class="sum-section"><span class="sum-label">按人要点</span>${speakerRows}</div>`
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
  const ts = e.target.closest(".seg-ts") || e.target.closest(".marker-ts");
  if (ts) return seekTo(Number(ts.dataset.ms));
  const chip = e.target.closest(".spk-chip");
  if (chip) return startSpeakerRename(chip);
});

/** 发言块上的说话人 chip：就地改成真名，改完刷新整页数据 */
function startSpeakerRename(chip) {
  const localId = chip.dataset.local;
  if (!localId || !state.job) return;
  const old = chip.textContent;
  const input = document.createElement("input");
  input.className = "spk-input";
  input.value = old;
  input.setAttribute("aria-label", "修改说话人名称");
  chip.replaceWith(input);
  input.focus();
  input.select();

  let settled = false;
  const finish = async (save) => {
    if (settled) return;
    settled = true;
    const value = input.value.trim();
    if (!save || !value || value === old) {
      input.replaceWith(chip);
      return;
    }
    try {
      const resp = await fetch(`/api/jobs/${state.job.id}/speakers`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ localId, label: value }),
      });
      const data = await resp.json();
      if (!data.success) {
        showError(data.error || "改名失败");
        input.replaceWith(chip);
        return;
      }
      await openDetail({ jobId: state.job.id });
      showError("名称已更新，已有纪要需要重新生成才会用上新名字");
    } catch {
      showError("网络错误，名称未保存");
      input.replaceWith(chip);
    }
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));
}
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
    if (j.markers?.length) {
      lines.push(`## 现场标记`);
      j.markers.forEach((m) => lines.push(`- ${m.at ? m.at + " " : ""}${m.text}`));
      lines.push("");
    }
    if (j.speakerPoints?.length) {
      lines.push(`## 按人要点`);
      j.speakerPoints.forEach((s) => lines.push(`- ${s.speaker}：${(s.points || []).join("；")}`));
      lines.push("");
    }
  }
  lines.push(`## 转写全文`, "");
  if (state.segments.length) {
    state.segments.forEach((s) => {
      if (!(s.text || "").trim()) return;
      const spk = s.speakerLabel || s.speaker;
      lines.push(`[${formatFrac(s.startMs / 1000)}] ${spk ? spk + "：" : ""}${s.text}`);
    });
  } else {
    lines.push(record.transcript || "");
  }
  if (state.markers.length) {
    lines.push("", `## 录音标记`, "");
    state.markers.forEach((m) => {
      lines.push(`- ${formatFrac(m.startMs / 1000)} ${m.text}`);
    });
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

/**
 * 三区工作台：
 *   顶部  = 控制 + 时间轴（波形 / 播放头 / 标记钉）
 *   左下  = 实时转写（事实层）
 *   右下  = 用户标记（判断层）
 *
 * 时间轴口径：音频时钟 = 已推 PCM 的时长，暂停不前进。
 * 标记只依赖这个时钟，所以它天然与字幕对齐，暂停期间记的标记落在暂停点。
 */

const rec = {
  ws: null,
  ctx: null,
  node: null,
  stream: null,
  scriptNode: null,
  jobId: null,
  active: false,
  paused: false,
  finalizing: false,
  audioMs: 0,
  sentences: new Map(),
  nodes: new Map(),
  wave: [],                 // 每 2 秒一个桶，值为 0~1 的幅度
  marks: [],
  draft: { active: false, startMs: 0, startedAt: 0, text: "" },
  ticker: null,
  elapsedTicker: null,
  follow: true,
  wordCount: 0,
  lastFinalMs: 0,
  seq: 0,
  afterStopGoHome: false,
  stopTimer: null,
};

const recIdle = $("#recIdle");
const recWorkspace = $("#recWorkspace");
const recDot = $("#recDot");
const recStatus = $("#recStatus");
const recTimer = $("#recTimer");
const recSubs = $("#recSubs");
const recFoot = $("#recFoot");
const recWordCount = $("#recWordCount");
const noteList = $("#noteList");
const noteEmpty = $("#noteEmpty");
const noteInput = $("#noteInput");
const composerStatus = $("#composerStatus");
const composerStart = $("#composerStart");
const composerElapsed = $("#composerElapsed");
const noteCount = $("#noteCount");
const markCount = $("#markCount");
const tabMarkCount = $("#tabMarkCount");
const btnMic = $("#btnMic");
const btnPause = $("#btnPause");
const btnStop = $("#btnStop");
const recPins = $("#recPins");
const recCanvas = $("#recCanvas");
const recPlayhead = $("#recPlayhead");
const recLive = $("#recLive");
const liveTag = $("#liveTag");

const TIMELINE_SPAN_MS = 5 * 60 * 1000;   // 超过 5 分钟就滚动窗口
const WAVE_BUCKET_MS = 2000;

function openRec() {
  resetRec();
  switchView("rec");
  recIdle.hidden = false;
  recWorkspace.hidden = true;
}

function showIdle() {
  recIdle.hidden = false;
  recWorkspace.hidden = true;
}

function showWorkspace() {
  recIdle.hidden = true;
  recWorkspace.hidden = false;
  drawTimeline();
  renderPins();
  noteInput.focus({ preventScroll: true });
}

function resetRec() {
  rec.active = false;
  rec.paused = false;
  rec.finalizing = false;
  rec.audioMs = 0;
  rec.jobId = null;
  rec.sentences.clear();
  rec.nodes.clear();
  rec.wave = [];
  rec.marks = [];
  rec.follow = true;
  rec.wordCount = 0;
  rec.lastFinalMs = 0;
  rec.seq = 0;
  rec.afterStopGoHome = false;
  clearInterval(rec.ticker);
  rec.ticker = null;
  clearInterval(rec.elapsedTicker);
  rec.elapsedTicker = null;
  clearTimeout(rec.stopTimer);
  rec.stopTimer = null;

  resetDraft();
  if (recSubs) recSubs.innerHTML = `<p class="sub-empty">开始说话，字幕会出现在这里</p>`;
  if (recTimer) recTimer.textContent = "00:00";
  if (recStatus) recStatus.textContent = "连接中";
  if (recDot) recDot.className = "rec-dot";
  if (recFoot) recFoot.textContent = "已转写 00:00 / 已录 00:00";
  if (recWordCount) recWordCount.textContent = "0 字";
  if (recPins) recPins.innerHTML = "";
  if (recPlayhead) recPlayhead.style.left = "0%";
  renderNotes();
  if (btnMic) {
    btnMic.disabled = false;
    btnMic.innerHTML = micIcon() + "开始录音";
  }
  if (btnPause) {
    btnPause.disabled = false;
    btnPause.textContent = "暂停";
  }
  if (btnStop) {
    btnStop.disabled = true;
    btnStop.textContent = "结束";
  }
  if (liveTag) liveTag.textContent = "实时";
  setRecTab("transcript");
}

function micIcon() {
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2.5" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3.5"/></svg>`;
}

/* ---------- 时钟与时间轴 ---------- */

function updateClock() {
  if (!recTimer) return;
  recTimer.textContent = formatDuration(rec.audioMs / 1000);
  recFoot.textContent = `已转写 ${formatDuration((rec.lastFinalMs || 0) / 1000)} / 已录 ${formatDuration(rec.audioMs / 1000)}`;
  updatePlayhead();
}

function timelineWindow() {
  const total = Math.max(TIMELINE_SPAN_MS, rec.audioMs + 1000);
  if (total <= TIMELINE_SPAN_MS) return { start: 0, end: TIMELINE_SPAN_MS };
  return { start: total - TIMELINE_SPAN_MS, end: total };
}

function updatePlayhead() {
  if (!recPlayhead) return;
  const { start, end } = timelineWindow();
  const pct = Math.max(0, Math.min(100, ((rec.audioMs - start) / (end - start)) * 100));
  recPlayhead.style.left = pct + "%";
}

function pushLevel(rms) {
  const i = Math.floor(rec.audioMs / WAVE_BUCKET_MS);
  const v = Math.min(1, rms * 7);
  rec.wave[i] = Math.max(rec.wave[i] || 0, v);
}

function drawTimeline() {
  if (!recCanvas || recWorkspace.hidden) return;
  const rect = recCanvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;

  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(rect.width);
  const h = Math.round(rect.height);
  if (recCanvas.width !== w * dpr || recCanvas.height !== h * dpr) {
    recCanvas.width = w * dpr;
    recCanvas.height = h * dpr;
  }

  const ctx = recCanvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const { start, end } = timelineWindow();
  const span = Math.max(1, end - start);

  // 分钟刻度
  ctx.strokeStyle = "#e4e0d6";
  ctx.lineWidth = 1;
  const firstTick = Math.ceil(start / 60000) * 60000;
  for (let t = firstTick; t < end; t += 60000) {
    const x = Math.round(((t - start) / span) * w) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }

  // 波形：2 秒一柱
  const first = Math.floor(start / WAVE_BUCKET_MS);
  const last = Math.ceil(end / WAVE_BUCKET_MS);
  const bw = Math.max(1.5, w / (span / WAVE_BUCKET_MS) - 1);
  ctx.fillStyle = "#d84a35";
  ctx.globalAlpha = 0.5;
  for (let i = first; i <= last; i++) {
    const v = rec.wave[i] || 0;
    if (!v) continue;
    const x = ((i * WAVE_BUCKET_MS - start) / span) * w;
    const bh = Math.max(2, v * (h - 6));
    ctx.fillRect(x, (h - bh) / 2, bw, bh);
  }
  ctx.globalAlpha = 1;
}

let drawTimer = null;
function scheduleDraw() {
  if (drawTimer) return;
  drawTimer = requestAnimationFrame(() => {
    drawTimer = null;
    drawTimeline();
  });
}

function renderPins() {
  if (!recPins) return;
  const { start, end } = timelineWindow();
  recPins.innerHTML = rec.marks
    .filter((m) => m.startMs >= start && m.startMs <= end)
    .map((m) => {
      const pct = ((m.startMs - start) / (end - start)) * 100;
      return `<button class="rec-pin" style="left:${pct}%" data-id="${escapeAttr(m.id)}"
        title="${escapeAttr(m.text.slice(0, 60))}" aria-label="标记：${escapeAttr(m.text.slice(0, 30))}"></button>`;
    })
    .join("");
}

/* ---------- 录音主流程 ---------- */

async function startRecording() {
  if (rec.active) return;
  btnMic.disabled = true;
  btnMic.textContent = "正在连接…";
  rec.finalizing = false;
  rec.afterStopGoHome = false;

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
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("无法连接转写服务"));
    });

    ws.onmessage = onRecMessage;
    ws.onclose = () => {
      if (rec.active && !rec.finalizing) {
        stopAudioGraph();
        rec.active = false;
        showError("转写连接已断开，本次录音已中断");
        resetRec();
        showIdle();
      }
    };

    // 必须在 start 之前挂好 onmessage：started 是紧接着下发的
    ws.send(JSON.stringify({ type: "start", language: language.value, output: state.output }));

    // 先置 active，避免音频图刚连上时的头几帧被丢掉
    rec.active = true;
    await startAudioGraph();

    // 连接可能在建图期间就断了，别再切到工作台
    if (!rec.active) return;

    showWorkspace();
    btnStop.disabled = false;
    btnPause.disabled = false;
    recStatus.textContent = "连接中";
    recDot.className = "rec-dot is-idle";

    clearInterval(rec.ticker);
    rec.ticker = setInterval(() => {
      updateClock();
      scheduleDraw();
    }, 500);
    updateClock();
  } catch (e) {
    showError(e.message || "无法启动录音");
    rec.active = false;
    btnMic.disabled = false;
    btnMic.textContent = "重新请求麦克风";
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
  pushLevel(Math.sqrt(sum / Math.max(1, pcm.length / 8)));

  if (rec.ws && rec.ws.readyState === WebSocket.OPEN) {
    rec.ws.send(buffer);
  }
  rec.audioMs += 100;
  updateClock();
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

function onRecMessage(ev) {
  let msg;
  try { msg = JSON.parse(ev.data); } catch { return; }

  if (msg.type === "started") {
    rec.jobId = msg.jobId;
    restoreLocalMarks(msg.jobId);
    return;
  }
  if (msg.type === "ready") {
    syncClock(msg.audioMs);
    recStatus.textContent = "录音中";
    recDot.className = "rec-dot is-live";
    return;
  }
  if (msg.type === "paused") {
    syncClock(msg.audioMs);
    recStatus.textContent = "已暂停";
    recDot.className = "rec-dot is-idle";
    return;
  }
  if (msg.type === "resumed") {
    syncClock(msg.audioMs);
    recStatus.textContent = "录音中";
    recDot.className = "rec-dot is-live";
    return;
  }
  if (msg.type === "sentence") {
    upsertSentence(msg);
    return;
  }
  if (msg.type === "marker-ack") {
    const m = rec.marks.find((x) => x.id === msg.id);
    if (m) m.synced = true;
    persistLocalMarks();
    return;
  }
  if (msg.type === "marker-nack") {
    showError(`标记未能保存：${msg.message || "未知原因"}`);
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

/**
 * 服务端时钟与本地偏差过大时校正，只影响此后的标记，已提交的不回改。
 * 阈值取 200ms：暂停时服务端会补 0.5s 静音来促使断句，那 500ms 必须被吸收，
 * 否则暂停一次，之后所有标记都会比字幕早半秒。
 */
function syncClock(serverMs) {
  const v = Number(serverMs);
  if (!Number.isFinite(v)) return;
  if (Math.abs(v - rec.audioMs) > 200) {
    rec.audioMs = v;
    updateClock();
  }
}

function upsertSentence(msg) {
  const key = String(msg.id ?? `s${msg.startMs}`);
  rec.sentences.set(key, msg);

  let el = rec.nodes.get(key);
  if (!el) {
    el = document.createElement("p");
    el.className = "sub-line";
    el.innerHTML = `<span class="sub-ts"></span><span class="sub-text"></span>`;
    rec.nodes.set(key, el);
    const empty = recSubs.querySelector(".sub-empty");
    if (empty) empty.remove();
    recSubs.appendChild(el);
  }
  el.dataset.ms = msg.startMs;
  el.classList.toggle("is-partial", !msg.final);
  el.querySelector(".sub-ts").textContent = formatFrac(msg.startMs / 1000);
  el.querySelector(".sub-text").textContent = msg.text;

  if (msg.final) {
    rec.lastFinalMs = Math.max(rec.lastFinalMs, msg.endMs || msg.startMs);
    recLive.textContent = "新增一句";
    rec.wordCount = 0;
    for (const s of rec.sentences.values()) {
      if (s.final) rec.wordCount += (s.text || "").replace(/\s/g, "").length;
    }
    recWordCount.textContent = `${rec.wordCount} 字`;
    updateClock();
  }

  if (rec.follow) recSubs.scrollTop = recSubs.scrollHeight;
}

/* ---------- 标记 ---------- */

function noteBeginIfNeeded() {
  if (rec.draft.active || !rec.active || rec.finalizing) return;
  rec.draft.active = true;
  rec.draft.startMs = Math.round(rec.audioMs);
  rec.draft.startedAt = Date.now();
  rec.draft.text = "";
  composerStatus.hidden = false;
  composerStart.textContent = `开始于 ${formatFrac(rec.draft.startMs / 1000)}`;
  updateElapsed();
  clearInterval(rec.elapsedTicker);
  rec.elapsedTicker = setInterval(updateElapsed, 500);
}

function updateElapsed() {
  if (!rec.draft.active) return;
  const sec = Math.max(0, Math.round((Date.now() - rec.draft.startedAt) / 1000));
  composerElapsed.textContent = `已 ${sec} 秒`;
}

function resetDraft() {
  rec.draft.active = false;
  rec.draft.startMs = 0;
  rec.draft.startedAt = 0;
  rec.draft.text = "";
  clearInterval(rec.elapsedTicker);
  rec.elapsedTicker = null;
  if (composerStatus) composerStatus.hidden = true;
  if (noteInput) noteInput.value = "";
  if (noteCount) noteCount.textContent = "0/2000";
}

function clearDraftInput() {
  const hasText = noteInput.value.trim().length > 0;
  if (!hasText) return resetDraft();
  confirmDialog({
    title: "清空这条标记",
    body: "当前输入的内容会丢失，确定清空吗？",
    okText: "清空",
  }).then((ok) => {
    if (ok) resetDraft();
    else noteInput.focus();
  });
}

function submitNote({ silent = false } = {}) {
  if (!rec.draft.active) return false;
  const text = noteInput.value.trim();
  if (!text) {
    if (!silent) {
      noteInput.classList.remove("is-shake");
      void noteInput.offsetWidth;
      noteInput.classList.add("is-shake");
      showError("先写点什么再回车");
    }
    return false;
  }

  const mark = {
    id: "mk_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36),
    startMs: rec.draft.startMs,
    endMs: Math.round(rec.audioMs),
    text,
    duringPause: rec.paused,
    createdAt: Date.now(),
    seq: rec.seq++,
    synced: false,
  };
  rec.marks.push(mark);

  sendMark(mark);
  persistLocalMarks();

  resetDraft();
  renderNotes();
  renderPins();
  scrollNotesToBottom();
  return true;
}

function sendMark(mark) {
  if (!rec.ws || rec.ws.readyState !== WebSocket.OPEN) return;
  rec.ws.send(JSON.stringify({
    type: "mark",
    id: mark.id,
    startMs: mark.startMs,
    endMs: mark.endMs,
    text: mark.text,
    duringPause: mark.duringPause,
    seq: mark.seq,
  }));
}

function deleteMark(id) {
  const idx = rec.marks.findIndex((m) => m.id === id);
  if (idx < 0) return;
  rec.marks.splice(idx, 1);
  if (rec.ws && rec.ws.readyState === WebSocket.OPEN) {
    rec.ws.send(JSON.stringify({ type: "mark-delete", id }));
  }
  persistLocalMarks();
  renderNotes();
  renderPins();
}

function renderNotes() {
  if (!noteList) return;
  const items = rec.marks.slice().sort((a, b) => a.startMs - b.startMs || a.seq - b.seq);
  markCount.textContent = `${items.length} 条`;
  if (tabMarkCount) tabMarkCount.textContent = items.length ? String(items.length) : "";

  if (!items.length) {
    noteList.innerHTML = `<p class="note-empty" id="noteEmpty">会议中随时记下要点，回车即存。时间点会自动对齐到录音。</p>`;
    return;
  }

  noteList.innerHTML = items
    .map(
      (m) => `<article class="note-card" data-id="${escapeAttr(m.id)}">
        <div class="note-head">
          <button class="note-ts" data-ms="${m.startMs}" title="点击定位到这段字幕">${formatFrac(m.startMs / 1000)}</button>
          ${m.duringPause ? `<span class="note-flag">暂停中</span>` : ""}
          <span class="note-actions">
            <button class="note-act" data-act="edit" type="button">编辑</button>
            <button class="note-act is-danger" data-act="del" type="button">删除</button>
          </span>
        </div>
        <p class="note-text">${escapeHtml(m.text)}</p>
      </article>`
    )
    .join("");
}

function scrollNotesToBottom() {
  noteList.scrollTop = noteList.scrollHeight;
}

function startEditNote(card) {
  const id = card.dataset.id;
  const mark = rec.marks.find((m) => m.id === id);
  if (!mark) return;
  const textEl = card.querySelector(".note-text");
  const ta = document.createElement("textarea");
  ta.className = "note-edit";
  ta.value = mark.text;
  ta.rows = 2;
  textEl.replaceWith(ta);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);

  let settled = false;
  const finish = (save) => {
    if (settled) return;
    settled = true;
    const value = ta.value.trim();
    if (save && value && value !== mark.text) {
      mark.text = value;
      sendMark(mark);
      persistLocalMarks();
    }
    renderNotes();
    renderPins();
  };
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); finish(false); }
    else if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); finish(true); }
  });
  ta.addEventListener("blur", () => finish(true));
}

/* ---------- 本地恢复 ---------- */

const PENDING_MARKS_KEY = "vs.marks.pending";

function marksKey(jobId) {
  return `vs.marks.${jobId || "pending"}`;
}

/**
 * 双写：jobId 未知（started 还没到）时先写 pending，
 * 拿到 jobId 后写自己的键。避免把上一场会议的标记错挂到这一场。
 */
function persistLocalMarks() {
  try {
    const data = JSON.stringify(rec.marks.map((m) => ({
      id: m.id, startMs: m.startMs, endMs: m.endMs, text: m.text,
      duringPause: m.duringPause, createdAt: m.createdAt, seq: m.seq,
    })));
    localStorage.setItem(rec.jobId ? marksKey(rec.jobId) : PENDING_MARKS_KEY, data);
  } catch {}
}

function clearLocalMarks() {
  try {
    if (rec.jobId) localStorage.removeItem(marksKey(rec.jobId));
    localStorage.removeItem(PENDING_MARKS_KEY);
  } catch {}
}

/** 把 started 之前输入的标记并入当前会话，并补发一次 */
function restoreLocalMarks(jobId) {
  let stored = [];
  try {
    stored = JSON.parse(localStorage.getItem(PENDING_MARKS_KEY) || "[]");
  } catch { stored = []; }

  const pending = (Array.isArray(stored) ? stored : []).filter(
    (m) => m && m.id && !rec.marks.some((x) => x.id === m.id)
  );
  if (!pending.length) return;

  for (const m of pending) {
    const mark = { ...m, synced: false };
    rec.marks.push(mark);
    sendMark(mark);
  }
  try { localStorage.removeItem(PENDING_MARKS_KEY); } catch {}
  persistLocalMarks();
  renderNotes();
  renderPins();
  showError(`已恢复 ${pending.length} 条开始录音前输入的标记`);
}

/* ---------- 结束 ---------- */

async function stopRecording(goHome = false) {
  if (!rec.active || !rec.ws) return;
  if (rec.audioMs < 1000) {
    showError("录音不足 1 秒，再录一会儿吧");
    return;
  }
  rec.finalizing = true;
  rec.afterStopGoHome = goHome;
  btnStop.disabled = true;
  btnPause.disabled = true;
  btnStop.textContent = "正在收尾…";
  recStatus.textContent = "正在生成终稿";
  recDot.className = "rec-dot is-live";

  submitNote({ silent: true });
  stopAudioGraph();
  rec.active = false;

  try {
    rec.ws.send(JSON.stringify({ type: "stop" }));
  } catch {}

  clearTimeout(rec.stopTimer);
  rec.stopTimer = setTimeout(() => {
    if (!rec.finalizing) return;
    rec.finalizing = false;
    showError("收尾超时，已保存已转写内容");
    finishRecordingFlow(null);
  }, 20000);
}

async function finishRecordingFlow(msg) {
  rec.finalizing = false;
  clearTimeout(rec.stopTimer);
  rec.stopTimer = null;
  clearInterval(rec.ticker);
  rec.ticker = null;

  try { rec.ws && rec.ws.close(); } catch {}
  rec.ws = null;

  if (!msg || !msg.recordId) {
    showError("没有识别到语音内容，本次录音未保存");
    clearLocalMarks();
    resetRec();
    showIdle();
    return;
  }

  clearLocalMarks();

  if (rec.afterStopGoHome) {
    resetRec();
    showIdle();
    switchView("home");
    fetchRecords();
    return;
  }

  await openDetail({ jobId: msg.jobId, recordId: msg.recordId });
  // 录音场景默认结束即出纪要，用户不用再点一次
  if (state.output === "summary" && state.job && !state.record?.summaryJson) {
    generateSummary();
  }
}

/* ---------- 交互绑定 ---------- */

$("#btnBackRecIdle").addEventListener("click", () => {
  switchView("home");
});

const recDiarLock = $("#recDiarLock");
if (recDiarLock) recDiarLock.addEventListener("click", () => openModal("recDiarization"));

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
  noteInput.focus({ preventScroll: true });
});

btnStop.addEventListener("click", () => stopRecording(false));

recSubs.addEventListener("scroll", () => {
  const nearBottom = recSubs.scrollHeight - recSubs.scrollTop - recSubs.clientHeight < 40;
  rec.follow = nearBottom;
});

noteInput.addEventListener("compositionstart", noteBeginIfNeeded);
noteInput.addEventListener("paste", noteBeginIfNeeded);
noteInput.addEventListener("input", () => {
  noteBeginIfNeeded();
  rec.draft.text = noteInput.value;
  noteCount.textContent = `${noteInput.value.length}/2000`;
});
noteInput.addEventListener("keydown", (e) => {
  if (e.isComposing || e.keyCode === 229) return;

  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    submitNote();
    return;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    clearDraftInput();
    return;
  }
  if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
    noteBeginIfNeeded();
  }
});

// 焦点不在输入框时，直接敲字也能开始记（字符要手动补进去，focus 是同步切的）
document.addEventListener("keydown", (e) => {
  if (recWorkspace.hidden) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key.length !== 1) return;
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;

  e.preventDefault();
  noteInput.focus({ preventScroll: true });
  noteBeginIfNeeded();

  const start = noteInput.selectionStart ?? noteInput.value.length;
  const end = noteInput.selectionEnd ?? start;
  if (noteInput.value.length >= 2000) return;
  noteInput.value = noteInput.value.slice(0, start) + e.key + noteInput.value.slice(end);
  noteInput.selectionStart = noteInput.selectionEnd = start + e.key.length;
  rec.draft.text = noteInput.value;
  noteCount.textContent = `${noteInput.value.length}/2000`;
});

noteList.addEventListener("click", (e) => {
  const ts = e.target.closest(".note-ts");
  if (ts) return scrollTranscriptTo(Number(ts.dataset.ms));

  const card = e.target.closest(".note-card");
  if (!card) return;
  const act = e.target.closest(".note-act");
  if (!act) return;

  if (act.dataset.act === "edit") return startEditNote(card);
  if (act.dataset.act === "del") {
    const mark = rec.marks.find((m) => m.id === card.dataset.id);
    confirmDialog({
      title: "删除标记",
      body: `确定删除这条标记吗？\n\n${mark?.text || ""}`,
      okText: "删除",
    }).then((ok) => { if (ok) deleteMark(card.dataset.id); });
  }
});

recPins.addEventListener("click", (e) => {
  const pin = e.target.closest(".rec-pin");
  if (!pin) return;
  const card = noteList.querySelector(`.note-card[data-id="${pin.dataset.id}"]`);
  if (!card) return;
  card.scrollIntoView({ block: "nearest", behavior: "smooth" });
  card.classList.add("is-hit");
  setTimeout(() => card.classList.remove("is-hit"), 900);
});

function scrollTranscriptTo(ms) {
  let best = null;
  for (const el of rec.nodes.values()) {
    const v = Number(el.dataset.ms);
    if (v <= ms) best = el;
    else break;
  }
  if (!best) return;
  best.scrollIntoView({ block: "center", behavior: "smooth" });
  best.classList.add("is-hit");
  setTimeout(() => best.classList.remove("is-hit"), 900);
}

$("#recTabs").addEventListener("click", (e) => {
  const tab = e.target.closest(".rec-tab");
  if (tab) setRecTab(tab.dataset.panel);
});

function setRecTab(panel) {
  $$(".rec-tab").forEach((b) => b.classList.toggle("active", b.dataset.panel === panel));
  const body = $("#recBody");
  if (!body) return;
  body.dataset.mobilePanel = panel;
}

// 录音中离开首页链接：先收尾保存，不要静默丢弃
$("#brandHome").addEventListener(
  "click",
  (e) => {
    if (!rec.active) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    confirmDialog({
      title: "结束录音",
      body: "录音还在进行。离开会结束本次录音，已转写的内容与标记会保存。",
      okText: "结束并离开",
    }).then((ok) => {
      if (ok) stopRecording(true);
    });
  },
  true
);

window.addEventListener("resize", () => scheduleDraw());

/* ---------------- 初始化 ---------------- */

$$(".vt-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === state.viewMode));
resetRec();
switchView("home");
fetchRecords();
