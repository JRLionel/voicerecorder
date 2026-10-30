/**
 * 本地存储：所有键名集中在这里。
 *
 * 为什么集中：改造前 7 个键散落在 3000 行里，
 * 改前缀或做迁移时根本找不全。
 */

export const KEYS = {
  viewMode: "vs_view_mode",
  autoMinutes: "vs_auto_minutes",
  lastTemplateId: "vs_last_template_id",
  clientId: "vs_client_id",
  favs: "vs_fav_ids",
  modelConfig: "vs_model_config",
  pendingMarks: "vs.marks.pending",
  marksFor: (jobId) => `vs.marks.${jobId || "pending"}`,
};

export function read(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : raw;
  } catch {
    return fallback;
  }
}

export function write(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

export function remove(key) {
  try {
    localStorage.removeItem(key);
  } catch {}
}

export function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

/** 设备标识：只用于新建记录时的 client_id，服务端不做校验 */
export function ensureClientId() {
  let id = read(KEYS.clientId);
  if (!id) {
    id = "cli_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    write(KEYS.clientId, id);
  }
  return id;
}

export function getFavorites() {
  try {
    return new Set(JSON.parse(read(KEYS.favs, "[]") || "[]"));
  } catch {
    return new Set();
  }
}

export function saveFavorites(favs) {
  write(KEYS.favs, JSON.stringify([...favs]));
}

/** 切换收藏，返回切换后的状态 */
export function toggleFavorite(id) {
  const favs = getFavorites();
  if (favs.has(id)) favs.delete(id);
  else favs.add(id);
  saveFavorites(favs);
  return favs.has(id);
}
