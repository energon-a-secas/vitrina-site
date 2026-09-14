<div align="center">

# Vitrina

A shelf read by its spines

[![Live][badge-site]][url-site]
[![HTML5][badge-html]][url-html]
[![CSS3][badge-css]][url-css]
[![JavaScript][badge-js]][url-js]
[![Claude Code][badge-claude]][url-claude]
[![License][badge-license]](LICENSE)

[badge-site]:    https://img.shields.io/badge/live_site-0063e5?style=for-the-badge&logo=googlechrome&logoColor=white
[badge-html]:    https://img.shields.io/badge/HTML5-E34F26?style=for-the-badge&logo=html5&logoColor=white
[badge-css]:     https://img.shields.io/badge/CSS3-1572B6?style=for-the-badge&logo=css3&logoColor=white
[badge-js]:      https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black
[badge-claude]:  https://img.shields.io/badge/Claude_Code-CC785C?style=for-the-badge&logo=anthropic&logoColor=white
[badge-license]: https://img.shields.io/badge/license-MIT-404040?style=for-the-badge

[url-site]:   https://vitrina.neorgon.com/
[url-html]:   #
[url-css]:    #
[url-js]:     #
[url-claude]: https://claude.ai/code

</div>

---

## Overview

Vitrina stands a collection of Spanish-language science fiction paperbacks on a
shelf built from their real spine scans. Each book is rendered at the height its
catalogue record gives in centimetres, and the width comes from the scan's own
aspect ratio, so a row comes out as uneven as the shelf it was photographed
from. Click a spine and the book turns around: cover, imprint, translator, cover
artist, table of contents.

It exists because the covers of the Ediciones B lines of the late 1980s and
1990s are hard to find anywhere else. [La Tercera Fundación][tf] scanned them,
and this is a way to stand in front of them.

**Live:** vitrina.neorgon.com

[tf]: https://tercerafundacion.net/biblioteca/

---

## Features

- **Spines at true proportions** -- height from the book's real dimensions,
  width from the scan's aspect ratio, so no two look alike
- **A drawn spine when there is no scan** -- flat and lettered, never passing
  for the real thing, so the shelf stays complete and honest
- **Three views** -- the shelf, a cover gallery, and the catalogue to browse
- **Group and order** -- by your own shelf labels, by the catalogue's
  collection, by author, series or decade; ordered by collection number, which
  is how they would actually stand
- **A real shelf to look at first** -- `/demo/` shows a real collection
  read-only, so the finished thing is visible before you start your own at
  `/shelf/`, which begins empty
- **The whole collection** -- one toggle draws every catalogued volume of each
  collection you own from, your books lit and the rest dimmed, so Nova reads as
  13 of 365 rather than 13. Click a dimmed one to put it on the shelf
- **Gaps in your series** -- volumes the catalogue numbers in a series you
  already collect, one click from the shelf
- **Add from the catalogue** -- 774 records across the five collections this
  shelf touches, each arriving with its cover and spine
- **Add by hand** -- for a book no catalogue has, with your own image URLs
- **Shelf report** -- how many centimetres of shelf, which authors, which
  editions have no spine scan
- **Your browser or your account** -- signed out, the shelf stays in this
  browser; sign in with a Neorgon account and it is kept in your account, on
  every device you sign in on. Nothing is public unless you publish it
- **This browser's books, moved when you say** -- signing in never moves them by
  itself: the page offers to add them to your account and fill in the notes and
  labels it lacks, then to clear this browser's copy of what the account holds in
  full
- **Shared shelves at `/u/?handle`** -- reserve your shelf's address from Share
  now. Publishing opens later, and until then nobody else can see any shelf. A
  published shelf shows its address, its catalogue books and your shelf labels,
  never notes, dates or books added by hand
- **Delete my Vitrina data** -- in Share, with an export offered first; the
  address is then held for 30 days so nobody else can take it
- **Export and import** -- the shelf exports to JSON and imports back; into an
  account, an import only adds books and never removes one

---

## Keyboard

| Key | Does |
|---|---|
| `1` `2` `3` | Shelf, Covers, Browse |
| `/` | Focus the search box |
| `a` | Add a book |
| `←` `→` | Walk along the row with a book open |
| `Esc` | Close the drawer or dialog |

---

## Where the data comes from

[La Tercera Fundación][tf] is a volunteer catalogue of Spanish-language science
fiction, and it has no public API, so `scripts/scrape.py` reads it: one request
every 1.2 seconds, a descriptive User-Agent, and an on-disk cache so a re-run
costs nothing. `robots.txt` allows crawlers in general and disallows `ClaudeBot`,
so the owner runs it and a Claude session never does.

**Images are hotlinked, apart from small thumbnails of the shelf's own books.**
The catalogue serves them from Cloudflare with a one-year cache header and no
hotlink protection, so the only cover art in this repo is `assets/thumbs/`,
described below. Otherwise it carries bibliographic facts only: titles, authors,
imprints, ISBNs, formats, page counts, tables of contents. Back cover copy is
deliberately not stored; the drawer links to the record instead.

```bash
python3 scripts/scrape.py resolve   # my list -> candidate editions
python3 scripts/scrape.py detail    # picked editions -> data/library.json
python3 scripts/scrape.py catalog   # the collections my books live in
python3 scripts/scrape.py spines    # which editions have a scanned spine
python3 scripts/scrape.py cache-images            # local fallback copies
python3 scripts/scrape.py cache-images --catalog  # ...for every browsable record
python3 scripts/thumbs.py                         # WebP thumbnails of your own books
```

Your own books are served from `assets/thumbs/`, sized to what the page paints:
the shelf's 31 spines drop from 218 KB to 84 KB and its 39 covers from 1.4 MB
to 563 KB. Everything else is asked of the catalogue, which is most of what the
whole-collection view draws and is why this repo carries a copy of what is on
the page and nothing more. If a request fails the shelf tries the catalogue,
then the gitignored `data/images/` cache, then gives up and draws a spine.

`scripts/rank.py` scores the candidates for each wanted title and writes one
brief per book, which is what makes choosing between four editions of the same
novel a reading job rather than a guessing one.

---

## Running locally

ES modules require an HTTP server (not `file://`):

```bash
make serve      # http://localhost:8881
make validate   # every test, plain node and python, no install
make routes     # regenerate /shelf/, /demo/ and /u/ from _templates/app.html
```

`make validate` needs a Node that strips TypeScript types by default (verified on v25.4.0).
The backend tests import `convex/lib/*.ts` directly, and a Node without that stops at the
first of those imports.

---

## Backend

A signed-in person's shelf is kept in Convex, in the `vitrina-site` project, one
row per book under their Clerk account id; no email or name is stored. A
catalogue book's row holds its catalogue id and what the person wrote about
their copy: a shelf label, a note, the name they list it under and the date they
added it. The bibliographic record is read from `data/` in the browser, so
nothing from the catalogue is copied per person. A book added by hand also keeps
a short record (title, authors, year, pages, publisher, collection, dimensions,
`https:` image URLs). Beyond the books an account has an optional handle, a
published switch, a running count of its books and bytes (at most 2000 books and
8 MiB), and rate-limit records, swept once they are 31 days old. Erasing an
account deletes all of it except a suspension, and holds the handle for 30 days.

Signing in is the fleet's Neorgon Auth Kit, on the one production Clerk instance
every Neorgon site shares. A visitor with no Neorgon session downloads neither
clerk-js nor the Convex client on `/shelf/` or `/demo/`; `/u/` loads the client
to read a shared shelf. The shelf kept in a browser never moves to an account on
its own.

Publishing ships closed: until the owner sets `PUBLISHING` to `open` on the
production deployment, no shelf is public, whatever its switch says. A published
shelf shows the handle, its catalogue books and their shelf labels, never notes,
dates or books added by hand.

```bash
make install    # npm install, for the Convex CLI only; the site itself needs none
make where      # which deployment the pages name, and which one .env.local pushes to
make push-dev   # push convex/ to the dev deployment once
make deploy     # deploy convex/ to production; it asks for confirmation
```

The functions in `convex/` are thin wrappers over `convex/lib/`, which
`make validate` tests against an in-memory database. `scripts/convex_smoke.py`
calls the deployed ones end to end, on dev or on production.

---

## Architecture

![Architecture](docs/architecture.svg)

```
vitrina-site/
├── index.html              # the home page, which loads no app code
├── _templates/
│   └── app.html            # app shell: controls, three views, drawer, dialogs
├── shelf/ demo/ u/         # the three app pages, generated by make routes
├── css/
│   ├── style.css           # site styles; tokens come from the CDN base.css
│   └── neorgon-*.css       # vendored with the header, footer, beacon and auth kits
├── js/
│   ├── app.js              # entry point: loads, renders, then hands over to account.js or profile.js
│   ├── state.js            # the shelf, prefs and which shelf is shown; the only module that writes the shelf
│   ├── syncplan.js         # pure: between a browser shelf and an account shelf
│   ├── backend.js          # the deployment a page names, every Convex function name, the loaders
│   ├── account.js          # /shelf/: whose shelf is shown, and every write to the account
│   ├── session.js          # what account.js shares with the modules that cannot import it
│   ├── strips.js           # the notices above /shelf/, and moving a browser shelf into an account
│   ├── profile.js          # /u/: a shared shelf, and its owner's own view of it
│   ├── share.js            # the Share dialog: address, publishing, deleting your data
│   ├── accountplan.js      # pure: what account.js, strips.js, profile.js and share.js decide
│   ├── keyguard.js         # pure: which keys the page leaves to a dialog or menu it does not own
│   ├── overflow.js         # hides the header kit's ⋯ toggle while nothing in it is drawn
│   ├── handles.js          # handle rules, mirrored from convex/lib/handles.ts
│   ├── data.js             # loading, grouping, ordering, series gaps, the remote-image switch
│   ├── shelf.js            # spine geometry: cm to pixels, aspect to width
│   ├── render.js           # the three views
│   ├── detail.js           # the drawer for one book
│   ├── browse.js           # the catalogue, with owned books marked
│   ├── modals.js           # add, import, export, shelf report
│   ├── events.js           # every listener, and the Shelf tools menu; no inline onclick
│   ├── utils.js            # folding, parsing cm and years, toast, download
│   └── neorgon-*.js        # vendored kits, the Auth Kit among them; never edited here
├── convex/
│   ├── schema.ts           # profiles, entries, shelfMeta, heldHandles, erasures, suspendedSubjects, rateEvents
│   ├── shelf.ts            # shelf:mine and the three shelf writes
│   ├── profiles.ts         # handles, publishing, byHandle, deleteMyData
│   ├── admin.ts            # moderation, for ADMIN_SUBJECTS only
│   ├── purge.ts            # erasure in batches, and the daily sweeps crons.ts runs
│   ├── http.ts             # the Clerk user.deleted webhook
│   └── lib/                # every rule, as cores make validate imports with no install
├── tests/                  # every one runs under make validate, with no install
│   └── support/
│       ├── fakedb.mjs      # an in-memory Convex database for the convex/lib tests
│       ├── minidom.mjs     # a small DOM the flow tests load a generated page into
│       └── shelfworld.mjs  # a Convex deployment, a client and the Auth Kit, faked for the flow tests
├── scripts/
│   ├── tf.py               # parser for tercerafundacion.net, no network in it
│   ├── scrape.py           # the polite, cached client and its five modes
│   ├── rank.py             # scores candidate editions, writes per-book briefs
│   ├── routes.py           # writes /shelf/, /demo/ and /u/ from the template
│   ├── catalog_ids.py      # keeps catalogue ids append-only
│   └── convex_smoke.py     # calls the deployed functions on dev or production
└── data/
    ├── wantlist.json       # what I own, by hand
    ├── candidates.json     # every catalogued edition of each wanted title
    ├── picks.json          # which edition, and why
    ├── library.json        # the shelf: 39 books, full records
    ├── catalog.json        # 774 browsable records across 5 collections
    └── spines.json         # which editions have a scanned spine
```

---

<div align="center">
<sub>Part of <a href="https://neorgon.com/">Neorgon</a></sub>
</div>
