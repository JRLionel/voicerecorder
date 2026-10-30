/**
 * 模型配置浮层：顶栏入口 → 配置「纪要生成」与「语音转文字」两类模型服务。
 *
 * 数据流（三层）：
 *   .env（服务端）  →  默认值，只下发 url 与 model，密钥不下发
 *   浏览器覆盖项     →  本地 localStorage，只存「与默认值不同」的字段
 *   实际生效配置     →  逐字段合并：浏览器填了的用浏览器的，没填的回落 .env
 *
 * 所以：
 * - 界面里的模型 ID / 服务地址默认就是 .env 里的当前值，改了才存覆盖项；
 * - 密钥框留空 = 沿用服务端 .env 的密钥（服务端密钥永远不会出现在浏览器里）；
 * - localStorage 里不留默认值，.env 改了这里也跟着变。
 *
 * 配置随请求带给后端（上传 / 生成纪要 / 实时录音 / 重新标注），
 * 后端同样按「浏览器优先、.env 兜底」解析。
 */

import { $, $$ } from "../../core/dom.js";
import { escapeAttr } from "../../core/format.js";
import { API, jsonFetch, postJson } from "../../core/api.js";
import { KEYS, readJson, write } from "../../core/storage.js";
import { lockScroll } from "../../core/scroll-lock.js";
import { showToast } from "../../core/toast.js";

/* ---------- 图标 ----------
   必须排在 FIELD_META 之前：const 有 TDZ，字段表在模块初始化时就会取引号。 */

const globeIcon =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.2 2.4 3.4 5.4 3.4 8.5S14.2 18.1 12 20.5c-2.2-2.4-3.4-5.4-3.4-8.5S9.8 5.9 12 3.5Z"/></svg>';

const keyIcon =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="12" r="3.6"/><path d="M11.6 12H20"/><path d="M17 12v3"/><path d="M14.5 12v2.2"/></svg>';

const modelIcon =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 4 7v10l8 4 8-4V7l-8-4Z"/><path d="m4 7 8 4 8-4"/><path d="M12 11v10"/></svg>';

const boltIcon =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12l1-8.5Z"/></svg>';

const eyeIcon =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/></svg>';

const eyeOffIcon =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9.6 6.2A9.6 9.6 0 0 1 12 5.8c6 0 9.5 6.2 9.5 6.2a17 17 0 0 1-3 3.8"/><path d="M6.3 8.3A16.7 16.7 0 0 0 2.5 12S6 18.2 12 18.2c1.2 0 2.3-.2 3.3-.6"/><path d="m3 3 18 18"/><path d="M10.2 10.3a2.6 2.6 0 0 0 3.6 3.6"/></svg>';

/* ---------- 配置结构 ---------- */

const SCOPES = ["minutes", "batch", "diar", "realtime"];

const MODES = [
  {
    id: "batch",
    title: "非实时",
    sub: "说话人不分离",
    urlPh: "https://asr.example.com/v1",
    modelPh: "whisper-large-v3",
  },
  {
    id: "diar",
    title: "非实时",
    sub: "说话人分离",
    urlPh: "https://asr.example.com/v1",
    modelPh: "paraformer-zh-spk",
  },
  {
    id: "realtime",
    title: "实时",
    sub: "流式低延迟",
    urlPh: "https://asr.example.com/v1",
    modelPh: "streaming-asr-zh",
  },
];

const MINUTES_PLACEHOLDERS = {
  url: "https://api.example.com/v1/chat",
  model: "glm-4-plus",
};

const FIELD_KEYS = ["url", "key", "model"];

const FIELD_META = {
  url: {
    label: "服务地址",
    en: "URL",
    placeholder: "https://api.example.com/v1/chat",
    icon: globeIcon,
  },
  key: {
    label: "密钥",
    en: "API KEY",
    placeholder: "sk-························",
    icon: keyIcon,
  },
  model: {
    label: "模型 ID",
    en: "MODEL ID",
    placeholder: "glm-4-plus",
    icon: modelIcon,
  },
};

/* ---------- 状态 ---------- */

/** 服务端 .env 的默认值：{ url, model, hasKey } */
let defaults = emptyDefaults();

/** 浏览器里的覆盖项：只存与默认值不同的字段 */
let overrides = emptyConfig();

/** 表单当前值（= 覆盖项与默认值合并后的结果） */
let draft = emptyConfig();

let currentMode = "batch";
let saveTimer = null;

const layer = () => $("#modelSetup");

function emptyEntry() {
  return { url: "", key: "", model: "" };
}

function emptyConfig() {
  const cfg = {};
  SCOPES.forEach((s) => {
    cfg[s] = emptyEntry();
  });
  return cfg;
}

function emptyDefaults() {
  const def = {};
  SCOPES.forEach((s) => {
    def[s] = { url: "", model: "", hasKey: false };
  });
  return def;
}

/* ---------- 读写 ---------- */

/** 读取浏览器里存的覆盖项 */
export function loadConfig() {
  const saved = readJson(KEYS.modelConfig, null);
  const cfg = emptyConfig();
  if (!saved || typeof saved !== "object") return cfg;
  SCOPES.forEach((scope) => {
    const src = saved[scope];
    if (!src || typeof src !== "object") return;
    FIELD_KEYS.forEach((k) => {
      if (typeof src[k] === "string") cfg[scope][k] = src[k];
    });
  });
  return cfg;
}

function saveConfig(cfg) {
  write(KEYS.modelConfig, JSON.stringify(cfg));
}

/**
 * 实际生效的配置：浏览器填了的用浏览器的，没填的回落 .env。
 * 密钥永不下发，所以这里的 key 只可能是浏览器自己填的那一份。
 */
function effective(scope) {
  const d = defaults[scope] || { url: "", model: "", hasKey: false };
  const o = overrides[scope] || emptyEntry();
  return {
    url: o.url || d.url || "",
    key: o.key || "",
    model: o.model || d.model || "",
  };
}

/** 该作用域是否已就绪：地址、密钥、模型三项都能拿到 */
export function isReady(scope, cfg = overrides) {
  const d = defaults[scope] || { url: "", model: "", hasKey: false };
  const o = cfg[scope] || emptyEntry();
  const url = o.url || d.url || "";
  const model = o.model || d.model || "";
  const key = o.key || (d.hasKey ? "server" : "");
  return Boolean(url && key && model);
}

/** 已就绪的服务数量（共 4 项：纪要 1 项 + 转写 3 项） */
export function readyCount(cfg = overrides) {
  return SCOPES.filter((s) => isReady(s, cfg)).length;
}

/**
 * 随请求发给后端的覆盖项（只含非空字段）。
 * 后端按「浏览器优先、.env 兜底」解析，所以这里不需要带默认值。
 */
export function modelConfigPayload() {
  const out = {};
  SCOPES.forEach((scope) => {
    const o = overrides[scope] || emptyEntry();
    const item = {};
    FIELD_KEYS.forEach((k) => {
      if (o[k]) item[k] = o[k];
    });
    if (Object.keys(item).length) out[scope] = item;
  });
  return out;
}

/** 拉取服务端默认值（url + model + 有没有配密钥） */
export async function loadDefaults() {
  const data = await jsonFetch(API.modelConfig);
  if (!data || !data.success || !data.defaults) return defaults;
  const next = emptyDefaults();
  SCOPES.forEach((scope) => {
    const d = data.defaults[scope] || {};
    next[scope] = {
      url: typeof d.url === "string" ? d.url : "",
      model: typeof d.model === "string" ? d.model : "",
      hasKey: Boolean(d.hasKey),
    };
  });
  defaults = next;
  return defaults;
}

function isValidUrl(value) {
  if (!value) return false;
  try {
    const u = new URL(value.trim());
    return ["http:", "https:", "ws:", "wss:"].includes(u.protocol);
  } catch {
    return false;
  }
}

/* ---------- 渲染 ---------- */

function fieldHtml(scope, key, cfg, placeholders) {
  const meta = FIELD_META[key];
  const id = `mf-${scope}-${key}`;
  const value = escapeAttr(cfg[key] || "");
  const icon = meta.icon ? `<span class="model-input-icon">${meta.icon}</span>` : "";

  // 密钥框留空 = 沿用服务端配置：给个明说的占位，别让人以为是漏填
  const placeholder =
    key === "key" && defaults[scope]?.hasKey
      ? "留空则沿用服务端配置"
      : escapeAttr(placeholders[key] || meta.placeholder);

  let input;
  if (key === "key") {
    input = `<div class="model-input-wrap">
        ${icon}
        <input class="model-input${icon ? " has-icon" : ""} has-eye" id="${id}" type="password"
               data-scope="${scope}" data-key="${key}" placeholder="${placeholder}"
               value="${value}" autocomplete="off" spellcheck="false">
        <button class="model-eye" type="button" data-eye="${id}" aria-label="显示密钥" title="显示 / 隐藏密钥">${eyeIcon}</button>
      </div>`;
  } else {
    input = `<div class="model-input-wrap">
        ${icon}
        <input class="model-input${icon ? " has-icon" : ""}" id="${id}" type="text"
               data-scope="${scope}" data-key="${key}" placeholder="${placeholder}"
               value="${value}" autocomplete="off" spellcheck="false">
      </div>`;
  }

  return `<div class="model-field" data-field="${key}">
      <label class="model-label" for="${id}">${meta.label}<span class="model-label-en">${meta.en}</span></label>
      ${input}
      <p class="model-err">地址需以 http:// 或 https:// 开头（实时通道也可用 ws:// / wss://）</p>
    </div>`;
}

function testHtml(scope) {
  return `<div class="model-test">
      <button class="model-test-btn" type="button" data-test="${scope}">${boltIcon}<span>测试连接</span></button>
      <span class="model-test-result" data-result="${scope}"></span>
    </div>`;
}

function renderMinutes() {
  const box = $("#minutesFields");
  if (!box) return;
  box.innerHTML =
    FIELD_KEYS.map((k) => fieldHtml("minutes", k, draft.minutes, MINUTES_PLACEHOLDERS)).join("") +
    testHtml("minutes");
}

function renderStt() {
  const panel = $("#sttPanel");
  if (!panel) return;
  const mode = MODES.find((m) => m.id === currentMode) || MODES[0];
  panel.innerHTML =
    FIELD_KEYS.map((k) =>
      fieldHtml(mode.id, k, draft[mode.id], { url: mode.urlPh, model: mode.modelPh })
    ).join("") +
    testHtml(mode.id);
  // 重放面板入场动画
  panel.style.animation = "none";
  void panel.offsetWidth;
  panel.style.animation = "";
}

function setStatus(node, ready, text, partial) {
  if (!node) return;
  const label = node.querySelector("span");
  if (label) label.textContent = text;
  node.classList.toggle("is-ready", Boolean(ready));
  node.classList.toggle("is-partial", Boolean(partial) && !ready);
}

/** 弹窗内的状态指示：跟随表单当前值实时变化 */
function updateDraftStatus() {
  const minutesReady = isReady("minutes", draft);
  setStatus($("#minutesStatus"), minutesReady, minutesReady ? "已配置" : "未配置");

  const sttReady = ["batch", "diar", "realtime"].filter((s) => isReady(s, draft)).length;
  setStatus(
    $("#sttStatus"),
    sttReady === 3,
    `${sttReady} / 3 项已就绪`,
    sttReady > 0 && sttReady < 3
  );
}

/** 顶栏徽标：只跟已保存的配置走 */
export function updateBadge() {
  const badge = $("#modelBadge");
  const btn = $("#btnModelSetup");
  if (!badge) return;
  const n = readyCount(overrides);
  badge.textContent = `${n} / 4`;
  badge.classList.toggle("is-ready", n === 4);
  badge.classList.toggle("is-partial", n > 0 && n < 4);
  if (btn) btn.title = `模型服务已就绪 ${n} / 4 项`;
}

/* ---------- 开关 ---------- */

/** 用「当前表单值」减去「服务端默认值」，只留下真正被改过的字段 */
function draftToOverrides() {
  const next = emptyConfig();
  SCOPES.forEach((scope) => {
    const d = defaults[scope] || { url: "", model: "" };
    const v = draft[scope] || emptyEntry();
    next[scope].url = v.url && v.url !== (d.url || "") ? v.url : "";
    next[scope].model = v.model && v.model !== (d.model || "") ? v.model : "";
    next[scope].key = v.key || "";
  });
  return next;
}

/** 覆盖项 + 默认值 → 表单当前值 */
function buildDraft() {
  const next = emptyConfig();
  SCOPES.forEach((scope) => {
    const e = effective(scope);
    next[scope] = { url: e.url, key: e.key, model: e.model };
  });
  return next;
}

export function openSetup() {
  const box = layer();
  if (!box) return;
  draft = buildDraft();
  renderMinutes();
  renderStt();
  updateDraftStatus();
  box.hidden = false;
  lockScroll(true);
  const first = box.querySelector(".model-input");
  if (first) first.focus();
}

export function closeSetup() {
  const box = layer();
  if (!box || box.hidden) return;
  box.hidden = true;
  lockScroll(false);
  clearTimeout(saveTimer);
  saveTimer = null;
}

export function isSetupOpen() {
  const box = layer();
  return Boolean(box) && !box.hidden;
}

function saveAndClose() {
  overrides = draftToOverrides();
  saveConfig(overrides);
  updateBadge();
  const n = readyCount(overrides);
  showToast(`配置已保存 · ${n}/4 项模型服务就绪`);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    closeSetup();
    saveTimer = null;
  }, 350);
}

/* ---------- 事件 ---------- */

function fieldOf(target) {
  return target.closest ? target.closest(".model-field") : null;
}

function clearFieldError(field) {
  if (field && field.classList.contains("is-error")) field.classList.remove("is-error");
}

function validateField(key, value) {
  if (key !== "url") return true;
  if (!value) return true;
  return isValidUrl(value);
}

function onInput(e) {
  const input = e.target.closest(".model-input");
  if (!input) return;
  const { scope, key } = input.dataset;
  if (!scope || !key || !draft[scope]) return;
  draft[scope][key] = input.value;
  // 重新输入即清除错误态
  if (key === "url") clearFieldError(fieldOf(input));
  updateDraftStatus();
}

function onFocusOut(e) {
  const input = e.target.closest(".model-input");
  if (!input) return;
  const { key } = input.dataset;
  const field = fieldOf(input);
  if (!field) return;
  const value = input.value.trim();
  if (validateField(key, value)) {
    clearFieldError(field);
    return;
  }
  field.classList.add("is-error");
}

async function runTest(scope) {
  const btn = $(`[data-test="${scope}"]`);
  const result = $(`[data-result="${scope}"]`);
  if (!btn || !result) return;
  btn.disabled = true;
  btn.classList.add("is-loading");
  result.className = "model-test-result";
  result.textContent = "检测中…";

  // 传表单当前值（可能还没保存），后端按同一套合并规则去真发一次请求
  const entry = draft[scope] || emptyEntry();
  const data = await postJson(API.modelConfigTest, {
    scope,
    url: entry.url || "",
    key: entry.key || "",
    model: entry.model || "",
  });

  if (data.success && data.ok) {
    result.className = "model-test-result is-ok";
    result.textContent = `已连通 · ${data.latencyMs}ms`;
  } else {
    result.className = "model-test-result is-bad";
    result.textContent = data.error || "检测失败，请检查服务地址与密钥";
  }
  btn.disabled = false;
  btn.classList.remove("is-loading");
}

function onClick(e) {
  const modeBtn = e.target.closest(".model-mode");
  if (modeBtn) {
    const id = modeBtn.dataset.mode;
    if (!id || id === currentMode) return;
    currentMode = id;
    $$(".model-mode").forEach((b) => {
      const on = b.dataset.mode === currentMode;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    renderStt();
    return;
  }

  const eye = e.target.closest("[data-eye]");
  if (eye) {
    const input = document.getElementById(eye.dataset.eye);
    if (!input) return;
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    eye.innerHTML = show ? eyeOffIcon : eyeIcon;
    eye.setAttribute("aria-label", show ? "隐藏密钥" : "显示密钥");
    return;
  }

  const test = e.target.closest("[data-test]");
  if (test) {
    runTest(test.dataset.test);
    return;
  }

  if (e.target.closest("[data-close-model]")) {
    closeSetup();
    return;
  }

  // 点击遮罩空白处关闭
  if (e.target === layer()) closeSetup();
}

function onKeyDown(e) {
  if (e.key === "Escape" && isSetupOpen()) closeSetup();
}

export function initModelSetup() {
  const box = layer();
  if (!box) return;

  const btn = $("#btnModelSetup");
  if (btn) btn.addEventListener("click", openSetup);

  box.addEventListener("input", onInput);
  box.addEventListener("focusout", onFocusOut);
  box.addEventListener("click", onClick);

  const save = $("#modelSave");
  if (save) save.addEventListener("click", saveAndClose);

  document.addEventListener("keydown", onKeyDown);

  // 先把 .env 的默认值取回来，表单里的模型 ID 才是「当前在用的那个」
  overrides = loadConfig();
  loadDefaults().then(() => {
    updateBadge();
  });
  updateBadge();
}
