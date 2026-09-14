# CLAUDE.md: Vitrina

A display case for Spanish-language science fiction paperbacks. Every book is
its real scanned spine, hotlinked from tercerafundacion.net, standing at a
height derived from the edition's dimensions in centimetres with the width taken
from the scan's own aspect ratio. Three views: the shelf, a cover gallery, and
774 catalogue records to browse and add from.

One template generates three app pages. `/shelf/` is the visitor's own shelf,
which starts empty and lives in `localStorage`; a signed-in person's shelf lives
in the Convex backend under `convex/`. `/demo/` is `data/library.json`, the
maintainer's own shelf, read-only. `/u/?handle` is a shelf somebody published,
read-only. `/` is a static home page. The design contract for accounts and
public shelves is `docs/plans/2026-09-11-vitrina-public-shelves.md` in the
monorepo root.

**Live:** vitrina.neorgon.com · **Port:** 8881

## Run

```bash
make serve      # http://localhost:8881
make validate   # every test, plain node and python, no install
make routes     # regenerate /shelf/, /demo/ and /u/ from _templates/app.html
```

ES modules, so it must be served over HTTP. `file://` blocks them.

## The data pipeline

The catalogue has no API. `scripts/scrape.py` is a polite cached client (1.2s
between requests, descriptive User-Agent, every page cached under
`data/.cache/`, which is gitignored). The owner runs it, never a Claude session
(see the tercerafundacion.net gotcha below). Modes, in the order they are run:

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

## The backend

Convex project `vitrina-site` on team `luciano-adonis-villarroel`. Each handler
in `convex/*.ts` takes the person from `ctx.auth.getUserIdentity()`, never from
an argument, and hands `ctx.db`, `Date.now()` and `process.env` values to a core
in `convex/lib/`, which `make validate` runs against `tests/support/fakedb.mjs`
with no deployment and no install. Expected failures return
`{ ok: false, code, message }` and never throw. `js/backend.js` names every
function a browser may call, and `tests/backend.test.mjs` fails when that list
and `convex/*.ts` disagree.

```bash
make where        # the deployment each page names, and the one .env.local pushes to
make push-dev     # push convex/ to the dev deployment once
python3 scripts/convex_smoke.py --dev    # the whole path on dev, publishing included
python3 scripts/convex_smoke.py --prod   # the safe path on production
npx convex deploy --yes --message "vitrina $(git rev-parse HEAD)"   # production, from a Claude session
```

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

**The only third-party copies stored are the demo shelf's thumbnails.**
`assets/thumbs/` holds small copies of the 39 books in `library.json` (step 1 of
the image chain below). Every other image is hotlinked, back cover copy is not
captured at all (see the comment in `tf.parse_book`), and `data/.cache/` and
`data/images/` are gitignored. The page copy has to match: the provenance line
kept saying "Nothing is copied here" after the thumbnails were committed. If the
catalogue ever blocks hotlinking,
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

**Images have a four-step chain, and the first step is ours.**

1. `assets/thumbs/` for the shelf's own books. Committed and served by this
   site, built by `scripts/thumbs.py` from the cache below, sized to what the
   page actually paints. Only the 39 books on the shelf have one.
2. The catalogue, for everything else. The whole-collection view draws 564
   spines and 525 of them are hotlinked, which is deliberate: this repo
   republishes a copy of what is on the page every time, and nothing more.
3. `data/images/` (gitignored, from `scrape.py cache-images`), so the shelf
   survives a blocked hotlink or no network in development.
4. The drawn spine.

Each step is tried at most once per image, tracked with a `data-tried*` flag on
the element, so a source that fails twice cannot loop. `data.js` is the only
place an id becomes an image URL, and `assets/thumbs/index.json` is what tells
the page a thumbnail exists rather than guessing and eating a 404. While the
remote-image switch is on (see the tercerafundacion.net gotcha), step 2 asks the
catalogue for nothing.

**Regenerate thumbnails after changing the shelf.** `scrape.py cache-images`
then `scripts/thumbs.py`. A book added to `picks.json` without this keeps
working, it just hotlinks like a catalogue volume.

**The search box has to reach every view.** `renderRuns()` originally ignored
`state.query`, and because `showRuns` persists in prefs a returning visitor
opened straight into the whole-collection view where typing did nothing at all.
All three views now run through `matches()` in `data.js`, which is the single
definition of what a query matches. Adding a fourth view means wiring it there
too.

**The local image fallback is gated on an index.** `cache-images` writes
`data/images/index.json`; `data.js` loads it and `hasLocalSpine`/`hasLocalCover`
decide whether a failed image is worth retrying locally. Without that gate the
retry fired for every catalogue spine with no scan, which was 43 doomed requests
on one load of the whole-collection view. The index is inside the gitignored
directory, so the published page never finds it and never retries.

**The light must not live on the scrolling element.** The downlight was a
`::before` on `.shelfrow__case`, which is what scrolls, so on a 365-volume row
the lamp slid away with the books. It now sits on `.shelfrow__case-wrap`, which
does not move. Anything that should stay still belongs on the wrapper; only the
books and the board scroll.

**The Browser pane cannot verify scroll behaviour.** It runs no
`requestAnimationFrame` and dispatches no scroll events even with a real
`clientWidth`, so `data-scroll` and the edge fades cannot be exercised there.
That is why `scrollState()` in `shelf.js` is a pure function with its own test
(`make validate`) rather than logic buried in a listener.

**Scanning has three tiers, cheapest first.** The native `BarcodeDetector`
costs nothing and exists on Android Chrome. The `barcode-detector` ponyfill
(Sec-ant, MIT, zxing wasm) is fetched only when the native one is missing AND
somebody opens the camera: measured 441 KB brotli for the wasm, pulled at
runtime from jsdelivr by the module itself, not by us. Typing the number is
always there and is why the dialog leads with a text field. `js/camera.js`
picks the tier; nothing else needs to know which one ran.

**A camera stream outlives the dialog that started it.** `openModal` and
`closeModal` both run `runCleanups()`, and the scanner registers its teardown
with `onModalClose`. Without that the indicator light stays on after the dialog
closes. Any future dialog holding a resource registers the same way.

**`node --check` on a `.js` file is not a syntax check for these modules.**
Node reads a bare `.js` as CommonJS, where `import` is invalid anyway, and it
passed a genuine double comma inside an import list while the browser refused
the whole module graph and the page lost every handler. `tests/syntax.test.mjs`
copies each module to `.mjs` first, which is what makes node parse it under
module rules. It was tripped both ways before being trusted.

**Vitrina still has no Content-Security-Policy**, and one should not be written
from a resource dump: images are lazy, the ponyfill loads on demand and the
Convex client only when a page needs an account, so a page that has merely been
opened under-reports its own hosts. The list from source is `cdn.neorgon.org`,
`tercerafundacion.net`, `esm.sh`, `fastly.jsdelivr.net` (the wasm, fetched from
inside the ponyfill), `cdn.jsdelivr.net` (the pinned Convex client in
`js/backend.js`), the production Convex deployment, `neorgon.goatcounter.com`,
`gc.zgo.at`, `static.cloudflareinsights.com`, plus `data:` and `blob:`, and it
needs `wasm-unsafe-eval`. Plan section 6 keeps the full list. Verify it against
a page that has actually scrolled the shelf and opened the scanner.

**Four addresses, one app, and the home page is not the app.** `/` is a static
home page that loads no app code. The app runs at `/shelf/` (your own shelf,
editable), `/demo/` (a real collection, read-only) and `/u/` (a shared shelf,
read-only). All three pages are generated from `_templates/app.html` by
`scripts/routes.py`. Never edit `shelf/index.html`, `demo/index.html` or
`u/index.html` by hand: `make validate` runs `routes.py --check` and fails on
drift, tripped both by a hand edit and by a template change left ungenerated.
The only per-route differences are the head (title, description, canonical,
robots, the Convex meta, and on `/u/` the analytics-off and referrer metas), the
header subtitle, the hide-owned label, the footer line, the banner, and
`data-mode` on `<body>`. The template is a `.html` file in an underscore
directory on purpose: Jekyll leaves `_templates/` out of the published site, and
the fleet fixers (`roll-hub-icon.py`, `no-em-dash.py`, the favicon kit) walk
`.html` only, so a hub icon roll rewrites the template and every page together
instead of leaving `--check` red. `routes.py` also refuses a template that lost
a placeholder or kept a mistyped one, a page that came out without its
`data-mode`, which is the attribute the whole read-only layer keys on, and a
route whose mode is not in `export const MODES` in `js/state.js`: `hydrate()`
treats a mode it does not know as the editable shelf, so a mistyped mode would
publish a read-only page that edits and saves. `tests/routes.test.py` trips that
refusal on a throwaway copy.

**Every URL the page resolves is root-absolute.** The app used to live at `/`
and fetched `data/library.json` relative to the page, which at `/demo/` becomes
`/demo/data/library.json` and 404s. It is `/css/`, `/js/`, `/data/` and
`/assets/` now, in the template, `data.js` and `scan.js`. ES module imports stay
relative: they resolve against the module file, not the page. A
`<base href="/">` was shorter and was rejected because it turns the skip link
`#main` into a jump to the home page.

**Read-only has two layers, and only one of them holds.** On `/demo/` and
`/u/`, CSS keyed on `body[data-mode="demo"]` and `body[data-mode="profile"]`
hides the edit controls before any script runs: rendered ones by `data-add` or
`data-act`, the header's by id (`/u/` hides Export too). The header kit and
Shelf tools move controls rather than cloning them, so their ids survive and the
rule still applies inside the mobile menu. That layer is cosmetic. The one that
holds is `state.js`: `addEntry`, `removeEntry`, `updateEntry`, `restoreSeed` and
`importEntries` return early when `state.readOnly` (announcing
`vitrina:read-only`), and also while the source is `account-loading` or
`account-error` or has no complete account adapter (announcing
`vitrina:shelf-not-ready`). Anything that toasts after an edit has to check what
the edit returned: `saveFromAddDialog` and `addFromCatalog` used to report
"added" or "already on your shelf" straight over the read-only notice.
Preferences are not the shelf but had the same leak: on a read-only page
`savePrefs()` keeps only the shortcuts switch, or arranging the demo would open a
visitor's own shelf in Browse. `/u/` also opens on the shelf view without the
whole collection, for that visit only.

**`vitrina_shelf_v1` holds the browser shelf and nothing else.** It is written
only by the local adapter, which `state.js` hands out only while `state.source`
is `local` on an editable page, and by `rewriteBrowserShelf(transform)` and
`clearBrowserShelf()`, which work from storage alone and never from
`state.entries`. So while an account shelf is in memory none of it can reach
that key, and a browser two people share never shows one of them the other's
shelf. `tests/readonly.test.mjs` holds this through every exported function,
with a note marker only an account row carries. `save()` is private and checks
the source again, but no exported path reaches it with another source: it is a
backstop no test can trip, so it is not coverage. An adapter installed with
`setPersistence()` is consulted only while the source is `account`, so one left
behind after a sign-out never receives a browser edit. `state.js` is the only
module that writes `localStorage`; `data.js` reads one flag from it,
`vitrina:no-remote-images`.

**`/shelf/` starts empty, and both empty states have to agree.** It used to seed
from `library.json`, handing every first-time visitor the maintainer's books as
their own, saved on the first edit. With the whole-collection view on by
default, an empty shelf reaches `renderRuns()`, which draws the collections the
shelf owns from, finds none, and used to fall through to a developer message
telling the visitor to run the scraper. It now hands an empty shelf to
`empty()`, which offers "Start from the demo shelf", that is, `restoreSeed()`.
The button checks `storedShelfSize()` first: a tab left open on the empty state
would otherwise overwrite a shelf filled in another tab since. The copy brings
each book's shelf label and nothing else of the maintainer's: no note, no
`listed_as`, no date. It used to keep them, and a browser shelf can later move
to an account, where they would have arrived as the visitor's own.

**`/u/?handle` is a real directory, and publishing ships closed.** GitHub Pages
serves the site's own `404.html` for any unknown path, with HTTP status 404,
verified live on this domain, so a profile served through `404.html` answers 404
to every crawler and link preview. fitprofile-site hands out `/p/<id>` links
built exactly that way, and every one of them opens its 404 page. So `/u/` is a
generated page and the handle rides in the query: `handleFromSearch()` in
`js/handles.js` reads it, skipping the header kit's own query keys, so
`?theme=matrix&ana` is Ana's shelf. The handle rules are canonical in
`convex/lib/handles.ts` and mirrored in `js/handles.js`;
`tests/handles-mirror.test.mjs` runs one corpus through both. Production leaves
`PUBLISHING` unset until the owner opens it, so `profiles:setPublished` answers
`publishing-closed` and `profiles:byHandle` answers `null` to everyone but the
shelf's owner, while a handle can still be claimed. Opening it
(`npx convex env set --prod PUBLISHING open`) is the owner's decision, taken
after reading the catalogue's legal notice and with `ADMIN_SUBJECTS` set on
production first, never a session's own call. `/u/` is `noindex`, stays out of
`sitemap.xml` and `llms.txt`, counts no visit and sends `strict-origin`
referrers.

**Every surface that renders `data-add` needs its own click branch.** The stage,
the drawer and the modal each delegate clicks separately. Add by ISBN lists its
editions as `data-add` buttons inside the modal, whose handler had no such
branch, so from the day scanning shipped, picking an edition did nothing. It was
verified by watching the lookup resolve, which is not the same as clicking the
result.

**Copy on `/demo/` and `/u/` must not call the books the visitor's.** "The lit
ones are yours" on the maintainer's shelf told every visitor they owned it.
Strings that name an owner go through `whose(yours, demo)` in `state.js`, which
answers from `state.readOnly`, and so does any new one that says "your" about
the books.

**tercerafundacion.net refuses ClaudeBot, so a Claude session sends it
nothing.** Its `robots.txt` allows every crawler and gives `ClaudeBot`
`Disallow: /`. A Claude session never runs `scripts/scrape.py`, never fetches
the site, and never follows a "Read the catalogue record" link; refreshing the
catalogue is the owner's job. Before any browser verification, set
`localStorage["vitrina:no-remote-images"] = "1"` on the page's origin and
reload: `spineUrl` and `coverUrl` in `data.js` then return `''`, custom image
URLs on hand-added books are withheld too (they can point at the catalogue), and
only this site's thumbnails and the development cache still show.
`REMOTE_IMAGES = false` in `data.js` does the same for everybody.
`tests/remote-images.test.mjs` holds both, and the template carries no
preconnect to the catalogue for the same reason.

**`catalog.json` ids are append-only.** An account shelf stores a catalogue book
as `tf<id>` and the browser resolves the record from `library.json` or
`catalog.json`, so an id that leaves the file turns that book into "A book no
longer in the catalogue" on every account holding it, with nothing in the
account to rebuild it from. `scrape.py catalog` merges into the existing file
(`catalog_ids.merge_catalog`), keeping collections the shelf no longer touches,
and `python3 scripts/catalog_ids.py --check`, in `make validate`, fails when an
id in `git show HEAD:data/catalog.json` is missing from the working copy. Merge
a lost id back rather than dropping it.

**Every attribute built from a record goes through `escHtml`.** `shelf.js` once
wrote `record.id` raw into `data-book-id`, and an id of `1" onerror="x` became an
`onerror` attribute that fired, because the image it sat on 404s. On the demo an
id is catalogue data; on an account shelf or in an imported file it is whatever
somebody wrote. `tests/escaping.test.mjs` renders that id and reads every
`data-add` and `data-book-id` in the modules from source. `syncplan.js` also
makes `record.id` follow the entry's key on import and when normalising a
browser shelf, so a file cannot choose the id that lands in an attribute or an
image URL.

**Shelf tools is Vitrina's menu, so Vitrina runs it.** The header kit opens,
closes and steers only the menus it builds (its `⋯` overflow and the palette).
`bindShelfMenu()` in `events.js` does the rest for Shelf report, Export and
Import: toggle, arrow keys, Escape back to the trigger, a click elsewhere, and
closing on scroll once focus has left the bar, or the app-mode header slides away
with the menu open. At 700 px and below the kit folds header actions into its
`⋯` menu, which closes on any click inside it, so a menu folded in there could
never open. `bindShelfMenu()` moves the three items into `.header-actions`
instead, and back above that width, putting Add a book ahead of Add by ISBN
again. Moved, never cloned, so their listeners and the ids the read-only CSS
hides them by survive. `tests/header-menu.test.mjs` drives it on a stand-in
header.

**Two deployments, and a page names only production.** The dev deployment is
the one `CONVEX_DEPLOYMENT` in `.env.local` names, and `make push-dev`
(`npx convex dev --once`) reaches that one and nothing else. Production is
`https://fantastic-chickadee-557.convex.cloud`, defined in `CONVEX_URL` in
`scripts/routes.py` (two tests pin the same string), which writes it into
`/shelf/` and `/u/` and refuses a page naming any other deployment host, in any
attribute spelling; `/demo/` names none. `make where` prints both sides, and
they must differ.

**Production is deployed by hand, with `--yes`, from the shipping commit.** From
this checkout `npx convex deploy` targets the project's production deployment,
and `make deploy` runs it bare, which stops to confirm. A Claude session has no
TTY, and a non-TTY deploy crashes on that prompt, so it runs
`npx convex deploy --yes --message "vitrina $(git rev-parse HEAD)"` itself
(`--yes` exists in convex 1.45.0 but is hidden from `--help`). Nothing else
carries `convex/` to production, so redeploy from the commit that ships:
`npx convex function-spec --prod` proves the functions exist, not that they are
current. Typecheck is skipped while `typescript` is not installed; if it ever
is, pin it exactly and pass `--typecheck=enable`.

**`scripts/convex_smoke.py` is the only check that a deployment runs what
`convex/lib` says.** It calls the deployed functions through
`npx convex run --identity` with made-up subjects. `--dev` runs the whole path,
publishing and moderation included, and first requires `PUBLISHING` open and
`user_vitrina_dev_admin` in `ADMIN_SUBJECTS` on dev. `--prod` never publishes,
whatever `PUBLISHING` says, uses only the synthetic subject `user_vitrina_smoke`,
refuses to run if that subject is a prod admin, and while publishing is closed
checks that it answers `publishing-closed`. Both end by erasing their subject and
waiting for `purge:sweep`, which runs 5 minutes after the shelf empties, so a
run takes at least that long. The erased handle stays held 30 days, so a second
`--prod` run on the same UTC day needs `--handle smoke-YYYYMMDD-2`. `--dry-run`
prints the commands and runs nothing; env values are read into memory and never
printed.

**Three environment variables, checked by hash.** `PUBLISHING` (`open`, or unset
for closed), `ADMIN_SUBJECTS` (comma-separated Clerk user ids; unset means nobody
is an admin) and `CLERK_WEBHOOK_SECRET`. Only the handlers read `process.env`;
the cores take the values as arguments. Check a value with
`npx convex env get [--prod] NAME | shasum` against the `shasum` of what was
meant, and never run `npx convex env list`, which prints every value into the
transcript.

**npm stays local here, and only for the CLI.** Vitrina is not in the root
`package.json` `workspaces`, so `make install` (`npm install`) builds this
site's own `node_modules` and leaves the root install alone; the same command
inside a workspace member prunes the root's. Run `npm prefix` from the site
first and expect the site's own directory. `package.json` pins only `convex`
1.45.0, for the CLI: the page loads the client from the pinned jsDelivr URL in
`js/backend.js`, and `make validate` needs no install.

**`convex/lib` is written for plain node.** The backend tests import
`convex/lib/*.ts` directly, so `make validate` needs a Node that strips
TypeScript types by default (verified on v25.4.0), and that Node, with no
install, sets the rules. Relative imports between `convex/lib` files carry the
`.ts` extension (`convex/tsconfig.json` allows it because `noEmit` is true).
Types arrive only through statement-form `import type { ... }`; an inline
`{ type X }` fails. No `convex/lib` file imports `convex/*` or `_generated` at
runtime, and there is no `enum`, `namespace` or parameter property. Separately,
the Convex bundler skips any `convex/` file whose basename has more than one
dot, with only a warning, so a `shelf.core.ts` would never deploy.

**An account shelf has a byte budget as well as a book cap.** `MAX_ENTRIES` is
2000 and `SHELF_BYTES_MAX` is 8 MiB (`convex/lib/limits.ts`), both checked
against the person's `shelfMeta` row. One Convex function reads at most 16 MiB,
and `shelf:mine` and `profiles:byHandle` read a whole shelf, so 2000 books at
the widest the entry rules allow (about 14.6 KB each) would have stopped such a
shelf loading at all past about 1,150 of them. A row weighs `storedBytes(row)`:
its shelf fields as UTF-8 JSON plus 150 bytes. Only growth is refused, as
`shelf-full` with `reason: "space"`, so shortening a note always works. Every
insert, fill, edit and delete in `shelfCore.ts`, and each purge batch, patches
`count` and `bytes` in the same transaction; a new write path that skips that
lets the budget drift. `tests/convex-contract.test.mjs` states these numbers
literally, so changing one there is a deliberate act.

**The webhook answers 503 until its secret is set.** `POST /clerk-users-webhook`
is served on the deployment's `.convex.site` host, not `.convex.cloud`. With
`CLERK_WEBHOOK_SECRET` unset it answers 503, so Svix holds the event and
retries; a missing header, a bad signature or a timestamp more than 300 s off
answers 400; any other signed delivery answers 200. Only a verified
`user.deleted` whose `data.id` matches `^user_[A-Za-z0-9]+$` erases anything.
Creating the endpoint in Clerk and setting the secret are owner steps (plan
section 5). The signature check is `convex/lib/webhookVerify.ts` on Web Crypto;
there is no `svix` package.

**Expired handle holds and old rate rows are swept daily.** A released handle is
held 30 days for everyone. A claim deletes an expired hold it happens to find,
but a handle nobody tried again kept its row, a bare name, for good, so
`convex/crons.ts` runs `purge:sweepHeldHandles` daily (500 per run, rescheduling
while more remain) next to `purge:sweepRateEvents` (rows older than 31 days, one
day past the longest window). `suspendedSubjects` is never swept or erased:
suspension outlives erasure on purpose.

**Admin actions need an admin identity, and two of them work by account id.**
Every `admin:*` function answers `not-admin` to a caller not in
`ADMIN_SUBJECTS`, a CLI call with no identity included, so run them as
`npx convex run --prod --identity '{"subject":"<admin user id>","issuer":"https://clerk.neorgon.com"}' admin:<name> '<args>'`.
`setSuspended`, `purgeByHandle` and `releaseHandle` take a handle.
`setSubjectSuspended` and `purgeBySubject` take the Clerk user id from the Clerk
dashboard, for what a handle cannot reach: a suspended person who erased their
data and has no handle left, or a shelf that never had one.
