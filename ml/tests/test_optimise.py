"""Tests for the optimiser's guarantees. Run from the repo root: pytest"""
import math

import numpy as np
import pandas as pd

from ml.afyastock_ml.optimise import Settings, km, plan_reorders, plan_transfers

S = Settings(ven_weights={"V": 3, "E": 2, "N": 1}, min_transfer_value_kes=0)


def places(*coords):
    return pd.DataFrame([{"location_id": i + 1, "name": f"F{i + 1}", "latitude": la, "longitude": lo}
                         for i, (la, lo) in enumerate(coords)])


def row(loc, item=1, closing=0, expiring=0, monthly=10, horizon=None, risk=None, cost=10, ven="E"):
    return {"location_id": loc, "item_id": item, "closing": closing, "expiring": expiring, "monthly": monthly,
            "horizon": np.nan if horizon is None else horizon, "risk": np.nan if risk is None else risk,
            "unit": "pack", "unit_cost": cost, "ven": ven, "item_name": f"Item {item}"}


NEAR = places((0.0, 37.0), (0.05, 37.0), (0.1, 37.0), (0.0, 37.05))   # all within ~12 km


def test_distance():
    assert abs(km(0, 37, 0.1, 37) - 11.1) < 0.2


def test_donor_keeps_its_own_need_and_receiver_gets_no_more_than_needed():
    state = pd.DataFrame([row(1, closing=100, monthly=10),              # surplus 80 beyond 2 months
                          row(2, closing=0, monthly=10, horizon=0, risk=1.0)])
    t = plan_transfers(state, NEAR, S)
    assert len(t) == 1 and t.iloc[0].from_location_id == 1 and t.iloc[0].to_location_id == 2
    assert t.iloc[0].quantity <= 100 - S.donor_keeps_months * 10
    assert t.iloc[0].quantity <= S.receiver_target_months * 10


def test_no_transfer_beyond_distance_limit():
    far = places((0.0, 37.0), (1.0, 37.0))                               # ~111 km apart
    state = pd.DataFrame([row(1, closing=100), row(2, closing=0, horizon=0, risk=1.0)])
    assert plan_transfers(state, far, S).empty


def test_expiring_stock_is_offered_even_without_surplus():
    state = pd.DataFrame([row(1, closing=20, expiring=18, monthly=2),   # needs 4, 18 will expire
                          row(2, closing=0, monthly=10, horizon=30, risk=0.6)])
    t = plan_transfers(state, NEAR, S)
    assert len(t) == 1 and t.iloc[0].expiring_quantity > 0


def test_urgent_receiver_served_first_when_stock_is_short():
    state = pd.DataFrame([row(1, closing=30, monthly=5),                # only 20 spare
                          row(2, closing=0, horizon=0, risk=1.0),
                          row(3, closing=0, horizon=60, risk=0.6)])
    t = plan_transfers(state, NEAR, S).set_index("to_location_id")
    assert t.loc[2].quantity >= 15 and (3 not in t.index or t.loc[3].quantity < t.loc[2].quantity)


def test_each_facility_receives_from_at_most_two_places():
    rows = [row(4, item=i, closing=0, horizon=0, risk=1.0) for i in (1, 2, 3)]
    rows += [row(d, item=i, closing=100) for d, i in ((1, 1), (2, 2), (3, 3))]
    t = plan_transfers(pd.DataFrame(rows), NEAR, S)
    assert t[t.to_location_id == 4].from_location_id.nunique() <= 2


def test_reorders_rank_vital_first_and_respect_budget():
    state = pd.DataFrame([row(1, item=1, closing=0, horizon=0, risk=1.0, ven="N"),
                          row(1, item=2, closing=0, horizon=0, risk=1.0, ven="V")])
    s = Settings(ven_weights={"V": 3, "E": 2, "N": 1}, default_budget_kes=300)
    r = plan_reorders(state, pd.DataFrame(columns=["to_location_id", "item_id", "quantity"]), s)
    assert list(r.ven) == ["V", "N"]
    assert list(r.within_budget) == [True, False]                     # each order costs 250
    assert math.isclose(r.cumulative_cost.iloc[-1], r.cost.sum())


def test_transfer_lowers_remaining_risk():
    state = pd.DataFrame([row(1, closing=0, horizon=0, risk=1.0)])
    transfers = pd.DataFrame([{"to_location_id": 1, "item_id": 1, "quantity": 10}])   # half of the 20 target
    r = plan_reorders(state, transfers, S)
    assert math.isclose(r.iloc[0].remaining_risk, 0.5)
