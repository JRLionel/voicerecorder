/**
 * 一次性数据迁移：把旧的 records.summary_json 变成独立的 minutes 行。
 *
 * 幂等条件：该记录还没有任何纪要行。
 * 属于业务迁移而不是表结构迁移 —— 它要用到模板归一与 Markdown 渲染。
 */

const tplLib = require("../templates");
const { withTransaction } = require("../../data/db/transaction");
const { newId } = require("../../shared/utils/id");
const { nowIso } = require("../../shared/utils/time");

function migrateLegacySummaries() {
  let migrated = 0;

  withTransaction((db) => {
    const rows = db
      .prepare(
        `SELECT * FROM records
          WHERE summary_json IS NOT NULL AND TRIM(summary_json) <> ''
            AND id NOT IN (SELECT record_id FROM minutes)`
      )
      .all();
    if (!rows.length) return;

    const insert = db.prepare(
      `INSERT INTO minutes
         (id, record_id, job_id, template_id, template_name, template_snapshot,
          json, markdown, topic, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'done', ?)`
    );
    const point = db.prepare(
      "UPDATE records SET current_minutes_id = ?, template_id = ?, template_name = ? WHERE id = ?"
    );
    const snapshot = JSON.stringify(tplLib.snapshotOf(tplLib.DEFAULT_TEMPLATE));

    for (const row of rows) {
      let parsed = null;
      try {
        parsed = JSON.parse(row.summary_json);
      } catch {
        continue;
      }
      if (!parsed) continue;
      const data = tplLib.normalizeSummary(parsed, tplLib.DEFAULT_TEMPLATE);
      const markdown = row.summary_text || tplLib.toMarkdown(tplLib.DEFAULT_TEMPLATE, data);
      const id = newId("min", 6);
      insert.run(
        id, row.id, row.job_id || null, tplLib.DEFAULT_TEMPLATE_ID, tplLib.DEFAULT_TEMPLATE.name,
        snapshot, JSON.stringify(data), markdown, data.topic || null,
        row.updated_at || row.created_at || nowIso()
      );
      point.run(id, tplLib.DEFAULT_TEMPLATE_ID, tplLib.DEFAULT_TEMPLATE.name, row.id);
      migrated += 1;
    }
  });

  return migrated;
}

module.exports = { migrateLegacySummaries };
