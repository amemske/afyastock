"""
AfyaStock forecasting: stock_reports -> forecasts + alerts, with a backtest.

The core difficulty: recorded use is not demand. When a facility runs out, it can
only record what it had, so the data understates what patients needed. The usual
reorder rule (average of the last 3 months' use) then orders too little, which
causes the next stockout.

Approach
  - Censoring: a month that ends with an empty shelf is "censored": its recorded use is
    a lower bound, not real demand. Censored and imputed months are never used as
    training targets; the model learns demand from months where the shelf had stock,
    and is told about recent stockouts through its features.
  - Model: gradient-boosted trees (scikit-learn HistGradientBoosting, the same
    histogram algorithm as LightGBM), one model for 1- and 2-month-ahead forecasts,
    trained on log(1 + use) so tablets and inhalers can share one model.
  - Baselines it must beat: last month's use, and the 3-month average (AMC) that
    max-min resupply systems use.
  - Backtest: rolling origin. For each month from month 18 on, train only on what was
    known then, forecast the next 1-2 months, and compare with the generator's hidden
    true demand (synthetic data only).
  - Alerts: stockout risk within 30/60 days from the forecast and its uncertainty;
    expiry risk where stock expiring soon exceeds likely use. Every alert carries
    plain-language reasons built from SHAP values and the stock position.

Usage (from the repo root, with the venv active):
  python -m ml.afyastock_ml.forecast
"""

from __future__ import annotations

import json
import math
import os
from dataclasses import dataclass
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
from sklearn.metrics import average_precision_score

REPO_ROOT = Path(__file__).resolve().parents[2]
MODEL_PARAMS = dict(max_iter=300, learning_rate=0.05, max_leaf_nodes=31,
                    min_samples_leaf=40, l2_regularization=1.0, random_state=0)
CLASSIFIER_PARAMS = dict(max_iter=200, learning_rate=0.05, max_leaf_nodes=31,
                         min_samples_leaf=60, l2_regularization=1.0, random_state=0)
ALERT_THRESHOLD = 0.25      # 30-day: chosen on the backtest to match the standard rule's recall with fewer alerts
ALERT_THRESHOLD_60 = 0.5    # 60-day: stockouts over two months are common, so only flag likely ones
FIRST_ORIGIN = 17          # first backtest origin (month index); needs a year+ of history
HORIZONS = (1, 2)
Z80 = 1.2816               # 80% interval
MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


# ---------------------------------------------------------------- data as arrays

@dataclass
class Panel:
    """Every series as a row, every month as a column."""
    keys: pd.DataFrame          # one row per series: location/item ids, codes and static attributes
    periods: list[date]
    used: np.ndarray            # recorded use
    closing: np.ndarray
    received: np.ndarray
    expiring: np.ndarray
    imputed: np.ndarray         # bool
    censored: np.ndarray        # bool: shelf empty at month end, so use understates demand
    truth: np.ndarray | None    # true demand (synthetic data only), NaN where unknown

    @property
    def n_months(self) -> int:
        return len(self.periods)


def build_panel(stock: pd.DataFrame, locations: pd.DataFrame, items: pd.DataFrame,
                truth: pd.DataFrame | None = None) -> Panel:
    stock = stock.sort_values(["location_id", "item_id", "period"])
    periods = sorted(stock["period"].unique())
    keys = (stock[["location_id", "item_id"]].drop_duplicates().reset_index(drop=True)
            .merge(locations, on="location_id").merge(items, on="item_id"))

    def wide(col, dtype=float):
        w = stock.pivot_table(index=["location_id", "item_id"], columns="period", values=col, aggfunc="first")
        w = w.reindex(pd.MultiIndex.from_frame(keys[["location_id", "item_id"]]))[periods]
        return w.to_numpy(dtype=dtype)

    closing = wide("closing_balance")
    t = None
    if truth is not None and not truth.empty:
        tw = truth.pivot_table(index=["location_id", "item_id"], columns="period", values="demand", aggfunc="first")
        t = tw.reindex(pd.MultiIndex.from_frame(keys[["location_id", "item_id"]])).reindex(columns=periods).to_numpy(float)
    return Panel(keys, periods, wide("quantity_used"), closing, wide("quantity_received"),
                 wide("expiring_soon"), wide("is_imputed", bool), closing <= 0, t)


# ---------------------------------------------------------------- features

FEATURES = ["h", "target_month", "month_sin", "month_cos",
            "use_0", "use_1", "use_2", "use_3", "use_4", "use_5",
            "level6", "trend", "same_month_last_year", "same_month_last_year_censored",
            "censored_0", "censored_1", "stockouts_6", "imputed_6", "no_delivery_2",
            "item", "seasonality", "location_type", "rural"]

STOCK_FEATURES = ["stock_on_hand", "stock_cover", "delivery_cover", "received_0", "received_1",
                  "months_since_delivery", "delivery_variability"]
RISK_FEATURES = [f for f in FEATURES if f != "h"] + STOCK_FEATURES

GROUPS = {   # how SHAP contributions are explained to a person
    "stock on hand": ["stock_on_hand", "stock_cover"],
    "delivery pattern": ["delivery_cover", "received_0", "received_1", "months_since_delivery",
                         "delivery_variability"],
    "recent use": ["use_0", "use_1", "use_2", "use_3", "use_4", "use_5", "level6", "trend"],
    "recent stockouts": ["censored_0", "censored_1", "stockouts_6"],
    "seasonal timing": ["target_month", "month_sin", "month_cos", "same_month_last_year",
                        "same_month_last_year_censored"],
    "facility and medicine type": ["item", "seasonality", "location_type", "rural"],
    "data gaps": ["imputed_6", "no_delivery_2"],
    "forecast horizon": ["h"],
}


def window(a: np.ndarray, t: int, k: int) -> np.ndarray:
    """Columns t-k+1 .. t (clipped at 0)."""
    return a[:, max(0, t - k + 1): t + 1]


def features_at(p: Panel, t: int, h: int) -> pd.DataFrame:
    """Features known at the end of month t, for forecasting month t+h."""
    n = len(p.keys)
    f = {"h": np.full(n, h)}
    m = (p.periods[0].month - 1 + t + h) % 12 + 1
    f["target_month"] = np.full(n, m)
    f["month_sin"] = np.full(n, math.sin(2 * math.pi * m / 12))
    f["month_cos"] = np.full(n, math.cos(2 * math.pi * m / 12))
    for k in range(6):
        f[f"use_{k}"] = np.log1p(p.used[:, t - k]) if t - k >= 0 else np.full(n, np.nan)

    u6, c6, i6 = window(p.used, t, 6), window(p.censored, t, 6), window(p.imputed, t, 6)
    good = ~c6 & ~i6
    with np.errstate(invalid="ignore", divide="ignore"):
        lvl6 = np.where(good.any(1), (u6 * good).sum(1) / good.sum(1), u6.mean(1))
        u3, g3 = window(p.used, t, 3), (~window(p.censored, t, 3) & ~window(p.imputed, t, 3))
        lvl3 = np.where(g3.any(1), (u3 * g3).sum(1) / g3.sum(1), lvl6)
    f["level6"] = np.log1p(lvl6)
    f["trend"] = np.log1p(lvl3) - np.log1p(lvl6)

    j = t + h - 12
    f["same_month_last_year"] = np.log1p(p.used[:, j]) if j >= 0 else np.full(n, np.nan)
    f["same_month_last_year_censored"] = p.censored[:, j].astype(float) if j >= 0 else np.full(n, np.nan)
    f["censored_0"] = p.censored[:, t].astype(float)
    f["censored_1"] = p.censored[:, t - 1].astype(float) if t >= 1 else np.zeros(n)
    f["stockouts_6"] = c6.sum(1)
    f["imputed_6"] = i6.sum(1)
    f["no_delivery_2"] = (window(p.received, t, 2).sum(1) == 0).astype(float)

    for col in ["item", "seasonality", "location_type"]:
        f[col] = p.keys[f"{col}_code"].to_numpy()
    f["rural"] = p.keys["rural"].astype(float).to_numpy()
    return pd.DataFrame(f)[FEATURES]


def risk_features_at(p: Panel, t: int) -> pd.DataFrame:
    """Demand features for next month plus stock and delivery position at the end of month t."""
    f = features_at(p, t, 1).drop(columns="h")
    level = np.maximum(np.expm1(f["level6"].to_numpy()), 1)
    rec6 = window(p.received, t, 6)
    f["stock_on_hand"] = np.log1p(p.closing[:, t])
    f["stock_cover"] = p.closing[:, t] / level
    f["delivery_cover"] = rec6.mean(1) / level
    f["received_0"] = np.log1p(p.received[:, t])
    f["received_1"] = np.log1p(p.received[:, t - 1]) if t >= 1 else np.nan
    last = np.array([np.max(np.nonzero(r)[0]) if r.any() else -1 for r in (p.received[:, : t + 1] > 0)])
    f["months_since_delivery"] = np.where(last >= 0, t - last, t + 1)
    with np.errstate(invalid="ignore", divide="ignore"):
        f["delivery_variability"] = rec6.std(1) / np.maximum(rec6.mean(1), 1)
    return f[RISK_FEATURES]


def stockout_label(p: Panel, t: int, months: int) -> tuple[np.ndarray, np.ndarray]:
    """Did the shelf end empty in any of the next `months` months? Second array: label is known."""
    ends = [t + k for k in range(1, months + 1)]
    y = np.zeros(len(p.keys), bool)
    known = np.ones(len(p.keys), bool)
    for e in ends:
        y |= p.censored[:, e]
        known &= ~p.imputed[:, e]
    return y, known


def fit_risk(p: Panel, last_known: int, months: int) -> HistGradientBoostingClassifier:
    X, y = [], []
    for t in range(2, last_known - months + 1):
        lab, known = stockout_label(p, t, months)
        X.append(risk_features_at(p, t)[known])
        y.append(lab[known])
    return HistGradientBoostingClassifier(**CLASSIFIER_PARAMS).fit(pd.concat(X, ignore_index=True), np.concatenate(y))


def training_set(p: Panel, last_known: int) -> tuple[pd.DataFrame, np.ndarray]:
    """All (origin, horizon) pairs whose target month is <= last_known and is a usable target."""
    X, y = [], []
    for t in range(2, last_known):
        for h in HORIZONS:
            if t + h > last_known:
                continue
            ok = ~p.censored[:, t + h] & ~p.imputed[:, t + h]
            X.append(features_at(p, t, h)[ok])
            y.append(np.log1p(p.used[ok, t + h]))
    return pd.concat(X, ignore_index=True), np.concatenate(y)


def fit(p: Panel, last_known: int) -> HistGradientBoostingRegressor:
    X, y = training_set(p, last_known)
    return HistGradientBoostingRegressor(**MODEL_PARAMS).fit(X, y)


# ---------------------------------------------------------------- baselines

def baseline(p: Panel, t: int, name: str) -> np.ndarray:
    if name == "last_month":
        return p.used[:, t].copy()
    if name == "amc_3":                       # what a max-min system plans with
        return window(p.used, t, 3).mean(1)
    raise ValueError(name)


# ---------------------------------------------------------------- backtest

def wape_by_item(pred, actual, item_codes) -> float:
    """Weighted absolute % error per medicine, averaged so each medicine counts equally."""
    df = pd.DataFrame({"p": pred, "a": actual, "i": item_codes}).dropna()
    per = df.groupby("i").apply(lambda g: (g.p - g.a).abs().sum() / max(g.a.sum(), 1), include_groups=False)
    return float(per.mean())


def bias_pct(pred, actual) -> float:
    m = ~np.isnan(actual)
    return float((pred[m].sum() - actual[m].sum()) / max(actual[m].sum(), 1))


def backtest(p: Panel, log=print) -> tuple[pd.DataFrame, dict]:
    """Rolling-origin backtest. Returns per-row results and log-space residual spreads
    measured against recorded (uncensored) use, which is what a real deployment would have."""
    rows, resid = [], {h: [] for h in HORIZONS}
    resid_sum, alert_inputs = [], []
    last_origin = p.n_months - 1 - max(HORIZONS)
    for t in range(FIRST_ORIGIN, last_origin + 1):
        model = fit(p, t)
        preds = {}
        for h in HORIZONS:
            X = features_at(p, t, h)
            gbm = np.expm1(model.predict(X)).clip(0)
            preds[h] = gbm
            base = {b: baseline(p, t, b) for b in ("last_month", "amc_3")}
            truth = p.truth[:, t + h] if p.truth is not None else np.full(len(gbm), np.nan)
            obs_ok = ~p.censored[:, t + h] & ~p.imputed[:, t + h]
            resid[h].append((np.log1p(p.used[:, t + h]) - np.log1p(gbm))[obs_ok])
            after_stockout = p.censored[:, t] | (p.censored[:, t - 1] if t >= 1 else False)
            rows.append(pd.DataFrame({
                "origin": t, "h": h, "item": p.keys["item_code_str"], "location_type": p.keys["location_type_str"],
                "rural": p.keys["rural"], "after_stockout": after_stockout, "truth": truth,
                "gbm": gbm, **base}))
        ok2 = ~p.censored[:, t + 1] & ~p.imputed[:, t + 1] & ~p.censored[:, t + 2] & ~p.imputed[:, t + 2]
        resid_sum.append((np.log1p(p.used[:, t + 1] + p.used[:, t + 2])
                          - np.log1p(preds[1] + preds[2]))[ok2])
        alert_inputs.append(t)
        log(f"  backtest origin {p.periods[t]:%b %Y}: done")
    spread = {h: float(np.std(np.concatenate(resid[h]))) for h in HORIZONS}
    spread["sum_1_2"] = float(np.std(np.concatenate(resid_sum)))
    alert_eval = evaluate_alerts(p, alert_inputs)
    return pd.concat(rows, ignore_index=True), spread, alert_eval


def evaluate_alerts(p: Panel, origins) -> dict:
    """Did 30-day alerts predict the shelf being empty at the end of next month?
    The label (closing balance of zero) is in the reports, so this check also works on real data.
    Compared with a common rule of thumb: alert when stock on hand is under one month of AMC.
    Average precision compares the two across every possible threshold."""
    prob, rule_score, label = [], [], []
    for t in origins:
        clf = fit_risk(p, t, 1)
        y, known = stockout_label(p, t, 1)
        prob.append(clf.predict_proba(risk_features_at(p, t))[:, 1][known])
        rule_score.append((baseline(p, t, "amc_3") / np.maximum(p.closing[:, t], 0.5))[known])
        label.append(y[known])
    prob, rule_score, y = np.concatenate(prob), np.concatenate(rule_score), np.concatenate(label)

    def score(flag):
        tp, fp, fn = (flag & y).sum(), (flag & ~y).sum(), (~flag & y).sum()
        prec, rec = tp / max(tp + fp, 1), tp / max(tp + fn, 1)
        return {"alerts": int(flag.sum()), "precision": round(float(prec), 3), "recall": round(float(rec), 3)}

    rule_flag = rule_score > 1                                  # stock < 1 month of AMC
    rule_recall = (rule_flag & y).sum() / max(y.sum(), 1)
    pos = np.sort(prob[y])                                      # threshold that catches the same share
    same_recall = prob >= pos[int((1 - rule_recall) * len(pos))] if len(pos) else np.zeros_like(y)
    return {"stockouts": int(y.sum()), "cases": int(len(y)), "months": len(origins),
            "afyastock_at_threshold": score(prob >= ALERT_THRESHOLD),
            "afyastock_same_recall_as_rule": score(same_recall),
            "rule_under_1_month_amc": score(rule_flag),
            "average_precision": {"afyastock": round(float(average_precision_score(y, prob)), 3),
                                  "rule": round(float(average_precision_score(y, rule_score)), 3),
                                  "random": round(float(y.mean()), 3)}}


def summarise_backtest(bt: pd.DataFrame) -> dict:
    bt = bt.dropna(subset=["truth"])
    models = ["last_month", "amc_3", "gbm"]
    out = {"rows_evaluated": int(len(bt)), "overall": {}, "after_stockout": {}, "by_location_type": {}, "by_area": {}}
    for m in models:
        out["overall"][m] = {"wape": round(wape_by_item(bt[m], bt.truth, bt.item), 3),
                             "bias": round(bias_pct(bt[m].to_numpy(), bt.truth.to_numpy()), 3)}
        s = bt[bt.after_stockout]
        out["after_stockout"][m] = {"wape": round(wape_by_item(s[m], s.truth, s.item), 3),
                                    "bias": round(bias_pct(s[m].to_numpy(), s.truth.to_numpy()), 3)}
    for lt, g in bt.groupby("location_type"):
        out["by_location_type"][lt] = {m: round(wape_by_item(g[m], g.truth, g.item), 3) for m in models}
    for rural, g in bt.groupby("rural"):
        out["by_area"]["rural" if rural else "urban"] = {m: round(wape_by_item(g[m], g.truth, g.item), 3) for m in models}
    return out


# ---------------------------------------------------------------- final forecast, alerts, reasons

def normal_sf(z: np.ndarray) -> np.ndarray:
    return 0.5 * np.vectorize(math.erfc)(z / math.sqrt(2))


def expected_deliveries(p: Panel, t: int) -> np.ndarray:
    """Typical monthly delivery over the last 6 months. Without an orders table this is the
    best guess of what will arrive; a real deployment would use actual pending orders."""
    return window(p.received, t, 6).mean(1)


PHRASES = {   # group -> (wording when it raises risk, wording when it lowers risk)
    "stock on hand": ("Low stock on hand raises the risk", "Stock on hand lowers the risk"),
    "delivery pattern": ("Thin or irregular deliveries raise the risk", "A steady delivery pattern lowers the risk"),
    "recent use": ("High or rising use raises the risk", "Recent use lowers the risk"),
    "recent stockouts": ("Recent stockouts raise the risk", "No recent stockouts lowers the risk"),
    "seasonal timing": ("Seasonal timing ({m}) raises the risk", "Seasonal timing ({m}) lowers the risk"),
    "facility and medicine type": ("This facility type and medicine raise the risk",
                                   "This facility type and medicine lower the risk"),
    "data gaps": ("Missing reports raise the risk", "Complete reporting lowers the risk"),
    "forecast horizon": ("Forecast horizon raises the risk", "Forecast horizon lowers the risk"),
}


def explain(shap_row: np.ndarray, month_name: str) -> list[dict]:
    """Turn the stockout model's SHAP values (log-odds) into the two biggest plain-language reasons."""
    contrib = {g: float(sum(shap_row[RISK_FEATURES.index(f)] for f in fs if f in RISK_FEATURES))
               for g, fs in GROUPS.items()}
    out = []
    for g, v in sorted(contrib.items(), key=lambda kv: -abs(kv[1]))[:2]:
        if abs(v) < 0.1:
            continue
        text = PHRASES[g][0 if v > 0 else 1].format(m=month_name)
        if abs(v) > 1:
            text = text.replace(" raise", " strongly raise").replace(" lower", " strongly lower")
        out.append({"factor": g, "effect": round(v, 3), "text": text})
    return out


def final_forecast(p: Panel, spread: dict) -> tuple[pd.DataFrame, pd.DataFrame, HistGradientBoostingRegressor]:
    import shap

    T = p.n_months - 1
    model = fit(p, T)
    X1, X2 = features_at(p, T, 1), features_at(p, T, 2)
    lp1, lp2 = model.predict(X1), model.predict(X2)
    f1, f2 = np.expm1(lp1).clip(0), np.expm1(lp2).clip(0)
    clf30, clf60 = fit_risk(p, T, 1), fit_risk(p, T, 2)
    XR = risk_features_at(p, T)
    def shap_values(clf):
        v = shap.TreeExplainer(clf).shap_values(XR)
        return v[1] if isinstance(v, list) else v      # older shap returns one array per class
    sv30, sv60 = shap_values(clf30), shap_values(clf60)

    fc_rows = []
    for h, lp, s in ((1, lp1, spread[1]), (2, lp2, spread[2])):
        period = date(p.periods[T].year + (p.periods[T].month + h - 1) // 12, (p.periods[T].month + h - 1) % 12 + 1, 1)
        fc_rows.append(pd.DataFrame({
            "location_id": p.keys.location_id, "item_id": p.keys.item_id, "period": period,
            "predicted_use": np.expm1(lp).clip(0).round(1),
            "lower_bound": np.expm1(lp - Z80 * s).clip(0).round(1),
            "upper_bound": np.expm1(lp + Z80 * s).round(1)}))
    forecasts = pd.concat(fc_rows, ignore_index=True)

    stock = p.closing[:, T]
    incoming = expected_deliveries(p, T)
    risk30, risk60 = clf30.predict_proba(XR)[:, 1], clf60.predict_proba(XR)[:, 1]
    months_of_stock = stock / np.maximum(f1, 1)
    use_3m = f1 + 2 * f2
    expiring = p.expiring[:, T]
    target_month = MONTH_NAMES[(p.periods[T].month) % 12]

    alerts = []
    for s_i in range(len(p.keys)):
        k = p.keys.iloc[s_i]
        c6 = int(window(p.censored, T, 6)[s_i].sum())
        i6 = int(window(p.imputed, T, 6)[s_i].sum())
        confidence = "low" if (i6 >= 2 or c6 >= 3) else "high"
        facts = []
        weeks = stock[s_i] / max(f1[s_i], 1e-9) * 4.3
        facts.append({"factor": "stock position", "text":
                      "The shelf is already empty" if stock[s_i] <= 0 else
                      f"{stock[s_i]:g} {k.unit}s on hand cover about {weeks:.0f} weeks at the forecast use of "
                      f"{f1[s_i]:.0f} next month"})
        if c6:
            facts.append({"factor": "recent stockouts", "text":
                          f"Ran out in {c6} of the last 6 months, so recorded use understates real demand"})
        if window(p.received, T, 2)[s_i].sum() == 0:
            facts.append({"factor": "deliveries", "text": "No delivery recorded in the last 2 months"})
        elif incoming[s_i] < 0.8 * f1[s_i]:
            facts.append({"factor": "deliveries", "text":
                          f"Deliveries have averaged {incoming[s_i]:.0f} a month, below the forecast need of "
                          f"{f1[s_i]:.0f}"})
        if i6:
            facts.append({"factor": "data gaps", "text": f"{i6} of the last 6 monthly reports were missing or unusable"})

        if stock[s_i] <= 0:                                    # already out: highest priority
            alerts.append({"location_id": k.location_id, "item_id": k.item_id, "alert_type": "stockout_risk",
                           "horizon_days": 0, "risk_score": 1.0, "months_of_stock": 0.0,
                           "drivers": facts + explain(sv30[s_i], target_month), "confidence": confidence})
        elif risk30[s_i] >= ALERT_THRESHOLD or risk60[s_i] >= ALERT_THRESHOLD_60:
            in30 = risk30[s_i] >= ALERT_THRESHOLD
            horizon, score, sv = (30, risk30[s_i], sv30) if in30 else (60, risk60[s_i], sv60)
            alerts.append({"location_id": k.location_id, "item_id": k.item_id, "alert_type": "stockout_risk",
                           "horizon_days": horizon, "risk_score": round(float(score), 3),
                           "months_of_stock": round(float(months_of_stock[s_i]), 2),
                           "drivers": facts + explain(sv[s_i], target_month), "confidence": confidence})
        excess = expiring[s_i] - use_3m[s_i]
        if expiring[s_i] > 0 and excess > 0:
            alerts.append({"location_id": k.location_id, "item_id": k.item_id, "alert_type": "expiry_risk",
                           "horizon_days": 90, "risk_score": round(float(min(1.0, excess / expiring[s_i])), 3),
                           "months_of_stock": round(float(months_of_stock[s_i]), 2),
                           "drivers": [{"factor": "expiry", "text":
                                        f"{expiring[s_i]:g} {k.unit}s expire within 3 months but only about "
                                        f"{use_3m[s_i]:.0f} are likely to be used; about {excess:.0f} could be "
                                        f"moved to a facility that needs them"}],
                           "confidence": confidence})
    return forecasts, pd.DataFrame(alerts), model


# ---------------------------------------------------------------- database I/O

def load(conn) -> Panel:
    def q(sql):
        with conn.cursor() as cur:
            cur.execute(sql)
            return pd.DataFrame(cur.fetchall(), columns=[d.name for d in cur.description])

    stock = q("""SELECT location_id, item_id, period, quantity_used, closing_balance, quantity_received,
                        expiring_soon, is_imputed FROM stock_reports""")
    if stock.empty:
        raise SystemExit("stock_reports is empty. Run the pipeline first.")
    for c in ["quantity_used", "closing_balance", "quantity_received", "expiring_soon"]:
        stock[c] = pd.to_numeric(stock[c])
    locs = q("""SELECT id AS location_id, location_type AS location_type_str,
                       COALESCE((attributes->>'rural')::boolean, false) AS rural FROM locations""")
    items = q("""SELECT id AS item_id, code AS item_code_str, unit,
                        COALESCE(attributes->>'seasonality', 'none') AS seasonality_str FROM items""")
    locs["location_type_code"] = pd.Categorical(locs["location_type_str"]).codes
    items["item_code"] = pd.Categorical(items["item_code_str"]).codes
    items["seasonality_code"] = pd.Categorical(items["seasonality_str"]).codes
    truth = q("""SELECT l.id AS location_id, i.id AS item_id, r.period,
                        (r.payload->'truth'->>'demand')::float AS demand
                 FROM raw_reports r JOIN locations l ON l.code = r.location_code
                 JOIN items i ON i.code = r.item_code
                 WHERE r.payload ? 'truth'""")
    return build_panel(stock, locs, items, truth)


def save(conn, metrics: dict, params: dict, data_until: date, forecasts: pd.DataFrame, alerts: pd.DataFrame) -> int:
    with conn.cursor() as cur:
        cur.execute("""INSERT INTO model_runs (job, model, version, params, metrics, data_until)
                       VALUES ('forecast', 'hist_gradient_boosting', '1', %s, %s, %s) RETURNING id""",
                    (json.dumps(params), json.dumps(metrics), data_until))
        run_id = cur.fetchone()[0]
        with cur.copy("""COPY forecasts (run_id, location_id, item_id, period, predicted_use, lower_bound,
                         upper_bound) FROM STDIN""") as copy:
            for r in forecasts.itertuples(index=False):
                copy.write_row((run_id, int(r.location_id), int(r.item_id), r.period, float(r.predicted_use),
                                float(r.lower_bound), float(r.upper_bound)))
        with cur.copy("""COPY alerts (run_id, location_id, item_id, alert_type, horizon_days, risk_score,
                         months_of_stock, drivers, confidence) FROM STDIN""") as copy:
            for a in alerts.itertuples(index=False):
                copy.write_row((run_id, int(a.location_id), int(a.item_id), a.alert_type, int(a.horizon_days),
                                a.risk_score, a.months_of_stock, json.dumps(a.drivers), a.confidence))
    return run_id


def print_report(m: dict) -> None:
    names = {"last_month": "Last month's use", "amc_3": "3-month average (AMC)", "gbm": "AfyaStock model"}
    print(f"\nBacktest against true demand ({m['rows_evaluated']:,} forecasts)")
    print(f"  {'':<24}{'error (WAPE)':>14}{'bias':>9}{'after a stockout':>19}")
    for k, label in names.items():
        o, s = m["overall"][k], m["after_stockout"][k]
        print(f"  {label:<24}{o['wape']:>14.1%}{o['bias']:>+9.1%}{s['wape']:>13.1%} ({s['bias']:+.0%})")
    a = m["alerts_backtest"]
    print(f"\n30-day stockout alerts vs what happened ({a['stockouts']:,} stockouts in {a['cases']:,} cases)")
    for k, label in (("rule_under_1_month_amc", "Rule: stock < 1 month AMC"),
                     ("afyastock_same_recall_as_rule", "AfyaStock, same recall"),
                     ("afyastock_at_threshold", f"AfyaStock, risk >= {ALERT_THRESHOLD:.0%}")):
        v = a[k]
        print(f"  {label:<27} {v['alerts'] / a['months']:>5.0f} alerts/month  "
              f"precision {v['precision']:.0%}  recall {v['recall']:.0%}")
    ap = a["average_precision"]
    print(f"  Average precision: AfyaStock {ap['afyastock']:.2f}, rule {ap['rule']:.2f}, random {ap['random']:.2f}")
    print("\n  Error by group (AfyaStock model vs AMC):")
    for grp in ("by_location_type", "by_area"):
        for g, v in m[grp].items():
            print(f"    {g:<16}{v['gbm']:>8.1%}  vs  {v['amc_3']:.1%}")


def main() -> None:
    import psycopg
    from dotenv import load_dotenv

    load_dotenv(REPO_ROOT / ".env")
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise SystemExit("DATABASE_URL is not set. Add it to .env.")
    with psycopg.connect(url) as conn:
        p = load(conn)
        print(f"Loaded {len(p.keys)} series x {p.n_months} months. Running backtest...")
        bt, spread, alert_eval = backtest(p)
        metrics = summarise_backtest(bt) if p.truth is not None else {}
        metrics["alerts_backtest"] = alert_eval
        metrics["uncertainty_log_sd"] = {str(k): round(v, 3) for k, v in spread.items()}
        print_report(metrics)
        forecasts, alerts, _ = final_forecast(p, spread)
        run_id = save(conn, metrics, MODEL_PARAMS, p.periods[-1], forecasts, alerts)

    counts = alerts.groupby(["alert_type", "horizon_days"]).size() if not alerts.empty else {}
    print(f"\nForecast run {run_id}: {len(forecasts):,} forecasts for "
          f"{forecasts.period.min():%b %Y} and {forecasts.period.max():%b %Y}")
    labels = {("stockout_risk", 0): "Out of stock now", ("stockout_risk", 30): "Stockout risk within 30 days",
              ("stockout_risk", 60): "Stockout risk within 60 days", ("expiry_risk", 90): "Stock likely to expire"}
    for key, n in dict(counts).items():
        print(f"  {labels.get(key, key)}: {n}")


if __name__ == "__main__":
    main()
