#!/usr/bin/env python3
"""Build small WebP thumbnails of the shelf's own books.

Why this exists, and why it covers only the 39 books on the shelf:

The catalogue serves the originals, and the page asks it first for every
volume it draws. That is deliberate: the whole-collection view draws 564
spines and republishing all of them is not this project's business.

But a spine is 22 KB at the source and is drawn about 30 pixels wide, and
the shelf's own books are the ones on screen in every view, every time. So
those, and only those, get a copy sized to what the page actually paints.
The other 525 stay hotlinked and unchanged.

Input is data/images/ (gitignored, written by `scrape.py cache-images`).
Output is assets/thumbs/, which IS committed, because it is what the
published page serves.

Sizes come from the CSS, not from taste:
  spine  285px tall on the shelf (19cm x UNIT_PX 15), 232px in the drawer
  cover  168px wide in the drawer, ~150px in the covers grid
Both are generated at 2x for high-density screens and never upscaled.

Spines get the generous end of that because they are the critical path: the
default view is 564 of them and nothing else. Covers are only reached by
opening the Covers tab or a book, so they are sized to the drawer and no
larger.
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(ROOT, "data", "images")
OUT = os.path.join(ROOT, "assets", "thumbs")
LIBRARY = os.path.join(ROOT, "data", "library.json")

SPINE_H = 570   # 2x the 285px the shelf draws
COVER_W = 340   # 2x the 168px drawer cover, the largest one ever painted
QUALITY = 82


def main():
    try:
        from PIL import Image
    except ImportError:
        sys.exit("needs Pillow: python3 -m pip install pillow")

    if not os.path.isdir(SRC):
        sys.exit("no %s; run `python3 scripts/scrape.py cache-images` first" % SRC)
    with open(LIBRARY, encoding="utf-8") as fh:
        books = json.load(fh)["books"]
    ids = sorted({b["id"] for b in books if b.get("id") is not None})

    os.makedirs(OUT, exist_ok=True)
    made = {"spine": [], "cover": []}
    src_bytes = out_bytes = 0
    skipped = 0

    for bid in ids:
        for kind, prefix, box in (("spine", "lomo", ("h", SPINE_H)),
                                  ("cover", "portada", ("w", COVER_W))):
            src = os.path.join(SRC, "%s-%08d.jpg" % (prefix, bid))
            if not os.path.exists(src):
                skipped += 1
                continue
            dest = os.path.join(OUT, "%s-%08d.webp" % (prefix, bid))
            im = Image.open(src)
            im = im.convert("RGB")
            w, h = im.size
            if box[0] == "h":
                scale = min(1.0, box[1] / float(h))     # never upscale
            else:
                scale = min(1.0, box[1] / float(w))
            if scale < 1.0:
                im = im.resize((max(1, int(w * scale)), max(1, int(h * scale))),
                               Image.LANCZOS)
            im.save(dest, "WEBP", quality=QUALITY, method=6)
            made[kind].append(bid)
            src_bytes += os.path.getsize(src)
            out_bytes += os.path.getsize(dest)

    made["spine"].sort()
    made["cover"].sort()
    with open(os.path.join(OUT, "index.json"), "w", encoding="utf-8") as fh:
        json.dump(made, fh, separators=(",", ":"), sort_keys=True)
        fh.write("\n")

    n = len(made["spine"]) + len(made["cover"])
    print("%d thumbnails: %d spines, %d covers (%d source images had no scan)"
          % (n, len(made["spine"]), len(made["cover"]), skipped))
    if n:
        print("%.1f MB of originals -> %.0f KB (%.0f%% smaller, %.1f KB each)"
              % (src_bytes / 1048576.0, out_bytes / 1024.0,
                 100 * (1 - out_bytes / float(src_bytes)), out_bytes / 1024.0 / n))
    print("-> %s" % OUT)


if __name__ == "__main__":
    main()
