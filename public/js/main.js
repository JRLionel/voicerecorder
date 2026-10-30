/**
 * 前端入口：加载元数据 → 各 feature 初始化 → 首屏。
 *
 * 依赖方向：main → features → components → core。
 * feature 之间的反向依赖走 core/bus.js 的事件，避免循环 import。
 */

import { $, $$ } from "./core/dom.js";
import { loadMeta } from "./core/meta.js";
import { switchView } from "./core/router.js";
import { BUS, emit } from "./core/bus.js";
import { state } from "./core/store.js";
import { initModal } from "./components/modal.js";

import { initRecordsPage, fetchRecords } from "./features/records/page.js";
import { initUploadPage, openNew } from "./features/upload/page.js";
import { initRecordingPage, openRec } from "./features/recording/page.js";
import { initDetailPage } from "./features/detail/page.js";
import { initMinutesPanel } from "./features/minutes/panel.js";
import { initMinutesActions } from "./features/minutes/actions.js";
import { initTemplatesPage } from "./features/templates/page.js";
import { initPicker, initUploadTemplateButton } from "./features/templates/picker.js";
import { initEditor } from "./features/templates/editor.js";

async function boot() {
  // 阈值 / 文案：服务端 shared/ 的同一份数据
  await loadMeta();

  initModal();

  initRecordsPage();
  initUploadPage();
  initRecordingPage();
  initDetailPage();
  initMinutesPanel();
  initMinutesActions();

  initPicker();
  initEditor();
  initTemplatesPage();
  initUploadTemplateButton($("#btnPickTemplate"));

  // 首页三个入口：上传（视频/音频）与实时录音是两个 feature
  $$(".entry-card").forEach((card) => {
    card.addEventListener("click", () => {
      if (card.dataset.entry === "record") return openRec();
      openNew(card.dataset.entry);
    });
  });

  $("#brandHome").addEventListener("click", () => {
    emit(BUS.STOP_UPLOAD_POLL);
    switchView("home");
    emit(BUS.RECORDS_RELOAD);
  });

  $$(".vt-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === state.viewMode));

  switchView("home");
  await fetchRecords();
}

boot().catch((e) => {
  console.error("[boot] 初始化失败:", e);
});
