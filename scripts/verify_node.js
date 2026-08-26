/* verify_node.js — 用页面同款聚合逻辑(js/aggregate.js)重算 data.js, 与 transactions.json 对拍。 */
"use strict";
const fs = require("fs");
const path = require("path");
const ROOT = path.dirname(__dirname);

global.window = {};
eval(fs.readFileSync(path.join(ROOT, "js", "data.js"), "utf8"));
const DATA = global.window.DATA;
const AGG = require(path.join(ROOT, "js", "aggregate.js"));

const expected = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "transactions.json"), "utf8"));

let fails = 0;
const eq = (name, a, b) => {
  const ok = Math.abs(a - b) <= 0.02;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name.padEnd(22)} aggregate.js=${a}  json=${b}`);
  if (!ok) fails++;
};

const txs = DATA.transactions;
const s = AGG.summarize(txs);
const ref = { income: 0, expense: 0, refund: 0, transfer: 0 };
for (const t of expected.transactions) ref[t.type] += t.amount;

eq("income", s.income, Math.round(ref.income * 100) / 100);
eq("expense", s.expense, Math.round(ref.expense * 100) / 100);
eq("refund", s.refund, Math.round(ref.refund * 100) / 100);
eq("transfer", s.transfer, Math.round(ref.transfer * 100) / 100);
eq("netExpense", s.netExpense, Math.round((ref.expense - ref.refund) * 100) / 100);
eq("netCashflow", s.netCashflow, Math.round((ref.income - (ref.expense - ref.refund)) * 100) / 100);

// 分类合计 = 总支出
const cats = AGG.byCategory(txs);
const catSum = cats.reduce((a, c) => a + c.amount, 0);
eq("byCategory 合计", Math.round(catSum * 100) / 100, s.expense);

// 月度合计 = 总收支
const months = AGG.byMonth(txs);
eq("byMonth 收入合计", Math.round(months.reduce((a, m) => a + m.income, 0) * 100) / 100, s.income);
eq("byMonth 支出合计", Math.round(months.reduce((a, m) => a + m.expense, 0) * 100) / 100, s.expense);

// 筛选一致性抽查: 2026-08 餐饮美食 明细和 == 分类聚合
const f = AGG.filterTx(txs, { start: "2026-08-01", end: "2026-08-31", categories: new Set(["餐饮美食"]) });
const fSum = Math.round(f.filter((t) => t.type === "expense").reduce((a, t) => a + t.amount, 0) * 100) / 100;
const cSum = AGG.byCategory(AGG.filterTx(txs, { start: "2026-08-01", end: "2026-08-31" }))
  .find((c) => c.category === "餐饮美食");
eq("筛选抽查 2026-08 餐饮", fSum, cSum ? cSum.amount : -1);

console.log(fails ? `  结果: FAIL (${fails})` : "  结果: 全部 PASS");
process.exit(fails ? 1 : 0);
