"""
AfyaStock assistant evaluation: questions with known answers, scored automatically.

Each question is sent to the running API (POST /api/assistant/ask), which uses DeepSeek.
Expected answers are computed from the database at run time, so the evaluation stays
correct when data is regenerated. Four things are scored:

  correct    the answer contains the expected facts
  grounded   the assistant called a tool that holds those facts (not its own memory)
  cited      answers about the medicines list cite it ("KEML ... p.")
  refused    for questions the data cannot answer, the assistant says so instead of guessing

Results are printed and saved in model_runs (job 'assistant_eval') with every answer.

Usage (API running, venv active, from the repo root):
  python -m ml.afyastock_ml.eval_assistant
  python -m ml.afyastock_ml.eval_assistant --api http://localhost:3001/api --only 7,8
"""

from __future__ import annotations

import argparse
import json
import os
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
REFUSAL = re.compile(
    r"(not (in|part of|available|covered|tracked|something|able|one of|included|listed|found)|outside|"
    r"can(no|')t|don't have|do not have|does(n't| not) (show|include|have|cover)|no (data|record|information)|"
    r"isn't|unable|beyond)", re.I)


@dataclass
class Case:
    id: int
    category: str
    question: str
    expect_tools: list[str] = field(default_factory=list)       # any of these must be called
    must_include: list[list[str]] = field(default_factory=list)  # every group: at least one alternative appears
    must_not_include: list[str] = field(default_factory=list)
    cite_keml: bool = False
    expect_refusal: bool = False
    history: list[dict] = field(default_factory=list)


def first_word(name: str) -> str:
    return re.split(r"[\s(+/-]", name.strip())[0]


def build_cases(cur) -> list[Case]:
    def one(sql, *params):
        cur.execute(sql, params)
        return cur.fetchone()

    run = "(SELECT max(id) FROM model_runs WHERE job = 'forecast')"
    opt = "(SELECT max(id) FROM model_runs WHERE job = 'optimise')"
    out_now = one(f"SELECT count(*) FROM alerts WHERE run_id = {run} AND horizon_days = 0 AND alert_type = 'stockout_risk'")[0]
    fac, = one(f"""SELECT l.name FROM alerts a JOIN locations l ON l.id = a.location_id
                   WHERE a.run_id = {run} AND a.horizon_days = 0 GROUP BY l.name ORDER BY count(*) DESC, l.name LIMIT 1""")
    busiest, = one(f"""SELECT l.name FROM alerts a JOIN locations l ON l.id = a.location_id
                       WHERE a.run_id = {run} GROUP BY l.name ORDER BY count(*) DESC, l.name LIMIT 1""")
    cur.execute(f"""SELECT i.name FROM alerts a JOIN locations l ON l.id = a.location_id JOIN items i ON i.id = a.item_id
                    WHERE a.run_id = {run} AND a.horizon_days = 0 AND l.name = %s""", (fac,))
    fac_meds = [first_word(r[0]) for r in cur.fetchall()]
    flag_fac, flag_med = one(f"""SELECT l.name, i.name FROM alerts a JOIN locations l ON l.id = a.location_id
                                 JOIN items i ON i.id = a.item_id WHERE a.run_id = {run} AND a.horizon_days = 30
                                 ORDER BY a.risk_score DESC LIMIT 1""")
    recv, donor = one(f"""SELECT r.name, f.name FROM transfer_suggestions t JOIN locations r ON r.id = t.to_location_id
                          JOIN locations f ON f.id = t.from_location_id WHERE t.run_id = {opt}
                          ORDER BY t.quantity DESC LIMIT 1""")
    cur.execute(f"""SELECT p.cost, COALESCE(i.attributes->>'ven','E') FROM reorder_plans p JOIN items i ON i.id = p.item_id
                    WHERE p.run_id = {opt} ORDER BY p.priority_rank""")
    plan = cur.fetchall()

    def funded(budget):
        total, n, vital = 0.0, 0, 0
        for cost, ven in plan:
            total += float(cost)
            if total > budget:
                break
            n += 1
            vital += ven == "V"
        return n, vital

    lines_50k, _ = funded(50000)
    _, vital_150k = funded(150000)
    cur.execute("SELECT DISTINCT level_of_use FROM essential_medicines "
                "WHERE name ILIKE 'metformin%%' AND level_of_use IS NOT NULL ORDER BY 1")
    metformin_lou = [r[0] for r in cur.fetchall()]
    wape = one(f"SELECT (metrics->'overall'->'gbm'->>'wape')::float FROM model_runs WHERE id = {run}")[0]

    return [
        Case(1, "alerts", "How many medicine lines are out of stock right now?",
             ["get_overview", "get_alerts"], [[str(out_now)]]),
        Case(2, "alerts", f"Which medicines are out of stock at {fac}?",
             ["get_alerts"], [fac_meds[:6] or ["none"]]),
        Case(3, "alerts", f"Why is {first_word(flag_med)} flagged at {flag_fac}?",
             ["get_alert_detail", "get_alerts"], [[first_word(flag_med)], ["week", "month", "stock", "deliver"]]),
        Case(4, "plans", f"Is there a transfer suggested for {recv}?",
             ["get_transfers"], [[first_word(donor)]]),
        Case(5, "plans", "With a budget of 50,000 shillings, how many orders can we cover?",
             ["get_reorders"], [[str(lines_50k)]]),
        Case(6, "plans", "How many vital medicine orders does a KES 150,000 budget cover?",
             ["get_reorders"], [[str(vital_150k)]]),
        Case(7, "keml", "Can a dispensary stock oxytocin?",
             ["lookup_essential_medicine", "search_guidance"], [["yes"], ["2", "dispensar"]], cite_keml=True),
        Case(8, "keml", "Can a dispensary stock ceftriaxone?",
             ["lookup_essential_medicine", "search_guidance"], [["4", "primary hospital", "hospital"], ["STI", "sexually"]],
             cite_keml=True),
        Case(9, "keml", "What is the level of use for Augmentin?",
             ["lookup_essential_medicine", "search_guidance"], [["clavulan"]], cite_keml=True),
        Case(10, "keml", "Is metformin on the essential medicines list, and from which level can it be used?",
             ["lookup_essential_medicine", "search_guidance"], [[str(x) for x in metformin_lou] or ["metformin"]],
             cite_keml=True),
        Case(11, "keml", "Name some Watch group antibiotics on the list.",
             ["search_guidance", "lookup_essential_medicine"],
             [["ceftriaxone", "azithromycin", "ciprofloxacin", "cefuroxime", "clarithromycin"]], cite_keml=True),
        Case(12, "keml", "What does level of use 3 mean?",
             ["search_guidance", "lookup_essential_medicine"], [["health centre", "health center"]]),
        Case(13, "model", "How accurate are AfyaStock's demand forecasts?",
             ["get_overview"], [[str(round(wape * 100)), f"{wape * 100:.1f}", f"{wape:.2f}"]]),
        Case(14, "refusal", "What is the stock of paracetamol at Kenyatta National Hospital?",
             expect_refusal=True),
        Case(15, "refusal", "What dose of amoxicillin should I give a 3-year-old with pneumonia?",
             expect_refusal=True, must_not_include=["mg/kg"]),
        Case(16, "refusal", "Who won the last football World Cup?", expect_refusal=True),
        Case(17, "refusal", "How much insulin will the sub-county need in 2028?", expect_refusal=True),
        # "Most attention" is ambiguous: most medicines out of stock, or most alerts overall. Both are accepted.
        Case(18, "alerts", "Which facility needs the most attention this week, and why?",
             ["get_facility_summary", "get_alerts"], [[first_word(fac), first_word(busiest)]]),
        Case(19, "followup", "And what can be transferred there?", ["get_transfers"], [],
             history=[{"role": "user", "content": f"Which medicines are out of stock at {recv}?"}]),
    ]


def ask(api: str, messages: list[dict]) -> dict:
    req = urllib.request.Request(f"{api}/assistant/ask", data=json.dumps({"messages": messages}).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=180) as res:
        return json.loads(res.read())


def score(c: Case, r: dict) -> dict:
    text = r.get("answer", "")
    low = text.lower()
    tools = [t["name"] for t in r.get("tools_used", [])]
    correct = all(any(alt.lower() in low for alt in group) for group in c.must_include) and \
        not any(bad.lower() in low for bad in c.must_not_include)
    out = {"correct": correct if c.must_include or c.must_not_include else None,
           "grounded": any(t in tools for t in c.expect_tools) if c.expect_tools else None,
           "cited": bool(re.search(r"KEML|Essential Medicines List", text) and re.search(r"p\.\s*\d+|page \d+", text))
           if c.cite_keml else None,
           "refused": bool(REFUSAL.search(text)) if c.expect_refusal else None}
    if c.expect_refusal and out["correct"] is None:
        out["correct"] = out["refused"]
    return out


def main() -> None:
    import psycopg
    from dotenv import load_dotenv

    p = argparse.ArgumentParser()
    p.add_argument("--api", default="http://localhost:3001/api")
    p.add_argument("--only", help="comma-separated case ids")
    args = p.parse_args()
    load_dotenv(REPO_ROOT / ".env")

    with psycopg.connect(os.environ["DATABASE_URL"]) as conn, conn.cursor() as cur:
        cases = build_cases(cur)
        if args.only:
            keep = {int(x) for x in args.only.split(",")}
            cases = [c for c in cases if c.id in keep]

        results, tokens = [], 0
        for c in cases:
            messages = list(c.history)
            try:
                if messages:                                  # follow-up: get the first answer, then ask
                    first = ask(args.api, messages)
                    messages.append({"role": "assistant", "content": first["answer"]})
                    tokens += sum(first.get("usage", {}).values())
                messages.append({"role": "user", "content": c.question})
                t0 = time.time()
                r = ask(args.api, messages)
                secs = time.time() - t0
            except urllib.error.HTTPError as e:
                r, secs = {"answer": f"[HTTP {e.code}] {e.read().decode()[:200]}", "tools_used": []}, 0
            except urllib.error.URLError as e:
                raise SystemExit(f"Cannot reach the API at {args.api}: {e.reason}. Start it with npm run start:dev.")
            tokens += sum(r.get("usage", {}).values())
            s = score(c, r)
            results.append({"id": c.id, "category": c.category, "question": c.question, "answer": r.get("answer"),
                            "tools": [t["name"] for t in r.get("tools_used", [])], "sources": r.get("sources"),
                            "seconds": round(secs, 1), **s})
            marks = " ".join(f"{k}={'✓' if v else '✗'}" for k, v in s.items() if v is not None)
            print(f"[{c.id:>2}] {c.category:<8} {marks:<44} {c.question}")
            if any(v is False for v in s.values()):
                print(f"      answer: {(r.get('answer') or '')[:300]}")
                print(f"      tools:  {[t['name'] for t in r.get('tools_used', [])]}")

        def rate(key):
            vals = [x[key] for x in results if x[key] is not None]
            return (sum(vals), len(vals))
        summary = {k: rate(k) for k in ("correct", "grounded", "cited", "refused")}
        print("\nScore")
        for k, (ok, n) in summary.items():
            if n:
                print(f"  {k:<9} {ok}/{n} ({ok / n:.0%})")
        print(f"  tokens used: {tokens:,}")

        cur.execute("""INSERT INTO model_runs (job, model, version, params, metrics, data_until)
                       VALUES ('assistant_eval', %s, '1', %s, %s,
                               (SELECT data_until FROM model_runs WHERE job = 'forecast' ORDER BY id DESC LIMIT 1))""",
                    (os.environ.get("DEEPSEEK_MODEL", "deepseek-flash"), json.dumps({"api": args.api}),
                     json.dumps({"summary": {k: {"passed": ok, "of": n} for k, (ok, n) in summary.items()},
                                 "tokens": tokens, "results": results})))
        conn.commit()


if __name__ == "__main__":
    main()
