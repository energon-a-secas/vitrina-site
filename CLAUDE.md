# CLAUDE.md: Vitrina

A display case for Spanish-language science fiction paperbacks. Every book is
its real scanned spine, hotlinked from tercerafundacion.net, standing at a
height derived from the edition's dimensions in centimetres with the width taken
from the scan's own aspect ratio. Three views: the shelf, a cover gallery, and
774 catalogue records to browse and add from. The shelf is seeded from
`data/library.json` and then lives in `localStorage`.

**Live:** vitrina.neorgon.com · **Port:** 8881

## Run

```bash
make serve      # http://localhost:8881
```

ES modules, so it must be served over HTTP. `file://` blocks them.

## The data pipeline

The catalogue has no API. `scripts/scrape.py` is a polite cached client (1.2s
between requests, descriptive User-Agent, every page cached under
`data/.cache/`, which is gitignored). Modes, in the order they are run:

```bash
python3 scripts/scrape.py resolve   # wantlist.json -> candidates.json
python3 scripts/rank.py             # candidates -> ranked.json + data/briefs/
                                    #   (a human or an agent then writes picks.json)
python3 scripts/scrape.py detail    # picks.json  -> library.json
python3 scripts/scrape.py catalog   # -> catalog.json, the browsable collections
python3 scripts/scrape.py spines    # marks has_spine on library.json
```

`scripts/tf.py` holds all parsing and touches no network, so it can be tested
against a saved page.

## Gotchas

**The search has three modes and only one of them finds everything.**
`tipo=titulo` returns rich `tf-libro-en-ficha` records but matches work titles
and misses plenty: `Elantris` returns zero. `tipo=libro` returns compact
`li.tf-buscar-item` rows carrying only an id and author names, but it finds
everything. So `resolve` asks the rich mode first, falls back to the compact
one, follows a hit to its detail page for the work id, and reads the work page
(`/ver/ficha/<id>`), which lists every edition with the full record. Changing
that order silently drops books.

**A collection listing omits the collection on every record.** The page itself
is the collection, so `Colección:` is absent and the number lives in
`<span class="tf-numero-titulo">Nº 205</span>` inside the heading. Parse a
listing without passing `context=` to `parse_records` and 667 of 774 records
arrive with no collection and the number glued to the front of the title.

**The catalogue appends `EN VENTA` to some stored titles.** It is a for-sale
marker, not part of the title. `tf.clean_title` strips it.

**A missing spine is answered with an HTML 404, not an image.** So availability
cannot be read from the URL; `scrape.py spines` records it, `shelf.js` honours
`has_spine: false` by drawing a spine instead of firing a doomed request, and
the image `error` handler is the second line of defence for anything unchecked.

**Book height is the only number the layout needs.** The spine scan's aspect
ratio already encodes thickness, so `shelf.js` sets the height from
`dimensions` (`12×19` means 19cm) and computes the exact width on image load.
Do not add a thickness field; `thicknessCm()` from the page count exists only to
reserve layout space and to size a drawn spine.

**The owner's shelf labels are memory, not metadata.** Seventeen of the
thirty-nine books are filed under an imprint that never published that edition:
the Chanur novels and the Homecoming saga sit under "B de Bolsillo" but are Nova
and VIB. `entry.shelf` keeps the owner's own filing because that is how the
books physically stand; `Group: Collection` shows what the catalogue says. Never
silently rewrite one into the other.

**Nothing third-party is stored.** Images are hotlinked, back cover copy is not
captured at all (see the comment in `tf.parse_book`), and `data/.cache/` and
`data/images/` are gitignored. If the catalogue ever blocks hotlinking,
`scripts/scrape.py cache-images` builds a local copy and `data.js` is the one
place that maps an id to an image URL.

**A collection number is not a unique key.** The catalogue numbers the whole
saga del retorno as VIB 11, so three owned volumes share that number. In
`collectionRuns()` a slot holds a LIST; keying it by number alone silently
dropped two of the four VIB books and the count read 37 of 39. A slot with
several owned volumes orders them by `subcollection_number`.

**`.stage` needs an explicit width.** `main` is a flex column, and `margin: 0
auto` on a flex item disables cross-axis stretch. With no definite width the
browser sizes the item to max-content and clamps it to `max-width`, so the
13,900px Nova row in the whole-collection view pinned the stage at a flat
1400px and scrolled the whole page sideways. `width: 100%` fixes it;
`min-width: 0` alone does not. Same shape, same fix, on `.provenance`.

**Images have a three-step chain.** The catalogue first, then `data/images/`
(written by `scrape.py cache-images`, gitignored), then the drawn spine. The
middle step exists so the shelf survives a blocked hotlink or no network; on
the published page it simply 404s and the drawn spine takes over. `data.js` is
the only place an id becomes an image URL.
