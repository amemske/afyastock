"""
AfyaStock synthetic data generator.

Reads a domain pack (config.yaml + items.csv), simulates monthly stock for every
location x item, and writes:
  - locations, items      (reference data)
  - raw_reports           (reports as submitted, mistakes included)

How the simulation works, per location x item x month:
  1. True demand = base use x facility size x season x growth trend x noise (x outbreak spike).
  2. Stock moves through batches with expiry dates (first-expiry, first-out).
  3. Use is capped by what is on the shelf, so stockouts hide real demand,
     exactly like real consumption data.
  4. Expired stock becomes losses; stock expiring within 3 months is reported.
  5. Resupply follows a max-min rule with partial fills, late deliveries and
     occasional unrequested bulk "push" deliveries.
  6. The report is then made messy: missed months, copy errors, all-zero reports.

The true demand and what was done to each report are kept in raw_reports.payload
under "truth", so we can later measure how well the pipeline and models recover reality.
Real data would never have that field.

Usage (from the repo root):
  python -m ml.afyastock_ml.generate --reset             # write to DATABASE_URL
  python -m ml.afyastock_ml.generate --csv-out data/raw  # write CSVs, no database
"""

from __future__ import annotations

import argparse
import json
import math
import os
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd
import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_PACK = REPO_ROOT / "packs" / "health"

SYLLABLES = ["ka", "ki", "mu", "nya", "ru", "ga", "tha", "we", "ri", "ko",
             "ma", "ndu", "chi", "lo", "mbi", "ta", "go", "si", "nja", "re"]
TYPE_LABELS = {"dispensary": "Dispensary", "health_centre": "Health Centre",
               "hospital": "Sub-County Hospital"}


# ---------------------------------------------------------------- helpers

def add_months(d: date, n: int) -> date:
    y, m = divmod(d.month - 1 + n, 12)
    return date(d.year + y, m + 1, 1)


def km_offset_to_latlon(center, dx_km, dy_km):
    lat0, lon0 = center
    lat = lat0 + dy_km / 110.574
    lon = lon0 + dx_km / (111.320 * math.cos(math.radians(lat0)))
    return round(lat, 6), round(lon, 6)


def make_name(rng: np.random.Generator, used: set[str]) -> str:
    while True:
        parts = rng.choice(SYLLABLES, size=rng.integers(2, 4))
        name = "".join(parts).capitalize()
        if name not in used and len(name) >= 5:
            used.add(name)
            return name


# ---------------------------------------------------------------- reference data

def build_locations(cfg: dict, rng: np.random.Generator) -> pd.DataFrame:
    region = cfg["region"]
    rural_share = cfg["locations"]["rural_share"]
    used: set[str] = set()
    rows = []
    for t in cfg["locations"]["types"]:
        lo, hi = t["size_factor"]
        for i in range(t["count"]):
            # hospitals sit near the centre, dispensaries spread out
            max_r = region["radius_km"] * (0.3 if t["type"] == "hospital" else 1.0)
            r = max_r * math.sqrt(rng.random())
            theta = rng.random() * 2 * math.pi
            lat, lon = km_offset_to_latlon(region["center"], r * math.cos(theta), r * math.sin(theta))
            rural = bool(rng.random() < rural_share) if t["type"] != "hospital" else False
            name = make_name(rng, used)
            rows.append({
                "code": f"MLM-{t['code_prefix']}-{i + 1:03d}",
                "name": f"{name} {TYPE_LABELS.get(t['type'], t['type'].title())}",
                "location_type": t["type"],
                "region": region["name"],
                "latitude": lat,
                "longitude": lon,
                "size_factor": round(float(rng.uniform(lo, hi)), 3),
                "rural": rural,
            })
    return pd.DataFrame(rows)


def load_items(pack: Path) -> pd.DataFrame:
    return pd.read_csv(pack / "items.csv")


# ---------------------------------------------------------------- simulation

@dataclass
class Shelf:
    """Stock as batches of (quantity, expiry month index), used first-expiry first-out."""
    batches: list[list[float]] = field(default_factory=list)

    def total(self) -> float:
        return sum(q for q, _ in self.batches)

    def add(self, qty: float, expiry: int) -> None:
        if qty > 0:
            self.batches.append([qty, expiry])
            self.batches.sort(key=lambda b: b[1])

    def take(self, qty: float) -> float:
        taken = 0.0
        for b in self.batches:
            if taken >= qty:
                break
            use = min(b[0], qty - taken)
            b[0] -= use
            taken += use
        self.batches = [b for b in self.batches if b[0] > 0]
        return taken

    def remove_expired(self, t: int) -> float:
        expired = sum(q for q, e in self.batches if e <= t)
        self.batches = [b for b in self.batches if b[1] > t]
        return expired

    def expiring_within(self, t: int, months: int) -> float:
        return sum(q for q, e in self.batches if t < e <= t + months)


def simulate_series(loc, item, cfg, rng, start: date, n: int) -> list[dict]:
    dem, sup = cfg["demand"], cfg["supply"]
    season = cfg["seasonality"][item["seasonality"]]
    shelf_life = int(item["shelf_life_months"])

    base = item["base_monthly_use"] * loc["size_factor"]
    if item["seasonality"] == "malaria" and loc["rural"]:
        base *= dem["rural_malaria_boost"]

    shelf = Shelf()
    months0 = rng.uniform(*sup["initial_months_of_stock"])
    shelf.add(round(base * months0), int(rng.integers(6, shelf_life)))

    pending: dict[int, float] = {}       # month index -> quantity arriving
    recent_use: list[float] = []
    outbreak_left, outbreak_mult = 0, 1.0
    rows = []

    for t in range(n):
        period = add_months(start, t)

        # 1. true demand
        if outbreak_left == 0 and rng.random() < dem["outbreak_prob"]:
            outbreak_left = dem["outbreak_months"]
            outbreak_mult = rng.uniform(*dem["outbreak_multiplier"])
        mult = outbreak_mult if outbreak_left > 0 else 1.0
        outbreak_left = max(0, outbreak_left - 1)
        trend = (1 + item["annual_trend"]) ** (t / 12)
        noise = rng.lognormal(0, dem["noise_sd"])
        demand = max(0, round(base * season[period.month - 1] * trend * noise * mult))

        # 2. opening stock and deliveries
        opening = shelf.total()
        received = pending.pop(t, 0.0)
        if received:
            used_life = int(rng.integers(sup["remaining_life_used"][0], sup["remaining_life_used"][1] + 1))
            shelf.add(received, t + shelf_life - used_life)
        pushed = 0.0
        if rng.random() < sup["push_prob"]:
            pushed = round(base * sup["push_months_of_stock"])
            shelf.add(pushed, t + int(rng.integers(*sup["push_remaining_life"])))
        received += pushed

        # 3. use is capped by what is on the shelf
        available = shelf.total()
        used = shelf.take(min(demand, available))
        stocked_out = demand > available

        # 4. expiry
        losses = shelf.remove_expired(t)
        closing = shelf.total()
        expiring_soon = shelf.expiring_within(t, 3)

        # 5. resupply order (max-min on average monthly use, which is itself
        #    understated after stockouts, a real-world bias)
        recent_use.append(used)
        amc = max(np.mean(recent_use[-3:]), 1.0)
        on_order = sum(pending.values())
        if closing < sup["min_months"] * amc:
            order = sup["max_months"] * amc - closing - on_order
            if order > 0:
                supplied = round(order * rng.uniform(*sup["fill_rate"]))
                arrival = t + (2 if rng.random() < sup["delay_prob"] else 1)
                pending[arrival] = pending.get(arrival, 0) + supplied

        rows.append({
            "period": period,
            "opening_balance": round(opening),
            "quantity_received": round(received),
            "quantity_used": round(used),
            "losses": round(losses),
            "closing_balance": round(closing),
            "expiring_soon": round(expiring_soon),
            "truth": {"demand": int(demand), "stocked_out": bool(stocked_out),
                      "pushed": bool(pushed), "outbreak": mult > 1.0},
        })
    return rows


# ---------------------------------------------------------------- messiness

FIELDS = ["opening_balance", "quantity_received", "quantity_used", "losses", "closing_balance"]


def copy_error(value: int, rng: np.random.Generator) -> int:
    """A plausible human copying mistake."""
    s = str(value)
    kind = rng.choice(["swap", "extra_zero", "drop_digit"])
    if kind == "swap" and len(s) >= 2:
        i = int(rng.integers(0, len(s) - 1))
        s = s[:i] + s[i + 1] + s[i] + s[i + 2:]
    elif kind == "extra_zero":
        s = s + "0"
    elif len(s) >= 2:
        i = int(rng.integers(0, len(s)))
        s = s[:i] + s[i + 1:]
    return int(s) if s else 0


def make_messy(row: dict, loc, cfg, rng) -> dict | None:
    rep = cfg["reporting"]
    missed = rep["missed_rate"]["rural" if loc["rural"] else "urban"]
    if rng.random() < missed:
        return None                                   # report never submitted
    out = dict(row)
    errors = []
    if rng.random() < rep["zero_report_rate"]:
        for f in FIELDS + ["expiring_soon"]:
            out[f] = 0
        errors.append("all_zero")
    elif rng.random() < rep["copy_error_rate"]:
        f = str(rng.choice(FIELDS))
        before = out[f]
        out[f] = copy_error(int(before), rng)
        if out[f] != before:
            errors.append(f"copy_error:{f}:{before}->{out[f]}")
    out["truth"] = {**row["truth"], "injected_errors": errors}
    return out


# ---------------------------------------------------------------- main

def generate(pack: Path) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    cfg = yaml.safe_load((pack / "config.yaml").read_text())
    rng = np.random.default_rng(cfg["seed"])
    start = date.fromisoformat(str(cfg["period"]["start"]))
    n = int(cfg["period"]["months"])

    locations = build_locations(cfg, rng)
    items = load_items(pack)

    reports = []
    for _, loc in locations.iterrows():
        for _, item in items.iterrows():
            for row in simulate_series(loc, item, cfg, rng, start, n):
                messy = make_messy(row, loc, cfg, rng)
                if messy is None:
                    continue
                reports.append({"location_code": loc["code"], "item_code": item["code"], **messy})
    raw = pd.DataFrame(reports)
    return locations, items, raw


def summarise(locations, items, raw) -> None:
    truth = raw["truth"]
    n_err = sum(1 for t in truth if t["injected_errors"])
    expected = len(locations) * len(items) * raw["period"].nunique()
    print(f"Locations: {len(locations)}  Items: {len(items)}  Months: {raw['period'].nunique()}")
    print(f"Reports written: {len(raw):,} of {expected:,} expected "
          f"({expected - len(raw):,} missed, {(expected - len(raw)) / expected:.1%})")
    print(f"Reports with injected errors: {n_err:,} ({n_err / len(raw):.1%})")
    print(f"Months with a stockout (true): {sum(t['stocked_out'] for t in truth) / len(raw):.1%}")
    print(f"Reports with stock expiring within 3 months: {(raw['expiring_soon'] > 0).mean():.1%}")


def write_csv(out_dir: Path, locations, items, raw) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    locations.to_csv(out_dir / "locations.csv", index=False)
    items.to_csv(out_dir / "items.csv", index=False)
    r = raw.copy()
    r["truth"] = r["truth"].map(json.dumps)
    r.to_csv(out_dir / "raw_reports.csv", index=False)
    print(f"CSV files written to {out_dir}")


def write_db(url: str, locations, items, raw, reset: bool) -> None:
    import psycopg

    with psycopg.connect(url) as conn, conn.cursor() as cur:
        if reset:
            cur.execute("TRUNCATE raw_reports, locations, items RESTART IDENTITY CASCADE")

        for _, l in locations.iterrows():
            cur.execute(
                """INSERT INTO locations (code, name, location_type, region, latitude, longitude, attributes)
                   VALUES (%s,%s,%s,%s,%s,%s,%s)
                   ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, location_type = EXCLUDED.location_type,
                     region = EXCLUDED.region, latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,
                     attributes = EXCLUDED.attributes""",
                (l["code"], l["name"], l["location_type"], l["region"], l["latitude"], l["longitude"],
                 json.dumps({"rural": bool(l["rural"]), "size_factor": float(l["size_factor"])})),
            )
        for _, i in items.iterrows():
            cur.execute(
                """INSERT INTO items (code, name, category, unit, unit_cost, shelf_life_months, attributes)
                   VALUES (%s,%s,%s,%s,%s,%s,%s)
                   ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, category = EXCLUDED.category,
                     unit = EXCLUDED.unit, unit_cost = EXCLUDED.unit_cost,
                     shelf_life_months = EXCLUDED.shelf_life_months, attributes = EXCLUDED.attributes""",
                (i["code"], i["name"], i["category"], i["unit"], float(i["unit_cost_kes"]),
                 int(i["shelf_life_months"]),
                 json.dumps({"seasonality": i["seasonality"], "illustrative_cost": True})),
            )

        with cur.copy(
            """COPY raw_reports (location_code, item_code, period, opening_balance, quantity_received,
               quantity_used, losses, closing_balance, expiring_soon, source, payload) FROM STDIN"""
        ) as copy:
            for r in raw.itertuples(index=False):
                copy.write_row((r.location_code, r.item_code, r.period, r.opening_balance,
                                r.quantity_received, r.quantity_used, r.losses, r.closing_balance,
                                r.expiring_soon, "synthetic", json.dumps({"truth": r.truth})))
    print("Written to database.")


def main() -> None:
    p = argparse.ArgumentParser(description="Generate synthetic stock reports for AfyaStock.")
    p.add_argument("--pack", type=Path, default=DEFAULT_PACK, help="domain pack folder")
    p.add_argument("--csv-out", type=Path, help="write CSVs here instead of the database")
    p.add_argument("--reset", action="store_true", help="empty locations, items and raw_reports first")
    args = p.parse_args()

    locations, items, raw = generate(args.pack)
    summarise(locations, items, raw)

    if args.csv_out:
        write_csv(args.csv_out, locations, items, raw)
        return

    from dotenv import load_dotenv
    load_dotenv(REPO_ROOT / ".env")
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise SystemExit("DATABASE_URL is not set. Add it to .env or use --csv-out.")
    write_db(url, locations, items, raw, args.reset)


if __name__ == "__main__":
    main()
