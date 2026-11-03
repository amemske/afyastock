"""Tests for the Essential Medicines List loader.
Unit tests always run; the full-PDF checks run only when the PDF is present (it is not in the repo)."""
import pytest

from ml.afyastock_ml.guidance import DEFAULT_PDF, Entry, Form, clean, passage, refs_in, section_depth


def char(text, x0, top, size=3.8):
    return {"text": text, "x0": x0, "x1": x0 + 2, "top": top, "size": size}


def test_superscripts_become_footnote_numbers():
    chars = [char("2", 100, 50), char("8", 102, 50), char("3", 120, 50)]   # "28" then a gap then "3"
    assert refs_in((90, 40, 200, 60), chars) == [28, 3]
    assert refs_in((300, 40, 400, 60), chars) == []


def test_section_headings_and_odd_characters():
    assert section_depth("7.2.1 Access Group Antibiotics") == 3
    assert section_depth("3. MEDICINES for PAIN") == 1
    assert section_depth("Use with caution") is None
    assert clean("1\ufffd ANAESTHETICS\n  and  GASES") == "1. ANAESTHETICS and GASES"


def test_passage_carries_level_of_use_and_notes():
    e = Entry(number="3.1.4", name="Ibuprofen", page=11, section=["3. PAIN"], section_notes=["Use with caution."],
              forms=[Form("Oral liquid", "100mg/5mL [c]", 2, [32]), Form("Tablet", "200mg", None)])
    text = passage(e, {32: "Do not use in children aged <3 months old."})
    assert "level of use 2 (dispensary/clinic)" in text and "Children's formulation" in text
    assert "level of use not stated" in text
    assert "Note 32: Do not use in children" in text and "page 11" in text


@pytest.fixture(scope="module")
def parsed():
    if not DEFAULT_PDF.exists():
        pytest.skip("KEML PDF not downloaded")
    from ml.afyastock_ml.guidance import parse_pdf
    return parse_pdf(DEFAULT_PDF)


def find(entries, name):
    return next(e for e in entries if e.name == name)


def test_every_form_in_the_list_is_found(parsed):
    entries, footnotes, _ = parsed
    assert sum(len(e.forms) for e in entries) == 1335        # total stated in the list's summary


def test_every_footnote_reference_resolves(parsed):
    entries, footnotes, _ = parsed
    refs = {n for e in entries for n in e.footnotes + [x for f in e.forms for x in f.footnotes]}
    assert refs and refs <= set(footnotes)


def test_known_entries(parsed):
    entries, footnotes, explanatory = parsed
    assert {f.lou for f in find(entries, "Ceftriaxone").forms} == {4}
    assert "At Level 2, use restricted" in footnotes[115]
    assert {f.lou for f in find(entries, "Oxytocin").forms} == {2}
    assert "Watch Group" in " ".join(find(entries, "Ceftriaxone").section)
    assert "lowest level" in explanatory["Level of use"]
