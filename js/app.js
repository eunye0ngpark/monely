/* app.js — 状态管理 / 筛选 / 渲染 / 交互。聚合计算一律走 js/aggregate.js(可在 node 中复算)。 */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const AGG = window.AGG, CH = window.CHARTS;

  /* ---------------- 配置(货币/格式/时区均为可配置项) ---------------- */
  const CONFIG = Object.assign({
    currency: "CNY", locale: "zh-CN", dateFmt: "iso", timezone: "Asia/Shanghai",
  }, JSON.parse(localStorage.getItem("fd.config") || "{}"));
  const CURRENCY_SYMBOL = { CNY: "¥", USD: "$", EUR: "€" };
  const I18N = { /* 语言包结构: 当前内置 zh; 新增语言时复制此对象并按键替换 */
    zh: { income: "收入", expense: "支出", refund: "退款", transfer: "转账" },
  };
  const L = I18N.zh;

  const fmt = {
    round2: AGG.round2,
    money(v, withSign) {
      if (v == null || isNaN(v)) return "—";
      const n = new Intl.NumberFormat(CONFIG.locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(v));
      return (withSign || "") + CURRENCY_SYMBOL[CONFIG.currency] + n;
    },
    num(v) { return v == null ? "—" : new Intl.NumberFormat(CONFIG.locale).format(v); },
    compact(v) {
      if (v == null) return "—";
      if (Math.abs(v) >= 10000) return fmt.round2(v / 10000) + "万";
      return new Intl.NumberFormat(CONFIG.locale, { maximumFractionDigits: 0 }).format(v);
    },
    date(iso) {
      if (!iso) return "—";
      const d = iso.slice(0, 10), p = d.split("-");
      if (CONFIG.dateFmt === "cn") return `${+p[0]}年${+p[1]}月${+p[2]}日`;
      if (CONFIG.dateFmt === "slash") return p.join("/");
      return d;
    },
    pct(v) { return v == null ? "—" : v + "%"; },
  };

  /* ---------------- 数据装载与演示模式 ---------------- */
  const qs = new URLSearchParams(location.search);
  const DEMO = qs.get("demo");           // empty | anomaly | nocharts
  const VIEW_ONLY = qs.get("view");      // 只渲染某个 section(截图/调试)

  function loadData() {
    const d = window.DATA || { meta: {}, quality: {}, transactions: [] };
    let txs = d.transactions.map((t) => Object.assign({}, t));
    let quality = Object.assign({ issues: [] }, d.quality);
    if (DEMO === "empty") txs = [];
    if (DEMO === "anomaly") {
      // 注入 5 条测试异常记录(仅演示错误处理, 标记为 SYN, 不参与计算)
      const syn = [
        { id: "SYN01", date: "2026-08-20 12:00:00", type: "expense", amount: null, category: "餐饮美食", subcategory: "", merchant: "测试商户", account: "总财产", payment_method: "未记录", note: "金额缺失测试", tags: [], recurring: false, currency: "CNY", has_issue: true },
        { id: "SYN02", date: "", type: "expense", amount: 66, category: "购物", subcategory: "", merchant: "测试商户", account: "总财产", payment_method: "未记录", note: "日期缺失测试", tags: [], recurring: false, currency: "CNY", has_issue: true },
        { id: "SYN03", date: "2026-08-21 09:00:00", type: "expense", amount: 88, category: "未分类", subcategory: "", merchant: "", account: "总财产", payment_method: "未记录", note: "分类为空测试, 已归入未分类", tags: [], recurring: false, currency: "CNY", has_issue: true },
        { id: "SYN04", date: "2026-08-21 10:00:00", type: "income", amount: 50, category: "其他", subcategory: "", merchant: "", account: "总财产", payment_method: "未记录", note: "收入金额为负测试(已按绝对值)", tags: [], recurring: false, currency: "CNY", has_issue: true },
        { id: "SYN05", date: "2026-08-18 12:30:00", type: "expense", amount: 30, category: "餐饮美食", subcategory: "", merchant: "星巴克", account: "总财产", payment_method: "未记录", note: "疑似重复测试", tags: [], recurring: false, currency: "CNY", possible_duplicate: true, has_issue: true },
      ];
      txs = txs.concat(syn);
      quality.issues = (quality.issues || []).concat([
        { id: "SYN01", row: "-", field: "amount", error: "金额缺失, 该记录不参与计算", raw: {} },
        { id: "SYN02", row: "-", field: "date", error: "日期缺失, 该记录不参与计算; 期望格式 YYYY-MM-DD HH:MM:SS", raw: {} },
        { id: "SYN03", row: "-", field: "category", error: "分类为空, 已归入「未分类」, 可导入修正后的数据", raw: {} },
        { id: "SYN04", row: "-", field: "amount", error: "收入金额为负数, 已按绝对值处理", raw: {} },
        { id: "SYN05", row: "-", field: "duplicate", error: "与历史记录疑似重复(同日同额同商户), 仅提示不删除", raw: {} },
      ]);
      quality.injected_demo = true;
    }
    return { meta: d.meta || {}, quality, txs };
  }

  const DATA = loadData();
  let ALL_TX = DATA.txs;
  const validTx = () => ALL_TX.filter((t) => t.amount != null && t.date);
  const FLAGS = new Set(JSON.parse(localStorage.getItem("fd.flags") || "[]"));

  /* ---- 网页编辑覆盖层: 只存修改量, 原始值保留在 tx._orig, 可随时还原 ---- */
  const EDITS = JSON.parse(localStorage.getItem("fd.edits") || "{}");
  function applyEdits() {
    for (const t of ALL_TX) {
      const e = EDITS[t.id];
      if (!e) continue;
      if (!t._orig) t._orig = { amount: t.amount, category: t.category, note: t.note };
      if (e.amount != null) t.amount = e.amount;
      if (e.category != null) t.category = e.category;
      if (e.note != null) t.note = e.note;
      t.edited = true;
      t.large = t.type === "expense" && t.amount != null && t.amount >= 3000;
    }
  }
  function persistEdits() { localStorage.setItem("fd.edits", JSON.stringify(EDITS)); }
  function saveEdit(id, patch) {
    EDITS[id] = Object.assign({}, EDITS[id], patch, { ts: new Date().toISOString() });
    persistEdits(); applyEdits();
  }
  function revertEdit(id) {
    const t = ALL_TX.find((x) => x.id === id);
    if (t && t._orig) Object.assign(t, t._orig, { edited: false, large: t.type === "expense" && t._orig.amount >= 3000 });
    delete EDITS[id]; persistEdits();
  }

  /* ---------------- 状态 ---------------- */
  const state = {
    start: null, end: null, types: new Set(), categories: new Set(),
    accounts: new Set(), payments: new Set(), search: "",
    largeOnly: false, recurringOnly: false,
    granularity: "month", quick: "month",
    sort: "date_desc", page: 1, pageSize: 50,
    drill: null, starMode: "chart", starAgg: "auto",
    modalTx: null,
  };

  function dataExtent() {
    const vs = validTx();
    if (!vs.length) return null;
    let min = vs[0].date, max = vs[0].date;
    for (const t of vs) { if (t.date < min) min = t.date; if (t.date > max) max = t.date; }
    return { min: min.slice(0, 10), max: max.slice(0, 10) };
  }

  function applyQuickRange(key) {
    const ext = dataExtent();
    if (!ext) { state.start = state.end = null; return; }
    const end = ext.max;
    const d = new Date(end + "T00:00:00");
    const iso = AGG.localISO;
    let start;
    if (key === "month") start = end.slice(0, 8) + "01";
    else if (key === "lastMonth") { start = iso(new Date(d.getFullYear(), d.getMonth() - 1, 1)); state.end = iso(new Date(d.getFullYear(), d.getMonth(), 0)); state.start = start; return; }
    else if (key === "3m") start = iso(new Date(d.getFullYear(), d.getMonth() - 2, 1));
    else if (key === "6m") start = iso(new Date(d.getFullYear(), d.getMonth() - 5, 1));
    else if (key === "year") start = end.slice(0, 4) + "-01-01";
    else { start = ext.min; }
    state.start = start; state.end = end;
  }

  /* ---------------- 筛选 ---------------- */
  function currentFilter() {
    return {
      start: state.start, end: state.end,
      types: state.types, categories: state.categories,
      accounts: state.accounts, payments: state.payments,
      search: state.search, largeOnly: state.largeOnly, recurringOnly: state.recurringOnly,
    };
  }
  const filtered = () => AGG.filterTx(ALL_TX, currentFilter());

  function bucketKey(day) {
    const d = new Date(day + "T00:00:00");
    if (state.granularity === "day") return day;
    if (state.granularity === "week") {
      const wd = (d.getDay() + 6) % 7; d.setDate(d.getDate() - wd);
      return AGG.localISO(d) + " 周";
    }
    if (state.granularity === "month") return day.slice(0, 7);
    if (state.granularity === "quarter") return day.slice(0, 4) + " Q" + (Math.floor((+day.slice(5, 7) - 1) / 3) + 1);
    return day.slice(0, 4) + " 年";
  }
  function bucketize(txs) {
    const m = new Map();
    for (const t of txs) {
      const k = bucketKey(t.date.slice(0, 10));
      if (!m.has(k)) m.set(k, { label: k, income: 0, expense: 0, refund: 0, transfer: 0 });
      m.get(k)[t.type] += t.amount;
    }
    return [...m.values()].sort((a, b) => a.label.localeCompare(b.label)).map((r) => {
      r.income = fmt.round2(r.income); r.netExpense = fmt.round2(r.expense - r.refund);
      r.net = fmt.round2(r.income - r.netExpense); return r;
    });
  }

  /* ---------------- 图表实例管理(失败时保留摘要与表格) ---------------- */
  const charts = {};
  const CHART_OK = typeof echarts !== "undefined" && DEMO !== "nocharts";
  function renderChart(id, option) {
    const el = $(id);
    if (!el) return;
    if (!CHART_OK) { el.innerHTML = '<div class="chart-fallback">图表组件未加载(演示模式 demo=nocharts)。<br>上方指标与下方表格不受影响, 数据完整可用。</div>'; return; }
    try {
      if (!charts[id]) charts[id] = echarts.init(el, null, { renderer: "canvas" });
      charts[id].setOption(option, true);
    } catch (e) {
      el.innerHTML = `<div class="chart-fallback">图表渲染失败: ${String(e).slice(0, 80)}<br>请查看表格视图。</div>`;
    }
  }
  window.addEventListener("resize", () => Object.values(charts).forEach((c) => { try { c.resize(); } catch (e) {} }));

  /* ---------------- KPI 与总结 ---------------- */
  const TYPE_META = {
    income: { icon: "↑", cls: "inc", amt: "amt-inc", sign: "+" },
    expense: { icon: "↓", cls: "exp", amt: "amt-exp", sign: "-" },
    refund: { icon: "↩", cls: "ref", amt: "amt-ref", sign: "+" },
    transfer: { icon: "⇄", cls: "tra", amt: "amt-tra", sign: "" },
  };

  function deltaHtml(v, invertGood) {
    if (v == null) return '<span class="k-delta flat">上期无数据</span>';
    const up = v > 0;
    const good = invertGood ? !up : up;
    return `<span class="k-delta ${v === 0 ? "flat" : good ? "up-good" : "up-bad"}">${up ? "▲" : v === 0 ? "■" : "▼"} ${Math.abs(v)}% 较上期</span>`;
  }

  function renderKPIs(txs, sum, cats, cmp) {
    const topCat = cats[0];
    const topTx = AGG.topExpenses(txs, 1)[0];
    const netGood = sum.netCashflow >= 0;
    $("kpiGrid").innerHTML = `
      <div class="kpi-hero ${netGood ? "" : "hero-bad"}">
        <div class="k-label">区间净现金流</div>
        <div class="k-value">${fmt.money(sum.netCashflow, netGood ? "+" : "-")}</div>
        <div class="k-sub">收入 − 支出(净); ${state.start || "…"} ~ ${state.end || "…"}</div>
        <div class="hero-delta">
          <span class="hd-label">结余环比</span>
          ${cmp ? deltaHtml(cmp.netChange, false) : '<span class="k-delta flat">—</span>'}
          <span class="k-sub">净现金流较上一等长周期</span>
        </div>
      </div>
      <div class="kpi-pair">
        <div class="pair-half">
          <div class="ph-head"><span class="ph-dot green"></span>总收入 ${TYPE_META.income.icon}</div>
          <div class="k-value amt-inc">${fmt.money(sum.income)}</div>
          ${cmp ? deltaHtml(cmp.incomeChange, false) : ""}
          <div class="k-sub">${txs.filter((t) => t.type === "income").length} 笔 · 转账 ${fmt.money(sum.transfer)} 不计入</div>
        </div>
        <div class="pair-half">
          <div class="ph-head"><span class="ph-dot rose"></span>总支出(净) ${TYPE_META.expense.icon}</div>
          <div class="k-value amt-exp">${fmt.money(sum.netExpense)}</div>
          ${cmp ? deltaHtml(cmp.expenseChange, true) : ""}
          <div class="k-sub">毛支出 ${fmt.money(sum.expense)} − 退款 ${fmt.money(sum.refund)}</div>
        </div>
      </div>
      <div class="kpi-pair">
        <div class="pair-half">
          <div class="ph-head"><span class="ph-dot rose"></span>最大支出分类</div>
          <div class="k-value k-cat">${topCat ? topCat.category : "—"}</div>
          <div class="k-sub">${topCat ? `${fmt.money(topCat.amount)} · 占总支出 ${fmt.round2((topCat.amount / (sum.expense || 1)) * 100)}%` : ""}</div>
        </div>
        <div class="pair-half">
          <div class="ph-head"><span class="ph-dot amber"></span>最大单笔支出</div>
          <div class="k-value">${topTx ? fmt.money(topTx.amount) : "—"}</div>
          <div class="k-sub">${topTx ? `${fmt.date(topTx.date)} · ${topTx.merchant || topTx.note || topTx.category}` : ""}</div>
        </div>
      </div>
      <div class="kpi-mini">
        <div class="k-label">储蓄率</div>
        <div class="k-value">${sum.savingsRate == null ? "—" : fmt.pct(sum.savingsRate)}</div>
        <div class="k-sub">净现金流 ÷ 收入</div>
      </div>`;
  }

  function renderSummary(sum, cats, cmp) {
    const top2 = cats.slice(0, 2);
    const pct = top2.length && sum.expense ? fmt.round2((top2.reduce((a, c) => a + c.amount, 0) / sum.expense) * 100) : 0;
    const trendTxt = cmp && cmp.expenseChange != null
      ? `, 支出较上一周期${cmp.expenseChange >= 0 ? "增加" : "减少"} ${Math.abs(cmp.expenseChange)}%` : "";
    const coverTxt = sum.income > 0
      ? (sum.netCashflow >= 0 ? `收入覆盖支出, 结余 ${fmt.money(sum.netCashflow)}` : `收入未能覆盖支出, 缺口 ${fmt.money(-sum.netCashflow)}`)
      : "本范围无收入记录";
    const catTxt = top2.length ? `其中「${top2.map((c) => c.category).join("」和「")}」占总支出的 ${pct}%` : "";
    const rangeTxt = !state.start && !state.end ? "全部时间"
      : state.start === state.end ? fmt.date(state.start) : `${fmt.date(state.start)} 至 ${fmt.date(state.end)}`;
    if (!txsZero(sum)) {
      $("summaryStrip").textContent =
        `${rangeTxt}净支出 ${fmt.money(sum.netExpense)}(毛支出 ${fmt.money(sum.expense)} − 退款 ${fmt.money(sum.refund)}), ${catTxt}${trendTxt}。${coverTxt}。`;
    } else {
      $("summaryStrip").textContent = `${rangeTxt}没有任何收支记录, 请调整筛选或导入数据。`;
    }
  }
  function txsZero(sum) { return sum.count === 0 || (sum.income === 0 && sum.expense === 0 && sum.refund === 0 && sum.transfer === 0); }

  /* ---------------- 表格渲染 ---------------- */
  function txRow(t, extra) {
    const m = TYPE_META[t.type];
    const badges = [
      t.large ? '<span class="badge large">◆ 大额</span>' : "",
      t.recurring ? '<span class="badge recur">↻ 重复</span>' : "",
      t.possible_duplicate ? '<span class="badge dup">⧉ 疑似重复</span>' : "",
      t.has_issue ? '<span class="badge issue">⚠ 异常</span>' : "",
      t.edited ? '<span class="badge edited">✎ 已编辑</span>' : "",
      FLAGS.has(t.id) ? '<span class="badge flag">★ 已标记</span>' : "",
    ].join("");
    return `<tr class="clickable" data-txid="${t.id}">
      <td class="num">${fmt.date(t.date)}</td>
      <td><span class="ticon ${m.cls}" title="${L[t.type]}">${m.icon}</span> ${L[t.type]}</td>
      <td class="num ${m.amt}">${m.sign}${fmt.money(t.amount)}</td>
      <td>${t.category}${t.subcategory ? `<div class="muted">${t.subcategory}</div>` : ""}</td>
      <td>${t.merchant || "—"}</td>
      <td>${t.account}</td>
      <td>${t.payment_method}</td>
      <td>${(t.tags || []).join(", ") || "—"}</td>
      <td>${badges}<span class="muted">${(t.note || "").slice(0, 40)}</span></td>
    </tr>`;
  }

  function renderTxTable(txs) {
    const sorted = txs.slice().sort((a, b) => {
      if (state.sort === "date_asc") return a.date.localeCompare(b.date);
      if (state.sort === "amount_desc") return b.amount - a.amount;
      if (state.sort === "amount_asc") return a.amount - b.amount;
      return b.date.localeCompare(a.date);
    });
    const pages = Math.max(1, Math.ceil(sorted.length / state.pageSize));
    state.page = Math.min(state.page, pages);
    const slice = sorted.slice((state.page - 1) * state.pageSize, state.page * state.pageSize);
    $("txCount").textContent = `共 ${fmt.num(sorted.length)} 笔 · 第 ${state.page}/${pages} 页`;
    $("txTable").innerHTML = `<thead><tr>
      <th>日期</th><th>类型</th><th>金额</th><th>分类</th><th>商户</th><th>账户</th><th>支付方式</th><th>标签</th><th>标记 / 备注</th>
    </tr></thead><tbody>${slice.map((t) => txRow(t)).join("") ||
      '<tr><td colspan="9" class="muted">当前筛选无记录</td></tr>'}</tbody>`;
    const pager = $("txPager");
    let btns = `<button ${state.page <= 1 ? "disabled" : ""} data-pg="prev">‹ 上一页</button>`;
    const win = [];
    for (let i = 1; i <= pages; i++) if (i <= 2 || i > pages - 2 || Math.abs(i - state.page) <= 2) win.push(i);
    let last = 0;
    for (const i of win) { if (i - last > 1) btns += "<span class=muted>…</span>"; btns += `<button class="${i === state.page ? "current" : ""}" data-pg="${i}">${i}</button>`; last = i; }
    btns += `<button ${state.page >= pages ? "disabled" : ""} data-pg="next">下一页 ›</button>`;
    pager.innerHTML = btns;
    pager.querySelectorAll("button[data-pg]").forEach((b) => b.onclick = () => {
      const v = b.dataset.pg;
      state.page = v === "prev" ? state.page - 1 : v === "next" ? state.page + 1 : +v;
      renderTxTable(filtered());
    });
  }

  function renderCatTable(cats, sum, prevCats) {
    const prevMap = new Map((prevCats || []).map((c) => [c.category, c.amount]));
    $("catTable").innerHTML = `<thead><tr>
      <th>分类</th><th class="num">支出金额</th><th>占比条形</th><th class="num">占比</th><th class="num">环比</th>
      <th class="num">笔数</th><th class="num">平均单笔</th><th>标记</th>
    </tr></thead><tbody>${cats.map((c) => {
      const pct = sum.expense ? fmt.round2((c.amount / sum.expense) * 100) : 0;
      const prev = prevMap.get(c.category);
      const mom = prev ? fmt.round2(((c.amount - prev) / prev) * 100) : null;
      const barW = Math.max(2, Math.min(100, pct * 2.2));
      return `<tr class="clickable" data-cat="${c.category}">
        <td><b>${c.category}</b></td>
        <td class="num amt-exp">${fmt.money(c.amount)}</td>
        <td class="rank-bar-cell"><div class="rank-bar" style="width:${barW}%"></div></td>
        <td class="num">${pct}%</td>
        <td class="num">${mom == null ? '<span class="muted">—</span>' : `<span class="${mom > 0 ? "amt-exp" : "amt-inc"}">${mom > 0 ? "+" : ""}${mom}%</span>`}</td>
        <td class="num">${c.count}</td>
        <td class="num">${fmt.money(c.avg)}</td>
        <td>${c.large ? '<span class="badge large">◆ 大额 ' + c.large + "</span>" : ""}${c.recurring ? '<span class="badge recur">↻ 重复 ' + c.recurring + "</span>" : ""}</td>
      </tr>`;
    }).join("") || '<tr><td colspan="8" class="muted">无支出记录</td></tr>'}</tbody>`;
    $("catTable").querySelectorAll("tr[data-cat]").forEach((tr) => tr.onclick = () => drillInto(tr.dataset.cat));
  }

  function renderTopExpenses(txs) {
    const top = AGG.topExpenses(txs, 8);
    $("topExpenseList").innerHTML = top.map((t) => `
      <li data-txid="${t.id}">
        <span>${t.large ? "◆" : "·"}</span>
        <span><b>${t.merchant || t.note || t.category}</b>
          <div class="te-meta">${fmt.date(t.date)} · ${t.category}${t.recurring ? " · ↻重复" : ""}</div></span>
        <span class="te-amount">${fmt.money(t.amount)}</span>
      </li>`).join("") || '<li class="muted">无支出记录</li>';
    $("topExpenseList").querySelectorAll("li[data-txid]").forEach((li) => li.onclick = () => openTxModal(li.dataset.txid));
  }

  /* ---------------- 下钻 ---------------- */
  function drillInto(cat, sub) {
    state.drill = cat; state.drillSub = sub || null;
    const all = filtered().filter((t) => t.type === "expense" && t.category === cat);
    const c = AGG.byCategory(all)[0];
    $("drillPanel").hidden = false;
    $("drillTitle").textContent = `分类下钻: ${cat} — ${all.length} 笔 · 合计 ${fmt.money(c ? c.amount : 0)}`;
    $("drillMerchants").innerHTML = (c ? c.topMerchants : []).map((m) =>
      `<li><span>${m.merchant}</span><b>${fmt.money(m.amount)}</b></li>`).join("") || '<li class="muted">无商户信息</li>';

    // 子品类消费明细: 按最细子类(中类/小类)聚合, 有 2 个及以上子类时展示
    const subMap = new Map();
    for (const t of all) {
      const k = t.subcategory || "(无子分类)";
      if (!subMap.has(k)) subMap.set(k, { name: k, amount: 0, count: 0 });
      const g = subMap.get(k); g.amount += t.amount; g.count++;
    }
    const subs = [...subMap.values()].sort((a, b) => b.amount - a.amount);
    const showSubs = subs.length >= 2;
    $("drillSubWrap").style.display = showSubs ? "" : "none";
    if (showSubs) {
      const total = c ? c.amount : 0;
      $("drillSubTable").innerHTML = `<thead><tr><th>子品类</th><th class="num">金额</th><th class="num">占比</th><th class="num">笔数</th><th class="num">平均单笔</th></tr></thead>
        <tbody>${subs.map((s) => `<tr class="clickable ${state.drillSub === s.name ? "sub-active" : ""}" data-sub="${s.name}">
          <td>${s.name}</td><td class="num amt-exp">${fmt.money(s.amount)}</td>
          <td class="num">${total ? fmt.round2((s.amount / total) * 100) : 0}%</td>
          <td class="num">${s.count}</td><td class="num">${fmt.money(fmt.round2(s.amount / s.count))}</td></tr>`).join("")}</tbody>`;
      $("drillSubTable").querySelectorAll("tr[data-sub]").forEach((tr) => tr.onclick = () =>
        drillInto(cat, state.drillSub === tr.dataset.sub ? null : tr.dataset.sub));
    }

    // 交易列表(可按子类过滤)
    const txs = state.drillSub ? all.filter((t) => (t.subcategory || "(无子分类)") === state.drillSub) : all;
    $("drillTxTitle").innerHTML = state.drillSub
      ? `子类「${state.drillSub}」交易(按金额降序, 前 20) <a href="#" id="drillSubReset" class="reset-link">× 显示全部子类</a>`
      : "该分类交易(按金额降序, 前 20)";
    const reset = $("drillSubReset");
    if (reset) reset.onclick = (e) => { e.preventDefault(); drillInto(cat, null); };
    $("drillTxTable").innerHTML = `<thead><tr><th>日期</th><th class="num">金额</th><th>商户</th><th>备注</th></tr></thead>
      <tbody>${txs.sort((a, b) => b.amount - a.amount).slice(0, 20).map((t) =>
        `<tr class="clickable" data-txid="${t.id}"><td class="num">${fmt.date(t.date)}</td><td class="num amt-exp">${fmt.money(t.amount)}</td><td>${t.merchant || "—"}</td><td class="muted">${(t.note || "").slice(0, 30)}</td></tr>`).join("")}</tbody>`;
    $("drillTxTable").querySelectorAll("tr[data-txid]").forEach((tr) => tr.onclick = () => openTxModal(tr.dataset.txid));
    renderAll(false); // 高亮条形
    $("drillPanel").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  /* ---------------- 星辰图 ---------------- */
  function starData(txs) {
    const expCats = AGG.byCategory(txs).map((c) => c.category);
    const yCats = ["（收入）", "（退款）", "（转账）"].concat(expCats);
    const yOf = (t) => t.type === "income" ? "（收入）" : t.type === "refund" ? "（退款）" : t.type === "transfer" ? "（转账）" : t.category;
    const amounts = txs.map((t) => t.amount).sort((a, b) => a - b);
    const q = (p) => amounts[Math.floor((amounts.length - 1) * p)] || 0;
    const lo = q(0.05), hi = q(0.98);
    const scale = (a) => {
      const t = hi > lo ? Math.min(1, Math.max(0, (a - lo) / (hi - lo))) : 0.5;
      return 5 + t * 22; // 5px ~ 27px
    };
    const jitter = (id) => { let h = 0; for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 997; return (h / 997 - 0.5) * 0.5; };
    const agg = state.starAgg === "day" || (state.starAgg === "auto" && txs.length > 1800);
    if (agg) {
      const m = new Map();
      for (const t of txs) {
        const k = t.type + "|" + t.date.slice(0, 10) + "|" + yOf(t);
        if (!m.has(k)) m.set(k, { type: t.type, date: t.date.slice(0, 10), yCat: yOf(t), amount: 0, count: 0, maxAmount: 0 });
        const g = m.get(k); g.amount += t.amount; g.count++; g.maxAmount = Math.max(g.maxAmount, t.amount);
      }
      const pts = [...m.values()].map((g) => Object.assign(g, { amount: fmt.round2(g.amount), size: Math.min(30, 7 + Math.sqrt(g.count) * 5), itemStyle: { borderWidth: 1 } }));
      return { yCats, pts, agg: true };
    }
    const pts = txs.map((t) => ({
      type: t.type, date: t.date.slice(0, 10), yCat: yOf(t), amount: t.amount,
      merchant: t.merchant, note: t.note, category: t.category, subcategory: t.subcategory,
      large: t.large, recurring: t.recurring, id: t.id,
      size: t.large ? Math.max(16, scale(t.amount)) : scale(t.amount),
      yJitter: jitter(t.id),
      itemStyle: { borderWidth: t.large ? 2 : 0.8 },
    }));
    return { yCats, pts, agg: false };
  }

  function renderStar(txs) {
    const isChart = state.starMode === "chart";
    $("chartStar").style.display = isChart ? "" : "none";
    $("starTableWrap").hidden = isChart; // 表格模式下显示备用表格
    $("starModeChart").classList.toggle("active", isChart);
    $("starModeTable").classList.toggle("active", !isChart);
    const { yCats, pts, agg } = starData(txs.filter((t) => t.amount != null));
    $("starNote").textContent =
      `当前 ${txs.length} 笔交易${agg ? " · 已按日聚合(每颗星 = 当天该分类合计, 大小代表笔数)" : " · 未聚合"}; ` +
      "星星在分类行内做了纵向错位以避免重叠, 可拖动下方滑块缩放时间范围; 金额越大星越大、越不透明。";
    if (isChart) {
      renderChart("chartStar", CH.star(yCats, pts, fmt, agg));
      if (charts.chartStar && CHART_OK) {
        charts.chartStar.off("click");
        charts.chartStar.on("click", (p) => {
          if (p.data && p.data.tx && p.data.tx.id) openTxModal(p.data.tx.id);
          else if (p.data && p.data.tx) { // 聚合点 → 联动筛选到当日该分类
            state.start = p.data.tx.date; state.end = p.data.tx.date;
            state.categories = new Set(p.data.tx.yCat.startsWith("（") ? [] : [p.data.tx.yCat]);
            state.types = new Set([p.data.tx.type]); syncFilterUI(); renderAll();
          }
        });
      }
    } else {
      const list = txs.slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 500);
      $("starTable").innerHTML = `<thead><tr><th>日期</th><th>类型</th><th class="num">金额</th><th>分类</th><th>商户</th><th>备注</th></tr></thead>
        <tbody>${list.map((t) => { const m = TYPE_META[t.type]; return `<tr class="clickable" data-txid="${t.id}">
          <td class="num">${fmt.date(t.date)}</td><td>${m.icon} ${L[t.type]}</td>
          <td class="num ${m.amt}">${m.sign}${fmt.money(t.amount)}</td><td>${t.category}</td>
          <td>${t.merchant || "—"}</td><td class="muted">${(t.note || "").slice(0, 30)}</td></tr>`; }).join("")}
        </tbody>`;
      $("starTable").querySelectorAll("tr[data-txid]").forEach((tr) => tr.onclick = () => openTxModal(tr.dataset.txid));
    }
  }

  /* ---------------- 质量面板 ---------------- */
  function renderQuality() {
    const q = DATA.quality;
    const issueRows = (q.issues || []);
    const dup = q.possible_duplicate_rows || 0;
    $("qualitySummary").innerHTML = `
      <p>原始 <b>${fmt.num(q.total_rows || ALL_TX.length)}</b> 行 · 参与计算 <b class="q-ok">${fmt.num(validTx().length)}</b> 行 ·
      校验问题 <b class="${issueRows.length ? "q-bad" : "q-ok"}">${issueRows.length}</b> 条 ·
      疑似重复 <b>${dup}</b> 行(仅提示, 未删除) · 大额标记 ${q.large_expense_rows || 0} 行 · 重复性标记 ${q.recurring_rows || 0} 行
      ${q.injected_demo ? ' · <b class="q-bad">当前为异常演示数据(demo=anomaly)</b>' : ""}</p>
      <p class="muted">类型映射: ${Object.entries(DATA.meta.type_mapping || {}).map(([k, v]) => `${k}: ${v}`).join("; ") || "—"}</p>
      ${Object.keys(EDITS).length ? `<p>✎ 本浏览器有 <b>${Object.keys(EDITS).length}</b> 笔网页编辑覆盖(原始 CSV 不受影响, 可逐笔在详情中还原) <button class="btn" id="clearEdits">清除全部编辑</button></p>` : ""}`;
    const ce = $("clearEdits");
    if (ce) ce.onclick = () => {
      if (!confirm(`确定清除本浏览器的 ${Object.keys(EDITS).length} 笔编辑?原始数据不受影响。`)) return;
      Object.keys(EDITS).forEach((k) => delete EDITS[k]);
      persistEdits();
      ALL_TX.forEach((t) => { if (t._orig) { Object.assign(t, t._orig, { edited: false }); } });
      renderAll();
    };
    $("qualityTable").innerHTML = issueRows.length
      ? `<thead><tr><th>记录</th><th>CSV 行</th><th>字段</th><th>问题与处理方式</th></tr></thead><tbody>
         ${issueRows.map((i) => `<tr><td>${i.id}</td><td>${i.row}</td><td>${i.field}</td><td>${i.error}</td></tr>`).join("")}</tbody>`
      : '<tbody><tr><td class="q-ok">✓ 全部记录通过字段校验(金额 / 日期 / 分类 / 符号), 无静默处理。</td></tr></tbody>';
  }

  /* ---------------- 筛选 chips ---------------- */
  function renderChips() {
    const chips = [];
    if (state.start || state.end) chips.push({ k: "range", label: `📅 ${fmt.date(state.start)} ~ ${fmt.date(state.end)}` });
    state.types.forEach((t) => chips.push({ k: "type:" + t, label: L[t] }));
    state.categories.forEach((c) => chips.push({ k: "cat:" + c, label: "分类: " + c }));
    state.accounts.forEach((c) => chips.push({ k: "acc:" + c, label: "账户: " + c }));
    state.payments.forEach((c) => chips.push({ k: "pay:" + c, label: "支付: " + c }));
    if (state.search) chips.push({ k: "search", label: `🔍 "${state.search}"` });
    if (state.largeOnly) chips.push({ k: "large", label: "仅大额" });
    if (state.recurringOnly) chips.push({ k: "recur", label: "仅重复性" });
    $("activeChips").innerHTML = chips.length
      ? chips.map((c) => `<span class="chip">${c.label}<button data-chip="${c.k}" aria-label="移除">✕</button></span>`).join("")
      : '<span class="muted">无(显示全部数据)</span>';
    $("activeChips").querySelectorAll("button[data-chip]").forEach((b) => b.onclick = () => {
      const k = b.dataset.chip;
      if (k === "range") { state.start = state.end = null; state.quick = "all"; applyQuickRange("all"); }
      else if (k === "search") state.search = "";
      else if (k === "large") state.largeOnly = false;
      else if (k === "recur") state.recurringOnly = false;
      else { const [p, v] = k.split(":"); ({ type: state.types, cat: state.categories, acc: state.accounts, pay: state.payments })[p].delete(v); }
      syncFilterUI(); renderAll();
    });
  }

  /* ---------------- 主渲染 ---------------- */
  function renderAll(resetPage = true) {
    if (resetPage) state.page = 1;
    const txs = filtered();
    const sum = AGG.summarize(txs);
    const cats = AGG.byCategory(txs);
    const cmp = state.start && state.end ? AGG.comparePrevious(txs, ALL_TX, state.start, state.end) : null;
    const prevCats = cmp ? AGG.byCategory(AGG.filterTx(ALL_TX, { start: cmp.prevStart, end: cmp.prevEnd })) : null;

    $("overviewRange").textContent = state.start ? `${fmt.date(state.start)} ~ ${fmt.date(state.end)}` : "全部时间";
    renderKPIs(txs, sum, cats, cmp);
    renderSummary(sum, cats, cmp);
    renderChips();
    $("matchCount").textContent = `命中 ${fmt.num(txs.length)} 笔 / 全部 ${fmt.num(ALL_TX.length)} 笔`;

    const buckets = bucketize(txs);
    renderChart("chartIncomeExpense", CH.incomeExpense(buckets, fmt));
    renderChart("chartCatRank", CH.catBar(cats.slice(0, 10), fmt, { highlight: state.drill }));
    renderChart("chartCatBar", CH.catBar(cats, fmt, { highlight: state.drill }));
    renderChart("chartCatDonut", CH.catDonut(cats, fmt));
    const largePts = txs.filter((t) => t.large).map((t) => ({ label: bucketKey(t.date.slice(0, 10)), amount: t.amount, date: t.date.slice(0, 10), merchant: t.merchant, note: t.note, category: t.category }));
    renderChart("chartTrend", CH.trend(buckets, largePts, fmt));
    renderChart("chartCumulative", CH.cumulative(buckets, fmt));
    const year = (state.end || (dataExtent() || {}).max || "2026").slice(0, 4);
    const dayRows = AGG.byDay(AGG.filterTx(ALL_TX, { start: year + "-01-01", end: year + "-12-31" }));
    $("calYearNote").textContent = `${year} 年 · 每日净支出`;
    renderChart("chartCalendar", CH.calendar(dayRows, year, fmt));
    $("trendUnitNote").textContent = { day: "按日", week: "按周", month: "按月", quarter: "按季度", year: "按年" }[state.granularity] + ", 单位: 元";

    renderTopExpenses(txs);
    renderCatTable(cats, sum, prevCats);
    renderStar(txs);
    renderTxTable(txs);
    renderQuality();
    bindChartEvents();
    updateEmptyState(txs);
    $("footerMeta").textContent = `数据: ${DATA.meta.source_file || "—"} · 生成于 ${DATA.meta.generated_at || "—"} · 时区 ${CONFIG.timezone} · 货币 ${CONFIG.currency} · 大额阈值 ≥3,000 元`;
  }

  function bindChartEvents() {
    if (!CHART_OK) return;
    const onCat = (chartId) => {
      const c = charts[chartId]; if (!c) return;
      c.off("click");
      c.on("click", (p) => {
        const cat = p.name || (p.data && p.data.name);
        if (cat && !String(cat).startsWith("其他")) drillInto(cat);
      });
    };
    onCat("chartCatRank"); onCat("chartCatBar");
    if (charts.chartCatDonut) {
      charts.chartCatDonut.off("click");
      charts.chartCatDonut.on("click", (p) => { if (p.name && !p.name.startsWith("其他")) drillInto(p.name); });
    }
    if (charts.chartTrend) {
      charts.chartTrend.off("click");
      charts.chartTrend.on("click", (p) => {
        if (p.componentType !== "series" || p.seriesType === "scatter") return;
        zoomToBucket(p.name);
      });
    }
    if (charts.chartCalendar) {
      charts.chartCalendar.off("click");
      charts.chartCalendar.on("click", (p) => {
        if (p.value && p.value[0]) {
          state.start = p.value[0]; state.end = p.value[0]; state.quick = "";
          syncFilterUI(); renderAll();
        }
      });
    }
  }

  function zoomToBucket(label) {
    // 点击趋势柱子 → 时间范围缩到该周期
    let s, e;
    const y4 = label.slice(0, 4);
    const iso = AGG.localISO;
    if (/^\d{4}-\d{2}-\d{2}$/.test(label)) { s = e = label; }
    else if (label.endsWith(" 周")) { const d = new Date(label.slice(0, 10) + "T00:00:00"); s = label.slice(0, 10); e = iso(new Date(d.getTime() + 6 * 864e5)); }
    else if (/^\d{4}-\d{2}$/.test(label)) { s = label + "-01"; e = iso(new Date(+y4, +label.slice(5, 7), 0)); }
    else if (label.includes("Q")) { const q = +label.slice(-1); s = `${y4}-${String((q - 1) * 3 + 1).padStart(2, "0")}-01`; e = iso(new Date(+y4, q * 3, 0)); }
    else if (/^\d{4}/.test(label)) { s = y4 + "-01-01"; e = y4 + "-12-31"; }
    if (s) { state.start = s; state.end = e; state.quick = ""; syncFilterUI(); renderAll(); }
  }

  function updateEmptyState(txs) {
    const empty = $("emptyState");
    if (!ALL_TX.length) {
      empty.hidden = false;
      $("emptyTitle").textContent = "还没有记账数据";
      $("emptyDesc").textContent = "导入 MoneyThings 导出的 CSV 文件, 或本工具生成的 JSON 数据文件, 即可生成收支分析报告。";
      $("emptyClear").style.display = "none";
      $("main").style.opacity = 0.25;
    } else if (!txs.length) {
      empty.hidden = false;
      $("emptyTitle").textContent = "没有符合条件的交易";
      $("emptyDesc").textContent = "当前筛选条件下没有任何记录, 请调整时间范围或清除部分筛选。";
      $("emptyClear").style.display = "";
      $("main").style.opacity = 0.25;
    } else {
      empty.hidden = true;
      $("main").style.opacity = 1;
    }
  }

  /* ---------------- 筛选 UI 同步 ---------------- */
  function fillSelect(id, values, keepLabels) {
    const el = $(id);
    const cur = new Set([...el.selectedOptions].map((o) => o.value));
    el.innerHTML = values.map((v) => `<option value="${v}" ${cur.has(v) ? "selected" : ""}>${v}</option>`).join("");
    el.size = Math.min(Math.max(values.length, 1), 1);
  }
  function syncFilterUI() {
    $("dateStart").value = state.start || ""; $("dateEnd").value = state.end || "";
    document.querySelectorAll(".quick-ranges .chip-btn").forEach((b) => b.classList.toggle("active", b.dataset.range === state.quick));
    document.querySelectorAll("#typeFilter .type-chip").forEach((b) => b.setAttribute("aria-pressed", state.types.has(b.dataset.type)));
    const syncMulti = (id, set) => [...$(id).options].forEach((o) => o.selected = set.has(o.value));
    syncMulti("fCategory", state.categories); syncMulti("fAccount", state.accounts); syncMulti("fPayment", state.payments);
    $("fLarge").checked = state.largeOnly; $("fRecurring").checked = state.recurringOnly;
    $("fSearch").value = state.search;
  }

  function bindUI() {
    document.querySelectorAll(".quick-ranges .chip-btn").forEach((b) => b.onclick = () => {
      state.quick = b.dataset.range; applyQuickRange(state.quick); syncFilterUI(); renderAll();
    });
    $("dateStart").onchange = () => { state.start = $("dateStart").value || null; state.quick = ""; renderAll(); };
    $("dateEnd").onchange = () => { state.end = $("dateEnd").value || null; state.quick = ""; renderAll(); };
    $("granularity").onchange = () => { state.granularity = $("granularity").value; renderAll(); };
    document.querySelectorAll("#typeFilter .type-chip").forEach((b) => b.onclick = () => {
      const t = b.dataset.type;
      state.types.has(t) ? state.types.delete(t) : state.types.add(t);
      syncFilterUI(); renderAll();
    });
    const onMulti = (id, set) => $(id).onchange = () => { set.clear(); [...$(id).selectedOptions].forEach((o) => set.add(o.value)); renderAll(); };
    onMulti("fCategory", state.categories); onMulti("fAccount", state.accounts); onMulti("fPayment", state.payments);
    $("fLarge").onchange = () => { state.largeOnly = $("fLarge").checked; renderAll(); };
    $("fRecurring").onchange = () => { state.recurringOnly = $("fRecurring").checked; renderAll(); };
    let deb;
    $("fSearch").oninput = () => { clearTimeout(deb); deb = setTimeout(() => { state.search = $("fSearch").value.trim(); renderAll(); }, 250); };
    $("btnClear").onclick = clearFilters;
    $("emptyClear").onclick = clearFilters;
    $("txSort").onchange = () => { state.sort = $("txSort").value; renderTxTable(filtered()); };
    $("txPageSize").onchange = () => { state.pageSize = +$("txPageSize").value; state.page = 1; renderTxTable(filtered()); };
    $("txTable").parentElement.addEventListener("click", (e) => {
      const tr = e.target.closest("tr[data-txid]"); if (tr) openTxModal(tr.dataset.txid);
    });
    $("drillClose").onclick = () => { $("drillPanel").hidden = true; state.drill = null; state.drillSub = null; renderAll(false); };
    $("starModeChart").onclick = () => { state.starMode = "chart"; renderStar(filtered()); };
    $("starModeTable").onclick = () => { state.starMode = "table"; renderStar(filtered()); };
    $("starAgg").onchange = () => { state.starAgg = $("starAgg").value; renderStar(filtered()); };
    // 弹窗
    $("txModalClose").onclick = () => { $("txModal").hidden = true; };
    $("txModal").addEventListener("click", (e) => { if (e.target === $("txModal")) $("txModal").hidden = true; });
    $("txModalFlag").onclick = toggleFlag;
    $("txModalEdit").onclick = openTxEdit;
    $("txEditSave").onclick = saveTxEdit;
    $("txEditCancel").onclick = () => openTxModal(state.modalTx.id);
    $("txModalRevert").onclick = revertTxEdit;
    // 设置
    $("btnConfig").onclick = () => { $("cfgModal").hidden = false; $("cfgCurrency").value = CONFIG.currency; $("cfgLocale").value = CONFIG.locale; $("cfgDateFmt").value = CONFIG.dateFmt; };
    $("cfgClose").onclick = () => {
      CONFIG.currency = $("cfgCurrency").value; CONFIG.locale = $("cfgLocale").value; CONFIG.dateFmt = $("cfgDateFmt").value;
      localStorage.setItem("fd.config", JSON.stringify(CONFIG));
      $("cfgModal").hidden = true; renderAll();
    };
    // 导入导出
    $("btnImport").onclick = () => $("fileInput").click();
    $("emptyImport").onclick = () => $("fileInput").click();
    $("fileInput").onchange = importFile;
    $("btnExport").onclick = exportCSV;
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") { $("txModal").hidden = true; $("cfgModal").hidden = true; } });
  }

  function clearFilters() {
    state.types.clear(); state.categories.clear(); state.accounts.clear(); state.payments.clear();
    state.search = ""; state.largeOnly = false; state.recurringOnly = false;
    state.quick = "all"; applyQuickRange("all"); state.drill = null;
    $("drillPanel").hidden = true;
    syncFilterUI(); renderAll();
  }

  /* ---------------- 交易详情、标记与编辑 ---------------- */
  function openTxModal(id) {
    const t = ALL_TX.find((x) => x.id === id);
    if (!t) return;
    state.modalTx = t;
    const m = TYPE_META[t.type];
    const origLine = t._orig
      ? `<dt>原始值</dt><dd class="muted">金额 ${fmt.money(t._orig.amount)} · 分类 ${t._orig.category} · 备注 ${t._orig.note || "—"}(网页编辑已覆盖, 可还原)</dd>` : "";
    $("txModalBody").innerHTML = `<dl class="detail-grid">
      <dt>编号</dt><dd>${t.id}${t.source_row ? " (CSV 第 " + t.source_row + " 行)" : ""}</dd>
      <dt>日期</dt><dd>${t.date || "—"}</dd>
      <dt>类型</dt><dd>${m.icon} ${L[t.type]}${t.type === "refund" ? "(冲减当期支出)" : t.type === "transfer" ? "(不计入收支)" : ""}</dd>
      <dt>金额</dt><dd class="${m.amt}" style="font-size:1.2rem">${m.sign}${fmt.money(t.amount)} ${t.currency !== "CNY" ? "(原币 " + t.currency + ")" : ""}</dd>
      <dt>分类</dt><dd>${t.category}${t.subcategory ? " / " + t.subcategory : ""}</dd>
      <dt>商户</dt><dd>${t.merchant || "—"}</dd>
      <dt>账户</dt><dd>${t.account}</dd>
      <dt>支付方式</dt><dd>${t.payment_method}</dd>
      <dt>标签</dt><dd>${(t.tags || []).join(", ") || "—"}</dd>
      <dt>备注</dt><dd>${t.note || "—"}</dd>
      <dt>标记</dt><dd>${[t.large && "◆ 大额支出(≥3,000)", t.recurring && "↻ 重复性支出", t.possible_duplicate && "⧉ 疑似重复(仅提示)", t.has_issue && "⚠ 校验异常", t.edited && "✎ 网页编辑"].filter(Boolean).join(" · ") || "无"}</dd>
      ${origLine}
    </dl>`;
    $("txModalFlag").textContent = FLAGS.has(t.id) ? "★ 取消标记" : "☆ 标记此交易";
    $("txModalRevert").hidden = !t.edited;
    $("txEditForm").hidden = true;
    $("txModalBody").hidden = false;
    $("txViewActions").style.display = "";
    $("txModal").hidden = false;
  }
  function openTxEdit() {
    const t = state.modalTx; if (!t) return;
    $("editAmount").value = t.amount != null ? t.amount : "";
    $("editCategory").value = t.category;
    $("editNote").value = t.note || "";
    $("categoryList").innerHTML = [...new Set(validTx().map((x) => x.category))].sort()
      .map((c) => `<option value="${c}">`).join("");
    $("txModalBody").hidden = true;
    $("txViewActions").style.display = "none";
    $("txEditForm").hidden = false;
  }
  function saveTxEdit() {
    const t = state.modalTx; if (!t) return;
    const amount = parseFloat($("editAmount").value);
    if (!isFinite(amount) || amount <= 0) { alert("金额必须是大于 0 的数字"); return; }
    const category = $("editCategory").value.trim() || "未分类";
    saveEdit(t.id, { amount: fmt.round2(amount), category, note: $("editNote").value.trim() });
    renderAll(false);
    openTxModal(t.id); // 回到详情视图并显示新值
  }
  function revertTxEdit() {
    const t = state.modalTx; if (!t) return;
    revertEdit(t.id);
    renderAll(false);
    openTxModal(t.id);
  }
  function toggleFlag() {
    const t = state.modalTx; if (!t) return;
    FLAGS.has(t.id) ? FLAGS.delete(t.id) : FLAGS.add(t.id);
    localStorage.setItem("fd.flags", JSON.stringify([...FLAGS]));
    $("txModalFlag").textContent = FLAGS.has(t.id) ? "★ 取消标记" : "☆ 标记此交易";
    renderAll(false);
  }

  /* ---------------- 导出 / 导入 ---------------- */
  function exportCSV() {
    const txs = filtered();
    const head = ["id", "date", "type", "amount", "currency", "category", "subcategory", "merchant", "account", "payment_method", "tags", "recurring", "large", "note"];
    const esc = (v) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const lines = [head.join(",")].concat(txs.map((t) => head.map((h) => esc(h === "tags" ? (t.tags || []).join("|") : t[h])).join(",")));
    const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `交易明细_${state.start || "all"}_${state.end || ""}.csv`;
    a.click(); URL.revokeObjectURL(a.href);
  }

  function parseCSVText(text) {
    // 支持引号/逗号/换行的极简 CSV 解析
    const rows = []; let row = [], cur = "", inQ = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQ) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; } else cur += ch; }
      else if (ch === '"') inQ = true;
      else if (ch === ",") { row.push(cur); cur = ""; }
      else if (ch === "\n" || ch === "\r") { if (cur !== "" || row.length) { row.push(cur); rows.push(row); row = []; cur = ""; } if (ch === "\r" && text[i + 1] === "\n") i++; }
      else cur += ch;
    }
    if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
    return rows;
  }

  function importFile(e) {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        let payload;
        if (/\.json$/i.test(file.name)) {
          const j = JSON.parse(reader.result);
          payload = { meta: j.meta || { source_file: file.name }, quality: j.quality || { issues: [] }, transactions: j.transactions || j };
          if (!Array.isArray(payload.transactions)) throw new Error("JSON 结构不正确");
        } else {
          const rows = parseCSVText(String(reader.result).replace(/^﻿/, ""));
          payload = convertMoneyThingsCSV(rows, file.name);
        }
        ALL_TX = payload.transactions;
        DATA.txs = ALL_TX;
        DATA.quality = payload.quality || { issues: [] };
        DATA.meta = payload.meta || {};
        applyEdits();
        buildFilterOptions();
        clearFilters();
        updateDatasetInfo();
        alert(`导入成功: ${ALL_TX.length} 笔交易(${file.name})`);
      } catch (err) {
        alert("导入失败: " + err.message + "\n请确认是 MoneyThings 交易明细 CSV 或本工具 JSON。");
      }
      e.target.value = "";
    };
    reader.readAsText(file, "utf-8");
  }

  const REFUND_CATS = new Set(["购物退款", "转账-退款"]);
  function convertMoneyThingsCSV(rows, fname) {
    const head = rows[0].map((h) => h.trim());
    const idx = (n) => head.indexOf(n);
    for (const col of ["交易类型", "大类", "交易金额", "交易时间"]) if (idx(col) < 0) throw new Error("缺少列: " + col);
    const issues = [], txs = [];
    const pa = (s) => { const t = String(s || "").replace(/[,¥￥\s]/g, ""); return t === "" ? null : Number(t); };
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i]; const g = (n) => (r[idx(n)] || "").trim();
      const amount = pa(g("交易金额"));
      const date = g("交易时间").replace(/\//g, "-");
      let cat = g("大类") || "未分类";
      if (!g("大类")) issues.push({ id: "I" + i, row: i, field: "category", error: "分类为空, 已归入「未分类」" });
      if (amount == null || isNaN(amount)) { issues.push({ id: "I" + i, row: i, field: "amount", error: "金额缺失或格式错误, 不参与计算" }); }
      if (!/^\d{4}-\d{2}-\d{2}/.test(date)) { issues.push({ id: "I" + i, row: i, field: "date", error: "日期格式错误, 不参与计算" }); }
      const rawType = g("交易类型");
      const type = cat === "转账" ? "transfer" : rawType === "收入" && REFUND_CATS.has(cat) ? "refund" : rawType === "收入" ? "income" : "expense";
      const note = g("备注"); let merchant = "", noteText = note;
      const sep = note.search(/[，,；;]/);
      if (sep > 0) { merchant = note.slice(0, sep); noteText = note.slice(sep + 1); }
      txs.push({
        id: "I" + String(i).padStart(5, "0"), date, type,
        amount: amount == null || isNaN(amount) ? null : Math.abs(amount),
        category: cat, subcategory: [g("中类"), g("小类")].filter(Boolean).join(" / "),
        merchant, account: g("转出账户") || g("转入账户") || "未记录",
        payment_method: "未记录", note: noteText, tags: g("标签") ? g("标签").split(/[,，\s]+/) : [],
        recurring: false, currency: g("交易货币") || "CNY", large: Math.abs(amount || 0) >= 3000,
      });
    }
    return { meta: { source_file: fname, generated_at: new Date().toISOString(), type_mapping: { note: "导入数据沿用默认映射规则" } },
             quality: { total_rows: rows.length - 1, issues, issue_count: issues.length }, transactions: txs };
  }

  function buildFilterOptions() {
    const cats = [...new Set(validTx().map((t) => t.category))].sort();
    const accs = [...new Set(validTx().map((t) => t.account))].sort();
    const pays = [...new Set(validTx().map((t) => t.payment_method))].sort();
    fillSelect("fCategory", cats); fillSelect("fAccount", accs); fillSelect("fPayment", pays);
  }

  /* ---------------- 启动 ---------------- */
  function updateDatasetInfo() {
    const ext = dataExtent();
    $("datasetInfo").textContent = ext
      ? `${DATA.meta.source_file || "数据集"} · ${fmt.num(ALL_TX.length)} 笔 · ${fmt.date(ext.min)} ~ ${fmt.date(ext.max)}`
      : (DEMO === "empty" ? "空数据演示模式" : "无数据");
  }
  function init() {
    applyEdits(); // 恢复本浏览器的网页编辑覆盖
    updateDatasetInfo();
    buildFilterOptions();
    bindUI();
    const rq = qs.get("range");
    state.quick = ["month", "lastMonth", "3m", "6m", "year", "all"].includes(rq) ? rq : "month";
    applyQuickRange(state.quick);
    syncFilterUI();
    if (VIEW_ONLY) {
      document.querySelectorAll("main > section, .filterbar").forEach((s) => {
        if (s.id !== VIEW_ONLY) s.style.display = "none";
      });
    }
    renderAll();
    if (VIEW_ONLY) window.scrollTo(0, 0);
    // 演示/测试钩子: ?state=drill[:分类] 下钻; ?state=edit:ID 打开编辑弹窗; ?starmode=table 星图表格模式
    const st = qs.get("state") || "";
    if (st.startsWith("drill")) {
      const cat = st.includes(":") ? st.split(":").slice(1).join(":") : (AGG.byCategory(filtered())[0] || {}).category;
      if (cat) drillInto(cat);
    }
    if (st.startsWith("edit:")) {
      const id = st.slice(5);
      openTxModal(id); openTxEdit();
    }
    if (qs.get("starmode") === "table") { state.starMode = "table"; renderStar(filtered()); }
    // 供自动化测试/控制台调试使用
    window.__app = { state, renderAll, filtered, drillInto, clearFilters, openTxModal, openTxEdit, saveTxEdit, revertTxEdit, EDITS, AGG, CONFIG, DATA };
  }
  document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", init) : init();
})();
