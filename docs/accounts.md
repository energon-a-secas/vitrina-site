# Vitrina: accounts and the backend

This file holds Vitrina's account reference: the Convex backend under
`convex/`, the browser modules that load, save, move and share a signed-in
shelf, and the gotchas behind both. `CLAUDE.md` links here and keeps only the
traps every session needs, because it loads into every session and subagent
and this file loads only when read. Read it before touching `convex/`,
`js/account.js`, `js/session.js`, `js/strips.js`, `js/profile.js`,
`js/share.js`, `js/keyguard.js`, `js/accountplan.js`, `js/profileplan.js`,
`js/erasing.js`, `js/overflow.js` or the Auth Kit files (`js/neorgon-auth.js`,
`js/neorgon-auth-sites.js`, `css/neorgon-auth.css`, and the kit's key and slot
in `_templates/app.html`). The site's own gotchas, the read-only layers and the
`vitrina_shelf_v1` storage rule among them, stay in `CLAUDE.md`. Where a gotcha
cites the plan, it means `docs/plans/2026-09-11-vitrina-public-shelves.md` in
the monorepo root.

## The backend

Convex project `vitrina-site` on team `luciano-adonis-villarroel`. Each handler
in `convex/*.ts` takes the person from `ctx.auth.getUserIdentity()`, never from
an argument, and hands `ctx.db`, `Date.now()` and `process.env` values to a core
in `convex/lib/`, which `make validate` runs against `tests/support/fakedb.mjs`
with no deployment and no install. The fake reads its tables and indexes from
`convex/schema.ts`, so a core that uses one the schema lacks fails there too.
Expected failures return `{ ok: false, code, message }` and never throw.
`js/backend.js` names every function a browser may call, and
`tests/backend.test.mjs` fails when that list and `convex/*.ts` disagree.

```bash
make where        # the deployment each page names, and the one .env.local pushes to
make push-dev     # push convex/ to the dev deployment once
python3 scripts/convex_smoke.py --dev    # the whole path on dev, publishing included
python3 scripts/convex_smoke.py --prod   # the safe path on production
npx convex deploy --yes --message "vitrina $(git rev-parse HEAD)"   # production, from a Claude session
```

## Accounts in the browser

`app.js` renders first, then hands the page to `account.js` (`/shelf/`,
`/demo/`) or `profile.js` (`/u/`) without awaiting either, so the first paint
never waits on sign-in or a database.

- `js/account.js`: boots the Auth Kit once. On `/demo/` it only calls
  `NeoAuth.start()` and never loads a Convex client. On `/shelf/` it runs the
  source machine, the account adapter `state.js` hands edits to, the write
  queue, refetches, and the memory-only list of changes the account did not take.
- `js/session.js`: what `account.js` shares (the kit, `call`, `send`,
  `refresh`, the last count, erasing) with `render.js`, `modals.js`, `strips.js`
  and `share.js`, which would otherwise import it in a circle. Also
  `offersDemoCopy()`.
- `js/strips.js`: the live region above `/shelf/` (signed out, not loaded,
  being deleted, not saved) and the move and fill flows.
- `js/profile.js`: `/u/`, its states, the anonymous client and the owner view.
- `js/share.js`: the Share dialog: address, publish switch, Copy link, Delete
  my Vitrina data.
- `js/accountplan.js`: pure. What the account modules decide: failure copy,
  batch copy, chunked uploads, `booksToKeep`, `authedCall`, `holderOf`,
  `writeQueue`, `shareFacts`. Pinned by `tests/accountplan.test.mjs`.
- `js/profileplan.js`: pure. What `/u/` decides: its states, `replyWins`,
  `publicEntries`, the owner banner. Pinned by the same test file.
- `js/erasing.js`: the timer `account.js` and `share.js` wait out a deletion
  with: its pace, a hidden tab, and when to stop asking.
- `js/keyguard.js`: pure. When the page's keydown handler leaves a key alone.
  Pinned by `tests/keyguard.test.mjs`.
- `js/overflow.js`: hides the header kit's `⋯` toggle while nothing folded into
  it is drawn.

`account.js` and `state.js` sit just under the fleet's 500-line cap for a
module (`wc -l js/*.js`), and so does `tests/support/shelfworld.mjs`: split one
before growing it, as `accountplan.js` gave its `/u/` half to `profileplan.js`.

## Gotchas

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
waiting for `purge:sweep`, which runs 5 minutes after the shelf empties (a Clerk
token for Convex lives 60 s, and none minted before the erasure may still write
when it ends), so a run takes at least that long. The erased handle stays held
30 days, so a second `--prod` run on the same UTC day needs
`--handle smoke-YYYYMMDD-2`. `--dry-run` prints the commands and runs nothing;
env values are read into memory and never printed.

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
Types arrive only through statement-form `import type { ... }`: an inline
`{ type X }` leaves the import in place at runtime, so from `convex/server` it
fails with no install (from a sibling `.ts` file it happens to run). No
`convex/lib` file imports `convex/*` or `_generated` at runtime, and there is no
`enum`, `namespace` or parameter property. Separately, the Convex bundler skips
any `convex/` file whose basename has more than one dot and logs it only when
`CONVEX_VERBOSE` is set, so a `shelf.core.ts` would never deploy and nothing
would say why. `auth.config.ts` is exempt because the bundler reads it by name.

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

**`profiles:byHandle` builds its answer field by field and lists books by id.**
`projectShelf` in `convex/lib/profilesCore.ts` never spreads a stored row, so a
field added to the schema stays private until it is named there. A public shelf
is `{ handle, books }`, each book `{ id, shelf }`, sorted by catalogue id: rows
come back in the order they were created, which told any visitor the order the
owner added their books. Every refusal (a malformed or unknown handle, a private
or suspended shelf, publishing closed) is the same `null`, so the answer never
says which. `tests/convex-profiles.test.mjs` holds the projection and the order,
and `convex_smoke.py` checks both views for private keys.

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

**The Auth Kit is vendored, and Vitrina is listed under "Your Neorgon sites".** `packages/neorgon-ui/sync-auth.sh --to vitrina-site` put
`js/neorgon-auth.js`, `js/neorgon-auth-sites.js` and `css/neorgon-auth.css`
here; fix the canonical source and resync, never the copies. `_templates/app.html`
carries the `clerk-publishable-key` meta and the kit stylesheet after the other
kits' stylesheets, and the `data-neo-auth` slot inside `.header-right` before
`.header-home`, marked `data-keep-mobile` as the kit's contract has it, so the
phone header keeps two things: Add by ISBN and the slot. `tests/routes.test.py`
pins all of it on every route page. `backend.js` imports the kit on demand, so no
page waits on it. The root `index.html` carries the key as well (added when the feature shipped,
plan O4), and that is what lists Vitrina, because `authkit.py build` lists a live
site whose own `index.html` has a `pk_live_` key; the home page still loads no
sign-in code. From then on that entry is
built from vitrina's registry `description`, `display_name` and `live_url`
(edited in the root `scripts/generate-registry.py`, then `make registry`) and
from `favicon.svg`. Changing any of them needs a plain `sync-auth.sh`, which
rebuilds the catalogue and refreshes every vendored copy (`--to` rebuilds it but
copies to one site), then `sync-auth.sh --check`, a root commit limited to
`packages/neorgon-ui/auth/neorgon-auth-sites.js`, and a commit of
`js/neorgon-auth-sites.js` in every repo the sync refreshed. Those repos are the
ones `ls projects/*/js/neorgon-auth.js` lists, less `neorgon-auth-client`, which
the sync skips: plan O4 names five, written before Enamel and Sash adopted the
kit. `--check` compares working copies, so it passes with those commits unmade,
and in vitrina a change to the key meta or the catalogue goes in a commit of its
own. `--check` is smoke check 13 and fails on a stale catalogue.

**`/shelf/` changes hands only when the kit says so.** `state.source` is
`local`, `account-loading`, `account` or `account-error`, and it moves between
the browser shelf and an account only on what `NeoAuth.onChange` reports, or
when the kit fails to load (plan section 3.1). Signed in: `account-loading`,
then `account` once `shelf:mine` answers, or `account-error` with Try again; a
`null` answer while the kit says signed in is a failed request, never a sign-out.
A different `userId` drops the last shelf and its unsaved changes before the next
one loads. The same person under a new label changes nothing: a new sequence
number would drop the load or deletion poll on its way, and the page would load
for good. A sign-out this page did not reload for (an explicit Sign out reloads;
a session that ends on its own does not) shows the browser shelf under the
signed-out strip, naming anything not saved. A `__client_uat` above 0 means a
session somewhere on the fleet, so `holdForKit()` puts `/shelf/` in
`account-loading` before `boot()` awaits anything, and the browser shelf appears
only once the kit settles signed out or fails to load: an edit made in that wait
went to the browser shelf and then vanished under the account shelf. While
`shelf:mine` answers `erasing`, the page stays loading, says how many books are
left and asks again through `js/erasing.js`: every 8 s, every 30 s once none are
left (only `purge:sweep` remains, 5 minutes on), nothing while the tab is
hidden, and after five answers in a row that are neither an erasure nor a shelf
it stops and shows Try again. It used to ask every 8 s for as long as the page
stayed open, a refused token included.

**A write goes out one at a time, and never for the next person.**
`accountplan.writeQueue` sends an account write only once the one before it,
retry included, has settled. The client's own queue keeps order only until a
write throws: `authedCall` retries after a fresh mint, by then the next write had
gone ahead, and a book put on and taken straight off stayed on the account. A
write whose shelf changed hands before its turn (its generation moved) is dropped
unsent. `authedCall` reads `holderOf(kit)`, user id and session id, before it
awaits anything and again just before it sets the token, and throws unsent if it
moved; its retry mints from the session it started with. `holderOf` is `null`
while the kit's session already belongs to the next person and its `userId` is
still the last one's, which is the order the kit swaps them in. Share's changes
use the same queue (`session.send`). A retried write may already have reached
the account the first time, with only its answer lost, so the answer to the
retry carries `retried: true`, and a book it skipped counts as added in the
move strip and the toasts (`batchToast`). The Share dialog reads no flag: a
`same-handle` for an address it was not showing counts as done, retried or not,
which also covers a change made first in another tab. Read the other way, a
move that worked said "Added 0 books." and a handle change that worked was
reported as refused. A note typed in the drawer that is longer than an account
keeps (1000 characters) comes back to be shortened, with the reason in the
prompt, instead of going out cut the way a move or an import cuts one so its
chunk still lands, and handed back unchanged it is refused rather than asked
for again, so an automated prompt that accepts its default cannot loop the page
(`detail.js`). A failed add or note edit stays on screen as "not saved" with
Try again, in memory only; a failed removal puts the book back.
A refetch, after a failure or when the tab becomes visible, is applied only when
no write is pending and none went out while it was on its way.

**Moving a browser shelf is offered, never done, and Done clears only what the
account holds in full.** When an account shelf arrives, `strips.js` normalises
the stored browser shelf once through `rewriteBrowserShelf`, saving any key it
mints (a key minted afresh on the next count would add a hand-added book twice),
and offers the books the account lacks, less the keys in `vitrina_moved_v1`,
plus Fill them in for books whose account copy has an empty note or label.
Nothing is uploaded until the person asks. Chunks of 200 go through
`session.send` with the generation read before each chunk and on each answer,
and a chunk's keys join `vitrina_moved_v1` only after the account took it. Not
now lasts the tab (`vitrina_move_later_v1` in `sessionStorage`), for as long as
the person who said it stays signed in. After a move,
"Clear this browser's copy" is checked by default, as the plan has it, and Done
reads `shelf:mine` fresh rather than trusting memory. `booksToKeep()` then keeps
every browser book the account lacks, holds with a label, note or listed-as text
that is not the same word for word (empty there, other words, or a note cut at
1000 characters), or, for a hand-added book, holds without a record field this
browser has. Clearing the whole shelf used to delete a note the account had
empty. When the account cannot be read at Done, nothing is cleared. Fill them in
sits beside Done and is offered again afterwards for the books that stayed.

**`/u/` has six states, and on your own address it waits for the kit.**
`profile.js` writes `data-profile-state` on `<body>` (`loading`, `missing`,
`unavailable`, `error`, `empty`, `shelf`), and CSS hides the controls, the
views, Shelf tools and the Shelf report in every state but `shelf`, and before
the script has run. Every visitor's request goes through an anonymous client the
kit never holds a token on. With `__client_uat` above 0 an anonymous `null` or
failure is held until the kit settles, since it may be this person's own private
shelf, which only a request carrying their token returns (`authedCall` on a
second, kit-bound client). Requests are numbered: `replyWins` lets a token reply
supersede an anonymous one in either order, and a sign-out or a different viewer
raises a floor that drops every older reply. The owner banner goes by precedence
suspended, closed, private, published, each with "Books added by hand, notes and
dates are never shown here." Unavailable reads the same for every cause and never
repeats the handle. At 700 px and below, `overflow.js` hides the header kit's `⋯`
toggle while none of the controls folded into it is drawn: the kit counts
children, and on `/u/` outside the Shelf state it opened an empty panel.

**Share lets the kit settle before it closes anything.** `openShare()` awaits
`NeoAuth.start()`, then closes the drawer and `#modal`, then awaits
`requireSignIn()`. While clerk-js loads nothing native is open and the page keeps
its keys, so an overlay opened in that wait used to end up under the kit's
dialog. The dialog paints from a fresh `shelf:mine`, read again after every
change. While `publishingOpen` is false it says public shelves are not open yet,
and the switch stays disabled except to take a shelf published earlier private
again, since `setPublished(false)` always works. Publishing needs "I am 16 or
older" ticked. Copy link appears only when the shelf is published, publishing is
open and the shelf is not suspended. A handle change confirms both of its effects.
Delete my Vitrina data sits beside Export my shelf, confirms, forgets
`vitrina_moved_v1` once the account takes it, then polls `shelf:mine` every
2.5 s with "Deleting your books: N left". It waits through `js/erasing.js` as
the shelf does, only quicker while books remain: every 30 s once none are left,
nothing while the tab is hidden, and Try again after five answers in a row that
say nothing about the deletion. Closing the dialog moves a counter that stops
every poll and paint meant for it. A `not-signed-in` answer while the kit still
says signed in means the deployment refused the
token, where `requireSignIn()` would open nothing, so the dialog stays open and
says to reload.

**Keys belong to whatever holds them.** `keysBelongElsewhere()` in
`js/keyguard.js` makes the page's keydown handler leave Escape, the focus trap
and the shortcuts alone while a native `<dialog>` is open (the kit's sign-in),
while a `.header-menu` is open, and when focus is inside a `[role=dialog]`
outside `#modal` and `#drawer` (Clerk's account menu). With the Shelf report
open under the kit's dialog, `trapFocus` swallowed Shift+Tab and `a` opened Add
a book behind it.

**The flow tests run the real modules on the generated pages.**
`tests/account-flow.test.mjs`, `move-flow.test.mjs`, `share-flow.test.mjs` and
`profile-flow.test.mjs` load `shelf/index.html` or `u/index.html` into `tests/support/minidom.mjs`, a
small DOM that throws on a selector it does not understand instead of matching
nothing, and run `account.js`, `strips.js`, `share.js` and `profile.js` in a world
from `tests/support/shelfworld.mjs`. Each world copies `js/` to a temporary
directory without the vendored `neorgon-*` files, with a `render.js` that draws
nothing and a `backend.js` that hands out fakes: a deployment that answers from
the token's user and can hold, fail, lose the answer to or replace one request; a client that queues
mutations and reads its token at dispatch, as `ConvexHttpClient` 1.45 does; a kit
that re-tokens its bound clients before it tells listeners, as the real one does;
and a clock that moves only when a test says so. So a module these tests load
cannot import a vendored kit file directly: reach the kit through `backend.js`.
They read the generated pages, so run `make routes` after a template change
before trusting them. Each rule they pin was tripped once in a scratch copy when
it was written.

**Only a live sign-in settles the rest.** A production Clerk key refuses
localhost, so no signed-in path runs anywhere but `vitrina.neorgon.com`, and the
fakes encode what the kit and clerk-js 5.127.2 did when they were read. Checked
there, with the remote-image switch on: that the shipped deployment accepts the
`convex` template's token (`convex/auth.config.ts`; without it no request is
signed in, so `/shelf/` says the account shelf could not be loaded and Share
says the account could not be reached); that signing in and Sign out reload the
page, and a session that ends on its own shows the signed-out strip; that
switching accounts swaps session, token and
`userId` in the order `holderOf` expects; that `__client_uat` holds `/shelf/` and
`/u/` until the kit settles, and a stale cookie releases them; that the kit's
dialog and Clerk's account menu keep the keyboard; that the header fits with the
slot showing Sign in or an avatar at 375, 414, 768 and 960 px (plan section 4,
step 7.2); and the owner's own `/u/?handle` banner, a refetch between two tabs,
and Delete my Vitrina data through to an empty shelf (plan section 5, step 5).
