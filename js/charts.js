/* charts.js — ECharts 配置构建器(纯函数, 不持有状态)。现代柔和配色, 圆角柱形。 */
(function () {
  "use strict";
  const C = { coral: "#EE7B72", accent: "#6675D9", amber: "#F2B04C", blue: "#7FA5F0", green: "#34BE82",
              purple: "#8B7CF6", ink: "#1B2033", muted: "#8A90A5", line: "#E8EBF2",
              ink2: "#3A4060" };
  const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, "PingFang SC", "Microsoft YaHei", sans-serif';

  function base(fmt) {
    return {
      backgroundColor: "transparent",
      textStyle: { fontFamily: FONT, color: C.ink },
      grid: { left: 8, right: 24, top: 42, bottom: 8, containLabel: true },
      tooltip: {
        trigger: "axis",
        backgroundColor: "rgba(27,32,51,0.92)", borderWidth: 0, padding: [8, 12],
        textStyle: { color: "#F4F6FA", fontSize: 12 },
        valueFormatter: fmt ? fmt.money : undefined,
        extraCssText: "border-radius:10px;box-shadow:0 8px 24px rgba(27,32,51,0.25);",
      },
      legend: { top: 0, left: 0, itemWidth: 12, itemHeight: 12, icon: "roundRect",
                textStyle: { fontSize: 12, color: C.muted } },
    };
  }
  const axisCommon = {
    axisLine: { lineStyle: { color: C.line } },
    axisTick: { show: false },
    axisLabel: { color: C.muted, fontSize: 11 },
    splitLine: { lineStyle: { color: "rgba(232,235,242,0.7)" } },
  };

  /* 1. 收入 vs 支出 圆角柱 + 净现金流线 */
  function incomeExpense(rows, fmt) {
    const o = base(fmt);
    o.tooltip.axisPointer = { type: "shadow", shadowStyle: { color: "rgba(76,125,240,0.06)" } };
    o.xAxis = { type: "category", data: rows.map((r) => r.label), ...axisCommon };
    o.yAxis = { type: "value", name: "元", nameTextStyle: { color: C.muted }, ...axisCommon };
    o.series = [
      { name: "收入", type: "bar", data: rows.map((r) => r.income),
        itemStyle: { color: C.green, borderRadius: [6, 6, 0, 0] }, barMaxWidth: 26 },
      { name: "支出(净,已减退款)", type: "bar", data: rows.map((r) => r.netExpense),
        itemStyle: { color: C.coral, borderRadius: [6, 6, 0, 0] }, barMaxWidth: 26 },
      { name: "净现金流", type: "line", smooth: true, data: rows.map((r) => r.net),
        itemStyle: { color: C.ink2 }, lineStyle: { width: 3, color: C.ink2 },
        symbol: "circle", symbolSize: 8, symbolBorderColor: "#fff", symbolBorderWidth: 2 },
    ];
    return o;
  }

  /* 2/3. 分类横向条形(圆角, 珊瑚渐变) */
  function catBar(cats, fmt, opts) {
    opts = opts || {};
    const data = cats.slice();
    const o = base(fmt);
    o.tooltip.trigger = "item";
    o.tooltip.formatter = (p) => {
      const c = data[p.dataIndex];
      return `<b>${c.category}</b><br>支出: ${fmt.money(c.amount)} (${c.pct}%)<br>笔数: ${c.count} · 平均: ${fmt.money(c.avg)}`;
    };
    o.grid.top = 10;
    o.xAxis = { type: "value", name: "元", nameTextStyle: { color: C.muted }, ...axisCommon };
    o.yAxis = { type: "category", inverse: true, data: data.map((c) => c.category), ...axisCommon,
                axisLabel: { ...axisCommon.axisLabel, fontSize: 12, fontWeight: 600, color: C.ink } };
    o.series = [{
      name: "支出", type: "bar", data: data.map((c) => c.amount),
      itemStyle: {
        borderRadius: [0, 7, 7, 0],
        color: (p) => opts.highlight === data[p.dataIndex].category
          ? { type: "linear", x: 0, y: 0, x2: 1, y2: 0, colorStops: [{ offset: 0, color: "#F2B04C" }, { offset: 1, color: "#F7CE8A" }] }
          : { type: "linear", x: 0, y: 0, x2: 1, y2: 0, colorStops: [{ offset: 0, color: "#97A5E8" }, { offset: 1, color: "#6675D9" }] },
      },
      barMaxWidth: 18,
      label: { show: true, position: "right", formatter: (p) => fmt.compact(data[p.dataIndex].amount), fontSize: 11, color: C.muted },
    }];
    return o;
  }

  /* 4. 分类占比环图(柔和 pastel, 圆角扇区) */
  function catDonut(cats, fmt) {
    const top = cats.slice(0, 8);
    const rest = cats.slice(8);
    const data = top.map((c) => ({ name: c.category, value: c.amount }));
    if (rest.length) data.push({ name: "其他(" + rest.length + "类)", value: fmt.round2(rest.reduce((a, c) => a + c.amount, 0)) });
    const total = data.reduce((a, d) => a + d.value, 0);
    const palette = ["#6675D9", "#EE7B72", "#F2B04C", "#4ECBA0", "#8B7CF6", "#7FA5F0", "#FF9FB2", "#5BC8D8", "#A8B3CF"];
    return {
      backgroundColor: "transparent", textStyle: { fontFamily: FONT },
      tooltip: { trigger: "item", backgroundColor: "rgba(27,32,51,0.92)", textStyle: { color: "#F4F6FA", fontSize: 12 },
                 formatter: (p) => `${p.name}<br>${fmt.money(p.value)} · ${p.percent}%`,
                 extraCssText: "border-radius:10px;" },
      legend: { orient: "vertical", right: 0, top: "middle", icon: "circle", itemWidth: 10,
                textStyle: { fontSize: 11, color: C.muted },
                formatter: (name) => {
                  const d = data.find((x) => x.name === name);
                  const pct = total ? fmt.round2((d.value / total) * 100) : 0;
                  return `${name.length > 8 ? name.slice(0, 8) + "…" : name}  ${pct}%`;
                } },
      series: [{
        type: "pie", radius: ["45%", "70%"], center: ["34%", "50%"],
        data, itemStyle: { borderColor: "#fff", borderWidth: 2, borderRadius: 6 },
        color: palette,
        label: { show: false }, emphasis: { label: { show: true, fontWeight: 700, formatter: "{b}\n{d}%", color: C.ink } },
      }],
    };
  }

  /* 5. 趋势: 柱 + 净现金流线 + 大额支出散点 */
  function trend(rows, largePoints, fmt) {
    const o = incomeExpense(rows, fmt);
    if (largePoints && largePoints.length) {
      o.series.push({
        name: "大额支出", type: "scatter", symbol: "diamond", symbolSize: 13,
        data: largePoints.map((p) => ({ value: [p.label, p.amount], tx: p })),
        itemStyle: { color: C.amber, borderColor: "#fff", borderWidth: 2,
                     shadowBlur: 6, shadowColor: "rgba(245,166,35,0.5)" },
        z: 5,
      });
      o.tooltip.trigger = "axis";
      o.tooltip.formatter = (params) => {
        const head = params[0] ? params[0].axisValue : "";
        const lines = params.filter((p) => p.seriesType !== "scatter")
          .map((p) => `${p.marker} ${p.seriesName}: <b>${fmt.money(p.value)}</b>`);
        const sc = params.find((p) => p.seriesType === "scatter");
        if (sc && sc.data.tx) lines.push(`◆ 大额: ${sc.data.tx.merchant || sc.data.tx.category} ${fmt.money(sc.data.tx.amount)}`);
        return `<b>${head}</b><br>` + lines.join("<br>");
      };
    }
    return o;
  }

  /* 6. 累计收入/支出(面积渐变) */
  function cumulative(rows, fmt) {
    let ci = 0, ce = 0;
    const labels = rows.map((r) => r.label);
    const inc = rows.map((r) => (ci = fmt.round2(ci + r.income)));
    const exp = rows.map((r) => (ce = fmt.round2(ce + r.netExpense)));
    const o = base(fmt);
    o.xAxis = { type: "category", data: labels, boundaryGap: false, ...axisCommon };
    o.yAxis = { type: "value", name: "元", nameTextStyle: { color: C.muted }, ...axisCommon };
    o.series = [
      { name: "累计收入", type: "line", smooth: true, data: inc, symbol: "none",
        itemStyle: { color: C.green }, lineStyle: { width: 3, color: C.green },
        areaStyle: { color: { type: "linear", x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [{ offset: 0, color: "rgba(52,190,130,0.18)" }, { offset: 1, color: "rgba(52,190,130,0.01)" }] } } },
      { name: "累计支出(净)", type: "line", smooth: true, data: exp, symbol: "none",
        itemStyle: { color: C.coral }, lineStyle: { width: 3, color: C.coral },
        areaStyle: { color: { type: "linear", x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [{ offset: 0, color: "rgba(238,123,114,0.15)" }, { offset: 1, color: "rgba(238,123,114,0.01)" }] } } },
    ];
    return o;
  }

  /* 7. 日历热力图(珊瑚色系) */
  function calendar(dayRows, year, fmt) {
    return {
      backgroundColor: "transparent", textStyle: { fontFamily: FONT },
      tooltip: { backgroundColor: "rgba(27,32,51,0.92)", textStyle: { color: "#F4F6FA", fontSize: 12 },
                 formatter: (p) => `${p.value[0]}<br>净支出: <b>${fmt.money(p.value[1])}</b>`,
                 extraCssText: "border-radius:10px;" },
      visualMap: {
        min: 0, max: Math.max(100, ...dayRows.map((d) => d.netExpense)), calculable: true,
        orient: "horizontal", left: "center", bottom: 0, text: ["支出多", "支出少"],
        inRange: { color: ["#FDF1F0", "#F6B8B3", "#EE7B72", "#D45B52"] },
        textStyle: { fontSize: 11, color: C.muted }, itemWidth: 12, itemHeight: 90,
      },
      calendar: {
        top: 30, left: 40, right: 16, cellSize: ["auto", 16], range: String(year),
        itemStyle: { borderColor: "#fff", borderWidth: 2, borderRadius: 3 },
        dayLabel: { nameMap: ["日", "一", "二", "三", "四", "五", "六"], fontSize: 10, color: C.muted },
        monthLabel: { fontSize: 11, color: C.muted }, yearLabel: { show: false },
        splitLine: { show: false },
      },
      series: { type: "heatmap", coordinateSystem: "calendar", data: dayRows.map((d) => [d.day, d.netExpense]) },
    };
  }

  /* 8. 星辰分布图 */
  const STAR_STYLE = {
    expense: { color: C.coral, symbol: "circle", label: "支出" },
    income: { color: C.green, symbol: "triangle", label: "收入" },
    refund: { color: C.amber, symbol: "diamond", label: "退款" },
    transfer: { color: C.blue, symbol: "rect", label: "转账" },
  };
  function star(cats, points, fmt, aggregated) {
    const series = Object.keys(STAR_STYLE).map((type) => {
      const st = STAR_STYLE[type];
      return {
        name: st.label, type: "scatter", symbol: st.symbol,
        data: points.filter((p) => p.type === type).map((p) => ({
          value: [p.date, p.yCat, p.amount], tx: p, itemStyle: p.itemStyle,
        })),
        symbolSize: (v, p) => p.data.tx.size,
        itemStyle: { color: st.color, opacity: 0.8, borderColor: "#fff" },
        emphasis: { scale: 1.4 },
      };
    });
    return {
      backgroundColor: "transparent", textStyle: { fontFamily: FONT, color: C.ink },
      grid: { left: 8, right: 30, top: 40, bottom: 52, containLabel: true },
      legend: { top: 0, icon: "roundRect", itemWidth: 12, itemHeight: 12, textStyle: { fontSize: 12, color: C.muted } },
      tooltip: {
        trigger: "item", backgroundColor: "rgba(27,32,51,0.92)", textStyle: { color: "#F4F6FA", fontSize: 12 },
        extraCssText: "border-radius:10px;",
        formatter: (p) => {
          const t = p.data.tx;
          if (aggregated) return `<b>${t.yCat}</b> · ${t.date}<br>${t.count} 笔 · 合计 <b>${fmt.money(t.amount)}</b><br>最大单笔: ${fmt.money(t.maxAmount)}`;
          return `<b>${t.merchant || t.note || "(无商户)"}</b><br>${t.date} · ${t.category}${t.subcategory ? " / " + t.subcategory : ""}<br>` +
                 `${STAR_STYLE[t.type].label} <b>${fmt.money(t.amount)}</b>${t.large ? " ◆大额" : ""}${t.recurring ? " · 重复" : ""}` +
                 (t.note ? `<br>备注: ${t.note.slice(0, 40)}` : "");
        },
      },
      xAxis: { type: "time", ...axisCommon, axisLabel: { ...axisCommon.axisLabel, formatter: "{MM}-{dd}" } },
      yAxis: { type: "category", data: cats, ...axisCommon,
               splitLine: { show: true, lineStyle: { color: "rgba(232,235,242,0.8)" } },
               axisLabel: { ...axisCommon.axisLabel, fontSize: 11, fontWeight: 600, color: C.ink } },
      dataZoom: [
        { type: "inside", xAxisIndex: 0, filterMode: "none" },
        { type: "slider", xAxisIndex: 0, height: 20, bottom: 8, borderColor: "transparent",
          backgroundColor: "rgba(232,235,242,0.4)", fillerColor: "rgba(102,117,217,0.15)",
          handleStyle: { color: C.accent } },
      ],
      series,
    };
  }

  window.CHARTS = { incomeExpense, catBar, catDonut, trend, cumulative, calendar, star, STAR_STYLE, COLORS: C };
})();
