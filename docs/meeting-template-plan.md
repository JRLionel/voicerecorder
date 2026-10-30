# 会议纪要 · 自定义模板 实现计划

> 状态：**设计定稿，待实施**
> 正式规格与任务在 `openspec/changes/add-minutes-templates/`（proposal / design / specs / tasks）。本文只保留决策与设计推理，任务清单以 `tasks.md` 为准，避免两处各写一份。
> 前置：`add-speaker-diarization-recording-ui` 归档后再开工（它还差 15 个任务，同改 `minutes-composition` 会互相踩）。

---

## 0. 决策台账

| # | 议题 | 决定 | 关键理由 |
|---|---|---|---|
| D1 | 一份转写几份纪要 | **多份，只追加不覆盖** | 用户明确需要"同一录音多份纪要"；覆盖式重生成会丢结果 |
| D2 | 转写与纪要的关系 | **拆成两个动作**：job 只转写，纪要走 `POST /api/minutes` | 纪要失败不再污染任务状态，可独立重试与换模板 |
| D3 | 旧纪要端点 | 收敛为 `/api/minutes`，旧两个端点留 deprecated 转发 | 前端未用过 `meeting-summary`，但 README 写过，直接删会让文档失效 |
| D4 | 上传页控件 | 「输出类型」→「☑ 转写完成后自动生成纪要」+ 模板行 | 用户视角仍是一个连续过程，后端是两个可重试动作 |
| D5 | 录音链路 | 不加模板选择器，用自动生成开关 + 上次使用的模板 | 纪要属于下一步；录音页保持"一键开始" |
| D6 | 生成并发 | 以 `minutes.status='generating'` 行作锁，10 分钟内重复请求返 409 | 不用额外状态列，行存在与否就是锁 |
| D7 | 系统模板升级 | 不可改不可删，按固定 id upsert，只能复制 | 允许编辑就只能在"覆盖用户修改"和"产生分叉"里二选一 |
| D8 | 列表分区与唯一性 | 同页「系统模板 / 我的模板」两段；全选只作用后者；名称唯一仅约束用户模板 | 分区后"内置没有勾选框"不再显得行为不一致 |
| D9 | 章节 key | 保存时按顺序重生成 `s0..sn`，不保留旧 key | key 只在"生成→回填"单次生命周期内有效，不跨次 |
| D10 | 模板开关项 | `extras` 只留参会人、按人要点；现场标记恒由系统追加 | 标记是审计字段，模板作者无权删掉 |
| D11 | 模板被删后的历史 | 仍可渲染，标注「已删除」 | 快照兜底，否则用户以为界面坏了 |
| D12 | 详情页版本切换 | **并列 pill**，不用版本下拉 | 多份可见、切换只需一次点击 |
| D13 | 导出命名 | `标题-模板名-MMDD-HHmm.md` | 旧实现固定 `标题.md`，连续导出会触发浏览器重名后缀 |
| D14 | 实施时机 | 先写规格，等前置变更归档后实施 | 避免两个变更同时改 `minutes-composition` |

---

## 1. 数据模型

### 1.1 `templates`

```sql
CREATE TABLE IF NOT EXISTS templates (
  id            TEXT PRIMARY KEY,          -- tpl_default / tpl_builtin_* / tpl_XXXXXX
  name          TEXT NOT NULL,
  description   TEXT,
  icon          TEXT,
  color         TEXT,
  builtin       INTEGER NOT NULL DEFAULT 0,
  sections_json TEXT NOT NULL,             -- [{key,title,type,hint}]
  extras_json   TEXT,                      -- {attendees, speakerPoints}
  prompt_extra  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT
);
CREATE UNIQUE INDEX idx_templates_user_name
  ON templates(name COLLATE NOCASE) WHERE builtin = 0;
```

`type` 取 `list` / `text` / `todos`；章节 1~8 个。不引入 `sort_order`：系统模板置顶，其余按 `updated_at DESC` 即可。

### 1.2 `minutes`（本次的核心）

```sql
CREATE TABLE IF NOT EXISTS minutes (
  id                TEXT PRIMARY KEY,
  record_id         TEXT NOT NULL,
  job_id            TEXT,
  template_id       TEXT,                  -- 可空：模板可能已删
  template_name     TEXT NOT NULL,         -- 冗余，删除后仍能显示
  template_snapshot TEXT NOT NULL,         -- 生成时的结构快照
  json              TEXT NOT NULL,
  markdown          TEXT NOT NULL,
  topic             TEXT,
  status            TEXT NOT NULL,         -- generating | done
  created_at        TEXT NOT NULL
);
CREATE INDEX idx_minutes_record ON minutes(record_id, created_at DESC);
```

### 1.3 现有表加列

| 表 | 新列 | 用途 |
|---|---|---|
| `records` | `template_id` / `template_name` | 当前纪要来自哪个模板 |
| `records` | `current_minutes_id` | 指向当前生效的一份 |
| `jobs` | `template_id` | 只存意图，不存快照 |
| `jobs` | `auto_minutes` | 转写完成后是否自动生成 |

`records.template`（`meeting` / `transcribe`）**保持不动**——它只驱动列表缩略图配色，语义改为"有没有纪要"，比原来"用户选了什么"更准确。全部走 `ensureColumns()` 幂等升级。

### 1.4 三条不变式

1. `minutes` 的内容字段写入后永不 UPDATE，唯一跃迁是 `generating → done`
2. `current_minutes_id` 为 NULL 或指向属于该记录的、存在的行
3. 指针变更与 `records.summary` 投影在同一事务内

---

## 2. 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/templates` | 系统在前、其余按更新时间倒序 |
| POST | `/api/templates` | 服务端生成 id 与章节 key；重名 409 |
| PATCH / DELETE | `/api/templates/:id` | 系统模板 403 |
| POST | `/api/templates/batch-delete` | 跳过系统模板，返回 `{deleted, skipped}` |
| POST | `/api/templates/:id/duplicate` | 任意模板可复制 |
| **POST** | **`/api/minutes`** | `{jobId\|recordId\|text, templateId?}`，同步返回 |
| GET | `/api/records/:id/minutes` | 摘要列表（升序，带当前标记） |
| GET / PATCH / DELETE | `/api/minutes/:id` | 读取 / 设为当前 / 删除 |
| POST | `/api/jobs` | 新增 `autoMinutes`、`templateId` |
| GET | `/api/jobs/:id`、`/api/records/:id` | 附带模板信息与纪要摘要列表 |
| ~~POST~~ | `/api/jobs/:id/summary`、`/api/meeting-summary` | deprecated 转发 |

错误码：`TEMPLATE_NAME_TAKEN` / `TEMPLATE_BUILTIN_LOCKED` / `TEMPLATE_INVALID` / `MINUTES_IN_PROGRESS`。

---

## 3. 生成流程

```
POST /api/minutes
  1. 解析模板：请求值 → 记录上已存的 → 默认；不存在则回退并提示
  2. BEGIN
  3. 该记录存在 10 分钟内的 generating → ROLLBACK + 409
  4. INSERT minutes(status='generating')        ← 锁
  5. COMMIT
  6. 读 segments → 按模板生成（事务外，可能数十秒）
  7. BEGIN
  8. UPDATE minutes SET status='done', json, markdown, topic
  9. UPDATE records SET current_minutes_id=新id, summary=主题前 46 字
 10. COMMIT
失败 → DELETE 该 generating 行 + 返回错误（不留脏行）
```

**快照时机跟着动作走**：在纪要动作开始时读取并快照，而不是任务创建时。模板是"当前的写作规范"，执行时取当前版符合直觉；单机场景不存在一边改模板一边跑任务的并发。

**幂等**：自动生成前检查该记录是否已有纪要，有则跳过，避免 `/resume` 反复堆叠。

---

## 4. 界面

### 4.1 模板管理页（`#viewTemplates`）

```
[返回]  我的模板                                [+ 新建模板]
──────────────────────────────────────────────────────────
系统模板
┌──────────────┐ ┌──────────────┐
│ 默认模板 内置 │ │ 周会模板 内置 │      ← 无勾选框，菜单仅「复制」
└──────────────┘ └──────────────┘
我的模板                              ☑ 全选  已选 0 项 · 删除
┌──────────────┐ ┌──────────────┐
│ ☐    ⋯       │ │ ☐    ⋯       │      ← 单选 / 全选 / 编辑 / 复制 / 删除
└──────────────┘ └──────────────┘
```

全选三态复用记录列表的 `syncSelection()` 思路；批量删除复用 `.sel-bar` 浮动条；删除确认文案说明"历史纪要不受影响"。

### 4.2 详情页纪要卡（并列 pill）

```
① 空态     会议纪要
            [ 生成会议纪要 ]                    ← 主按钮，进选择器

② 一份     会议纪要  [＋ 再生成一份]  (( 模板一 ))            复制

③ 多份     会议纪要  [＋ 再生成一份]  ( 模板一 )  (( 模板二 ))  复制

④ 生成中   会议纪要  [＋ 再生成一份]  ( 模板一 )  (( 模板二 ⟳ )) 复制
           正在用「周会模板」生成第 2 份…
```

- pill 从左到右 = 生成顺序；标签为模板名，同模板第二次生成追加 ` 2`；tooltip 显示生成时间
- 点击 pill 只切指针并重渲染正文，**不调模型**
- 删除入口只在当前 pill 的 hover 态出现（移动端常显）；删当前项按右邻 → 左邻回落
- 视觉用胶囊而非下划线 tab：首页那组是导航，这里表达"同一内容的多份结果"
- 按钮文案定为 **「＋ 再生成一份」** 而非「选择模板」，因为"不覆盖"是这个功能的卖点，按钮就该说清

### 4.3 模板选择浮层（`#tplPicker`，三处复用）

上传页、详情页首次生成、详情页再生成共用同一组件。默认选中上次使用的模板（`vs_last_template_id`），不存在则选中默认。模板 >5 个时出搜索框；↑↓ 移动、Enter 确认、Esc 关闭。

### 4.4 模板编辑浮层（`#tplEditor`）

名称、说明、图标与配色、章节行编辑器（增删 + 上下移动）、补充要求。有未保存改动时关闭需二次确认。

⚠️ 现有确认弹窗是单实例的（`app.js:428` 用 `.modal-backdrop:not([hidden])` 守卫）。新增两个浮层必须独立 DOM，并抽 `openLayer/closeLayer` 用计数器管理 `body.overflow`，否则三层叠加会互相抢占。

---

## 5. 对现有默认模板逻辑的影响

| 模块 | 现状 | 改法 | 风险对策 |
|---|---|---|---|
| `reducePrompt()` | 硬编码提示词 | `buildSummaryPrompt(template)`，章节契约动态生成 | 默认模板的系统提示词必须与旧版逐字等价，快照测试锁死 |
| `mapPrompt()` | 与模板无关 | 追加一行模板关注点，提升长会议章节召回 | 成本≈0 |
| `normalize()` | 固定字段清洗 | 支持 `sections[]` 按 key 回填；旧结构经 `legacyToSections()` 转换 | 模型偶发返回旧结构时不出现空白纪要 |
| `toMarkdown()` | 固定七段 | `toMarkdown(template, json)` | 默认模板输出逐字一致（复制/导出被外部依赖） |
| `parseJsonLoose()` 兜底 | 塞 `topic + content[0]` | 塞进首个列表章节 | 失败时仍有内容 |
| `persistRecord()` | 写 `template='meeting'` | 只写转写摘要，`template='transcribe'`；纪要成功后再改 `meeting` | 列表配色依赖该字段，别改语义 |
| `renderSummaryBlock()` | 七个固定块 | 按快照章节遍历，三类分派渲染 | 老记录无快照走运行时转换 |
| `btnExport` | 按固定字段拼 | 导出当前纪要，文件名带模板与时间 | 页面与导出共用同一渲染函数 |
| `server.js` 三处入口 | 无模板参数 | 统一 `resolveTemplate()` | 不带参数时行为与今日一致 |

**一句话**：默认模板不是"新增的一个选项"，而是把今天的行为抽成一条系统模板记录。**等价性是第一优先级**——提示词、JSON、Markdown、DOM 四项都应与改造前一致。

---

## 6. 老数据迁移

每条有 `summary_json` 的记录生成一条 minutes（默认模板、`status='done'`），`current_minutes_id` 指过去。幂等条件：`record_id NOT IN (SELECT record_id FROM minutes)`。`summary_json` / `summary_text` 保留但停止写入，作为只读兜底留一个版本。

迁移前复制一份 `server/data/voicerecorder.db`。回滚不需要动数据：新表新列弃用即可，旧列未删。

---

## 7. 风险

| 风险 | 对策 |
|---|---|
| 默认模板与原产出不等价 | 四项快照测试，差异先解释再合 |
| 指针一致性被绕过 | 写入集中在 `server/minutes.js`，`db.js` 只暴露仓储函数，全部走事务 |
| 模型返回缺 key | 按 title 兜底 → 再按顺序填入首个列表章节 |
| pill 过多撑爆头部 | 横向滚动不换行，`＋` 锚定最左，超 8 份提示总数 |
| 自动生成重复触发 | 已有纪要即跳过；`resume` 不重跑纪要步骤 |
| SQLite 单写者持锁 | LLM 调用放在事务外 |

---

## 8. 本期不做

模板导入导出、模板市场、模板共享、纪要跨记录对比、模板级 few-shot 示例、录音前选择模板、纪要版本分支合并、多纪要软上限（只在 UI 提示总数）。

---

## 9. 实施结果

`openspec/changes/add-minutes-templates` 的 79 项任务全部完成，`openspec validate --strict` 通过。

### 与计划的差异

| 项 | 计划 | 实际 | 原因 |
|---|---|---|---|
| 系统内置模板数量 | 待定（Open Question） | **只放 1 个**（默认模板） | 其余内置模板属产品内容，未定义不臆造；`BUILTIN_TEMPLATES` 数组追加一条即生效，启动按 id upsert |
| 模板列表形态 | 卡片 / 列表 | **只做卡片** | 需求允许「列表或卡片」二选一，卡片更贴合既有 `entry-card` 视觉 |
| 提示词等价性 | 逐字等价 | **语义等价** | 输出结构从固定字段变为 `sections[]`，逐字相同不可能；改为断言角色、七条规则、说话人/标记段落齐全，Markdown 仍逐字一致 |
| 标记去向标签 | 统一文案 | **默认模板点名章节，自定义模板写「已纳入正文」** | 自定义模板没有「会议内容」章节，点名会指向不存在的章节 |

### 实现要点（踩过的点）

- **生成锁就是 minutes 行本身**：`status='generating'` 存在即视为进行中，10 分钟超时视为僵尸；LLM 调用放在事务外，避免 SQLite 单写者被长请求占住
- **三层浮层的 z-index 与滚动锁**：`.layer-backdrop` 920、`.modal-backdrop` 提到 940（编辑器未保存确认要盖在浮层上）、`body.overflow` 用计数器而不是布尔
- **自动生成是 fire-and-forget**：任务完成即 `done`，纪要在后台跑；前端在详情页轮询 `generating` 直到出结果，避免"任务完成但页面空着"
- **幂等**：自动生成前查 `countMinutes(recordId) === 0`，续跑不会重复堆叠
- **模板按 key 回填**：模型返回的 `sections` 按服务端生成的 `s0..sn` 对齐，标题只做展示，防止模型改标题导致串位

### 验证记录

| 项 | 方式 | 结果 |
|---|---|---|
| 默认模板等价性 | `npm run test:templates` | 18 项通过（Markdown 与旧实现逐字一致） |
| 既有逻辑回归 | `npm run test:offline` | 13 项通过 |
| 端到端 | 上传 37s 音频 + 自动生成 | 转写完成 → 自动产出默认模板纪要 → `records.template` 翻为 `meeting` |
| 并发 | 两个请求同时打 `/api/minutes` | 第二个 409 `MINUTES_IN_PROGRESS` |
| 失败清理 | 用不可达模型地址的实例生成 | 500 且不留 `generating` 行，结论数不变 |
| 版本切换 / 删除 | 浏览器 + API | 切换只改指针；删当前项回落到相邻，删光回到空态 |
| 导出命名 | 浏览器下载 | `实时录音 …-默认模板-1030-0918.md` |
| 界面 | 无头 Chromium，1180px 与 375px | 5 个视图无 console 报错，pill 不溢出、顶栏不换行 |
