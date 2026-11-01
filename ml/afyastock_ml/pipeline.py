"""
AfyaStock validation pipeline: raw_reports -> stock_reports + data_issues.

Every raw report is checked, repaired where the evidence is clear, and written to
stock_reports with a link back to the raw report it came from (provenance).
Every problem found is written to data_issues together with what was done about it.
Nothing is silently changed.

Rules, applied to each location x item series in date order:
  1. duplicate_report   Two reports for the same month: keep the latest, log the other.
  2. negative_value     A negative figure is impossible: treat the report as missing.
  3. all_zero_report    Every figure is zero although the facility had stock before or
                        after: almost certainly a blank form, so treat it as missing.
  4. balance_mismatch   opening + received - used - losses != closing.
                        Find the one wrong figure using two kinds of evidence:
                          - continuity: opening must equal last month's closing,
                            closing must equal next month's opening;
                          - copy-error shape: the reported number looks like the correct
                            one with two digits swapped, a digit dropped or a zero added.
                        If exactly one figure fits, fix it. Otherwise rebuild the month from
                        its neighbours and flag it as unresolved.
  5. missing_report     A month with no usable report: impute it from neighbouring months
                        so the series has no gaps, and mark it is_imputed.

Usage (from the repo root, with the venv active):
  python -m ml.afyastock_ml.pipeline
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

import pandas as pd

REPO_ROOT = Path(__file__).resolve().parents[2]
FIELDS = ["opening_balance", "quantity_received", "quantity_used", "losses", "closing_balance"]


# ---------------------------------------------------------------- arithmetic

def balance_gap(r: dict) -> float:
    return (r["opening_balance"] + r["quantity_received"] - r["quantity_used"]
            - r["losses"] - r["closing_balance"])


def implied_value(r: dict, f: str) -> float:
    """The value field f would need for the balance to hold, given the other four."""
    o, rec, u, l, c = (r[k] for k in FIELDS)
    return {
        "opening_balance": c - rec + u + l,
        "quantity_received": c - o + u + l,
        "quantity_used": o + rec - l - c,
        "losses": o + rec - u - c,
        "closing_balance": o + rec - u - l,
    }[f]


def looks_like_copy_error(reported: float, correct: float) -> bool:
    """True if `reported` could be `correct` miscopied: adjacent digits swapped,
    one digit dropped, or a zero added at the end."""
    if correct < 0 or reported == correct:
        return False
    s, o = str(int(correct)), str(int(reported))
    if o == s + "0":
        return True
    if len(o) == len(s) - 1 and any(s[:i] + s[i + 1:] == o for i in range(len(s))):
        return True
    o_padded = o.zfill(len(s))           # a swap can create a leading zero
    if len(o_padded) == len(s):
        for i in range(len(s) - 1):
            if s[:i] + s[i + 1] + s[i] + s[i + 2:] == o_padded:
                return True
    return False


# ---------------------------------------------------------------- data structures

@dataclass
class Issue:
    raw_report_id: int | None
    location_code: str
    item_code: str
    period: date
    rule: str
    severity: str
    message: str
    action_taken: str


@dataclass
class CleanRow:
    location_code: str
    item_code: str
    period: date
    values: dict
    expiring_soon: float
    is_imputed: bool
    raw_report_id: int | None


@dataclass
class Result:
    rows: list[CleanRow] = field(default_factory=list)
    issues: list[Issue] = field(default_factory=list)


# ---------------------------------------------------------------- repair logic

def repair_balance(r: dict, prev_closing: float | None, next_opening: float | None):
    """Return (fixed_values, field_fixed_or_None, resolved: bool)."""
    candidates = []
    for f in FIELDS:
        target = implied_value(r, f)
        if target < 0:
            continue
        continuity = ((f == "opening_balance" and prev_closing is not None and target == prev_closing) or
                      (f == "closing_balance" and next_opening is not None and target == next_opening))
        shape = looks_like_copy_error(r[f], target)
        if continuity or shape:
            candidates.append((f, target, continuity, shape))

    strong = [c for c in candidates if c[2] and c[3]]     # both kinds of evidence agree
    pick = strong if len(strong) == 1 else None
    if pick is None:
        cont = [c for c in candidates if c[2]]
        shape_only = [c for c in candidates if c[3]]
        if len(cont) == 1:
            pick = cont
        elif len(shape_only) == 1:
            pick = shape_only
    if pick:
        f, target, _, _ = pick[0]
        fixed = dict(r)
        fixed[f] = target
        return fixed, f, True

    # Unresolved: trust continuity for the balances, recompute use from them.
    fixed = dict(r)
    if prev_closing is not None:
        fixed["opening_balance"] = prev_closing
    if next_opening is not None:
        fixed["closing_balance"] = next_opening
    used = implied_value(fixed, "quantity_used")
    if used < 0:
        fixed["quantity_received"] -= used        # cannot have negative use; assume more arrived
        used = 0
    fixed["quantity_used"] = used
    return fixed, None, False


def impute_month(prev: dict | None, nxt: dict | None, neighbour_use: list[float]) -> dict:
    """Fill a missing month so the stock arithmetic still holds."""
    use_est = round(sum(neighbour_use) / len(neighbour_use)) if neighbour_use else 0
    opening = prev["closing_balance"] if prev else None
    closing = nxt["opening_balance"] if nxt else None
    if opening is None and closing is None:
        opening = closing = 0
    if opening is None:                              # first month missing
        opening = closing + use_est
    if closing is None:                              # last month missing
        closing = max(opening - use_est, 0)
        use_est = opening - closing
    received = closing - opening + use_est
    if received < 0:                                 # stock fell more than typical use
        use_est, received = opening - closing, 0
    return {"opening_balance": opening, "quantity_received": received,
            "quantity_used": use_est, "losses": 0, "closing_balance": closing}


def clean_series(raw: pd.DataFrame, periods: list[date], loc: str, item: str) -> Result:
    """Validate and repair one location x item series. `raw` holds only that series."""
    res = Result()

    def log(rid, period, rule, sev, msg, action):
        res.issues.append(Issue(rid, loc, item, period, rule, sev, msg, action))

    # 1. duplicates: keep the most recently ingested report for each month
    raw = raw.sort_values(["period", "ingested_at", "id"])
    dupes = raw[raw.duplicated("period", keep="last")]
    for d in dupes.itertuples():
        log(d.id, d.period, "duplicate_report", "info",
            "More than one report for this month.", "Kept the latest submission.")
    raw = raw.drop_duplicates("period", keep="last")
    by_period = {r["period"]: r for r in raw.to_dict("records")}

    def raw_closing(p_idx):
        if p_idx < 0:
            return None
        r = by_period.get(periods[p_idx])
        return None if r is None else r["closing_balance"]

    def raw_opening(p_idx):
        if p_idx >= len(periods):
            return None
        r = by_period.get(periods[p_idx])
        return None if r is None else r["opening_balance"]

    # 2-3. decide which reports are unusable (treated as missing)
    usable: dict[date, dict] = {}
    for i, p in enumerate(periods):
        r = by_period.get(p)
        if r is None:
            continue
        vals = {f: float(r[f]) if pd.notna(r[f]) else None for f in FIELDS}
        if any(v is None for v in vals.values()):
            log(r["id"], p, "incomplete_report", "error", "One or more figures are blank.",
                "Treated as missing and imputed.")
            continue
        if any(v < 0 for v in vals.values()):
            log(r["id"], p, "negative_value", "error", "A figure is negative.",
                "Treated as missing and imputed.")
            continue
        if all(v == 0 for v in vals.values()):
            neighbour_stock = (raw_closing(i - 1) or 0) + (raw_opening(i + 1) or 0)
            if neighbour_stock > 0:
                log(r["id"], p, "all_zero_report", "warning",
                    "All figures are zero, but the facility held stock in a neighbouring month.",
                    "Treated as a blank form; imputed.")
                continue
        usable[p] = {**vals, "id": int(r["id"]), "expiring_soon": float(r["expiring_soon"] or 0)}

    # 4. balance check and repair, using continuity with usable neighbours
    for i, p in enumerate(periods):
        r = usable.get(p)
        if r is None or balance_gap(r) == 0:
            continue
        prev_c = usable[periods[i - 1]]["closing_balance"] if i > 0 and periods[i - 1] in usable else None
        next_o = usable[periods[i + 1]]["opening_balance"] if i + 1 < len(periods) and periods[i + 1] in usable else None
        gap = balance_gap(r)
        fixed, f, ok = repair_balance(r, prev_c, next_o)
        if ok:
            log(r["id"], p, "balance_mismatch", "warning",
                f"Stock does not add up (off by {gap:g}).",
                f"Corrected {f} from {r[f]:g} to {fixed[f]:g}.")
        else:
            log(r["id"], p, "balance_mismatch", "error",
                f"Stock does not add up (off by {gap:g}) and the wrong figure could not be identified.",
                "Rebuilt from neighbouring months; needs review.")
        usable[p] = {**r, **{k: fixed[k] for k in FIELDS}}

    # 5. write every month, imputing gaps
    for i, p in enumerate(periods):
        r = usable.get(p)
        if r is not None:
            res.rows.append(CleanRow(loc, item, p, {f: r[f] for f in FIELDS},
                                     r["expiring_soon"], False, r["id"]))
            continue
        prev = res.rows[-1].values if res.rows else None
        nxt = next((usable[q] for q in periods[i + 1:] if q in usable), None)
        nxt_adjacent = nxt if (i + 1 < len(periods) and periods[i + 1] in usable) else None
        neighbour_use = [x["quantity_used"] for x in (prev, nxt) if x is not None]
        vals = impute_month(prev, nxt_adjacent, neighbour_use)
        if p not in by_period:
            log(None, p, "missing_report", "warning", "No report was submitted for this month.",
                "Imputed from neighbouring months.")
        res.rows.append(CleanRow(loc, item, p, vals, 0, True, None))
    return res


def run_pipeline(raw: pd.DataFrame, periods: list[date]) -> Result:
    out = Result()
    for (loc, item), g in raw.groupby(["location_code", "item_code"], sort=True):
        r = clean_series(g, periods, loc, item)
        out.rows += r.rows
        out.issues += r.issues
    return out


def all_periods(raw: pd.DataFrame) -> list[date]:
    start, end = raw["period"].min(), raw["period"].max()
    out, d = [], start
    while d <= end:
        out.append(d)
        d = date(d.year + (d.month == 12), d.month % 12 + 1, 1)
    return out


# ---------------------------------------------------------------- evaluation (synthetic data only)

def evaluate(raw: pd.DataFrame, result: Result) -> dict:
    """Compare what the pipeline did with the errors the generator injected."""
    truth = {int(r.id): (r.payload or {}).get("truth", {}) for r in raw.itertuples()}
    if not any(truth.values()):
        return {}
    flagged = {}
    for i in result.issues:
        if i.raw_report_id is not None:
            flagged.setdefault(i.raw_report_id, []).append(i)
    clean_by_raw = {r.raw_report_id: r for r in result.rows if r.raw_report_id is not None}

    copy_total = copy_detected = copy_fixed = zero_total = zero_detected = false_alarms = 0
    for rid, t in truth.items():
        errs = t.get("injected_errors", [])
        hits = flagged.get(rid, [])
        if not errs and any(h.severity != "info" for h in hits):
            false_alarms += 1
        for e in errs:
            if e.startswith("copy_error"):
                copy_total += 1
                _, f, change = e.split(":")
                before = float(change.split("->")[0])
                if any(h.rule == "balance_mismatch" for h in hits):
                    copy_detected += 1
                    row = clean_by_raw.get(rid)
                    if row is not None and row.values[f] == before:
                        copy_fixed += 1
            elif e == "all_zero":
                zero_total += 1
                if any(h.rule == "all_zero_report" for h in hits):
                    zero_detected += 1
    pct = lambda a, b: round(a / b, 3) if b else None
    return {
        "copy_errors_injected": copy_total,
        "copy_errors_detected": pct(copy_detected, copy_total),
        "copy_errors_restored_exactly": pct(copy_fixed, copy_total),
        "all_zero_injected": zero_total,
        "all_zero_detected": pct(zero_detected, zero_total),
        "clean_reports_wrongly_flagged": false_alarms,
    }


# ---------------------------------------------------------------- database I/O

def load_raw(conn) -> pd.DataFrame:
    cols = ["id", "location_code", "item_code", "period", *FIELDS, "expiring_soon", "payload", "ingested_at"]
    with conn.cursor() as cur:
        cur.execute(f"SELECT {', '.join(cols)} FROM raw_reports")
        df = pd.DataFrame(cur.fetchall(), columns=cols)
    for f in FIELDS + ["expiring_soon"]:
        df[f] = pd.to_numeric(df[f])
    return df


def save(conn, result: Result, metrics: dict) -> None:
    with conn.cursor() as cur:
        cur.execute("SELECT code, id FROM locations")
        loc_ids = dict(cur.fetchall())
        cur.execute("SELECT code, id FROM items")
        item_ids = dict(cur.fetchall())

        unknown = {(r.location_code, r.item_code) for r in result.rows
                   if r.location_code not in loc_ids or r.item_code not in item_ids}
        if unknown:
            raise SystemExit(f"Reports reference unknown locations/items, e.g. {sorted(unknown)[:3]}")

        cur.execute("TRUNCATE stock_reports, data_issues RESTART IDENTITY")
        with cur.copy("""COPY stock_reports (location_id, item_id, period, opening_balance, quantity_received,
                         quantity_used, losses, closing_balance, expiring_soon, is_imputed, raw_report_id)
                         FROM STDIN""") as copy:
            for r in result.rows:
                v = r.values
                copy.write_row((loc_ids[r.location_code], item_ids[r.item_code], r.period,
                                v["opening_balance"], v["quantity_received"], v["quantity_used"],
                                v["losses"], v["closing_balance"], r.expiring_soon, r.is_imputed,
                                r.raw_report_id))
        with cur.copy("""COPY data_issues (raw_report_id, location_code, item_code, period, rule,
                         severity, message, action_taken) FROM STDIN""") as copy:
            for i in result.issues:
                copy.write_row((i.raw_report_id, i.location_code, i.item_code, i.period, i.rule,
                                i.severity, i.message, i.action_taken))
        cur.execute("INSERT INTO model_runs (job, model, version, metrics, data_until) VALUES (%s,%s,%s,%s,%s)",
                    ("pipeline", "rules", "1", json.dumps(metrics),
                     max(r.period for r in result.rows)))


def main() -> None:
    import psycopg
    from dotenv import load_dotenv

    load_dotenv(REPO_ROOT / ".env")
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise SystemExit("DATABASE_URL is not set. Add it to .env.")

    with psycopg.connect(url) as conn:
        raw = load_raw(conn)
        if raw.empty:
            raise SystemExit("raw_reports is empty. Run the generator first.")
        periods = all_periods(raw)
        result = run_pipeline(raw, periods)
        counts = pd.Series([i.rule for i in result.issues]).value_counts().to_dict()
        metrics = {"raw_reports": len(raw), "clean_rows": len(result.rows),
                   "imputed_rows": sum(r.is_imputed for r in result.rows),
                   "issues": counts, "evaluation": evaluate(raw, result)}
        save(conn, result, metrics)

    print(f"Raw reports read:   {metrics['raw_reports']:,}")
    print(f"Clean rows written: {metrics['clean_rows']:,} ({metrics['imputed_rows']:,} imputed)")
    print("Issues logged:")
    for rule, n in counts.items():
        print(f"  {rule:<18} {n:,}")
    if metrics["evaluation"]:
        e = metrics["evaluation"]
        print("Check against the generator's hidden truth:")
        print(f"  Copy errors detected:          {e['copy_errors_detected']:.1%} of {e['copy_errors_injected']}")
        print(f"  Copy errors restored exactly:  {e['copy_errors_restored_exactly']:.1%}")
        print(f"  All-zero reports detected:     {e['all_zero_detected']:.1%} of {e['all_zero_injected']}")
        print(f"  Clean reports wrongly flagged: {e['clean_reports_wrongly_flagged']}")


if __name__ == "__main__":
    main()
