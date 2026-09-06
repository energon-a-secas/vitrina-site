#!/usr/bin/env python3
"""Rank each want's candidate editions, then write one brief per want.

The ranking is mechanical and deliberately conservative: it orders candidates
and states why, but it does not decide. The interesting cases are the ones where
the shelf label and the catalogue disagree, and those want a reader, not a score.

    python3 scripts/rank.py            # write data/ranked.json + briefs/
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
BRIEFS = os.path.join(DATA, "briefs")

# The shelf labels in wantlist.json, as the catalogue writes them.
# Measured from the candidate pool 2026-09-06: the headings in the owner's list
# are literally `Colección` + `Editorial`, so this is a lookup, not a guess.
SHELF = {
    "Nova":           {"collection": "Nova",            "publisher": "Ediciones B"},
    "B de Bolsillo":  {"collection": "Ciencia Ficción", "publisher": "B de Bolsillo"},
    "Zeta Bolsillo":  {"collection": "Ciencia Ficción", "publisher": "Zeta Bolsillo"},
}


def score(rec, want, spines):
    """Higher is better. Returns (points, reasons)."""
    pts, why = 0, []
    target = SHELF.get(want.get("shelf"), {})

    if target.get("publisher") and rec.get("publisher") == target["publisher"]:
        pts += 50
        why.append("publisher is the one on the shelf label")
    elif rec.get("publisher") in ("Ediciones B", "B de Bolsillo", "Zeta Bolsillo", "B de Books"):
        pts += 12
        why.append("same publishing house, different imprint")

    if target.get("collection") and rec.get("collection") == target["collection"]:
        pts += 40
        why.append("collection is the one on the shelf label")

    if spines.get(str(rec["id"])):
        pts += 30
        why.append("has a scanned spine")
    else:
        why.append("NO scanned spine")

    if rec.get("collection_number"):
        pts += 5
        why.append("numbered in its collection")

    fmt = (rec.get("format") or "").lower()
    if "digital" in fmt or "digital" in (rec.get("collection") or "").lower():
        pts -= 40
        why.append("digital edition, not a paperback")
    if "cartoné" in fmt or "tapa dura" in fmt:
        pts -= 5
        why.append("hardback")

    if rec.get("cover") and rec.get("year"):
        yr = "".join(c for c in rec["year"] if c.isdigit())[-4:]
        if yr.isdigit() and int(yr) < 2000:
            pts += 8
            why.append("pre-2000 printing, the covers this shelf is for")
    return pts, why


def main():
    wants = json.load(open(os.path.join(DATA, "candidates.json"), encoding="utf-8"))
    spath = os.path.join(DATA, "spines.json")
    spines = json.load(open(spath, encoding="utf-8")) if os.path.exists(spath) else {}
    os.makedirs(BRIEFS, exist_ok=True)

    ranked = []
    for entry in wants:
        want = entry["want"]
        scored = []
        for rec in entry["candidates"]:
            pts, why = score(rec, want, spines)
            r = dict(rec)
            r["has_spine"] = bool(spines.get(str(rec["id"])))
            r["score"] = pts
            r["why"] = why
            scored.append(r)
        scored.sort(key=lambda r: -r["score"])
        item = {"want": want, "route": entry.get("route"), "ranked": scored}
        ranked.append(item)
        with open(os.path.join(BRIEFS, want["slug"] + ".json"), "w", encoding="utf-8") as fh:
            json.dump(item, fh, ensure_ascii=False, indent=1)
            fh.write("\n")

    with open(os.path.join(DATA, "ranked.json"), "w", encoding="utf-8") as fh:
        json.dump(ranked, fh, ensure_ascii=False, indent=1)
        fh.write("\n")

    print("%d briefs -> %s" % (len(ranked), BRIEFS))
    clean = sum(1 for r in ranked if r["ranked"] and r["ranked"][0]["score"] >= 120)
    nospine = sum(1 for r in ranked if r["ranked"] and not r["ranked"][0]["has_spine"])
    print("  %d have an unambiguous top candidate (score >= 120)" % clean)
    print("  %d have a top candidate with no scanned spine" % nospine)
    for r in ranked:
        top = r["ranked"][0] if r["ranked"] else None
        flag = "" if top and top["score"] >= 120 else "   <-- needs a reader"
        print("  %-38s %-28s %-14s %3s %s%s" % (
            r["want"]["title"][:38],
            (top["collection"] if top else "?") or "-",
            (top["publisher"] if top else "?") or "-",
            top["score"] if top else "-",
            "spine" if top and top["has_spine"] else "NO SPINE",
            flag))


if __name__ == "__main__":
    main()
