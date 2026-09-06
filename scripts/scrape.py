#!/usr/bin/env python3
"""Build Vitrina's data files from tercerafundacion.net.

    python3 scripts/scrape.py resolve      # my list -> candidate editions
    python3 scripts/scrape.py detail       # picked editions -> library.json
    python3 scripts/scrape.py catalog      # the collections my books live in
    python3 scripts/scrape.py spines       # which editions have a scanned spine
    python3 scripts/scrape.py cache-images # optional offline copy, gitignored

Every mode is idempotent and reads through an on-disk HTML cache under
`data/.cache/`, so re-running costs no requests. Pass `--refresh` to re-fetch.

Why the site is scraped at all: tercerafundacion.net has no public API. It is a
volunteer catalogue and the only place the 1980s and 1990s Spanish covers are
scanned, which is the whole point of this shelf. The client waits 1.2s between
requests, sends a descriptive User-Agent, and caches everything it reads.
robots.txt allows it (`Allow: /`, `search=yes`); the `ai-train=no` signal is
respected: nothing here trains anything.
"""

import argparse
import json
import os
import re
import sys
import time
import unicodedata

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tf  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
CACHE = os.path.join(DATA, ".cache")

WANTLIST = os.path.join(DATA, "wantlist.json")      # what I own, by hand
CANDIDATES = os.path.join(DATA, "candidates.json")  # search results per want
PICKS = os.path.join(DATA, "picks.json")            # want -> chosen book id
LIBRARY = os.path.join(DATA, "library.json")        # the shelf, full records
CATALOG = os.path.join(DATA, "catalog.json")        # browsable collections
IMAGES = os.path.join(DATA, "images")



def norm(s):
    """Casefold, strip accents and punctuation. For matching titles only."""
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9 ]+", " ", s.lower()).strip()


def load(path, default=None):
    if not os.path.exists(path):
        return default
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


# ── resolve ───────────────────────────────────────────────────────────

def _title_match(a, b):
    """Loose enough for `Ilion I: El asedio` against `Ilion`, tight enough that
    `Proteo` does not swallow `Proteo desencadenado`."""
    na, nb = norm(a), norm(b)
    if not na or not nb:
        return False
    return na == nb or na in nb or nb in na


def _author_match(want_authors, got_authors):
    """Surnames only. The catalogue writes `C. J. Cherryh`, a wantlist may say
    `Cherryh, C. J.`, and an anthology lists thirty names."""
    if not want_authors or not got_authors:
        return True
    wanted = {w for a in want_authors for w in norm(a).split() if len(w) > 3}
    got = {w for a in got_authors for w in norm(a).split() if len(w) > 3}
    return bool(wanted & got)


def cmd_resolve(args):
    """Find every catalogued edition of each wanted title.

    Three search modes exist and only one of them is reliable:

      tipo=titulo  rich `tf-libro-en-ficha` records, but it matches work titles
                   and misses plenty (`Elantris` returns nothing)
      tipo=libro   compact `li.tf-buscar-item` rows, id and author only, but it
                   finds everything
      (untyped)    a mixed bag, capped at ten per kind

    So: ask the rich mode first and take it when it answers, otherwise fall back
    to the compact mode, follow one hit to its detail page for the work id, and
    read the work page, which lists every edition with the full record."""
    wants = load(WANTLIST)
    if not wants:
        sys.exit("no %s; write the wantlist first" % WANTLIST)
    fetch = tf.Fetcher(CACHE, refresh=args.refresh)
    out = []
    for i, want in enumerate(wants, 1):
        queries = [want["title"]] + [q for q in want.get("queries", []) if q != want["title"]]
        cands, route, compact = [], None, []

        for q in queries:
            recs = tf.parse_records(fetch.get(tf.search_url(q, "titulo")))
            hit = [r for r in recs if _title_match(want["title"], r["title"])
                   and _author_match(want.get("authors"), r["authors"])]
            if hit:
                cands, route = recs, "titulo"
                break

        if not cands:
            for q in queries:
                rows = tf.parse_compact(fetch.get(tf.search_url(q, "libro")))
                compact = [r for r in rows if _title_match(want["title"], r["title"])
                           and _author_match(want.get("authors"), r["authors"])]
                if not compact:
                    continue
                seen_work = set()
                for row in compact[:3]:
                    detail = tf.parse_book(fetch.get(tf.book_url(row["id"])))
                    if not detail:
                        continue
                    wid = detail.get("work_id")
                    if wid and wid not in seen_work:
                        seen_work.add(wid)
                        cands += tf.parse_records(fetch.get(tf.work_url(wid)))
                    elif not wid:
                        cands.append(detail)
                    if cands:
                        route = "libro+ficha"
                        break
                if cands:
                    break

        by_id = {}
        for rec in cands:
            by_id.setdefault(rec["id"], rec)
        cands = list(by_id.values())
        print("[%2d/%d] %-40s %2d candidates  via %s"
              % (i, len(wants), want["title"][:40], len(cands), route or "nothing"))
        out.append({"want": want, "route": route, "candidates": cands,
                    "compact_seen": compact[:12]})
    tf.dump(CANDIDATES, out)
    empty = [o["want"]["title"] for o in out if not o["candidates"]]
    print("\n%s  (cache %d hit / %d fetched)" % (CANDIDATES, fetch.hits, fetch.misses))
    if empty:
        print("no candidates for %d: %s" % (len(empty), "; ".join(empty)))


# ── detail ───────────────────────────────────────────────────────────────────

def cmd_detail(args):
    """Fetch the chosen editions' detail pages and write library.json."""
    picks = load(PICKS)
    if not picks:
        sys.exit("no %s; run resolve and pick editions first" % PICKS)
    fetch = tf.Fetcher(CACHE, refresh=args.refresh)
    books = []
    for i, pick in enumerate(picks, 1):
        bid = pick["book_id"]
        if bid is None:
            books.append({
                "id": None, "slug": pick["slug"], "title": pick["title"],
                "authors": pick.get("authors", []), "unmatched": True,
                "note_mine": pick.get("note"),
            })
            print("[%2d/%d] %-42s not in the catalogue" % (i, len(picks), pick["title"][:42]))
            continue
        rec = tf.parse_book(fetch.get(tf.book_url(bid)))
        if rec is None:
            print("[%2d/%d] %-42s parse failed (id %s)" % (i, len(picks), pick["title"][:42], bid))
            continue
        rec["slug"] = pick["slug"]
        rec["shelf"] = pick.get("shelf")
        rec["note_mine"] = pick.get("note")
        rec["listed_as"] = pick.get("listed_as")
        books.append(rec)
        print("[%2d/%d] %-42s %s / %s %s" % (
            i, len(picks), rec["title"][:42], rec["publisher"],
            rec["collection"], rec["collection_number"] or ""))
    tf.dump(LIBRARY, {"source": tf.BASE, "books": books})
    print("\n%s  (%d books, cache %d hit / %d fetched)"
          % (LIBRARY, len(books), fetch.hits, fetch.misses))


# ── catalog ───────────────────────────────────────────────────────────

# `url`, `spine` and `cover` are pure functions of `id`, and the *_ids are
# catalogue-internal keys nothing here follows. Storing them costs more than
# half the file, so the browser rebuilds them instead (see js/data.js).
DERIVABLE = ("url", "spine", "cover", "author_ids", "series_ids",
             "publisher_country", "has_spine")


def cmd_catalog(args):
    """Crawl the listing pages of every collection the shelf touches, so the
    app can browse what is missing. Listings carry the full record, so no
    detail page is fetched here."""
    ids = args.collections
    if not ids:
        lib = load(LIBRARY) or {"books": []}
        ids = sorted({b["collection_id"] for b in lib["books"] if b.get("collection_id")})
    if not ids:
        sys.exit("no collections; run detail first or pass --collections 3 ...")
    fetch = tf.Fetcher(CACHE, refresh=args.refresh)
    collections, books, seen = [], [], set()
    for cid in ids:
        first = fetch.get(tf.collection_url(cid, 1))
        head = tf.parse_collection_header(first)
        _, total = tf.parse_pagination(first)
        head["pages"] = total
        print("collection %-5s %-28s %s books, %s pages"
              % (cid, (head["name"] or "?")[:28], head["count"], total))
        pages = [first] + [fetch.get(tf.collection_url(cid, p)) for p in range(2, total + 1)]
        got = 0
        for p, page in enumerate(pages, 1):
            # A listing omits the collection on every record, because the page
            # itself is the collection. Hand it back or 667 of 774 records
            # arrive with no collection and the number stuck to the title.
            recs = tf.parse_records(page, context=head)
            for rec in recs:
                if rec["id"] in seen:
                    continue
                seen.add(rec["id"])
                for k in DERIVABLE:
                    rec.pop(k, None)
                for k in [k for k, v in rec.items() if v in (None, [], "")]:
                    rec.pop(k)
                books.append(rec)
                got += 1
            print("   page %2d/%d  +%d" % (p, total, len(recs)))
        # `Total N elementos` only renders when a listing paginates.
        if head.get("count") is None:
            head["count"] = got
        collections.append(head)
    books.sort(key=lambda r: (r.get("collection_id") or 0,
                              _numkey(r.get("collection_number")), r["id"]))
    tf.dump(CATALOG, {"source": tf.BASE, "collections": collections, "books": books})
    orphans = [b["id"] for b in books if not b.get("collection_id")]
    print("\n%s  (%d books across %d collections, cache %d hit / %d fetched)"
          % (CATALOG, len(books), len(collections), fetch.hits, fetch.misses))
    if orphans:
        print("WARNING: %d records carry no collection: %s" % (len(orphans), orphans[:10]))


def _numkey(n):
    m = re.match(r"\d+", str(n or ""))
    return int(m.group()) if m else 10 ** 6


# ── spines ───────────────────────────────────────────────────────────────────

def cmd_spines(args):
    """Mark which records actually have a scanned spine. A missing spine is the
    single most visible defect on a shelf built out of spines, so it is checked
    rather than assumed, and the app falls back to a drawn spine."""
    paths = [LIBRARY] + ([CATALOG] if args.catalog else [])
    targets = []
    for path in paths:
        blob = load(path)
        if blob:
            targets.append((path, blob))
    if not targets:
        sys.exit("nothing to check; run detail or catalog first")
    fetch = tf.Fetcher(CACHE)
    # A HEAD that failed because the network blinked was written as "no spine"
    # and then never asked again, so one bad moment removed a book's art for
    # good. --refresh is the way back, and it has to actually clear the record.
    known = {} if args.refresh else (load(os.path.join(DATA, "spines.json"), {}) or {})
    checked = 0
    for path, blob in targets:
        for rec in blob["books"]:
            bid = rec.get("id")
            if bid is None or str(bid) in known:
                continue
            known[str(bid)] = fetch.head_ok(tf.SPINE % bid)
            checked += 1
            if checked % 25 == 0:
                print("  checked %d..." % checked)
        for rec in blob["books"]:
            if rec.get("id") is not None:
                rec["has_spine"] = known.get(str(rec["id"]), False)
        tf.dump(path, blob)
    tf.dump(os.path.join(DATA, "spines.json"), known)
    have = sum(1 for v in known.values() if v)
    print("\n%d of %d editions have a scanned spine (%d newly checked)" % (have, len(known), checked))


# ── cache-images ─────────────────────────────────────────────────────────

def cmd_cache_images(args):
    """Download a local copy of the images, as a fallback for the live ones.

    The catalogue serves these itself with a one-year cache header and no
    hotlink protection, so the page asks it first and this repo republishes
    nothing. These copies are what the shelf falls back to when that request
    fails: a blocked hotlink, a dead host, or a laptop with no network. The
    directory is gitignored, so a published page simply never finds them and
    draws a spine instead.

    Default is the shelf's own books. `--catalog` adds every browsable record,
    which is about 1550 files and, at one request every 0.6s, roughly a quarter
    of an hour.
    """
    import urllib.error
    import urllib.request

    ids = []
    lib = load(LIBRARY)
    if lib:
        ids += [b["id"] for b in lib["books"] if b.get("id") is not None]
    if args.catalog:
        cat = load(CATALOG)
        if cat:
            ids += [b["id"] for b in cat["books"] if b.get("id") is not None]
    ids = sorted(set(ids))
    if not ids:
        sys.exit("nothing to cache; run detail first")

    os.makedirs(IMAGES, exist_ok=True)
    got = skipped = missing = failed = 0
    total_bytes = 0
    last = [0.0]
    for n, bid in enumerate(ids, 1):
        for kind, url in (("lomo", tf.SPINE % bid), ("portada", tf.COVER % bid)):
            dest = os.path.join(IMAGES, "%s-%08d.jpg" % (kind, bid))
            if os.path.exists(dest):
                skipped += 1
                continue
            wait = args.delay - (time.time() - last[0])
            if wait > 0:
                time.sleep(wait)
            last[0] = time.time()
            req = urllib.request.Request(url, headers={"User-Agent": tf.UA})
            try:
                with urllib.request.urlopen(req, timeout=30) as resp:
                    data = resp.read()
                    ctype = resp.headers.get("Content-Type", "")
            except urllib.error.HTTPError:
                # No scan for that edition. Expected, and not a failure.
                missing += 1
                continue
            except Exception:                                  # noqa: BLE001
                failed += 1
                continue
            if not ctype.startswith("image/"):
                missing += 1
                continue
            with open(dest, "wb") as fh:
                fh.write(data)
            got += 1
            total_bytes += len(data)
        if n % 50 == 0:
            print("  %d/%d books, %d cached" % (n, len(ids), got), flush=True)

    # An index of what is actually here. Without it the page cannot tell a
    # cached image from one that was never fetched, so every catalogue spine
    # with no scan cost a second, doomed request to this directory: 43 of them
    # on one load of the whole-collection view.
    have = {"spine": [], "cover": []}
    for name in os.listdir(IMAGES):
        m = re.match(r"(lomo|portada)-(\d{8})\.jpg$", name)
        if m:
            have["spine" if m.group(1) == "lomo" else "cover"].append(int(m.group(2)))
    have["spine"].sort()
    have["cover"].sort()
    tf.dump(os.path.join(IMAGES, "index.json"), have)

    print("\n%d images cached (%.1f MB), %d already present, %d never scanned, %d failed"
          % (got, total_bytes / 1048576.0, skipped, missing, failed))
    print("index: %d spines, %d covers" % (len(have["spine"]), len(have["cover"])))
    print("-> %s  (gitignored: the published page uses the catalogue directly)" % IMAGES)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name, fn in (("resolve", cmd_resolve), ("detail", cmd_detail),
                     ("catalog", cmd_catalog), ("spines", cmd_spines),
                     ("cache-images", cmd_cache_images)):
        p = sub.add_parser(name, help=fn.__doc__.split("\n")[0])
        p.add_argument("--refresh", action="store_true", help="ignore the HTML cache")
        if name == "catalog":
            p.add_argument("--collections", type=int, nargs="*", help="collection ids (default: the shelf's own)")
        if name == "cache-images":
            p.add_argument("--catalog", action="store_true",
                           help="also cache every browsable record (about 1550 files, ~15 min)")
            p.add_argument("--delay", type=float, default=0.6,
                           help="seconds between image requests (default 0.6)")
        if name == "spines":
            p.add_argument("--catalog", action="store_true",
                           help="also check the 774 browsable records (about 12 minutes; "
                                "the browse view shows covers and the shelf falls back on a "
                                "failed image, so this is rarely worth it)")
        p.set_defaults(fn=fn)
    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
