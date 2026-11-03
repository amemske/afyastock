"""
AfyaStock optimiser: alerts + forecasts -> transfer suggestions and a budget-ranked reorder plan.

1. Transfers (per medicine, a small linear programme)
   Receivers: facilities with a stockout alert. Each needs enough to reach
   `receiver_target_months` of forecast use.
   Donors: facilities without a stockout alert that hold more than `donor_keeps_months`
   of their own forecast use. Stock that will expire before the donor can use it is
   always available to give, even if the donor is otherwise not in surplus.
   Objective: cover the most urgent shortages first (out of stock now > within 30 days
   > within 60 days), prefer nearby donors, and prefer moving stock that would expire.
   No donor is ever left below its own need.

2. Reorders (after transfers)
   Every facility-medicine still at risk gets an order up to `reorder_target_months`
   of forecast use. Orders are ranked by priority per shilling:
       VEN weight (Vital 3, Essential 2, Non-essential 1) x remaining stockout risk / cost
   so a pharmacist can see exactly which orders a given budget covers.

Usage (from the repo root, with the venv active):
  python -m ml.afyastock_ml.optimise
"""

from __future__ import annotations

import json
import math
import os
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd
import yaml
from scipy.optimize import linprog

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_PACK = REPO_ROOT / "packs" / "health"
URGENCY = {0: 3.0, 30: 2.0, 60: 1.0}            # horizon_days -> weight
URGENCY_LABEL = {0: "is out of stock", 30: "is likely to run out within 30 days",
                 60: "is likely to run out within 60 days"}


@dataclass
class Settings:
    ven_weights: dict
    max_transfer_km: float = 40
    road_factor: float = 1.3
    donor_keeps_months: float = 2.0
    receiver_target_months: float = 2.0
    min_transfer_share: float = 0.1
    min_transfer_value_kes: float = 500
    max_donors_per_facility: int = 2
    reorder_target_months: float = 2.5
    default_budget_kes: float = 150000

    @classmethod
    def from_pack(cls, pack: Path) -> "Settings":
        cfg = yaml.safe_load((pack / "config.yaml").read_text()).get("optimiser", {})
        return cls(**{"ven_weights": {"V": 3, "E": 2, "N": 1}, **cfg})


def km(lat1, lon1, lat2, lon2) -> float:
    """Straight-line (great-circle) distance in km."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(a))


# ---------------------------------------------------------------- transfers

def item_nodes(g: pd.DataFrame, s: Settings) -> tuple[pd.DataFrame, list[tuple[int, float, bool]]]:
    """Receivers (with need) and supply nodes (donor expiring stock / other surplus) for one medicine."""
    receivers = g[g.horizon.notna()].copy()
    receivers["need"] = (s.receiver_target_months * receivers.monthly - receivers.closing).clip(lower=0)
    receivers = receivers[receivers.need >= 1]

    donors = g[g.horizon.isna()].copy()
    donors["expiring_spare"] = (donors.expiring - 3 * donors.monthly).clip(lower=0).clip(upper=donors.closing)
    donors["surplus"] = (donors.closing - s.donor_keeps_months * donors.monthly).clip(lower=0)
    donors["regular_spare"] = (donors.surplus - donors.expiring_spare).clip(lower=0)
    supply = []
    for _, d in donors.iterrows():
        if d.expiring_spare >= 1:
            supply.append((int(d.location_id), float(d.expiring_spare), True))
        if d.regular_spare >= 1:
            supply.append((int(d.location_id), float(d.regular_spare), False))
    return receivers, supply


def solve_item(receivers, supply, loc, s: Settings, allowed: dict[int, set[int]] | None = None) -> dict:
    """Linear programme for one medicine. Returns {(donor, receiver): {qty, expiring, road}}.
    `allowed` limits which donors may send to which receiver (used after trips are chosen)."""
    if receivers.empty or not supply:
        return {}
    edges, cost = [], []
    for si, (dl, _, expiring) in enumerate(supply):
        for _, r in receivers.iterrows():
            rid = int(r.location_id)
            if allowed is not None and dl not in allowed.get(rid, set()):
                continue
            dist = km(loc.at[dl, "latitude"], loc.at[dl, "longitude"], loc.at[rid, "latitude"], loc.at[rid, "longitude"])
            if dist > s.max_transfer_km:
                continue
            road = dist * s.road_factor
            # Negative cost = benefit. Urgency dominates; then distance; then using expiring stock.
            cost.append(-100 * URGENCY[int(r.horizon)] + 0.5 * road - (20 if expiring else 0))
            edges.append((si, rid, road))
    if not edges:
        return {}
    A, b = [], []
    for si, (_, avail, _) in enumerate(supply):                     # give no more than spare
        A.append([1.0 if e[0] == si else 0.0 for e in edges])
        b.append(avail)
    for rid, need in zip(receivers.location_id.astype(int), receivers.need):   # receive no more than needed
        A.append([1.0 if e[1] == rid else 0.0 for e in edges])
        b.append(float(need))
    res = linprog(c=cost, A_ub=np.array(A), b_ub=np.array(b), bounds=[(0, None)] * len(edges), method="highs")
    if res.status != 0:
        return {}
    moved: dict[tuple[int, int], dict] = {}
    for (si, rid, road), x in zip(edges, res.x):
        if x < 0.5:
            continue
        dl, _, expiring = supply[si]
        m = moved.setdefault((dl, rid), {"qty": 0.0, "expiring": 0.0, "road": road})
        m["qty"] += x
        if expiring:
            m["expiring"] += x
    return moved


def choose_donors(flows: dict, receivers_by_item: dict, s: Settings) -> dict[int, set[int]]:
    """Pick at most `max_donors_per_facility` donor facilities per receiving facility,
    greedily covering the most urgent, valuable flows (vital and out-of-stock first)."""
    by_receiver: dict[int, list[tuple[int, int, float]]] = {}
    for item_id, moved in flows.items():
        rec = receivers_by_item[item_id].set_index("location_id")
        for (dl, rid), m in moved.items():
            r = rec.loc[rid]
            w = URGENCY[int(r.horizon)] * s.ven_weights.get(r.ven, 2) * m["qty"] * max(float(r.unit_cost), 1)
            by_receiver.setdefault(rid, []).append((item_id, dl, w))
    chosen: dict[int, set[int]] = {}
    for rid, cands in by_receiver.items():
        open_items, picked = {c[0] for c in cands}, set()
        for _ in range(s.max_donors_per_facility):
            score: dict[int, float] = {}
            for item_id, dl, w in cands:
                if item_id in open_items and dl not in picked:
                    score[dl] = score.get(dl, 0) + w
            if not score:
                break
            donor = max(score, key=score.get)
            picked.add(donor)
            open_items -= {c[0] for c in cands if c[1] == donor}
        chosen[rid] = picked
    return chosen


def plan_transfers(state: pd.DataFrame, locations: pd.DataFrame, s: Settings) -> pd.DataFrame:
    """state: one row per location x item with closing, expiring, monthly (forecast use per month),
    horizon (stockout alert horizon in days, NaN if none), risk, unit, unit_cost, ven."""
    loc = locations.set_index("location_id")
    nodes = {item_id: item_nodes(g, s) for item_id, g in state.groupby("item_id")}

    # Pass 1: best flows with every donor allowed, used only to choose which trips to make.
    first = {i: solve_item(r, sup, loc, s) for i, (r, sup) in nodes.items()}
    chosen = choose_donors(first, {i: r for i, (r, _) in nodes.items()}, s)

    # Pass 2: re-solve using only the chosen donor -> receiver trips, so spare stock
    # goes where a vehicle is already going.
    out = []
    for item_id, (receivers, supply) in nodes.items():
        moved = solve_item(receivers, supply, loc, s, allowed=chosen)
        rec = receivers.set_index("location_id")
        for (dl, rid), m in moved.items():
            r = rec.loc[rid]
            qty = math.floor(m["qty"])
            too_small = qty < max(1, s.min_transfer_share * r.monthly)
            vital_and_out = r.ven == "V" and int(r.horizon) == 0
            if too_small or (qty * r.unit_cost < s.min_transfer_value_kes and not vital_and_out):
                continue
            exp = min(qty, math.floor(m["expiring"]))
            reason = f"{loc.at[rid, 'name']} {URGENCY_LABEL[int(r.horizon)]}. "
            reason += f"{loc.at[dl, 'name']} can spare {qty} {r.unit}s"
            reason += (f", {exp} of which would otherwise expire within 3 months." if exp
                       else f" beyond {s.donor_keeps_months:g} months of its own forecast use.")
            out.append({"item_id": item_id, "from_location_id": dl, "to_location_id": rid,
                        "quantity": qty, "expiring_quantity": exp, "distance_km": round(m["road"], 1),
                        "urgency": int(r.horizon), "reason": reason})
    cols = ["item_id", "from_location_id", "to_location_id", "quantity", "expiring_quantity",
            "distance_km", "urgency", "reason"]
    return pd.DataFrame(out, columns=cols)


# ---------------------------------------------------------------- reorders

def plan_reorders(state: pd.DataFrame, transfers: pd.DataFrame, s: Settings) -> pd.DataFrame:
    """Orders for everything still at risk after transfers, ranked by priority per shilling."""
    at_risk = state[state.horizon.notna()].copy()
    incoming = (transfers.groupby(["to_location_id", "item_id"]).quantity.sum()
                if not transfers.empty else pd.Series(dtype=float))
    at_risk["transferred_in"] = [incoming.get((r.location_id, r.item_id), 0.0) for r in at_risk.itertuples()]
    stock_after = at_risk.closing + at_risk.transferred_in
    target = s.receiver_target_months * at_risk.monthly
    # A transfer lowers the risk in proportion to how much of the target it fills.
    filled_by_transfer = (at_risk.transferred_in / target.where(target > 0, 1)).clip(upper=1)
    at_risk["remaining_risk"] = at_risk.risk * (1 - filled_by_transfer)
    at_risk["quantity"] = np.ceil((s.reorder_target_months * at_risk.monthly - stock_after).clip(lower=0))
    at_risk = at_risk[at_risk.quantity >= 1].copy()
    at_risk["cost"] = (at_risk.quantity * at_risk.unit_cost).round(2)
    at_risk["ven_weight"] = at_risk.ven.map(s.ven_weights).fillna(2)
    at_risk["score"] = at_risk.ven_weight * at_risk.remaining_risk / at_risk.cost.clip(lower=1)
    at_risk = at_risk[at_risk.remaining_risk > 0].sort_values(
        ["score", "remaining_risk"], ascending=False).reset_index(drop=True)
    at_risk["priority_rank"] = np.arange(1, len(at_risk) + 1)
    at_risk["cumulative_cost"] = at_risk.cost.cumsum()
    at_risk["within_budget"] = at_risk.cumulative_cost <= s.default_budget_kes
    return at_risk


def reorder_cost_without_transfers(state: pd.DataFrame, s: Settings) -> float:
    r = state[state.horizon.notna()]
    qty = np.ceil((s.reorder_target_months * r.monthly - r.closing).clip(lower=0))
    return float((qty * r.unit_cost).sum())


# ---------------------------------------------------------------- database I/O

def q(conn, sql, params=None) -> pd.DataFrame:
    with conn.cursor() as cur:
        cur.execute(sql, params)
        return pd.DataFrame(cur.fetchall(), columns=[d.name for d in cur.description])


def load_state(conn) -> tuple[int, pd.DataFrame, pd.DataFrame]:
    run = q(conn, "SELECT id, data_until FROM model_runs WHERE job = 'forecast' ORDER BY id DESC LIMIT 1")
    if run.empty:
        raise SystemExit("No forecast run found. Run the forecast first.")
    run_id, until = int(run.id[0]), run.data_until[0]
    stock = q(conn, """SELECT location_id, item_id, closing_balance AS closing, expiring_soon AS expiring
                       FROM stock_reports WHERE period = %s""", (until,))
    fc = q(conn, """SELECT location_id, item_id, avg(predicted_use) AS monthly
                    FROM forecasts WHERE run_id = %s GROUP BY 1, 2""", (run_id,))
    alerts = q(conn, """SELECT location_id, item_id, horizon_days AS horizon, risk_score AS risk
                        FROM alerts WHERE run_id = %s AND alert_type = 'stockout_risk'""", (run_id,))
    items = q(conn, """SELECT id AS item_id, name AS item_name, unit, unit_cost,
                              COALESCE(attributes->>'ven', 'E') AS ven FROM items""")
    locations = q(conn, "SELECT id AS location_id, name, latitude, longitude FROM locations")
    state = (stock.merge(fc, on=["location_id", "item_id"]).merge(alerts, on=["location_id", "item_id"], how="left")
             .merge(items, on="item_id"))
    for c in ["closing", "expiring", "monthly", "risk", "unit_cost", "horizon"]:
        state[c] = pd.to_numeric(state[c])
    locations[["latitude", "longitude"]] = locations[["latitude", "longitude"]].astype(float)
    return run_id, state, locations


def save(conn, forecast_run: int, s: Settings, transfers: pd.DataFrame, reorders: pd.DataFrame, metrics: dict) -> int:
    with conn.cursor() as cur:
        cur.execute("""INSERT INTO model_runs (job, model, version, params, metrics, data_until)
                       SELECT 'optimise', 'linear_programme+ven_ranking', '1', %s, %s, data_until
                       FROM model_runs WHERE id = %s RETURNING id""",
                    (json.dumps({"forecast_run": forecast_run, **s.__dict__}), json.dumps(metrics), forecast_run))
        run_id = cur.fetchone()[0]
        with cur.copy("""COPY transfer_suggestions (run_id, from_location_id, to_location_id, item_id, quantity,
                         distance_km, reason) FROM STDIN""") as copy:
            for t in transfers.itertuples(index=False):
                copy.write_row((run_id, int(t.from_location_id), int(t.to_location_id), int(t.item_id),
                                int(t.quantity), float(t.distance_km), t.reason))
        with cur.copy("""COPY reorder_plans (run_id, location_id, item_id, quantity, cost, priority_rank,
                         budget_ceiling, within_budget, stockouts_prevented) FROM STDIN""") as copy:
            for r in reorders.itertuples(index=False):
                copy.write_row((run_id, int(r.location_id), int(r.item_id), int(r.quantity), float(r.cost),
                                int(r.priority_rank), s.default_budget_kes, bool(r.within_budget),
                                round(float(r.remaining_risk), 3)))
    return run_id


def summarise(state, transfers, reorders, s: Settings) -> dict:
    out_now = state[state.horizon == 0]
    helped_out_now = transfers[transfers.urgency == 0].to_location_id.astype(str) + "-" + transfers[transfers.urgency == 0].item_id.astype(str)
    unit_cost = state.drop_duplicates("item_id").set_index("item_id").unit_cost
    in_budget = reorders[reorders.within_budget]
    without = reorder_cost_without_transfers(state, s)
    return {
        "transfers": int(len(transfers)),
        "trips": int(transfers[["from_location_id", "to_location_id"]].drop_duplicates().shape[0]) if len(transfers) else 0,
        "units_moved": int(transfers.quantity.sum()) if len(transfers) else 0,
        "value_moved_kes": round(float((transfers.quantity * transfers.item_id.map(unit_cost)).sum()), 0) if len(transfers) else 0,
        "expiring_units_saved": int(transfers.expiring_quantity.sum()) if len(transfers) else 0,
        "expiring_value_saved_kes": round(float((transfers.expiring_quantity * transfers.item_id.map(unit_cost)).sum()), 0) if len(transfers) else 0,
        "out_of_stock_lines": int(len(out_now)),
        "out_of_stock_lines_helped_by_transfer": int(helped_out_now.nunique()),
        "reorder_lines": int(len(reorders)),
        "reorder_cost_total_kes": round(float(reorders.cost.sum()), 0),
        "reorder_cost_without_transfers_kes": round(without, 0),
        "default_budget_kes": s.default_budget_kes,
        "lines_within_budget": int(len(in_budget)),
        "vital_lines_within_budget": int((in_budget.ven == "V").sum()),
        "expected_stockouts_prevented_within_budget": round(float(in_budget.remaining_risk.sum()), 1),
    }


def main() -> None:
    import argparse

    import psycopg
    from dotenv import load_dotenv

    p = argparse.ArgumentParser(description="Plan transfers and budget-ranked reorders.")
    p.add_argument("--pack", type=Path, default=DEFAULT_PACK)
    args = p.parse_args()
    s = Settings.from_pack(args.pack)

    load_dotenv(REPO_ROOT / ".env")
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise SystemExit("DATABASE_URL is not set. Add it to .env.")
    with psycopg.connect(url) as conn:
        forecast_run, state, locations = load_state(conn)
        transfers = plan_transfers(state, locations, s)
        reorders = plan_reorders(state, transfers, s)
        metrics = summarise(state, transfers, reorders, s)
        run_id = save(conn, forecast_run, s, transfers, reorders, metrics)

    m = metrics
    print(f"Optimiser run {run_id} (based on forecast run {forecast_run})")
    print(f"\nTransfers: {m['transfers']} medicine lines in {m['trips']} trips, moving {m['units_moved']:,} units "
          f"worth KES {m['value_moved_kes']:,.0f}")
    print(f"  Out-of-stock lines helped: {m['out_of_stock_lines_helped_by_transfer']} of {m['out_of_stock_lines']}")
    print(f"  Near-expiry units put to use: {m['expiring_units_saved']:,} (KES {m['expiring_value_saved_kes']:,.0f} not wasted)")
    print(f"\nReorders: {m['reorder_lines']} lines, KES {m['reorder_cost_total_kes']:,.0f} in total "
          f"(KES {m['reorder_cost_without_transfers_kes']:,.0f} without transfers)")
    print(f"  Budget KES {m['default_budget_kes']:,.0f} covers {m['lines_within_budget']} lines "
          f"({m['vital_lines_within_budget']} vital), preventing about "
          f"{m['expected_stockouts_prevented_within_budget']} expected stockouts")


if __name__ == "__main__":
    main()
