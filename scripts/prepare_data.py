#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
prepare_data.py — MoneyThings CSV 导出 → 规范化交易 JSON

流程: 加载 → 校验字段 → 清洗异常 → 类型映射 → 衍生字段(商户/支付方式/重复性/大额/疑似重复) → 输出
输出:
  data/transactions.json      规范化交易 + 元信息 + 数据质量报告
  js/data.js                  同一份数据, 以 window.DATA 形式内嵌(离线可用)

类型映射规则(见 README):
  交易类型=收入/支出, 大类=转账            → transfer (不计入收支)
  交易类型=收入,     大类 in {购物退款,转账-退款} → refund (冲减支出)
  其余按交易类型                            → income / expense
金额一律存正数, 方向由 type 决定。
"""
import csv, json, re, sys, collections, datetime, hashlib, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "data", "moneythings_原始导出.csv")
OUT_JSON = os.path.join(ROOT, "data", "transactions.json")
OUT_JS = os.path.join(ROOT, "js", "data.js")

REFUND_CATS = {"购物退款", "转账-退款"}
TRANSFER_CATS = {"转账"}
RECUR_KEYWORDS = ["订阅", "icloud", "会员", "月保", "房租", "车贷", "续费"]
LARGE_EXPENSE_THRESHOLD = 3000  # 大额支出阈值(元), 单笔 >= 该值打标

PAY_RULES = [
    (["微信"], "微信支付"), (["支付宝"], "支付宝"), (["云闪付", "银联"], "云闪付/银联"),
    (["apple pay", "applepay"], "Apple Pay"), (["招商", "招行", "cmb"], "银行卡"),
    (["现金"], "现金"), (["扫二维码", "二维码"], "扫码支付"),
]

def parse_amount(s):
    """解析金额: 去千分位逗号/空白/货币符号。返回 (value|None, error|None)"""
    if s is None:
        return None, "金额缺失"
    t = str(s).replace(",", "").replace("¥", "").replace("￥", "").strip()
    if t == "":
        return None, "金额缺失"
    try:
        return float(t), None
    except ValueError:
        return None, f"金额格式错误: {s!r}"

def parse_datetime(s):
    """解析交易时间, 支持 YYYY-MM-DD HH:MM[:SS] / YYYY/M/D。返回 (iso|None, error|None)"""
    if not s or not str(s).strip():
        return None, "日期缺失"
    t = str(s).strip().replace("/", "-")
    m = re.match(r"^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$", t)
    if not m:
        return None, f"日期格式错误: {s!r} (期望 YYYY-MM-DD HH:MM:SS)"
    y, mo, d, h, mi, se = (int(x) if x else 0 for x in m.groups())
    try:
        dt = datetime.datetime(y, mo, d, h, mi, se)
    except ValueError as e:
        return None, f"日期无效: {s!r} ({e})"
    return dt.strftime("%Y-%m-%d %H:%M:%S"), None

def split_merchant_note(raw_note):
    """备注 → (merchant, note)。'商户，说明' 取首段为商户; 无分隔符则整段作为备注。"""
    n = (raw_note or "").strip()
    if not n:
        return "", ""
    for sep in ("，", ",", "；", ";"):
        if sep in n:
            head, tail = n.split(sep, 1)
            merchant = re.sub(r"[-—](消费|付款|收款|交易|订单).*$", "", head.strip())
            return merchant.strip(), tail.strip()
    return "", n

def guess_payment(cat, sub, note):
    text = f"{cat} {sub} {note}".lower()
    for keys, name in PAY_RULES:
        if any(k.lower() in text for k in keys):
            return name
    return "未记录"

def main():
    rows = list(csv.DictReader(open(RAW, encoding="utf-8-sig")))
    txs, issues = [], []
    seen = {}

    for i, r in enumerate(rows, start=1):
        tid = f"T{i:05d}"
        rec_issues = []

        dt, err = parse_datetime(r.get("交易时间"))
        if err:
            rec_issues.append({"field": "date", "error": err})
        amount, err = parse_amount(r.get("交易金额"))
        if err:
            rec_issues.append({"field": "amount", "error": err})

        raw_type = (r.get("交易类型") or "").strip()
        cat = (r.get("大类") or "").strip()
        sub = " / ".join(x for x in [(r.get("中类") or "").strip(), (r.get("小类") or "").strip()] if x)
        note_raw = r.get("备注") or ""
        merchant, note = split_merchant_note(note_raw)

        if not cat:
            cat = "未分类"
            rec_issues.append({"field": "category", "error": "分类为空, 已归入「未分类」"})

        # 类型映射
        if cat in TRANSFER_CATS:
            ttype = "transfer"
        elif raw_type == "收入" and cat in REFUND_CATS:
            ttype = "refund"
        elif raw_type == "收入":
            ttype = "income"
        elif raw_type == "支出":
            ttype = "expense"
        else:
            ttype = "expense"
            rec_issues.append({"field": "type", "error": f"未知交易类型: {raw_type!r}, 已按支出处理"})

        # 金额符号合法性: 原始数据中支出应为负、收入应为正
        raw_amt, _ = parse_amount(r.get("交易金额"))
        if raw_amt is not None:
            if raw_type == "支出" and raw_amt > 0 and ttype == "expense":
                rec_issues.append({"field": "amount", "error": "支出金额为正数, 已按绝对值处理"})
            if raw_type == "收入" and raw_amt < 0:
                rec_issues.append({"field": "amount", "error": "收入金额为负数, 已按绝对值处理"})

        account = (r.get("转出账户") or r.get("转入账户") or "").strip() or "未记录"
        pay = guess_payment(cat, sub, note_raw)
        currency = (r.get("交易货币") or "CNY").strip() or "CNY"
        if currency != "CNY":
            rec_issues.append({"field": "currency", "error": f"非人民币交易: {currency}, 未做汇率换算"})

        tx = {
            "id": tid, "date": dt or "", "type": ttype,
            "amount": round(abs(amount), 2) if amount is not None else None,
            "category": cat, "subcategory": sub, "merchant": merchant,
            "account": account, "payment_method": pay,
            "note": note, "tags": [t for t in re.split(r"[,，\s]+", (r.get("标签") or "").strip()) if t],
            "recurring": False, "currency": currency,
            "large": False, "possible_duplicate": False,
            "source_row": i,
        }
        if rec_issues:
            for it in rec_issues:
                it.update({"id": tid, "row": i, "raw": {k: r.get(k, "") for k in ("交易类型", "大类", "交易金额", "交易时间", "备注")}})
            issues.extend(rec_issues)
            tx["has_issue"] = True
        txs.append(tx)
        if dt and amount is not None:
            key = (dt[:10], round(abs(amount), 2), merchant or note[:12], cat)
            seen.setdefault(key, []).append(tid)

    # 疑似重复(仅标记, 不删除)
    dup_groups = [ids for ids in seen.values() if len(ids) > 1]
    dup_ids = {x for g in dup_groups for x in g}
    for tx in txs:
        if tx["id"] in dup_ids:
            tx["possible_duplicate"] = True

    # 重复性支出: 同(大类+中类+商户/备注键+整数金额) 出现在 >=3 个不同月份, 或命中订阅关键词
    groups = collections.defaultdict(set)
    for tx in txs:
        if tx["type"] != "expense" or tx["amount"] is None or not tx["date"]:
            continue
        key = (tx["category"], tx["subcategory"], tx["merchant"] or tx["note"][:10], round(tx["amount"]))
        groups[key].add((tx["date"][:7], tx["id"]))
    recur_ids = set()
    for (cat, sub, mkey, amt), hits in groups.items():
        months = {h[0] for h in hits}
        text = f"{cat} {sub} {mkey}".lower()
        kw_hit = any(k in text for k in RECUR_KEYWORDS)
        # 订阅关键词且跨 >=2 个月; 或同口径消费跨 >=4 个月(习惯性重复)
        if (kw_hit and len(months) >= 2) or len(months) >= 4:
            recur_ids.update(h[1] for h in hits)
    for tx in txs:
        if tx["id"] in recur_ids:
            tx["recurring"] = True
        if tx["type"] == "expense" and tx["amount"] is not None and tx["amount"] >= LARGE_EXPENSE_THRESHOLD:
            tx["large"] = True

    valid = [t for t in txs if t["amount"] is not None and t["date"]]
    months = sorted({t["date"][:7] for t in valid})
    n_large = sum(1 for t in txs if t["large"])
    n_rec = sum(1 for t in txs if t["recurring"])
    n_ref = sum(1 for t in txs if t["type"] == "refund")
    n_tr = sum(1 for t in txs if t["type"] == "transfer")

    quality = {
        "total_rows": len(rows),
        "valid": len(valid),
        "issues": issues,
        "issue_count": len(issues),
        "possible_duplicate_groups": len(dup_groups),
        "possible_duplicate_rows": len(dup_ids),
        "recurring_rows": n_rec,
        "large_expense_rows": n_large,
        "refund_rows": n_ref,
        "transfer_rows": n_tr,
        "type_counts": dict(collections.Counter(t["type"] for t in txs)),
        "date_range": [min(t["date"] for t in valid), max(t["date"] for t in valid)],
        "months": months,
    }
    meta = {
        "source_file": os.path.basename(RAW),
        "generated_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "timezone": "Asia/Shanghai",
        "currency": "CNY",
        "large_expense_threshold": LARGE_EXPENSE_THRESHOLD,
        "type_mapping": {
            "transfer": "大类=转账 → 不计入收入/支出",
            "refund": "收入 & 大类∈{购物退款,转账-退款} → 冲减支出",
            "income/expense": "其余按原始交易类型",
        },
    }
    payload = {"meta": meta, "quality": quality, "transactions": txs}

    with open(OUT_JSON, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
    with open(OUT_JS, "w", encoding="utf-8") as f:
        f.write("// 由 scripts/prepare_data.py 自动生成, 请勿手改。重新生成: python3 scripts/prepare_data.py\n")
        f.write("window.DATA = ")
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")

    print(f"行数: {len(rows)}  有效: {len(valid)}  问题: {len(issues)}")
    print(f"类型: {quality['type_counts']}")
    print(f"范围: {quality['date_range'][0]} → {quality['date_range'][1]}  ({len(months)} 个月)")
    print(f"大额支出: {n_large}  重复性: {n_rec}  退款: {n_ref}  转账: {n_tr}  疑似重复: {len(dup_ids)} 行/{len(dup_groups)} 组")
    if issues:
        for it in issues[:10]:
            print("  ISSUE", it["id"], it["field"], it["error"])

if __name__ == "__main__":
    main()
