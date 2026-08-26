/* aggregate.js — 纯函数聚合层: 浏览器(app.js)与 Node(verify_node.js)共用, 保证页面数字可复算核对。
   规则: income 计入收入; expense 计入支出; refund 冲减支出; transfer 不计入收支。
   净支出 = expense - refund; 净现金流 = income - 净支出。金额一律为正数, 方向由 type 决定。 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.AGG = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  const TYPE_LABEL = { income: "收入", expense: "支出", refund: "退款", transfer: "转账" };

  function monthOf(tx) { return tx.date.slice(0, 7); }
  function dayOf(tx) { return tx.date.slice(0, 10); }

  /* filters: {types:Set|Array, categories:Set, accounts:Set, payments:Set, tags:Set,
               start:'YYYY-MM-DD', end:'YYYY-MM-DD', search, minAmount, maxAmount, recurringOnly, largeOnly} */
  function filterTx(txs, f) {
    if (!f) return txs.slice();
    const has = (s) => s && (s.size !== undefined ? s.size > 0 : s.length > 0);
    const inSet = (s, v) => (s.size !== undefined ? s.has(v) : s.includes(v));
    return txs.filter((t) => {
      if (t.amount == null || !t.date) return false; // 异常记录不进入计算
      if (f.start && dayOf(t) < f.start) return false;
      if (f.end && dayOf(t) > f.end) return false;
      if (has(f.types) && !inSet(f.types, t.type)) return false;
      if (has(f.categories) && !inSet(f.categories, t.category)) return false;
      if (has(f.accounts) && !inSet(f.accounts, t.account)) return false;
      if (has(f.payments) && !inSet(f.payments, t.payment_method)) return false;
      if (has(f.tags) && !t.tags.some((x) => inSet(f.tags, x))) return false;
      if (f.minAmount != null && t.amount < f.minAmount) return false;
      if (f.maxAmount != null && t.amount > f.maxAmount) return false;
      if (f.recurringOnly && !t.recurring) return false;
      if (f.largeOnly && !t.large) return false;
      if (f.search) {
        const q = String(f.search).toLowerCase();
        const hay = `${t.merchant} ${t.note} ${t.category} ${t.subcategory}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function summarize(txs) {
    const s = { income: 0, expense: 0, refund: 0, transfer: 0, count: txs.length,
                netExpense: 0, netCashflow: 0, savingsRate: null };
    for (const t of txs) s[t.type] += t.amount;
    s.netExpense = round2(s.expense - s.refund);
    s.netCashflow = round2(s.income - s.netExpense);
    s.income = round2(s.income); s.expense = round2(s.expense);
    s.refund = round2(s.refund); s.transfer = round2(s.transfer);
    s.savingsRate = s.income > 0 ? round2((s.netCashflow / s.income) * 100) : null;
    return s;
  }

  function byCategory(txs) {
    /* 分类支出(支出口径: expense 原值; refund 计入「退款冲减」单独项, 不减分类) */
    const m = new Map();
    for (const t of txs) {
      if (t.type !== "expense") continue;
      if (!m.has(t.category)) m.set(t.category, { category: t.category, amount: 0, count: 0, merchants: new Map(), recurring: 0, large: 0, avg: 0 });
      const c = m.get(t.category);
      c.amount += t.amount; c.count += 1;
      if (t.recurring) c.recurring += 1;
      if (t.large) c.large += 1;
      const mk = t.merchant || "(无商户信息)";
      c.merchants.set(mk, (c.merchants.get(mk) || 0) + t.amount);
    }
    const out = [...m.values()].map((c) => {
      c.amount = round2(c.amount);
      c.avg = c.count ? round2(c.amount / c.count) : 0;
      c.topMerchants = [...c.merchants.entries()]
        .map(([merchant, amount]) => ({ merchant, amount: round2(amount) }))
        .sort((a, b) => b.amount - a.amount).slice(0, 5);
      delete c.merchants;
      return c;
    });
    return out.sort((a, b) => b.amount - a.amount);
  }

  function byMonth(txs) {
    const m = new Map();
    for (const t of txs) {
      const k = monthOf(t);
      if (!m.has(k)) m.set(k, { month: k, income: 0, expense: 0, refund: 0, transfer: 0 });
      m.get(k)[t.type] += t.amount;
    }
    return [...m.values()].sort((a, b) => a.month.localeCompare(b.month)).map((r) => {
      r.income = round2(r.income); r.expense = round2(r.expense);
      r.refund = round2(r.refund); r.transfer = round2(r.transfer);
      r.netExpense = round2(r.expense - r.refund);
      r.net = round2(r.income - r.netExpense);
      return r;
    });
  }

  function byDay(txs) {
    const m = new Map();
    for (const t of txs) {
      const k = dayOf(t);
      if (!m.has(k)) m.set(k, { day: k, income: 0, expense: 0, refund: 0, transfer: 0 });
      m.get(k)[t.type] += t.amount;
    }
    return [...m.values()].map((r) => {
      r.income = round2(r.income); r.expense = round2(r.expense);
      r.netExpense = round2(r.expense - r.refund);
      return r;
    });
  }

  function topExpenses(txs, n) {
    return txs.filter((t) => t.type === "expense")
      .sort((a, b) => b.amount - a.amount).slice(0, n || 10);
  }

  /* 环比: 当前范围 vs 紧邻的前一个等长周期 */
  function comparePrevious(txs, allTxs, start, end) {
    if (!start || !end) return null;
    const days = daysBetween(start, end) + 1;
    const prevEnd = addDays(start, -1);
    const prevStart = addDays(prevEnd, -(days - 1));
    const cur = summarize(filterTx(allTxs, { start, end }));
    const prev = summarize(filterTx(allTxs, { start: prevStart, end: prevEnd }));
    const pct = (a, b) => (b > 0 ? round2(((a - b) / b) * 100) : null);
    return { prevStart, prevEnd,
      expenseChange: pct(cur.netExpense, prev.netExpense),
      incomeChange: pct(cur.income, prev.income),
      netChange: pct(cur.netCashflow, prev.netCashflow) };
  }

  function round2(x) { return Math.round((x + Number.EPSILON) * 100) / 100; }
  /* 日期一律按本地(Asia/Shanghai 使用场景)处理, 禁止用 toISOString(UTC 会偏移一天) */
  function localISO(d) {
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }
  function daysBetween(a, b) { return Math.round((new Date(b + "T00:00:00") - new Date(a + "T00:00:00")) / 86400000); }
  function addDays(d, n) {
    const x = new Date(d + "T00:00:00"); x.setDate(x.getDate() + n);
    return localISO(x);
  }

  return { TYPE_LABEL, filterTx, summarize, byCategory, byMonth, byDay, topExpenses,
           comparePrevious, round2, monthOf, dayOf, localISO, addDays, daysBetween };
});
