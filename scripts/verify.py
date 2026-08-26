#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
verify.py — 独立从原始 CSV 重算关键指标, 与 data/transactions.json 及前端聚合逻辑核对。
用法: python3 scripts/verify.py
退出码 0 = 全部通过; 1 = 存在不一致。
"""
import csv, json, os, subprocess, sys, collections

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "data", "moneythings_示例数据.csv")
JSON_PATH = os.path.join(ROOT, "data", "transactions.json")
NODE_CHECK = os.path.join(ROOT, "scripts", "verify_node.js")

REFUND_CATS = {"购物退款", "转账-退款"}
TRANSFER_CATS = {"转账"}

def amt(s):
    return float(str(s).replace(",", "").strip())

def recompute_from_csv():
    """完全独立的重算(不复用 prepare_data 的代码路径)"""
    rows = list(csv.DictReader(open(RAW, encoding="utf-8-sig")))
    income = expense = refund = transfer = 0.0
    n = {"income": 0, "expense": 0, "refund": 0, "transfer": 0}
    monthly = collections.defaultdict(lambda: {"income": 0.0, "expense": 0.0, "refund": 0.0})
    cat_expense = collections.defaultdict(float)
    for r in rows:
        a = amt(r["交易金额"])
        cat = (r["大类"] or "").strip() or "未分类"
        month = r["交易时间"][:7]
        if cat in TRANSFER_CATS:
            transfer += abs(a); n["transfer"] += 1
        elif r["交易类型"] == "收入" and cat in REFUND_CATS:
            refund += abs(a); n["refund"] += 1; monthly[month]["refund"] += abs(a)
        elif r["交易类型"] == "收入":
            income += abs(a); n["income"] += 1; monthly[month]["income"] += abs(a)
        else:
            expense += abs(a); n["expense"] += 1
            monthly[month]["expense"] += abs(a); cat_expense[cat] += abs(a)
    return {"income": round(income, 2), "expense": round(expense, 2),
            "refund": round(refund, 2), "transfer": round(transfer, 2),
            "net_expense": round(expense - refund, 2),
            "net_cashflow": round(income - (expense - refund), 2),
            "counts": n, "rows": len(rows), "monthly": dict(monthly),
            "cat_expense": dict(cat_expense)}

def from_json():
    d = json.load(open(JSON_PATH))
    txs = d["transactions"]
    s = {"income": 0.0, "expense": 0.0, "refund": 0.0, "transfer": 0.0}
    n = collections.Counter()
    monthly = collections.defaultdict(lambda: {"income": 0.0, "expense": 0.0, "refund": 0.0})
    cat_expense = collections.defaultdict(float)
    for t in txs:
        s[t["type"]] += t["amount"]; n[t["type"]] += 1
        m = t["date"][:7]
        if t["type"] in ("income", "expense", "refund"):
            monthly[m][t["type"]] += t["amount"]
        if t["type"] == "expense":
            cat_expense[t["category"]] += t["amount"]
    return {"income": round(s["income"], 2), "expense": round(s["expense"], 2),
            "refund": round(s["refund"], 2), "transfer": round(s["transfer"], 2),
            "net_expense": round(s["expense"] - s["refund"], 2),
            "net_cashflow": round(s["income"] - (s["expense"] - s["refund"]), 2),
            "counts": dict(n), "rows": len(txs), "monthly": dict(monthly),
            "cat_expense": dict(cat_expense)}

def close(a, b, tol=0.02):
    return abs(a - b) <= tol

def main():
    csv_s = recompute_from_csv()
    js_s = from_json()
    fails = []

    print("=" * 64)
    print("核对 1: CSV 独立重算  vs  transactions.json")
    print("=" * 64)
    for k in ("rows", "income", "expense", "refund", "transfer", "net_expense", "net_cashflow"):
        a, b = csv_s[k], js_s[k]
        ok = (a == b) if k == "rows" else close(a, b)
        print(f"  {'PASS' if ok else 'FAIL'}  {k:14s} CSV={a:>14}  JSON={b:>14}")
        if not ok:
            fails.append(k)
    for t in ("income", "expense", "refund", "transfer"):
        a, b = csv_s["counts"].get(t, 0), js_s["counts"].get(t, 0)
        ok = a == b
        print(f"  {'PASS' if ok else 'FAIL'}  count.{t:9s} CSV={a:>6}  JSON={b:>6}")
        if not ok:
            fails.append(f"count.{t}")

    print("\n核对 2: 逐月聚合 (收入/支出/退款)")
    months = sorted(set(csv_s["monthly"]) | set(js_s["monthly"]))
    bad_m = 0
    for m in months:
        for k in ("income", "expense", "refund"):
            a = csv_s["monthly"].get(m, {}).get(k, 0.0)
            b = js_s["monthly"].get(m, {}).get(k, 0.0)
            if not close(a, b):
                print(f"  FAIL  {m} {k}: CSV={a} JSON={b}"); bad_m += 1
    print(f"  {'PASS' if bad_m == 0 else 'FAIL'}  {len(months)} 个月 × 3 指标, 不一致 {bad_m} 处")
    if bad_m:
        fails.append("monthly")

    print("\n核对 3: 分类占比之和 ≈ 100% (分母 = 总支出, 退款不摊入分类)")
    pcts = {c: round(v / js_s["expense"] * 100, 2) for c, v in js_s["cat_expense"].items()}
    total_pct = round(sum(pcts.values()), 2)
    ok = abs(total_pct - 100.0) < 0.5
    print(f"  {'PASS' if ok else 'FAIL'}  分类占比合计 = {total_pct}% (含两位小数四舍五入误差)")
    if not ok:
        fails.append("pct_sum")

    print("\n核对 4: 前端聚合逻辑 (node scripts/verify_node.js, 复用 js/aggregate.js)")
    try:
        out = subprocess.run(["node", NODE_CHECK], capture_output=True, text=True, timeout=60)
        print("  " + out.stdout.strip().replace("\n", "\n  "))
        if out.returncode != 0:
            fails.append("node")
            if out.stderr:
                print("  STDERR:", out.stderr[:500])
    except FileNotFoundError:
        print("  SKIP  未找到 node, 跳过前端逻辑核对")

    print("\n" + "=" * 64)
    if fails:
        print("结果: FAIL →", ", ".join(fails)); sys.exit(1)
    print("结果: 全部 PASS")

if __name__ == "__main__":
    main()
