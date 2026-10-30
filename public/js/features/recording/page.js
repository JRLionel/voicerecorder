/**
 * 实时录音工作台：三区布局
 *   顶部 = 控制 + 时间轴（波形 / 播放头 / 标记钉）
 *   左下 = 实时转写（事实层）
 *   右下 = 用户标记（判断层）
 *
 * 时间轴口径：音频时钟 = 已推 PCM 的时长，暂停不前进。
 * 标记只依赖这个时钟，所以它天然与字幕对齐，暂停期间记的标记落在暂停点。
 */

import { $, $$, flash } from "../../core/dom.js";
import { API } from "../../core/api.js";
import { BUS, emit } from "../../core/bus.js";
import { escapeAttr, escapeHtml, formatDuration, formatFrac } from "../../core/format.js";
import { KEYS, write, remove, read } from "../../core/storage.js";
import { showError } from "../../core/toast.js";
import { state } from "../../core/store.js";
import { switchView, setBeforeLeave } from "../../core/router.js";
import { confirmDialog, openModal } from "../../components/modal.js";
import { micIcon } from "../../components/icons.js";
import { openDetail } from "../detail/page.js";
import { autoGenerateMinutes } from "../minutes/actions.js";
import { PcmCapture } from "./pcm-capture.js";
import {
  drawTimeline, scheduleDraw, renderPins, updatePlayhead, pushLevel, timelineWindow,
  TIMELINE_SPAN_MS, WAVE_BUCKET_MS, recPins,
} from "./timeline.js";

const rec = {
  ws: null,
  capture: null,
  jobId: null,
  active: false,
  paused: false,
  finalizing: false,
  audioMs: 0,
  sentences: new Map(),
  nodes: new Map(),
  wave: [], // 每 2 秒一个桶，值为 0~1 的幅度
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
const recLive = $("#recLive");
const liveTag = $("#liveTag");
const language = $("#language");

/* ---------------- 视图切换 ---------------- */

export function openRec() {
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
  drawTimeline(rec, recWorkspace.hidden);
  renderPins(rec);
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
  if (recSubs) recSubs.innerHTML = '<p class="sub-empty">开始说话，字幕会出现在这里</p>';
  if (recTimer) recTimer.textContent = "00:00";
  if (recStatus) recStatus.textContent = "连接中";
  if (recDot) recDot.className = "rec-dot";
  if (recFoot) recFoot.textContent = "已转写 00:00 / 已录 00:00";
  if (recWordCount) recWordCount.textContent = "0 字";
  if (recPins) recPins.innerHTML = "";
  const playhead = $("#recPlayhead");
  if (playhead) playhead.style.left = "0%";
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

/* ---------------- 时钟 ---------------- */

function updateClock() {
  if (!recTimer) return;
  recTimer.textContent = formatDuration(rec.audioMs / 1000);
  recFoot.textContent = `已转写 ${formatDuration((rec.lastFinalMs || 0) / 1000)} / 已录 ${formatDuration(rec.audioMs / 1000)}`;
  updatePlayhead(rec);
}

/* ---------------- 录音主流程 ---------------- */

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
    ws.send(JSON.stringify({
      type: "start",
      language: language.value,
      output: state.autoMinutes ? "summary" : "transcript",
    }));

    // 先置 active，避免音频图刚连上时的头几帧被丢掉
    rec.active = true;
    await startAudioGraph(stream);

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
      scheduleDraw(rec, recWorkspace.hidden);
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

async function startAudioGraph(stream) {
  rec.capture = new PcmCapture({ onFrame: handlePcm });
  await rec.capture.start(stream);
}

function handlePcm(buffer) {
  if (!rec.active || rec.paused) return;
  const pcm = new Int16Array(buffer);
  let sum = 0;
  for (let i = 0; i < pcm.length; i += 8) {
    const v = pcm[i] / 32768;
    sum += v * v;
  }
  pushLevel(rec, Math.sqrt(sum / Math.max(1, pcm.length / 8)));

  if (rec.ws && rec.ws.readyState === WebSocket.OPEN) {
    rec.ws.send(buffer);
  }
  rec.audioMs += 100;
  updateClock();
}

function stopAudioGraph() {
  if (rec.capture) {
    rec.capture.stop();
    rec.capture = null;
  }
}

function onRecMessage(ev) {
  let msg;
  try {
    msg = JSON.parse(ev.data);
  } catch {
    return;
  }

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
 * 阈值取 200ms：暂停时服务端会补 0.5s 静音来促使断句，那 500ms 必须被吸收。
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
    el.innerHTML = '<span class="sub-ts"></span><span class="sub-text"></span>';
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

/* ---------------- 标记 ---------------- */

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
  renderPins(rec);
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
  renderPins(rec);
}

function renderNotes() {
  if (!noteList) return;
  const items = rec.marks.slice().sort((a, b) => a.startMs - b.startMs || a.seq - b.seq);
  markCount.textContent = `${items.length} 条`;
  if (tabMarkCount) tabMarkCount.textContent = items.length ? String(items.length) : "";

  if (!items.length) {
    noteList.innerHTML =
      '<p class="note-empty" id="noteEmpty">会议中随时记下要点，回车即存。时间点会自动对齐到录音。</p>';
    return;
  }

  noteList.innerHTML = items
    .map(
      (m) => `<article class="note-card" data-id="${escapeAttr(m.id)}">
        <div class="note-head">
          <button class="note-ts" data-ms="${m.startMs}" title="点击定位到这段字幕">${formatFrac(m.startMs / 1000)}</button>
          ${m.duringPause ? '<span class="note-flag">暂停中</span>' : ""}
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
    renderPins(rec);
  };
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      finish(false);
    } else if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      finish(true);
    }
  });
  ta.addEventListener("blur", () => finish(true));
}

/* ---------------- 本地恢复 ---------------- */

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
    write(rec.jobId ? KEYS.marksFor(rec.jobId) : KEYS.pendingMarks, data);
  } catch {}
}

function clearLocalMarks() {
  if (rec.jobId) remove(KEYS.marksFor(rec.jobId));
  remove(KEYS.pendingMarks);
}

/** 把 started 之前输入的标记并入当前会话，并补发一次 */
function restoreLocalMarks(jobId) {
  const stored = read(KEYS.pendingMarks, "[]");
  let list = [];
  try {
    list = JSON.parse(stored || "[]");
  } catch {
    list = [];
  }

  const pending = (Array.isArray(list) ? list : []).filter(
    (m) => m && m.id && !rec.marks.some((x) => x.id === m.id)
  );
  if (!pending.length) return;

  for (const m of pending) {
    const mark = { ...m, synced: false };
    rec.marks.push(mark);
    sendMark(mark);
  }
  remove(KEYS.pendingMarks);
  persistLocalMarks();
  renderNotes();
  renderPins(rec);
  showError(`已恢复 ${pending.length} 条开始录音前输入的标记`);
}

/* ---------------- 结束 ---------------- */

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

  try {
    rec.ws && rec.ws.close();
  } catch {}
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
    emit(BUS.RECORDS_RELOAD);
    return;
  }

  await openDetail({ jobId: msg.jobId, recordId: msg.recordId });
  // 录音场景默认结束即出纪要，用户不用再点一次
  if (state.autoMinutes && !state.minutes.length) {
    autoGenerateMinutes();
  }
}

/* ---------------- 交互绑定 ---------------- */

function setRecTab(panel) {
  $$(".rec-tab").forEach((b) => b.classList.toggle("active", b.dataset.panel === panel));
  const body = $("#recBody");
  if (!body) return;
  body.dataset.mobilePanel = panel;
}

function scrollTranscriptTo(ms) {
  let best = null;
  for (const el of rec.nodes.values()) {
    const v = Number(el.dataset.ms);
    if (v <= ms) best = el;
    else break;
  }
  if (!best) return;
  best.scrollIntoView({ block: "center", behavior: "smooth" });
  flash(best, "is-hit", 900);
}

export function initRecordingPage() {
  $("#btnBackRecIdle").addEventListener("click", () => switchView("home"));

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
      }).then((ok) => {
        if (ok) deleteMark(card.dataset.id);
      });
    }
  });

  recPins.addEventListener("click", (e) => {
    const pin = e.target.closest(".rec-pin");
    if (!pin) return;
    const card = noteList.querySelector(`.note-card[data-id="${pin.dataset.id}"]`);
    if (!card) return;
    card.scrollIntoView({ block: "nearest", behavior: "smooth" });
    flash(card, "is-hit", 900);
  });

  $("#recTabs").addEventListener("click", (e) => {
    const tab = e.target.closest(".rec-tab");
    if (tab) setRecTab(tab.dataset.panel);
  });

  window.addEventListener("resize", () => scheduleDraw(rec, recWorkspace.hidden));

  // 录音中离开：先收尾保存，不要静默丢弃
  setBeforeLeave((target) => {
    if (!rec.active || target !== "home") return true;
    confirmDialog({
      title: "结束录音",
      body: "录音还在进行。离开会结束本次录音，已转写的内容与标记会保存。",
      okText: "结束并离开",
    }).then((ok) => {
      if (ok) stopRecording(true);
    });
    return false;
  });

  resetRec();
}

export { rec, openRec as openRecording, TIMELINE_SPAN_MS, WAVE_BUCKET_MS, timelineWindow };
