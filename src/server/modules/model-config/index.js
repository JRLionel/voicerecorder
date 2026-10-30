/**
 * 模型配置：浏览器端填的优先，.env 兜底。
 *
 * 为什么要有这层：服务地址 / 密钥 / 模型 ID 之前只认 .env，换个服务就得改文件重启。
 * 现在可以在界面「模型配置」里填，配置存在浏览器本地，由每次请求带过来；
 * 服务端只在浏览器没填（或填不全）时，才回落到 .env 的默认值。
 *
 * 四个作用域与 .env 的对应关系：
 *   minutes  纪要生成             → MIMO（chat/completions + MIMO_SUMMARY_MODEL）
 *   batch    非实时·说话人不分离  → MIMO（chat/completions + MIMO_ASR_MODEL）
 *   diar     非实时·说话人分离    → 百炼离线识别（BAILIAN_WS_HOST + DIAR_MODEL）
 *   realtime 实时                  → 百炼流式（BAILIAN_WS_HOST + ASR_MODEL）
 *
 * 安全边界：
 * - .env 里的密钥永远不下发给浏览器，GET /api/model-config 只回 url 与 model；
 * - 浏览器传来的字段只做字符串裁剪，不参与任何模板拼接；
 * - 地址只接受 http/https/ws/wss，其余一律丢弃（避免 file:// 之类把本地文件读出去）。
 *
 * 模块导出的是「用当前进程配置」的一份实例；createApi(config) 可以造一份独立配置，
 * 单元测试用它验证「.env 也没配」时的报错路径。
 */

const defaultConfig = require("../../config");

const SCOPES = ["minutes", "batch", "diar", "realtime"];

const SCOPE_META = {
  minutes: { label: "纪要生成", engine: "mimo" },
  batch: { label: "非实时 · 说话人不分离", engine: "mimo" },
  diar: { label: "非实时 · 说话人分离", engine: "bailian" },
  realtime: { label: "实时", engine: "bailian" },
};

const MAX_URL = 500;
const MAX_KEY = 500;
const MAX_MODEL = 200;

const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"]);

/* ---------- 基础工具 ---------- */

function str(value, max) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
}

/**
 * 主机名像不像真的：要么是 localhost，要么带点（域名或 IP）。
 * 只用 URL 解析不够——「不是地址」会被 URL 变成合法的 punycode 主机名。
 */
function isPlausibleHost(hostname) {
  if (!hostname) return false;
  if (hostname === "localhost") return true;
  return hostname.includes(".");
}

/** 从地址里取 host（百炼的接口只需要 host）；也接受不带协议的裸 host */
function hostOf(value) {
  const v = str(value, MAX_URL);
  if (!v) return "";
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`;
  try {
    const u = new URL(withScheme);
    if (!ALLOWED_PROTOCOLS.has(u.protocol)) return "";
    if (!isPlausibleHost(u.hostname)) return "";
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return "";
  }
}

/** 地址是否可用（协议在白名单内、且主机名像真的） */
function isUsableUrl(value) {
  const v = str(value, MAX_URL);
  if (!v) return false;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`;
  try {
    const u = new URL(withScheme);
    return ALLOWED_PROTOCOLS.has(u.protocol) && isPlausibleHost(u.hostname);
  } catch {
    return false;
  }
}

/* ---------- 实例 ---------- */

/**
 * @param {object} cfg 形如 config.build(env) 的配置对象
 */
function createApi(cfg) {
  /** 百炼侧：把 host 补成 https:// 地址，界面里看起来跟 MIMO 那边一致 */
  const bailianUrl = () => (cfg.bailian.wsHost ? `https://${cfg.bailian.wsHost}` : "");

  /** 四个作用域的 .env 默认值（含密钥，只在服务端内部用） */
  function envDefaults() {
    return {
      minutes: {
        url: cfg.mimo.apiUrl,
        key: cfg.mimo.apiKey,
        model: cfg.mimo.summaryModel,
      },
      batch: {
        url: cfg.mimo.apiUrl,
        key: cfg.mimo.apiKey,
        model: cfg.mimo.asrModel,
      },
      diar: {
        url: bailianUrl(),
        key: cfg.bailian.apiKey,
        model: cfg.bailian.diarModel,
      },
      realtime: {
        url: bailianUrl(),
        key: cfg.bailian.apiKey,
        model: cfg.bailian.asrModel,
      },
    };
  }

  /**
   * 给浏览器的默认值：只给 url 与 model，绝不给 key。
   * hasKey 只告诉浏览器「服务端这边有没有配密钥」，方便它算就绪状态。
   */
  function publicDefaults() {
    const defaults = envDefaults();
    const out = {};
    for (const scope of SCOPES) {
      out[scope] = {
        url: defaults[scope].url || "",
        model: defaults[scope].model || "",
        hasKey: Boolean(defaults[scope].key),
      };
    }
    return out;
  }

  /** 归一化单个作用域的三个字段：只保留字符串，裁剪长度 */
  function sanitizeScope(raw) {
    const out = { url: "", key: "", model: "" };
    if (!raw || typeof raw !== "object") return out;
    out.url = str(raw.url, MAX_URL);
    out.key = str(raw.key, MAX_KEY);
    out.model = str(raw.model, MAX_MODEL);
    return out;
  }

  /** 归一化整份浏览器配置 */
  function normalize(raw) {
    const src = raw && typeof raw === "object" ? raw : {};
    const out = {};
    for (const scope of SCOPES) out[scope] = sanitizeScope(src[scope]);
    return out;
  }

  /**
   * 合并两份浏览器配置：新的非空字段覆盖旧的，空字段视作「没传」。
   * 用于「重新标注」这类局部更新——不能把上传时存下来的配置冲掉。
   */
  function merge(base, next) {
    const out = normalize(base);
    const n = normalize(next);
    for (const scope of SCOPES) {
      for (const k of ["url", "key", "model"]) {
        if (n[scope][k]) out[scope][k] = n[scope][k];
      }
    }
    return out;
  }

  /**
   * 从请求体里取出浏览器配置。
   * 上传走 multipart，配置是 JSON 字符串；其余接口是对象，两种都收。
   */
  function parsePayload(raw) {
    if (!raw) return normalize(null);
    if (typeof raw === "object") return normalize(raw);
    if (typeof raw === "string") {
      try {
        return normalize(JSON.parse(raw));
      } catch {
        return normalize(null);
      }
    }
    return normalize(null);
  }

  /**
   * 求某个作用域的最终配置：浏览器填的字段优先，没填的用 .env 补。
   */
  function resolve(scope, override) {
    const base = envDefaults()[scope] || { url: "", key: "", model: "" };
    const ov = sanitizeScope(override);
    return {
      url: ov.url || base.url || "",
      key: ov.key || base.key || "",
      model: ov.model || base.model || "",
    };
  }

  /** MIMO 侧：url 是完整端点，原样使用 */
  function resolveMimo(scope, override) {
    const r = resolve(scope, override);
    if (!r.url || !r.key || !r.model) {
      throw new Error(
        `${SCOPE_META[scope]?.label || scope} 未配置完整：请在「模型配置」里填写服务地址、密钥与模型 ID`
      );
    }
    return r;
  }

  /**
   * 百炼侧：需要 host 而不是完整 URL。
   * workspace 只在仍指向 .env 那个工作区时带上；换成公共端点就别再发这个头。
   */
  function resolveBailian(scope, override) {
    const r = resolve(scope, override);
    const host = hostOf(r.url);
    if (!host || !r.key || !r.model) {
      throw new Error(
        `${SCOPE_META[scope]?.label || scope} 未配置完整：请在「模型配置」里填写服务地址、密钥与模型 ID`
      );
    }
    const sameWorkspace = cfg.bailian.wsHost && host === cfg.bailian.wsHost;
    return {
      host,
      apiKey: r.key,
      model: r.model,
      workspace: sameWorkspace ? cfg.bailian.workspace : "",
    };
  }

  /** 按作用域选解析方式：minutes / batch 走 MIMO，diar / realtime 走百炼 */
  function resolveFor(scope, override) {
    return SCOPE_META[scope]?.engine === "bailian"
      ? resolveBailian(scope, override)
      : resolveMimo(scope, override);
  }

  /** 该作用域是否可用（url / key / model 三项齐全） */
  function isReady(scope, override) {
    const r = resolve(scope, override);
    return Boolean(r.url && r.key && r.model);
  }

  return {
    SCOPES,
    SCOPE_META,
    normalize,
    merge,
    parsePayload,
    resolve,
    resolveFor,
    resolveMimo,
    resolveBailian,
    envDefaults,
    publicDefaults,
    hostOf,
    isUsableUrl,
    isReady,
  };
}

const api = createApi(defaultConfig);

module.exports = { ...api, createApi };
