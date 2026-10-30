/** 文本与文件名处理。 */

/**
 * multer 把非 ASCII 文件名按 latin1 解码，中文会乱码，这里还原一次。
 * 只在「还原后确实更像正常中文」时才采用，避免把本来就是 latin1 的文件名弄坏。
 */
function decodeFilename(name) {
  try {
    const fixed = Buffer.from(name, "latin1").toString("utf8");
    if (fixed.includes("\uFFFD")) return name;
    return /[\u4e00-\u9fa5]/.test(fixed) || !/[\u4e00-\u9fa5]/.test(name) ? fixed : name;
  } catch {
    return name;
  }
}

/** 去掉扩展名，空则给「未命名」 */
function stripExt(name) {
  return String(name || "未命名").replace(/\.[^.]+$/, "") || "未命名";
}

/** 折叠空白，用于摘要投影 */
function collapseSpaces(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

/** 不含空白的字符数（字率护栏用） */
function charCount(text) {
  return String(text || "").replace(/\s/g, "").length;
}

module.exports = { decodeFilename, stripExt, collapseSpaces, charCount };
