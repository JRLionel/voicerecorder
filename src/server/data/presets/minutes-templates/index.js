/**
 * 内置模板收集器：遍历本目录下的模板文件并冻结。
 *
 * 只做三件事：收集 → 校验 id 唯一 → 排序冻结。
 * 不读数据库、不碰网络，保证「模板定义」是纯数据。
 */

const fs = require("node:fs");
const path = require("node:path");

const SECTION_TYPES = new Set(["list", "text", "todos"]);

function collect() {
  const dir = __dirname;
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".js") && name !== "index.js")
    .sort();

  const templates = [];
  for (const name of files) {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const tpl = require(path.join(dir, name));
    if (!tpl || typeof tpl !== "object" || !tpl.id) {
      throw new Error(`内置模板定义非法（缺 id）: ${name}`);
    }
    if (!Array.isArray(tpl.sections) || !tpl.sections.length) {
      throw new Error(`内置模板「${tpl.name || tpl.id}」至少需要一个章节`);
    }
    for (const section of tpl.sections) {
      if (!SECTION_TYPES.has(section.type)) {
        throw new Error(`内置模板「${tpl.name || tpl.id}」章节类型非法: ${section.type}`);
      }
    }
    templates.push(tpl);
  }

  const seen = new Set();
  for (const tpl of templates) {
    if (seen.has(tpl.id)) throw new Error(`内置模板 id 重复: ${tpl.id}`);
    seen.add(tpl.id);
  }

  templates.sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.id.localeCompare(b.id));
  return Object.freeze(templates.map((tpl) => Object.freeze({ ...tpl })));
}

module.exports = collect();
