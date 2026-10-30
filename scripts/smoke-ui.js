#!/usr/bin/env node
/**
 * 界面冒烟：用本机无头 Chromium 走一遍 5 个视图，收集 console 报错并断言关键 DOM。
 *
 * 用法：node scripts/smoke-ui.js [baseUrl]
 * 依赖：@playwright 的 chromium headless_shell（无需安装 playwright 包）
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");

const BASE = (process.argv[2] || "http://127.0.0.1:3000").replace(/\/$/, "");
const PORT = 9333;
const CANDIDATES = [
  path.join(os.homedir(), "Library/Caches/ms-playwright/chromium_headless_shell-1148/chrome-mac/headless_shell"),
  path.join(os.homedir(), "Library/Caches/ms-playwright/chromium-1148/chrome-mac/Chromium.app/Contents/MacOS/Chromium"),
];

let pass = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBinary() {
  for (const p of CANDIDATES) if (fs.existsSync(p)) return p;
  return null;
}

async function waitJson(url, tries = 120) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch {}
    await sleep(200);
  }
  throw new Error(`等待 ${url} 超时${typeof chromeErr !== "undefined" && chromeErr ? ` | chrome: ${chromeErr.slice(-400)}` : ""}`);
}

async function main() {
  const bin = findBinary();
  if (!bin) {
    console.error("找不到无头 Chromium，跳过界面冒烟");
    return;
  }

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "vs-ui-"));
  const proc = spawn(bin, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--no-sandbox", "--disable-gpu",
    // 假麦克风：只有 SMOKE_RECORD=1 时才会走到录音流程
    "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
    ...(process.env.SMOKE_RECORD === "1" && fs.existsSync("/tmp/vs-fake.wav")
      ? ["--use-file-for-fake-audio-capture=/tmp/vs-fake.wav"]
      : []),
    "--hide-scrollbars", "--window-size=1280,900", "--force-device-scale-factor=1",
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let chromeErr = "";
  proc.stderr.on("data", (d) => { chromeErr += d.toString(); if (chromeErr.length > 4000) chromeErr = chromeErr.slice(-2000); });

  let ws;
  const pending = new Map();
  let id = 0;
  const consoleErrors = [];
  const pageErrors = [];

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });

  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", {
      expression, returnByValue: true, awaitPromise: true, userGesture: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description || ""));
    return r.result?.value;
  };

  const click = async (selector) => evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.click();
    return true;
  })()`);

  const waitFor = async (expression, ms = 5000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (await evaluate(expression)) return true;
      await sleep(120);
    }
    return false;
  };

  try {
    const targets = await waitJson(`http://127.0.0.1:${PORT}/json/list`);
    const page = targets.find((t) => t.type === "page");
    ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
        return;
      }
      if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
        consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(" "));
      }
      if (msg.method === "Runtime.exceptionThrown") {
        pageErrors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
      }
      if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
        consoleErrors.push(msg.params.entry.text);
      }
    });

    await send("Runtime.enable");
    await send("Log.enable");
    await send("Page.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

    console.log("== 首页 ==");
    await send("Page.navigate", { url: BASE });
    await waitFor(`document.readyState === "complete"`);
    await sleep(800);

    check("5 个视图容器存在", await evaluate(`["viewHome","viewNew","viewRec","viewDetail","viewTemplates"].every(id => document.getElementById(id))`));
    check("首页三个入口", (await evaluate(`document.querySelectorAll("#viewHome .entry-card").length`)) === 3);
    check("记录列表已渲染", await evaluate(`!!document.querySelector("#recordsBody .record-row") || !!document.querySelector("#recordsBody .empty-state")`));

    console.log("== 记录详情 ==");
    const hasRow = await evaluate(`!!document.querySelector("#recordsBody .record-row .rec-open")`);
    if (hasRow) {
      await click("#recordsBody .record-row .rec-open");
      const opened = await waitFor(`document.getElementById("viewDetail").hidden === false`);
      check("点开记录进入详情", opened);
      check("标题已填充", (await evaluate(`document.getElementById("detailTitle").textContent.trim()`)).length > 0);
      check("转写区有内容", await evaluate(`
        (document.querySelectorAll("#segList .seg-row").length > 0) ||
        (document.getElementById("resultText").textContent.trim().length > 0)
      `));
      check("时间轴可点击（存在时间戳按钮）", await evaluate(`document.querySelectorAll("#segList [data-ms]").length > 0`));
      const seeked = await evaluate(`(() => {
        const ts = document.querySelector("#segList .seg-ts");
        if (!ts) return "no-ts";
        ts.click();
        const p = document.getElementById("player");
        return p && p.src ? "ok" : "no-src";
      })()`);
      check("点时间戳装载播放器", seeked === "ok" || seeked === "no-ts", seeked);

      const hasMinutes = await evaluate(`document.getElementById("summaryResult").hidden === false`);
      check("已生成纪要时显示纪要卡片", hasMinutes);
      if (hasMinutes) {
        check("纪要正文有章节", (await evaluate(`document.querySelectorAll("#summaryBody .sum-section").length`)) > 0);
        check("纪要版本胶囊存在", (await evaluate(`document.querySelectorAll("#minuteTabs .minute-tab").length`)) > 0);
      }

      console.log("== 模板选择浮层 ==");
      const openedPicker = await evaluate(`(() => {
        const b = document.getElementById("btnMinuteAdd");
        if (!b || b.offsetParent === null) return false;
        b.click(); return true;
      })()`);
      if (openedPicker) {
        check("打开发纪要浮层", await waitFor(`document.getElementById("tplPicker").hidden === false`));
        check("浮层列出模板", (await evaluate(`document.querySelectorAll("#tplPickerList .tpl-opt").length`)) > 0);
        await click("[data-close-picker]");
        check("关闭浮层", await waitFor(`document.getElementById("tplPicker").hidden === true`));
      }

      await click("#btnBackDetail");
      await waitFor(`document.getElementById("viewHome").hidden === false`);
      check("返回首页", await evaluate(`document.getElementById("viewHome").hidden === false`));
    } else {
      console.log("  --   库里没有记录，跳过详情检查");
    }

    console.log("== 上传视图 ==");
    await click('.entry-card[data-entry="audio"]');
    check("进入上传视图", await waitFor(`document.getElementById("viewNew").hidden === false`));
    check("上传标题正确", (await evaluate(`document.getElementById("newViewTitle").textContent`)).includes("上传音频"));
    check("分离开关存在且默认关闭", await evaluate(`document.getElementById("diarizationCard").getAttribute("aria-pressed") === "false"`));
    await click("#btnBackNew");
    await waitFor(`document.getElementById("viewHome").hidden === false`);

    console.log("== 录音视图 ==");
    await click('.entry-card[data-entry="record"]');
    check("进入录音预录态", await waitFor(`document.getElementById("viewRec").hidden === false && document.getElementById("recIdle").hidden === false`));
    await click("#btnBackRecIdle");
    await waitFor(`document.getElementById("viewHome").hidden === false`);

    console.log("== 模板管理页 ==");
    await click("#btnTemplates");
    check("进入模板页", await waitFor(`document.getElementById("viewTemplates").hidden === false`));
    await sleep(400);
    check("系统模板卡片渲染", (await evaluate(`document.querySelectorAll("#builtinList .tpl-card").length`)) >= 1);
    check("模板页有新建按钮", await evaluate(`!!document.getElementById("btnNewTemplate")`));
    await click("#btnNewTemplate");
    check("新建模板浮层打开", await waitFor(`document.getElementById("tplEditor").hidden === false`));
    check("编辑器默认一个章节", (await evaluate(`document.querySelectorAll("#edSectionList .ed-sec").length`)) === 1);

    const tplName = "冒烟UI模板-" + Date.now().toString(36);
    await evaluate(`(() => {
      const el = document.getElementById("edName");
      el.value = ${JSON.stringify(tplName)};
      el.dispatchEvent(new Event("input", { bubbles: true }));
      document.getElementById("edSave").click();
      return true;
    })()`);
    const created = await waitFor(
      `Array.from(document.querySelectorAll("#mineList .tpl-card-name")).some(n => n.textContent.includes(${JSON.stringify(tplName)}))`,
      6000
    );
    check("通过界面新建模板", created);

    if (created) {
      await evaluate(`(() => {
        const card = Array.from(document.querySelectorAll("#mineList .tpl-card")).find(c => c.textContent.includes(${JSON.stringify(tplName)}));
        const btn = card && card.querySelector('[data-act="delete"]');
        if (btn) btn.click();
        return true;
      })()`);
      check("删除模板弹出确认", await waitFor(`document.getElementById("modalBackdrop").hidden === false`));
      await click("#modalOk");
      const gone = await waitFor(
        `!Array.from(document.querySelectorAll("#mineList .tpl-card-name")).some(n => n.textContent.includes(${JSON.stringify(tplName)}))`,
        6000
      );
      check("通过界面删除模板", gone);
    }
    await click("#btnBackTemplates");
    await waitFor(`document.getElementById("viewHome").hidden === false`);


    console.log("== 列表交互 ==");
    await click('.vt-btn[data-mode="grid"]');
    check("切网格视图", await evaluate(`document.getElementById("recordsBody").classList.contains("grid-mode")`));
    await click('.vt-btn[data-mode="list"]');
    check("切回列表视图", await evaluate(`!document.getElementById("recordsBody").classList.contains("grid-mode")`));

    await evaluate(`(() => {
      const el = document.getElementById("searchInput");
      el.value = "__no_such_record__";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    await sleep(700);
    check("搜索无结果显示空态", await evaluate(`!!document.querySelector("#recordsBody .empty-state")`));

    await evaluate(`(() => {
      const el = document.getElementById("searchInput");
      el.value = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    await sleep(700);
    check("清空搜索恢复列表", await evaluate(`!!document.querySelector("#recordsBody .record-row") || !!document.querySelector("#recordsBody .empty-state")`));

    const hasBox = await evaluate(`!!document.querySelector("#recordsBody .row-sel")`);
    if (hasBox) {
      await click("#recordsBody .row-sel");
      check("勾选后出现批量操作条", await waitFor(`document.getElementById("selBar").hidden === false`));
      await click("#btnSelCancel");
      check("取消选择后操作条隐藏", await waitFor(`document.getElementById("selBar").hidden === true`));
    }

    console.log("== 上传页交互 ==");
    await click('.entry-card[data-entry="audio"]');
    await waitFor(`document.getElementById("viewNew").hidden === false`);
    await click("#diarizationCard");
    check("分离开关可打开", await evaluate(`document.getElementById("diarizationCard").getAttribute("aria-pressed") === "true"`));
    check("参会人数选项显示", await evaluate(`document.getElementById("diarExtra").hidden === false`));
    await click("#diarizationCard");
    check("分离开关可关闭", await evaluate(`document.getElementById("diarizationCard").getAttribute("aria-pressed") === "false"`));
    await click("#btnBackNew");
    await waitFor(`document.getElementById("viewHome").hidden === false`);

    console.log("== 模型配置 ==");
    check("顶栏不再显示「本机运行」提示", await evaluate(`document.querySelectorAll(".topbar-hint").length === 0`));
    const cfgDefaults = await evaluate(`fetch("/api/model-config").then(r => r.json()).then(d => d.defaults)`);
    await click("#btnModelSetup");
    check("打开模型配置浮层", await waitFor(`!document.getElementById("modelSetup").hidden`));
    check("纪要生成区块有 3 个字段", (await evaluate(`document.querySelectorAll("#minutesFields .model-field").length`)) === 3);
    check("转写模式有 3 个选项", (await evaluate(`document.querySelectorAll("#sttModes .model-mode").length`)) === 3);
    check("当前模式面板有 3 个字段", (await evaluate(`document.querySelectorAll("#sttPanel .model-field").length`)) === 3);
    check(
      "模型 ID 预填为 .env 里的模型",
      (await evaluate(`document.querySelector("#minutesFields input[data-key='model']").value`)) === cfgDefaults.minutes.model,
      `${cfgDefaults.minutes?.model}`
    );
    check(
      "服务地址预填为 .env 里的地址",
      (await evaluate(`document.querySelector("#minutesFields input[data-key='url']").value`)) === cfgDefaults.minutes.url
    );
    check("密钥框不下发服务端密钥", (await evaluate(`document.querySelector("#minutesFields input[data-key='key']").value`)) === "");
    check("密钥框提示沿用服务端配置", (await evaluate(`document.querySelector("#minutesFields input[data-key='key']").placeholder`)) === "留空则沿用服务端配置");
    check("有两个 API 指引链接", (await evaluate(`document.querySelectorAll(".model-guide-link").length`)) === 2);
    check("指引链接指向外部文档", (await evaluate(`document.querySelector(".model-guide-link").href`)).includes("mimo.mi.com"));
    await click('.model-mode[data-mode="realtime"]');
    check(
      "切到实时模式换掉模型 ID",
      (await evaluate(`document.querySelector("#sttPanel input[data-key='model']").value`)) === cfgDefaults.realtime.model
    );
    check("切模式后字段仍是 3 个", (await evaluate(`document.querySelectorAll("#sttPanel .model-field").length`)) === 3);
    // 测试连接：通与不通都会给回一句话，不该一直卡在「检测中…」
    await click("#minutesFields [data-test]");
    await waitFor(
      `document.querySelector("#minutesFields [data-result]").textContent.trim() !== "检测中…"`,
      20000
    );
    const testText = await evaluate(`document.querySelector("#minutesFields [data-result]").textContent.trim()`);
    check("测试连接给出结果", testText.length > 0 && testText !== "检测中…", testText);
    await click("[data-close-model]");
    check("关闭模型配置浮层", await waitFor(`document.getElementById("modelSetup").hidden`));


    if (process.env.SMOKE_RECORD === "1") {
      console.log("== 实时录音（假麦克风） ==");
      await click('.entry-card[data-entry="record"]');
      await waitFor(`document.getElementById("viewRec").hidden === false`);
      await click("#btnMic");
      const live = await waitFor(`document.getElementById("recStatus").textContent === "录音中"`, 20000);
      check("麦克风连接成功（录音中）", live, await evaluate(`document.getElementById("recStatus").textContent`));

      if (live) {
        await sleep(6000);
        check("实时字幕出现", (await evaluate(`document.querySelectorAll("#recSubs .sub-line").length`)) > 0,
          String(await evaluate(`document.querySelectorAll("#recSubs .sub-line").length`)));

        await evaluate(`(() => {
          const el = document.getElementById("noteInput");
          el.value = "冒烟标记";
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
          return true;
        })()`);
        await sleep(400);
        check("回车记下一条标记", (await evaluate(`document.querySelectorAll("#noteList .note-card").length`)) > 0);

        await click("#btnPause");
        check("暂停生效", await waitFor(`document.getElementById("recStatus").textContent === "已暂停"`));
        await click("#btnPause");
        check("恢复录音", await waitFor(`document.getElementById("recStatus").textContent === "录音中"`));

        await sleep(2000);
        await click("#btnStop");
        const finished = await waitFor(
          `document.getElementById("viewDetail").hidden === false || document.getElementById("recIdle").hidden === false`,
          30000
        );
        check("结束录音完成收尾", finished);
        const detailOpen = await evaluate(`document.getElementById("viewDetail").hidden === false`);
        check("录音结束进入详情", detailOpen, await evaluate(`document.getElementById("detailTitle").textContent`));
        if (detailOpen) {
          check("详情里有标记行", (await evaluate(`document.querySelectorAll("#segList .marker-row").length`)) > 0);
          check("音频可回放", await evaluate(`!!document.getElementById("player").src`));
        }
      }
    }

    console.log("== 控制台 ==");
    const noisy = consoleErrors.filter((e) => !/favicon|fonts\.googleapis|net::ERR_/i.test(e));
    check("无页面异常", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 300));
    check("无 console 报错", noisy.length === 0, noisy.join(" | ").slice(0, 300));
  } catch (e) {
    failures.push(`运行异常: ${e.message}`);
    console.error("界面冒烟异常:", e.message);
  } finally {
    try { ws && ws.close(); } catch {}
    try { proc.kill("SIGKILL"); } catch {}
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  }

  console.log("");
  if (failures.length) {
    console.error(`✗ ${failures.length} 项失败 / ${pass} 项通过`);
    for (const f of failures) console.error(`   - ${f}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ 全部 ${pass} 项通过`);
  }
}

main();
