"""
AfyaStock guidance loader: Kenya Essential Medicines List (KEML) 2023 PDF -> searchable reference data.

What it produces
  essential_medicines   one row per medicine x dose form x strength, with its level of use (LOU),
                        section, footnotes and printed page: the structured facts the assistant
                        looks up ("can a dispensary stock ceftriaxone?").
  guidance_chunks       one readable passage per medicine (all its forms together, with section
                        notes and footnotes), plus passages from the list's explanatory pages
                        (level-of-use definitions, AWaRe antibiotic groups). Full-text searchable.

How the PDF is read
  The list is a bordered table: #, Name of Medicine, Dose-form, Strength / Size, LOU.
  - Rows with a number start a medicine; rows without one add another form or strength to it.
  - Rows with only the first cell filled are section headings ("7.2.1 Access group antibiotics"),
    sometimes followed by a usage note.
  - Footnote markers are printed smaller (3.8pt vs 6.5pt) and are separated from the text by font
    size; the footnotes themselves are read from below each table and may continue across pages.

The PDF is a Ministry of Health publication and is not committed to the repo. Download it to
data/guidance/kenya-essential-medicines-list-2023.pdf (see README).

Usage (from the repo root, with the venv active):
  python -m ml.afyastock_ml.guidance
  python -m ml.afyastock_ml.guidance --ask "ceftriaxone"     # try a lookup afterwards
"""

from __future__ import annotations

import argparse
import os
import re
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_PDF = REPO_ROOT / "data" / "guidance" / "kenya-essential-medicines-list-2023.pdf"
TITLE = "Kenya Essential Medicines List 2023"
SOURCE_URL = "https://www.health.go.ke"   # publisher; the exact download link changes over time

HEADER = ["#", "Name of Medicine", "Dose-form", "Strength / Size", "LOU"]
SUPERSCRIPT_MAX_SIZE = 5.0          # footnote markers are ~3.8pt; body text ~6.5pt
PRINTED_PAGE_OFFSET = 10            # PDF page index - 10 = page number printed in the list
LEVELS = {1: "community health services", 2: "dispensary/clinic", 3: "health centre",
          4: "primary hospital", 5: "secondary hospital", 6: "tertiary hospital"}
FOOTER = re.compile(r"^(\d+\s+)?Kenya Essential Medicines List 2023(\s+\d+)?$")


# ---------------------------------------------------------------- data model

@dataclass
class Form:
    dose_form: str
    strength: str
    lou: int | None
    footnotes: list[int] = field(default_factory=list)


@dataclass
class Entry:
    number: str
    name: str
    page: int
    section: list[str]
    section_notes: list[str]
    footnotes: list[int] = field(default_factory=list)
    forms: list[Form] = field(default_factory=list)


def clean(text: str | None) -> str:
    if not text:
        return ""
    return re.sub(r"\s+", " ", text.replace("\ufffd", ".").replace("\u2010", "-")).strip()


# ---------------------------------------------------------------- parsing

def section_depth(heading: str) -> int | None:
    m = re.match(r"^(\d+(?:\.\d+)*)\.?\s", heading)
    return m.group(1).count(".") + 1 if m else None


def parse_pdf(path: Path) -> tuple[list[Entry], dict[int, str], dict[str, str]]:
    """Returns (entries, footnotes by number, explanatory text by topic)."""
    import pdfplumber

    entries: list[Entry] = []
    footnotes: dict[int, str] = {}
    last_note: int | None = None
    sections: list[tuple[int, str, list[str]]] = []       # (depth, title, notes)
    current: Entry | None = None
    current_form = ""

    with pdfplumber.open(path) as pdf:
        explanatory = explanatory_text(pdf)
        for idx, page in enumerate(pdf.pages):
            body = page.filter(lambda o: o.get("object_type") != "char" or o["size"] >= SUPERSCRIPT_MAX_SIZE)
            tables = [t for t in body.find_tables() if (t.extract() or [[]])[0][:5] == HEADER]
            if not tables:
                continue
            small = [c for c in page.chars if c["size"] < SUPERSCRIPT_MAX_SIZE and c["text"].isdigit()]
            printed = idx - PRINTED_PAGE_OFFSET

            for table in tables:
                for row_obj, row in zip(table.rows[1:], table.extract()[1:]):
                    cells = [clean(c) for c in (row + [None] * 5)[:5]]
                    marks = [refs_in(cell_bbox, small) for cell_bbox in (row_obj.cells + [None] * 5)[:5]]
                    num, name, form, strength, lou = cells

                    if num and not any([name, form, strength, lou]):            # section heading row
                        title, *notes = [clean(x) for x in (row[0] or "").split("\n")]
                        depth = section_depth(title)
                        if depth is None:                                     # stray note line
                            if sections:
                                sections[-1][2].append(clean(row[0]))
                            continue
                        sections = [s for s in sections if s[0] < depth] + [(depth, title, [" ".join(notes)] if notes else [])]
                        current = None
                        continue

                    if num and name:                                           # new medicine
                        current = Entry(number=num, name=name, page=printed,
                                        section=[s[1] for s in sections],
                                        section_notes=[n for s in sections for n in s[2] if n],
                                        footnotes=marks[1])
                        entries.append(current)
                        current_form = ""
                    if current is None or not (strength or lou or form):
                        continue
                    current_form = form or current_form
                    current.forms.append(Form(dose_form=current_form, strength=strength,
                                              lou=int(lou) if lou.isdigit() else None,
                                              footnotes=sorted(set(marks[2] + marks[3] + marks[4]))))

                # footnotes printed below this table
                below = page.crop((0, table.bbox[3], page.width, page.height)).extract_text() or ""
                for line in below.split("\n"):
                    line = line.strip()
                    if not line or FOOTER.match(line):
                        continue
                    m = re.match(r"^(\d{1,3})\s+(.*)$", line)
                    n = int(m.group(1)) if m else None
                    if n is not None and (last_note is None or 0 < n - last_note <= 5):
                        footnotes[n], last_note = clean(m.group(2)), n
                    elif last_note is not None:                              # continuation line
                        footnotes[last_note] = clean(footnotes[last_note] + " " + line)
    return entries, footnotes, explanatory


def refs_in(bbox, small_chars) -> list[int]:
    """Footnote numbers (superscript digits) printed inside a table cell."""
    if bbox is None:
        return []
    x0, top, x1, bottom = bbox
    inside = sorted((c for c in small_chars if x0 <= c["x0"] < x1 and top <= c["top"] < bottom),
                    key=lambda c: (round(c["top"]), c["x0"]))
    refs, digits, last_x = [], "", None
    for c in inside:
        if last_x is not None and c["x0"] - last_x > 3:                    # gap: a new number starts
            refs.append(int(digits))
            digits = ""
        digits += c["text"]
        last_x = c["x1"]
    if digits:
        refs.append(int(digits))
    return refs


def explanatory_text(pdf) -> dict[str, str]:
    """The list's own explanations the assistant may need to cite."""
    full = "\n".join((p.extract_text() or "") for p in pdf.pages[:20])
    out = {}
    m = re.search(r"Level of Use\s*\n(This indicates.*?)(?:Kenya Essential Medicines List 2023|Summary of Main)", full, re.S)
    if m:
        out["Level of use"] = clean(m.group(1))
    m = re.search(r"(Access antibiotics have.*?)(?:\n[A-Z][a-z]+ [a-z]+ the KEML|\Z)", full, re.S)
    if m:
        out["AWaRe antibiotic groups"] = clean(m.group(1))[:1500]
    return out


# ---------------------------------------------------------------- passages

def passage(e: Entry, footnotes: dict[int, str]) -> str:
    """One readable passage per medicine, with everything needed to answer from it alone."""
    lines = [f"{e.name} ({TITLE}, entry {e.number}, page {e.page})."]
    if e.section:
        lines.append("Section: " + " > ".join(e.section) + ".")
    for f in e.forms:
        where = f"level of use {f.lou} ({LEVELS.get(f.lou, 'unknown')})" if f.lou else "level of use not stated"
        child = " Children's formulation." if "[c]" in f.strength else ""
        lines.append(f"- {f.dose_form or 'Form not stated'}, {f.strength.replace('[c]', '').strip()}: {where}.{child}")
    notes = sorted(set(e.footnotes + [n for f in e.forms for n in f.footnotes]))
    for n in notes:
        if n in footnotes:
            lines.append(f"Note {n}: {footnotes[n]}")
    for s in e.section_notes:
        lines.append(f"Section note: {s}")
    return "\n".join(lines)


# ---------------------------------------------------------------- database

MIGRATION = """
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS essential_medicines (
    id             SERIAL PRIMARY KEY,
    document_id    INTEGER NOT NULL REFERENCES guidance_documents(id) ON DELETE CASCADE,
    entry_number   TEXT NOT NULL,
    name           TEXT NOT NULL,
    dose_form      TEXT,
    strength       TEXT,
    level_of_use   INTEGER,
    notes          TEXT,
    section        TEXT,
    page           INTEGER
);
CREATE INDEX IF NOT EXISTS idx_em_name_trgm ON essential_medicines USING gin (name gin_trgm_ops);

ALTER TABLE guidance_chunks ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE guidance_chunks ADD COLUMN IF NOT EXISTS search tsvector
    GENERATED ALWAYS AS (to_tsvector('english', coalesce(title, '') || ' ' || content)) STORED;
CREATE INDEX IF NOT EXISTS idx_chunks_search ON guidance_chunks USING gin (search);
CREATE INDEX IF NOT EXISTS idx_chunks_title_trgm ON guidance_chunks USING gin (title gin_trgm_ops);
"""


def save(conn, entries: list[Entry], footnotes: dict[int, str], explanatory: dict[str, str]) -> int:
    with conn.cursor() as cur:
        cur.execute(MIGRATION)
        cur.execute("DELETE FROM guidance_documents WHERE title = %s", (TITLE,))   # reload cleanly
        cur.execute("INSERT INTO guidance_documents (title, source_url, pack) VALUES (%s, %s, 'health') RETURNING id",
                    (TITLE, SOURCE_URL))
        doc_id = cur.fetchone()[0]
        i = 0
        for topic, text in explanatory.items():
            cur.execute("INSERT INTO guidance_chunks (document_id, chunk_index, title, content, page) VALUES (%s,%s,%s,%s,%s)",
                        (doc_id, i, topic, f"{topic} ({TITLE}): {text}", None))
            i += 1
        for e in entries:
            cur.execute("INSERT INTO guidance_chunks (document_id, chunk_index, title, content, page) VALUES (%s,%s,%s,%s,%s)",
                        (doc_id, i, e.name, passage(e, footnotes), e.page))
            i += 1
            for f in e.forms:
                refs = sorted(set(e.footnotes + f.footnotes))
                notes = " ".join(f"[{n}] {footnotes[n]}" for n in refs if n in footnotes) or None
                cur.execute("""INSERT INTO essential_medicines (document_id, entry_number, name, dose_form, strength,
                               level_of_use, notes, section, page) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                            (doc_id, e.number, e.name, f.dose_form, f.strength, f.lou, notes,
                             " > ".join(e.section), e.page))
    return doc_id


LOOKUP_SQL = """
SELECT name, dose_form, strength, level_of_use, notes, section, page,
       greatest(similarity(name, %(q)s), CASE WHEN name ILIKE '%%' || %(q)s || '%%' THEN 0.6 ELSE 0 END) AS score
  FROM essential_medicines
 WHERE name ILIKE '%%' || %(q)s || '%%' OR similarity(name, %(q)s) > 0.3
 ORDER BY score DESC, name, level_of_use
 LIMIT 20
"""

SEARCH_SQL = """
SELECT title, content, page, ts_rank(search, websearch_to_tsquery('english', %(q)s)) AS score
  FROM guidance_chunks
 WHERE search @@ websearch_to_tsquery('english', %(q)s)
 ORDER BY score DESC
 LIMIT 5
"""


def main() -> None:
    import psycopg
    from dotenv import load_dotenv

    p = argparse.ArgumentParser(description="Load the Kenya Essential Medicines List into the database.")
    p.add_argument("--pdf", type=Path, default=DEFAULT_PDF)
    p.add_argument("--ask", help="after loading, look up a medicine name and search the passages")
    p.add_argument("--skip-load", action="store_true", help="only run --ask against what is already loaded")
    args = p.parse_args()

    load_dotenv(REPO_ROOT / ".env")
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise SystemExit("DATABASE_URL is not set. Add it to .env.")

    with psycopg.connect(url) as conn:
        if not args.skip_load:
            if not args.pdf.exists():
                raise SystemExit(f"PDF not found at {args.pdf}. Download the KEML 2023 and save it there.")
            entries, footnotes, explanatory = parse_pdf(args.pdf)
            save(conn, entries, footnotes, explanatory)
            forms = sum(len(e.forms) for e in entries)
            print(f"Loaded {len(entries):,} medicines ({forms:,} forms and strengths), "
                  f"{len(footnotes):,} footnotes, {len(explanatory)} explanatory passages.")
            no_lou = sum(1 for e in entries for f in e.forms if f.lou is None)
            print(f"Forms without a level of use: {no_lou}")
        if args.ask:
            with conn.cursor() as cur:
                cur.execute(LOOKUP_SQL, {"q": args.ask})
                for name, form, strength, lou, notes, section, page, _ in cur.fetchall():
                    print(f"- {name}: {form} {strength}, LOU {lou} ({LEVELS.get(lou, '?')}), p.{page}"
                          + (f"\n    {notes[:160]}" if notes else ""))
                cur.execute(SEARCH_SQL, {"q": args.ask})
                hits = cur.fetchall()
                if hits:
                    print("\nBest passage:\n" + hits[0][1])


if __name__ == "__main__":
    main()
