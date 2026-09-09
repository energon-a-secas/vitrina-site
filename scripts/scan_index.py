#!/usr/bin/env python3
"""Build the ISBN scan index: the smallest file that can resolve a barcode.

Why it is separate from catalog.json. The catalogue carries a table of
contents, translators, cover artists and a format string, which is what the
drawer shows and none of what a scan needs. At 46 bytes per record gzipped it
is the wrong thing to grow, and growing it is the point: the five collections
scraped today are the owner's, and somebody else scanning their own Spanish
science fiction needs collections nobody here has scraped yet. This index costs
about 27 bytes per record instead, so a far wider slice of Tercera Fundacion
fits in a file the page can load only when the scanner opens.

Every ISBN is stored as its ISBN-13 form, because that is what a barcode is and
because 406 of the catalogue's 771 are ISBN-10. One key can hold several
editions: 48 keys cover 109 records, and the worst holds four. The index keeps
all of them, in the order the resolver should offer them.
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CATALOG = os.path.join(ROOT, "data", "catalog.json")
OUT = os.path.join(ROOT, "data", "scan-index.json")


def check13(body: str) -> str:
    total = sum(int(d) * (3 if i % 2 else 1) for i, d in enumerate(body))
    return str((10 - (total % 10)) % 10)


def to13(raw) -> str | None:
    v = "".join(c for c in str(raw or "").upper() if c.isdigit() or c == "X")
    if len(v) == 13 and v.isdigit():
        return v
    if len(v) == 10:
        body = "978" + v[:9]
        return body + check13(body)
    return None


def year_of(raw) -> int:
    """Catalogue years are free-form Spanish ('abr 1992'), so take the digits."""
    digits = "".join(c if c.isdigit() else " " for c in str(raw or "")).split()
    for chunk in digits:
        if len(chunk) == 4:
            return int(chunk)
    return 0


def main() -> None:
    with open(CATALOG, encoding="utf-8") as fh:
        cat = json.load(fh)
    books = cat["books"]
    collections = {c["id"]: c for c in cat.get("collections", [])}

    index: dict[str, list] = {}
    skipped = 0
    for b in books:
        k = to13(b.get("isbn"))
        if not k:
            skipped += 1
            continue
        index.setdefault(k, []).append({
            "i": b["id"],
            "t": b.get("title"),
            "a": (b.get("authors") or [None])[0],
            "y": b.get("year"),
            "c": b.get("collection_id"),
            "n": b.get("collection_number"),
            "d": b.get("dimensions"),
            "p": b.get("pages"),
        })

    # Oldest printing first inside a shared key: on this shelf the early edition
    # is the one with the cover art worth having, and it is the likelier answer.
    for entries in index.values():
        entries.sort(key=lambda e: year_of(e.get("y")))

    payload = {
        "source": cat.get("source"),
        "collections": {str(c["id"]): {"name": c["name"], "publisher": c.get("publisher")}
                        for c in collections.values()},
        "isbn": index,
    }
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))
        fh.write("\n")

    shared = sum(1 for v in index.values() if len(v) > 1)
    size = os.path.getsize(OUT)
    print("%d keys from %d records (%d had no usable ISBN)" % (len(index), len(books), skipped))
    print("%d keys hold more than one edition; the largest holds %d"
          % (shared, max((len(v) for v in index.values()), default=0)))
    print("%.0f KB raw, about %d bytes per record" % (size / 1024, size / max(1, len(books))))
    print("-> %s" % OUT)


if __name__ == "__main__":
    main()
