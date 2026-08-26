# monely. · 个人收支分析(现代风演示版)

与 `finance-dashboard`(包豪斯版)**同一产品框架**的另一种 UI 画风实现:浅灰底、白色圆角卡片、珊瑚红点缀的现代轻量 SaaS 风格。

- 功能完全一致: 财务总览 / 分类分析(含子品类下钻) / 时间趋势 / 星辰分布图 / 交易明细(可编辑) / 数据质量 / 筛选联动 / 导入导出
- 数据完全不同: **虚构示例数据**, 由 `scripts/generate_sample.py` 确定性生成(seed 固定, 可复现)

线上版本: https://monely-cyan.vercel.app
代码仓库(私有): https://github.com/eunye0ngpark/monely
已打通自动部署: push 到 main → Vercel 自动重新发布。

## 运行

```bash
cd cashflow-dashboard
python3 -m http.server 8792
# 打开 http://127.0.0.1:8792/index.html
```

## 示例数据说明(虚构, 非真实账目)

- 规模: 4,114 笔, 2025-01-01 ~ 2026-08-25(20 个月), 与真实数据集同量级
- 人设: 上海互联网从业, 养猫, 有私家车, 月薪 15,800, 房租 8,500
- 15 个支出大类、54 组最细子类、214 个可解析商户; 每个大类含 4–7 个子类, 支持下钻
- 含季节性峰值(618 / 双11 / 节假日旅行)、月度重复项(房租/话费/订阅/定投)、
  退款 37 笔、转账 103 笔、大额支出 23 笔、标签若干
- 重新生成: `python3 scripts/generate_sample.py && python3 scripts/prepare_data.py data/moneythings_示例数据.csv`

## 验证

```bash
python3 scripts/verify.py data/moneythings_示例数据.csv   # 独立重算核对
node scripts/e2e_check.mjs                                 # 34 项交互测试(需先启动本地服务)
```

## 与包豪斯版的差异

| | finance-dashboard | cashflow-dashboard |
|---|---|---|
| 视觉 | 包豪斯(黑边框/红黄蓝/几何) | 现代 SaaS(圆角卡片/柔和投影/靛蓝+玫瑰) |
| 数据 | 真实 MoneyThings 导出 | 虚构生成(人设一致但不可对账) |
| 代码 | 同一套 `aggregate.js` / `app.js` / 图表构建器 | 仅 `style.css`、`charts.js` 配色、品牌不同 |
