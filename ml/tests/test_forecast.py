"""Tests for the forecasting module's data handling. Run from the repo root: pytest"""
from datetime import date

import numpy as np
import pandas as pd

from ml.afyastock_ml.forecast import (FEATURES, RISK_FEATURES, build_panel, features_at,
                                      risk_features_at, stockout_label, training_set)

MONTHS = [date(2024 + (m // 12), m % 12 + 1, 1) for m in range(8)]


def tiny_panel(used, closing, imputed=None):
    rows = []
    for t, p in enumerate(MONTHS):
        rows.append({"location_id": 1, "item_id": 1, "period": p, "quantity_used": used[t],
                     "closing_balance": closing[t], "quantity_received": 10, "expiring_soon": 0,
                     "is_imputed": bool(imputed[t]) if imputed else False})
    stock = pd.DataFrame(rows)
    locs = pd.DataFrame({"location_id": [1], "location_type_str": ["dispensary"], "rural": [True],
                         "location_type_code": [0]})
    items = pd.DataFrame({"item_id": [1], "item_code_str": ["AL6"], "unit": ["pack"], "seasonality_str": ["malaria"],
                          "item_code": [0], "seasonality_code": [0]})
    return build_panel(stock, locs, items)


def test_empty_shelf_marks_month_as_censored():
    p = tiny_panel([5] * 8, [3, 0, 2, 2, 0, 1, 1, 1])
    assert p.censored[0].tolist() == [False, True, False, False, True, False, False, False]


def test_censored_and_imputed_months_are_never_training_targets():
    used = [10, 11, 3, 12, 13, 14, 15, 16]          # month 2 is a stockout: use 3 is not demand
    p = tiny_panel(used, [5, 5, 0, 5, 5, 5, 5, 5], imputed=[0, 0, 0, 0, 1, 0, 0, 0])
    X, y = training_set(p, last_known=7)
    targets = set(np.round(np.expm1(y)).astype(int))
    assert 3 not in targets and 13 not in targets   # censored month 2, imputed month 4
    assert list(X.columns) == FEATURES


def test_features_only_use_the_past():
    used = [10, 20, 30, 40, 50, 60, 70, 80]
    p = tiny_panel(used, [5] * 8)
    f = features_at(p, t=4, h=1)
    assert np.isclose(np.expm1(f["use_0"].iloc[0]), 50)     # month 4 is the latest known
    future = np.log1p([60, 70, 80])
    assert not np.isin(f.drop(columns=["h"]).to_numpy(), future).any()


def test_risk_features_and_labels():
    p = tiny_panel([5] * 8, [3, 3, 3, 0, 3, 3, 0, 3])
    assert list(risk_features_at(p, 2).columns) == RISK_FEATURES
    y1, _ = stockout_label(p, 2, 1)
    y2, _ = stockout_label(p, 4, 2)
    assert y1[0] and y2[0]                      # empty at end of month 3; and of month 6
    y_none, _ = stockout_label(p, 0, 1)
    assert not y_none[0]
