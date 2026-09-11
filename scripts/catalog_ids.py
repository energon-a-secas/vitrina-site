#!/usr/bin/env python3
"""Keep the catalogue's ids append-only.

    python3 scripts/catalog_ids.py          report HEAD's ids against the working copy
    python3 scripts/catalog_ids.py --check  exit 1 when an id at HEAD is missing (make validate)

An account shelf stores a catalogue book as tf<id> and nothing more; the browser
resolves the record from library.json or catalog.json. So an id that disappears
from data/catalog.json turns that book, on every account that has it, into "A
book no longer in the catalogue", and there is nothing in the account to rebuild
it from. `scrape.py catalog` merges into the existing file for that reason
(merge_catalog below), and this check is what notices a run or a hand edit that
did not.

The book list is not the first list in the file: collection headers come
first, and they carry integer ids too. What tells the two apart is the title, so
the ids are read from lists whose every record has an integer id and a title.
"""

import argparse
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
REL = "data/catalog.json"


def record_ids(blob):
    """Ids of every record in any list of records carrying an integer id and a
    title, or None when the file holds no such list (which is a broken file,
    not an empty catalogue)."""
    ids = set()
    found = False

    def is_book(rec):
        rid = rec.get("id") if isinstance(rec, dict) else None
        # bool is an int in Python, and True is not a catalogue id.
        return isinstance(rid, int) and not isinstance(rid, bool) and "title" in rec

    def walk(node):
        nonlocal found
        if isinstance(node, list):
            if node and all(is_book(rec) for rec in node):
                found = True
                ids.update(rec["id"] for rec in node)
                return
            for item in node:
                walk(item)
        elif isinstance(node, dict):
            for value in node.values():
                walk(value)

    walk(blob)
    return ids if found else None


def merge_catalog(existing, source, collections, books):
    """What `scrape.py catalog` writes: this crawl's collections and records,
    plus every record and collection header from the existing file that this
    crawl did not produce.

    Kept are the collections the shelf no longer touches (the crawl follows
    library.json, so a book leaving the demo shelf would otherwise drop its
    whole collection) and records a listing stopped showing. A record this crawl
    did produce replaces the old copy, so fixes to the parser still land.
    """
    old = existing if isinstance(existing, dict) else {}
    fresh_books = {rec["id"] for rec in books}
    fresh_collections = {head["id"] for head in collections}
    kept_books = [rec for rec in old.get("books") or []
                  if isinstance(rec, dict) and rec.get("id") is not None and rec["id"] not in fresh_books]
    kept_collections = [head for head in old.get("collections") or []
                        if isinstance(head, dict) and head.get("id") not in fresh_collections]
    kept_collections.sort(key=lambda head: str(head.get("id")))
    return {
        "source": source,
        "collections": list(collections) + kept_collections,
        "books": list(books) + kept_books,
    }


def head_catalog():
    try:
        out = subprocess.run(["git", "-C", ROOT, "show", "HEAD:" + REL],
                             capture_output=True, check=True)
    except (OSError, subprocess.CalledProcessError) as err:
        detail = getattr(err, "stderr", b"") or b""
        raise SystemExit("FAIL could not read %s at HEAD: %s"
                         % (REL, detail.decode("utf-8", "replace").strip() or err))
    return json.loads(out.stdout.decode("utf-8"))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true", help="exit 1 when an id at HEAD is missing")
    ap.add_argument("--file", default=os.path.join(ROOT, REL),
                    help="the working copy to compare (default data/catalog.json); a test points it at a doctored copy")
    args = ap.parse_args()

    head_ids = record_ids(head_catalog())
    if head_ids is None:
        raise SystemExit("FAIL %s at HEAD has no list of records with integer ids and titles" % REL)

    try:
        with open(args.file, encoding="utf-8") as fh:
            working = json.load(fh)
    except (OSError, ValueError) as err:
        raise SystemExit("FAIL could not read %s: %s" % (args.file, err))
    work_ids = record_ids(working)
    if work_ids is None:
        raise SystemExit("FAIL %s has no list of records with integer ids and titles" % args.file)

    missing = sorted(head_ids - work_ids)
    if missing:
        preview = ", ".join(str(i) for i in missing[:10]) + (" and %d more" % (len(missing) - 10) if len(missing) > 10 else "")
        print("FAIL %d catalogue id(s) committed at HEAD are missing from %s: %s" % (len(missing), args.file, preview))
        print("     Account shelves store tf<id> and read the record from this file, so those books would")
        print("     show as no longer in the catalogue. Merge them back rather than dropping them.")
        sys.exit(1 if args.check else 0)

    print("catalogue ids append-only: all %d ids at HEAD present, %d new in the working copy"
          % (len(head_ids), len(work_ids - head_ids)))


if __name__ == "__main__":
    main()
