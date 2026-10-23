/* ============================================================
   VoiceScribe 声记 — 工作台逻辑
   视图：home（模板+记录列表）/ new（上传转写）/ detail（记录详情）
   ============================================================ */

const $ = (sel) => document.querySelector(sel);

// ---------- 全局元素 ----------
const views = {
  home: $("#viewHome"),
  new: $("#viewNew"),
  detail: $("#viewDetail"),
};
const errorEl = $("#error");
const btnImport = $("#btnImport");

// 首页
const recordsBody = $("#recordsBody");
const listLoading = $("#listLoading");
const btnLoadMore = $("#btnLoadMore");
const searchInput = $("#searchInput");

// 新建
const uploadArea = $("#uploadArea");
const fileInput = $("#fileInput");
const fileInfo = $("#fileInfo");
const fileName = $("#fileName");
const fileSize = $("#fileSize");
const btnRemove = $("#btnRemove");
const language = $("#language");
const btnTranscribe = $("#btnTranscribe");
const loading = $("#loading");
const newViewTitle = $("#newViewTitle");

// 详情
const detailTitle = $("#detailTitle");
const detailMeta = $("#detailMeta");
const btnFav = $("#btnFav");
const btnDelete = $("#btnDelete");
const resultText = $("#resultText");
const usageInfo = $("#usageInfo");
const btnCopy = $("#btnCopy");
const btnSummary = $("#btnSummary");
const summaryLoading = $("#summaryLoading");
const summaryResult = $("#summaryResult");
const summaryText = $("#summaryText");
const btnCopySummary = $("#btnCopySummary");

// ---------- 状态 ----------
const state = {
  view: "home",
  tab: "recent",
  q: "",
  page: 1,
  pageSize: 20,
  total: 0,
  items: [],
  viewMode: localStorage.getItem("vs_view_mode") || "list",
  template: "transcribe",
  record: null,          // 当前详情记录
  pendingSummary: false, // meeting 模板转写后自动生成纪要
};

// 客户端标识，用于「我的」归属
let clientId = localStorage.getItem("vs_client_id");
if (!clientId) {
  clientId = "cli_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  localStorage.setItem("vs_client_id", clientId);
}

// 收藏（本地标记）
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

// ---------- 模板配置 ----------
const TEMPLATES = {
  meeting:    { title: "会议纪要",   color: "t-blue",   autoSummary: true },
  transcribe: { title: "语音转写",   color: "t-violet", autoSummary: false },
  slice:      { title: "长音频切片", color: "t-green",  autoSummary: false },
  report:     { title: "可视化报告", color: "t-amber",  autoSummary: false },
};

// ---------- 工具 ----------
function formatSize(bytes) {
  if (bytes == null) return "—";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function formatDuration(sec) {
  if (sec == null) return "—";
  const s = Math.round(sec);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${pad(m)}:${pad(r)}`;
}

function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.classList.add("show");
  setTimeout(() => errorEl.classList.remove("show"), 5000);
}

function switchView(name) {
  state.view = name;
  for (const [key, el] of Object.entries(views)) {
    el.hidden = key !== name;
  }
  window.scrollTo({ top: 0 });
}

// ---------- 记录列表 ----------
async function fetchRecords({ append = false } = {}) {
  listLoading.classList.add("show");
  try {
    const params = new URLSearchParams({
      q: state.q,
      page: state.page,
      pageSize: state.pageSize,
    });
    const resp = await fetch(`/api/records?${params}`);
    const data = await resp.json();
    if (!data.success) {
      showError(data.error || "获取记录列表失败");
      return;
    }
    let items = data.items;
    if (state.tab === "mine") {
      items = items.filter((it) => it.client_id === clientId);
    } else if (state.tab === "fav") {
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

function recordThumb(template) {
  const tpl = TEMPLATES[template] || TEMPLATES.transcribe;
  return `<span class="rec-thumb ${tpl.color}">
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
  document.querySelector(".records-head").style.display = grid ? "none" : "";

  if (!state.items.length) {
    const hints = {
      recent: "上传一份音频，开始第一次转写",
      mine: "你还没有创建过记录",
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
    return;
  }

  recordsBody.innerHTML = state.items
    .map((it, i) => {
      const metaLine = grid
        ? `<div class="rec-meta-line"><span>${formatDate(it.created_at)}</span><span>${formatDuration(it.duration)}</span><span>${formatSize(it.size)}</span></div>`
        : `
          <span class="rec-col rh-time">${formatDate(it.created_at)}</span>
          <span class="rec-col rh-dur">${formatDuration(it.duration)}</span>
          <span class="rh-src">上传文件</span>
          <span class="rec-col rh-size">${formatSize(it.size)}</span>`;
      return `
        <button class="record-row" data-id="${it.id}" style="animation-delay:${Math.min(i * 40, 320)}ms">
          <span class="rec-main">
            ${recordThumb(it.template)}
            <span class="rec-text">
              <span class="rec-title">${escapeHtml(it.title)}</span>
              <span class="rec-summary">${escapeHtml(it.summary || "（暂无摘要）")}</span>
            </span>
          </span>
          ${metaLine}
        </button>`;
    })
    .join("");

  const hasMore = state.items.length < state.total;
  btnLoadMore.style.display = hasMore ? "inline-flex" : "none";
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  return div.innerHTML;
}

recordsBody.addEventListener("click", (e) => {
  const row = e.target.closest(".record-row");
  if (row) openDetail(row.dataset.id);
});

btnLoadMore.addEventListener("click", () => {
  state.page += 1;
  fetchRecords({ append: true });
});

// 标签页
$("#tabs").addEventListener("click", (e) => {
  const tab = e.target.closest(".tab");
  if (!tab || tab.disabled) return;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
  state.tab = tab.dataset.tab;
  state.page = 1;
  fetchRecords();
});

// 搜索（防抖）
let searchTimer;
searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.q = searchInput.value.trim();
    state.page = 1;
    fetchRecords();
  }, 300);
});

// 视图切换
$("#viewToggle").addEventListener("click", (e) => {
  const btn = e.target.closest(".vt-btn");
  if (!btn) return;
  document.querySelectorAll(".vt-btn").forEach((b) => b.classList.toggle("active", b === btn));
  state.viewMode = btn.dataset.mode;
  localStorage.setItem("vs_view_mode", state.viewMode);
  renderRecords();
});

// ---------- 详情 ----------
async function openDetail(id) {
  try {
    const resp = await fetch(`/api/records/${id}`);
    const data = await resp.json();
    if (!data.success) {
      showError(data.error || "获取记录失败");
      return;
    }
    renderDetail(data.record);
    switchView("detail");
  } catch {
    showError("网络错误，请检查后端是否启动");
  }
}

function renderDetail(record) {
  state.record = record;
  const tpl = TEMPLATES[record.template] || TEMPLATES.transcribe;
  detailTitle.textContent = record.title;
  detailMeta.innerHTML = `
    <span>模板 <b>${tpl.title}</b></span>
    <span>创建 <b>${formatDate(record.created_at)}</b></span>
    <span>时长 <b>${formatDuration(record.duration)}</b></span>
    <span>大小 <b>${formatSize(record.size)}</b></span>`;

  btnFav.classList.toggle("active", getFavs().has(record.id));
  resultText.textContent = record.transcript || "（无识别结果）";
  usageInfo.textContent = record.language ? `语言: ${record.language}` : "";

  if (record.summary_text) {
    summaryText.textContent = record.summary_text;
    summaryResult.classList.add("show");
    btnSummary.style.display = "none";
  } else {
    summaryText.textContent = "";
    summaryResult.classList.remove("show");
    btnSummary.style.display = record.transcript ? "block" : "none";
  }
}

$("#btnBackDetail").addEventListener("click", () => {
  switchView("home");
  fetchRecords();
});

btnFav.addEventListener("click", () => {
  if (!state.record) return;
  const active = toggleFav(state.record.id);
  btnFav.classList.toggle("active", active);
});

btnDelete.addEventListener("click", async () => {
  if (!state.record) return;
  if (!confirm(`确定删除「${state.record.title}」吗？此操作不可恢复。`)) return;
  try {
    const resp = await fetch(`/api/records/${state.record.id}`, { method: "DELETE" });
    const data = await resp.json();
    if (!data.success) {
      showError(data.error || "删除失败");
      return;
    }
    switchView("home");
    state.page = 1;
    fetchRecords();
  } catch {
    showError("网络错误，请检查后端是否启动");
  }
});

// ---------- 新建（上传转写） ----------
function openNew(template) {
  state.template = template;
  state.pendingSummary = false;
  newViewTitle.textContent = `${TEMPLATES[template].title} · 发起闪记`;
  clearFile();
  loading.classList.remove("show");
  switchView("new");
}

document.querySelectorAll(".tpl-card").forEach((card) => {
  card.addEventListener("click", () => openNew(card.dataset.template));
});

btnImport.addEventListener("click", () => openNew("transcribe"));
$("#brandHome").addEventListener("click", () => {
  switchView("home");
  fetchRecords();
});
$("#btnBackNew").addEventListener("click", () => switchView("home"));

function setFile(file) {
  if (!file) return;
  fileName.textContent = file.name;
  fileSize.textContent = formatSize(file.size);
  fileInfo.classList.add("show");
  btnTranscribe.disabled = false;
}

function clearFile() {
  fileInput.value = "";
  fileInfo.classList.remove("show");
  btnTranscribe.disabled = true;
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
fileInput.addEventListener("change", () => {
  if (fileInput.files[0]) setFile(fileInput.files[0]);
});
btnRemove.addEventListener("click", clearFile);

// 转写
btnTranscribe.addEventListener("click", async () => {
  const file = fileInput.files[0];
  if (!file) return;

  btnTranscribe.disabled = true;
  loading.classList.add("show");

  const formData = new FormData();
  formData.append("audio", file);
  formData.append("language", language.value);
  formData.append("clientId", clientId);

  try {
    const resp = await fetch("/api/transcribe", { method: "POST", body: formData });
    const data = await resp.json();

    if (!data.success) {
      showError(data.error || "转写失败");
      return;
    }

    loading.classList.remove("show");
    if (data.recordId) {
      // 若为会议纪要模板，进入详情后自动生成纪要
      state.pendingSummary = TEMPLATES[state.template]?.autoSummary || false;
      await openDetail(data.recordId);
      if (state.pendingSummary && state.record && !state.record.summary_text) {
        generateSummary();
      }
    } else {
      showError("转写成功，但记录保存失败");
    }
  } catch {
    showError("网络错误，请检查后端是否启动");
  } finally {
    loading.classList.remove("show");
    btnTranscribe.disabled = false;
  }
});

// ---------- 会议纪要 ----------
async function generateSummary() {
  const record = state.record;
  if (!record || !record.transcript) return;

  btnSummary.disabled = true;
  btnSummary.style.display = "none";
  summaryLoading.classList.add("show");

  try {
    const resp = await fetch("/api/meeting-summary", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: record.transcript, recordId: record.id }),
    });
    const data = await resp.json();

    if (!data.success) {
      showError(data.error || "生成会议纪要失败");
      btnSummary.style.display = "block";
      return;
    }

    summaryText.textContent = data.summary || "（无结果）";
    summaryResult.classList.add("show");
    state.record.summary_text = data.summary || "";
  } catch {
    showError("网络错误，请检查后端是否启动");
    btnSummary.style.display = "block";
  } finally {
    summaryLoading.classList.remove("show");
    btnSummary.disabled = false;
  }
}

btnSummary.addEventListener("click", generateSummary);

// ---------- 复制 ----------
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

btnCopy.addEventListener("click", () => copyText(resultText.textContent, btnCopy));
btnCopySummary.addEventListener("click", () => copyText(summaryText.textContent, btnCopySummary));

// ---------- 初始化 ----------
document.querySelectorAll(".vt-btn").forEach((b) =>
  b.classList.toggle("active", b.dataset.mode === state.viewMode)
);
switchView("home");
fetchRecords();
