#!/usr/bin/env node
/* e2e_check.mjs — 用 Chrome DevTools Protocol 做真实交互测试(Node 原生 WebSocket)。
   前置: 本地服务器已启动 (python3 -m http.server 8791)。
   运行: node scripts/e2e_check.mjs  */
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";

const BASE = "http://127.0.0.1:8792/index.html";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9223;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (url) => new Promise((res, rej) => http.get(url, (r) => {
  let b = ""; r.on("data", (c) => (b += c)); r.on("end", () => res(b));
}).on("error", rej));

let ws, msgId = 0;
const pending = new Map();
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaljs(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error("页面内执行出错: " + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 300));
  return r.result.value;
}

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name} ${detail}`); }
}

async function main() {
  const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`,
    "--window-size=1440,2000", `--user-data-dir=/tmp/fd-e2e-profile-${Date.now()}`, "about:blank"], { stdio: "ignore" });
  try {
    let targets = null;
    for (let i = 0; i < 30; i++) { await sleep(400); try { targets = JSON.parse(await get(`http://127.0.0.1:${PORT}/json`)); break; } catch {} }
    if (!targets) throw new Error("无法连接 Chrome 调试端口");
    const page = targets.find((t) => t.type === "page");
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m.result || {}); pending.delete(m.id); }
      else if (m.method === "Runtime.exceptionThrown") {
        console.log("  [页面异常]", JSON.stringify(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 240));
      } else if (m.method === "Page.javascriptDialogOpening") {
        send("Page.handleJavaScriptDialog", { accept: true });
      }
    };
    await send("Runtime.enable");
    await send("Page.enable");
    await send("Page.navigate", { url: BASE });
    await sleep(3500); // 等数据与图表渲染

    console.log("== 1. 首屏核心结论 ==");
    const kpi = await evaljs(`document.getElementById('kpiGrid').innerText`);
    check("KPI 含区间净现金流", kpi.includes("区间净现金流"));
    check("KPI 含总收入/总支出", kpi.includes("总收入") && kpi.includes("总支出"));
    check("KPI 含最大支出分类与最大单笔支出", kpi.includes("最大支出分类") && kpi.includes("最大单笔支出"));
    const summary = await evaljs(`document.getElementById('summaryStrip').innerText`);
    check("自动总结句非空且含金额", /净支出 ¥[\d,]+/.test(summary), summary.slice(0, 60));

    console.log("== 2. 默认范围与数据一致性 ==");
    const kpiNums = await evaljs(`(() => {
      const s = __app.AGG.summarize(__app.filtered());
      return { inc: s.income, exp: s.netExpense, n: __app.filtered().length };
    })()`);
    const expNums = await evaljs(`(() => {
      const txs = __app.DATA.txs.filter(t => t.amount != null && t.date >= "2026-08-01" && t.date <= "2026-08-31");
      const s = __app.AGG.summarize(txs);
      return { inc: s.income, exp: s.netExpense, n: txs.length };
    })()`);
    check("默认范围=2026-08 且 KPI 数字与独立筛选重算一致",
      Math.abs(kpiNums.inc - expNums.inc) < 0.02 && Math.abs(kpiNums.exp - expNums.exp) < 0.02 && kpiNums.n === expNums.n,
      JSON.stringify(kpiNums) + " vs " + JSON.stringify(expNums));

    console.log("== 3. 类型筛选 → 清除筛选 ==");
    await evaljs(`document.querySelector('#typeFilter [data-type="expense"]').click()`);
    await sleep(400);
    const onlyExp = await evaljs(`__app.filtered().every(t => t.type === "expense") && __app.filtered().length`);
    check("仅支出筛选生效", onlyExp > 0, String(onlyExp));
    const chipVisible = await evaljs(`document.getElementById('activeChips').innerText.includes('支出')`);
    check("当前筛选条件可见(含支出 chip)", chipVisible);
    await evaljs(`document.getElementById('btnClear').click()`);
    await sleep(400);
    const cleared = await evaljs(`__app.filtered().length === __app.DATA.txs.filter(t=>t.amount!=null&&t.date).length && __app.state.types.size === 0`);
    check("清除筛选恢复完整数据", cleared);

    console.log("== 4. 快捷范围与自定义日期 ==");
    await evaljs(`document.querySelector('[data-range="6m"]').click()`);
    await sleep(400);
    const r6 = await evaljs(`({s: __app.state.start, e: __app.state.end})`);
    check("近6个月范围生效", r6.s === "2026-03-01" && r6.e === "2026-08-25", JSON.stringify(r6));
    await evaljs(`(() => { const el = document.getElementById('dateStart'); el.value = "2026-08-01"; el.onchange(); })()`);
    await sleep(300);
    const custom = await evaljs(`__app.state.start === "2026-08-01" && __app.state.quick === ""`);
    check("自定义开始日期生效并退出快捷模式", custom);

    console.log("== 5. 分类下钻联动 ==");
    await evaljs(`__app.drillInto("餐饮美食")`);
    await sleep(500);
    const drill = await evaljs(`({
      shown: !document.getElementById('drillPanel').hidden,
      title: document.getElementById('drillTitle').innerText,
      merchants: document.querySelectorAll('#drillMerchants li').length,
      rows: document.querySelectorAll('#drillTxTable tbody tr').length })`);
    check("下钻面板出现且含标题/商户/交易", drill.shown && drill.title.includes("餐饮美食") && drill.merchants > 0 && drill.rows > 0, JSON.stringify(drill));
    const drillSum = await evaljs(`(() => {
      const rows = [...document.querySelectorAll('#drillTxTable tbody tr')];
      const txs = __app.filtered().filter(t => t.type === "expense" && t.category === "餐饮美食").sort((a,b)=>b.amount-a.amount).slice(0,20);
      return rows.length === txs.length;
    })()`);
    check("下钻交易数与筛选结果一致(前20)", drillSum);
    await evaljs(`document.getElementById('drillClose').click()`);

    console.log("== 6. 搜索 / 表格排序分页 ==");
    await evaljs(`document.querySelector('[data-range="all"]').click()`);
    await sleep(400);
    await evaljs(`(() => { const el = document.getElementById('fSearch'); el.value = "星巴克"; __app.state.search = "星巴克"; __app.renderAll(); })()`);
    await sleep(400);
    const searchRes = await evaljs(`({
      n: __app.filtered().length,
      allHit: __app.filtered().every(t => (t.merchant + " " + t.note + " " + t.category + " " + t.subcategory).includes("星巴克")),
      expected: __app.DATA.txs.filter(t => t.amount != null && (t.merchant + " " + t.note).includes("星巴克")).length })`);
    check("搜索「星巴克」结果全部命中且数量与独立统计一致", searchRes.allHit && searchRes.n > 0 && searchRes.n === searchRes.expected, JSON.stringify(searchRes));
    await evaljs(`(() => { __app.state.search = ""; document.getElementById('fSearch').value = ""; __app.renderAll(); })()`);
    await sleep(300);
    await evaljs(`(() => { const el = document.getElementById('txSort'); el.value = "amount_desc"; el.onchange(); })()`);
    await sleep(300);
    const sortOk = await evaljs(`(() => {
      const cells = [...document.querySelectorAll('#txTable tbody tr td:nth-child(3)')].map(td => parseFloat(td.innerText.replace(/[^\\d.]/g, "")));
      return cells.length > 1 && cells[0] >= cells[cells.length - 1];
    })()`);
    check("按金额降序排序正确(本页)", sortOk);
    const pg = await evaljs(`(() => { const b = document.querySelector('#txPager [data-pg="2"]'); if (b) { b.click(); return true; } return false; })()`);
    await sleep(300);
    check("分页翻到第 2 页", pg && (await evaljs(`__app.state.page === 2`)));

    console.log("== 7. 交易详情与标记 ==");
    const firstId = await evaljs(`(() => { const tr = document.querySelector('#txTable tbody tr[data-txid]'); tr.click(); return tr.dataset.txid; })()`);
    await sleep(300);
    const modal = await evaljs(`({ open: !document.getElementById('txModal').hidden, body: document.getElementById('txModalBody').innerText })`);
    check("点击行打开详情弹窗", modal.open && modal.body.includes(firstId));
    await evaljs(`document.getElementById('txModalFlag').click()`);
    await sleep(300);
    const flagged = await evaljs(`JSON.parse(localStorage.getItem('fd.flags')).includes("${firstId}")`);
    check("标记交易并持久化 localStorage", flagged);
    await evaljs(`document.getElementById('txModalClose').click()`);

    console.log("== 8. 星辰图: 模式切换与数据点 ==");
    await evaljs(`document.getElementById('starModeTable').click()`);
    await sleep(400);
    const starDiag = await evaljs(`({ mode: __app.state.starMode, hidden: document.getElementById('starTableWrap').hidden, rows: document.querySelectorAll('#starTable tbody tr').length })`);
    check("星图表格备用模式可切换且有行", !starDiag.hidden && starDiag.rows > 0, JSON.stringify(starDiag));
    await evaljs(`document.getElementById('starModeChart').click()`);
    await sleep(400);
    const starCanvas = await evaljs(`!!document.querySelector('#chartStar canvas')`);
    check("星图模式渲染 canvas", starCanvas);
    const starClick = await evaljs(`(() => { const t = __app.filtered()[0]; __app.openTxModal(t.id); return !document.getElementById('txModal').hidden; })()`);
    check("星星点击链路(openTxModal)可用", starClick);
    await evaljs(`document.getElementById('txModalClose').click()`);

    console.log("== 9. 异常与空状态 ==");
    await send("Page.navigate", { url: BASE + "?demo=anomaly" });
    await sleep(3000);
    const anom = await evaljs(`({
      issues: document.querySelectorAll('#qualityTable tbody tr').length,
      excluded: __app.filtered().every(t => t.amount != null && t.date) })`);
    check("异常演示: 质量表公示 5+ 条问题", anom.issues >= 5, String(anom.issues));
    check("异常记录不参与指标计算", anom.excluded);
    await send("Page.navigate", { url: BASE + "?demo=empty" });
    await sleep(2500);
    const empty = await evaljs(`({ shown: !document.getElementById('emptyState').hidden, txt: document.getElementById('emptyDesc').innerText })`);
    check("空数据显示空状态与导入提示", empty.shown && empty.txt.includes("导入"));

    console.log("== 10. 图表失败降级 ==");
    await send("Page.navigate", { url: BASE + "?demo=nocharts" });
    await sleep(2500);
    const noc = await evaljs(`({
      fb: document.querySelectorAll('.chart-fallback').length,
      kpi: document.getElementById('kpiGrid').innerText.includes('区间净现金流'),
      tbl: document.querySelectorAll('#txTable tbody tr').length })`);
    check("图表未加载时保留指标与表格", noc.fb > 0 && noc.kpi && noc.tbl > 0, JSON.stringify(noc));

    console.log("== 11. 导出 CSV / 导入 JSON ==");
    await send("Page.navigate", { url: BASE });
    await sleep(3000);
    const csvText = await evaljs(`(async () => {
      let blob = null;
      const orig = URL.createObjectURL;
      URL.createObjectURL = (b) => { blob = b; return "blob:fake"; };
      document.getElementById('btnExport').click();
      URL.createObjectURL = orig;
      return blob ? await blob.text() : "";
    })()`);
    const csvLines = csvText ? csvText.trim().split("\n") : [];
    const expectedRows = await evaljs(`__app.filtered().length`);
    check("导出 CSV 表头正确且行数=筛选结果+1",
      csvLines[0] === "id,date,type,amount,currency,category,subcategory,merchant,account,payment_method,tags,recurring,large,note"
        && csvLines.length - 1 === expectedRows, `lines=${csvLines.length} expected=${expectedRows + 1}`);
    await send("DOM.enable");
    const doc = await send("DOM.getDocument");
    const fi = await send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "#fileInput" });
    const fixture = process.cwd() + "/scripts/fixtures/import_test.json";
    await send("DOM.setFileInputFiles", { nodeId: fi.nodeId, files: [fixture] });
    await sleep(1200);
    const imp = await evaljs(`({ n: __app.DATA.txs.length, info: document.getElementById('datasetInfo').innerText,
      sum: __app.AGG.summarize(__app.filtered()).income })`);
    check("导入 JSON 后数据集替换为 3 笔并重算", imp.n === 3 && Math.abs(imp.sum - 10000) < 0.02, JSON.stringify(imp));

    // 导入真实 MoneyThings CSV(完整管道: 解析引号/千分位金额/类型映射)
    await send("Page.navigate", { url: BASE });
    await sleep(3000);
    const doc2 = await send("DOM.getDocument");
    const fi2 = await send("DOM.querySelector", { nodeId: doc2.root.nodeId, selector: "#fileInput" });
    await send("DOM.setFileInputFiles", { nodeId: fi2.nodeId, files: [process.cwd() + "/data/moneythings_示例数据.csv"] });
    await sleep(2500);
    const expMeta = JSON.parse(fs.readFileSync(process.cwd() + "/data/transactions.json", "utf8"));
    const expCnt = { n: expMeta.transactions.length,
      tr: expMeta.transactions.filter(t => t.type === "transfer").length,
      ref: expMeta.transactions.filter(t => t.type === "refund").length,
      sum: expMeta.transactions.filter(t => t.type === "expense").reduce((a, t) => a + t.amount, 0) };
    const impCsv = await evaljs(`({ n: __app.DATA.txs.length,
      tr: __app.DATA.txs.filter(t => t.type === "transfer").length,
      ref: __app.DATA.txs.filter(t => t.type === "refund").length,
      sum: __app.AGG.summarize(__app.DATA.txs).expense })`);
    check("导入真实 CSV: 笔数/转账/退款/总支出与数据文件一致",
      impCsv.n === expCnt.n && impCsv.tr === expCnt.tr && impCsv.ref === expCnt.ref && Math.abs(impCsv.sum - expCnt.sum) < 0.02,
      JSON.stringify(impCsv) + " vs " + JSON.stringify(expCnt));

    console.log("== 12. file:// 直接打开(离线可用性) ==");
    await send("Page.navigate", { url: "file://" + process.cwd() + "/index.html" });
    await sleep(3000);
    const fileProto = await evaljs(`({ kpi: document.getElementById('kpiGrid').innerText.includes('区间净现金流'),
      canvas: !!document.querySelector('#chartCatRank canvas') })`);
    check("file:// 协议下页面与图表正常", fileProto.kpi && fileProto.canvas, JSON.stringify(fileProto));

    console.log("== 13. 交易编辑(金额/分类/备注) ==");
    await send("Page.navigate", { url: BASE });
    await sleep(3000);
    const editTarget = await evaljs(`(() => { const t = __app.DATA.txs.find(x => x.type === "expense" && x.amount < 100);
      __app.openTxModal(t.id); return { id: t.id, amount: t.amount, category: t.category, note: t.note }; })()`);
    await evaljs(`document.getElementById('txModalEdit').click()`);
    await sleep(200);
    const formVisible = await evaljs(`!document.getElementById('txEditForm').hidden && !!document.getElementById('editAmount').value`);
    check("编辑模式打开并预填原值", formVisible);
    await evaljs(`(() => { document.getElementById('editAmount').value = "123.45";
      document.getElementById('editCategory').value = "餐饮美食";
      document.getElementById('editNote').value = "E2E编辑测试备注";
      document.getElementById('txEditSave').click(); })()`);
    await sleep(500);
    const afterEdit = await evaljs(`(() => { const t = __app.DATA.txs.find(x => x.id === "${editTarget.id}");
      return { amount: t.amount, category: t.category, note: t.note, edited: !!t.edited,
        stored: (JSON.parse(localStorage.getItem('fd.edits')) || {})["${editTarget.id}"] ? true : false,
        origShown: document.getElementById('txModalBody').innerText.includes('原始值') }; })()`);
    check("编辑保存: 值更新 + localStorage 留痕 + 显示原始值",
      afterEdit.amount === 123.45 && afterEdit.category === "餐饮美食" && afterEdit.note === "E2E编辑测试备注"
        && afterEdit.edited && afterEdit.stored && afterEdit.origShown, JSON.stringify(afterEdit));
    await evaljs(`document.getElementById('txModalRevert').click()`);
    await sleep(400);
    const afterRevert = await evaljs(`(() => { const t = __app.DATA.txs.find(x => x.id === "${editTarget.id}");
      return { amount: t.amount, category: t.category, edited: !!t.edited,
        stored: (JSON.parse(localStorage.getItem('fd.edits')) || {})["${editTarget.id}"] ? true : false }; })()`);
    check("还原原始值: 恢复原值且清除覆盖记录",
      Math.abs(afterRevert.amount - editTarget.amount) < 0.001 && afterRevert.category === editTarget.category
        && !afterRevert.edited && !afterRevert.stored, JSON.stringify(afterRevert));
    await evaljs(`document.getElementById('txModalClose').click()`);

    console.log("== 14. 下钻面板子品类明细 ==");
    await evaljs(`__app.drillInto("交通出行")`);
    await sleep(500);
    const subInfo = await evaljs(`({ visible: document.getElementById('drillSubWrap').style.display !== "none",
      rows: [...document.querySelectorAll('#drillSubTable tbody tr')].map(tr => tr.cells[0].innerText) })`);
    check("交通出行下钻显示子品类表且含多个子类", subInfo.visible && subInfo.rows.length >= 2, JSON.stringify(subInfo.rows));
    const pickSub = subInfo.rows.find((n) => n !== "(无子分类)") || subInfo.rows[0];
    await evaljs(`(() => { const tr = [...document.querySelectorAll('#drillSubTable tbody tr')].find(tr => tr.cells[0].innerText === ${JSON.stringify(pickSub)}); tr.click(); })()`);
    await sleep(400);
    const subFilter = await evaljs(`({ title: document.getElementById('drillTxTitle').innerText,
      rowCount: document.querySelectorAll('#drillTxTable tbody tr').length,
      expected: __app.filtered().filter(t => t.type === "expense" && t.category === "交通出行" && (t.subcategory || "(无子分类)") === ${JSON.stringify(pickSub)}).length })`);
    check("点击子类过滤交易列表且数量一致",
      subFilter.title.includes(pickSub) && subFilter.rowCount === Math.min(20, subFilter.expected), JSON.stringify(subFilter));
    await evaljs(`document.getElementById('drillSubReset').click()`);
    await sleep(300);
    const subReset = await evaljs(`!document.getElementById('drillTxTitle').innerText.includes('子类「')`);
    check("重置子类过滤恢复全分类列表", subReset);
    await evaljs(`document.getElementById('drillClose').click()`);

    console.log(`\n结果: ${passed} PASS, ${failed} FAIL`);
    process.exitCode = failed ? 1 : 0;
  } finally {
    chrome.kill("SIGTERM");
  }
}
main().catch((e) => { console.error("E2E 运行失败:", e.message); process.exit(2); });
