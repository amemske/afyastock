"""Unit tests for the validation pipeline's repair rules. Run from the repo root: pytest ml/tests"""
from datetime import date

import pandas as pd

from ml.afyastock_ml.pipeline import (balance_gap, clean_series, impute_month,
                                      looks_like_copy_error, repair_balance)

PERIODS = [date(2025, m, 1) for m in (1, 2, 3)]


def report(i, period, o, rec, u, l, c, exp=0, ingested="2025-04-01"):
    return {"id": i, "location_code": "L1", "item_code": "I1", "period": period,
            "opening_balance": o, "quantity_received": rec, "quantity_used": u,
            "losses": l, "closing_balance": c, "expiring_soon": exp,
            "ingested_at": pd.Timestamp(ingested), "payload": None}


def series(*rows):
    return pd.DataFrame(list(rows))


# ---- copy-error shapes

def test_detects_swapped_digits():
    assert looks_like_copy_error(152, 125)


def test_detects_extra_zero():
    assert looks_like_copy_error(1250, 125)


def test_detects_dropped_digit():
    assert looks_like_copy_error(15, 125)


def test_swap_that_creates_leading_zero():
    assert looks_like_copy_error(15, 105)   # 105 -> "015" -> 15


def test_unrelated_numbers_are_not_copy_errors():
    assert not looks_like_copy_error(300, 125)


# ---- balance repair

def test_repairs_wrong_used_figure():
    r = {"opening_balance": 50, "quantity_received": 100, "quantity_used": 1200,  # true 120, extra zero
         "losses": 0, "closing_balance": 30}
    fixed, f, ok = repair_balance(r, prev_closing=50, next_opening=30)
    assert ok and f == "quantity_used" and fixed["quantity_used"] == 120
    assert balance_gap(fixed) == 0


def test_repairs_closing_using_next_month():
    r = {"opening_balance": 50, "quantity_received": 100, "quantity_used": 120,
         "losses": 0, "closing_balance": 3}                                      # true 30, digit dropped
    fixed, f, ok = repair_balance(r, prev_closing=50, next_opening=30)
    assert ok and f == "closing_balance" and fixed["closing_balance"] == 30


def test_unresolvable_mismatch_is_rebuilt_and_flagged():
    r = {"opening_balance": 50, "quantity_received": 100, "quantity_used": 77,
         "losses": 0, "closing_balance": 999}
    fixed, f, ok = repair_balance(r, prev_closing=50, next_opening=30)
    assert not ok and f is None
    assert balance_gap(fixed) == 0 and fixed["quantity_used"] >= 0


# ---- whole-series behaviour

def test_missing_month_is_imputed_and_balances():
    raw = series(report(1, PERIODS[0], 100, 0, 40, 0, 60),
                 report(3, PERIODS[2], 50, 0, 30, 0, 20))
    res = clean_series(raw, PERIODS, "L1", "I1")
    feb = res.rows[1]
    assert feb.is_imputed and feb.raw_report_id is None
    assert feb.values["opening_balance"] == 60 and feb.values["closing_balance"] == 50
    assert balance_gap(feb.values) == 0
    assert [i.rule for i in res.issues] == ["missing_report"]


def test_all_zero_report_after_stock_is_treated_as_missing():
    raw = series(report(1, PERIODS[0], 100, 0, 40, 0, 60),
                 report(2, PERIODS[1], 0, 0, 0, 0, 0),
                 report(3, PERIODS[2], 30, 0, 10, 0, 20))
    res = clean_series(raw, PERIODS, "L1", "I1")
    assert res.rows[1].is_imputed
    assert any(i.rule == "all_zero_report" for i in res.issues)


def test_genuine_empty_shelf_is_not_flagged():
    raw = series(report(1, PERIODS[0], 10, 0, 10, 0, 0),
                 report(2, PERIODS[1], 0, 0, 0, 0, 0),
                 report(3, PERIODS[2], 0, 50, 20, 0, 30))
    res = clean_series(raw, PERIODS, "L1", "I1")
    assert not res.rows[1].is_imputed
    assert res.issues == []


def test_duplicate_keeps_latest():
    raw = series(report(1, PERIODS[0], 100, 0, 40, 0, 60),
                 report(2, PERIODS[0], 100, 0, 45, 0, 55, ingested="2025-04-02"),
                 report(3, PERIODS[1], 55, 0, 5, 0, 50),
                 report(4, PERIODS[2], 50, 0, 10, 0, 40))
    res = clean_series(raw, PERIODS, "L1", "I1")
    assert res.rows[0].raw_report_id == 2
    assert any(i.rule == "duplicate_report" for i in res.issues)


def test_imputation_never_negative():
    v = impute_month({"closing_balance": 10}, {"opening_balance": 0}, [50])
    assert min(v.values()) >= 0 and balance_gap(v) == 0
