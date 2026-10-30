/**
 * 系统内置模板：默认会议纪要。
 *
 * 新增一个内置模板 = 在本目录新增一个文件，index.js 会自动收录；
 * id 必须保持稳定（minutes.template_id 逻辑引用它），一旦改动，
 * 已生成的纪要会显示「模板已删除」。
 */

module.exports = {
  id: "tpl_default",
  order: 0,
  name: "会议纪要",
  description: "主题、内容、决议、待办",
  icon: "calendar",
  color: "blue",
  builtin: 1,
  sections: [
    { key: "s0", title: "会议内容", type: "list", hint: "3~8 条，每条 20~60 字，按时间顺序，合并重复内容" },
    { key: "s1", title: "决议", type: "list", hint: "明确达成的结论；没有就给空数组" },
    { key: "s2", title: "待办", type: "todos", hint: "只保留真正的行动项，不要把讨论过程写成待办" },
  ],
  extras: { attendees: true, speakerPoints: true },
  promptExtra: "",
};
