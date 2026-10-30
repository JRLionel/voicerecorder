/**
 * 导出 Markdown：纪要（服务端已按模板快照渲染） + 转写全文 + 现场标记。
 *
 * 文件名带模板名与生成时间，不同版本不会互相覆盖。
 */

import { $ } from "../../core/dom.js";
import { formatFrac, formatStamp } from "../../core/format.js";
import { showError } from "../../core/toast.js";
import { state } from "../../core/store.js";

const btnExport = $("#btnExport");

function buildMarkdown() {
  const record = state.record;
  if (!record) return null;
  const detail = state.minutesCurrent;
  const lines = [`# ${record.title}`, ""];

  if (detail && detail.markdown) lines.push(detail.markdown, "");

  lines.push("## 转写全文", "");
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
    lines.push("", "## 录音标记", "");
    state.markers.forEach((m) => {
      lines.push(`- ${formatFrac(m.startMs / 1000)} ${m.text}`);
    });
  }

  const suffix = [detail?.templateName, formatStamp(detail?.createdAt)].filter(Boolean).join("-");
  const filename = `${record.title || "会议纪要"}${suffix ? "-" + suffix : ""}.md`;
  return { text: lines.join("\n"), filename };
}

function download() {
  const result = buildMarkdown();
  if (!result) return showError("还没有可导出的内容");

  const blob = new Blob([result.text], { type: "text/markdown;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = result.filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export function initExport() {
  btnExport.addEventListener("click", download);
}

export { buildMarkdown };
