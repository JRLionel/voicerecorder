/**
 * 上传进度：阶段文案、百分比、切片进度、预计剩余；以及任务轮询。
 */

import { $ } from "../../core/dom.js";
import { API, jsonFetch } from "../../core/api.js";
import { BUS, emit } from "../../core/bus.js";
import { formatDuration } from "../../core/format.js";
import { stageText } from "../../core/meta.js";
import { showError } from "../../core/toast.js";
import { state } from "../../core/store.js";

const progressCard = $("#progressCard");
const stageName = $("#stageName");
const stagePct = $("#stagePct");
const stageDetail = $("#stageDetail");
const stageDot = $("#stageDot");
const barFill = $("#barFill");
const btnCancel = $("#btnCancel");
const btnStart = $("#btnStart");

let progressStart = 0;

export function resetProgress() {
  progressCard.hidden = true;
  barFill.style.width = "0%";
  stagePct.textContent = "0%";
  stageName.textContent = "正在准备";
  stageDetail.textContent = "—";
  stageDot.className = "stage-dot";
  btnCancel.hidden = true;
}

export function renderProgress(job) {
  progressCard.hidden = false;
  const pct = Math.max(0, Math.min(100, job.progress || 0));
  barFill.style.width = pct + "%";
  stagePct.textContent = Math.round(pct) + "%";
  stageName.textContent = stageText(job.stage);

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

  stageDot.className =
    "stage-dot " + (job.status === "failed" ? "is-error" : job.status === "done" ? "is-done" : "is-live");
  btnCancel.hidden = !["queued", "running"].includes(job.status);
}

export function stopPolling() {
  if (state.pollTimer) {
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }
}

function resetStartButton() {
  btnStart.disabled = false;
  btnStart.textContent = "开始处理";
}

export function pollJob(jobId) {
  stopPolling();
  state.pollTimer = setTimeout(async () => {
    const data = await jsonFetch(API.job(jobId));
    if (!data.success) {
      showError(
        String(data.error || "").startsWith("网络错误")
          ? "网络中断，任务可能仍在后台运行"
          : data.error || "查询任务失败"
      );
      return resetStartButton();
    }

    state.job = data.job;
    renderProgress(data.job);
    btnStart.textContent = `处理中 ${Math.round(data.job.progress)}%`;

    if (data.job.status === "done") {
      resetStartButton();
      emit(BUS.OPEN_DETAIL, { jobId, recordId: data.job.recordId });
      return;
    }
    if (["failed", "canceled"].includes(data.job.status)) {
      resetStartButton();
      if (data.job.status === "failed") showError(data.job.error || "任务失败");
      return;
    }
    pollJob(jobId);
  }, 1200);
}

/** 标记开始时间：进入处理页时调用，用于估算剩余时间 */
export function markProgressStart() {
  progressStart = Date.now();
  return progressStart;
}

export function initProgressBindings() {
  btnCancel.addEventListener("click", async () => {
    if (!state.job) return;
    btnCancel.disabled = true;
    btnCancel.textContent = "正在取消";
    await jsonFetch(API.jobCancel(state.job.id), { method: "POST" });
    btnCancel.disabled = false;
    btnCancel.textContent = "取消任务";
  });
}
