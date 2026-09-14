#!/usr/bin/env python3
"""Exercise the Vitrina Convex functions against a real deployment.

make validate proves the rules in convex/lib against an in-memory database. It
cannot prove that the deployment the page calls runs the same code, or that
Convex's own validators, indexes and scheduler behave the way the fake does.
This script does, by calling the deployed functions through `npx convex run`
with a made-up identity (plan 2026-09-11, section 4 steps 2 and 7).

    python3 scripts/convex_smoke.py --dev             the whole path on dev, publishing included
    python3 scripts/convex_smoke.py --prod            the safe path on production
    python3 scripts/convex_smoke.py --dev --dry-run   print the commands, run nothing

Production is treated differently on purpose. It never publishes, whatever
PUBLISHING says, because a public shelf there is a real page. It never uses a
real person's subject, and it refuses to run if its own synthetic subject is an
admin, because it ends by erasing everything that subject owns. Every run ends
with deleteMyData and waits for the erasure to finish, so it leaves nothing
behind except the handle's 30-day hold.

No environment value is ever printed. PUBLISHING and ADMIN_SUBJECTS are read
into memory to decide what to check, and only a yes or no about them is shown.
"""

import argparse
import datetime
import json
import os
import shlex
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ISSUER = "https://clerk.neorgon.com"

# The keys a public or owner response must never carry (plan section 3.6).
FORBIDDEN = {"clerkSubject", "subject", "_id", "_creationTime", "note", "listedAs",
             "added", "record", "updatedAt", "createdAt", "email"}

DEV_ADMIN = "user_vitrina_dev_admin"
PROD_SUBJECT = "user_vitrina_smoke"


class SmokeFailure(Exception):
    pass


def forbidden_keys(value, where="$"):
    """Every path in a JSON value whose key is one a response must not carry."""
    found = []
    if isinstance(value, dict):
        for key, inner in value.items():
            if key in FORBIDDEN:
                found.append("%s.%s" % (where, key))
            found.extend(forbidden_keys(inner, "%s.%s" % (where, key)))
    elif isinstance(value, list):
        for index, inner in enumerate(value):
            found.extend(forbidden_keys(inner, "%s[%d]" % (where, index)))
    return found


def first_catalogue_id():
    """A catalogue id that really exists, so the upsert is a real book."""
    with open(os.path.join(ROOT, "data", "catalog.json"), encoding="utf-8") as fh:
        data = json.load(fh)
    lists = [data] if isinstance(data, list) else [v for v in data.values() if isinstance(v, list)]
    for items in lists:
        for record in items:
            if isinstance(record, dict) and isinstance(record.get("id"), int) and record.get("title"):
                return record["id"]
    raise SmokeFailure("data/catalog.json has no record with an integer id and a title")


class Smoke:
    def __init__(self, prod, dry_run):
        self.prod = prod
        self.dry_run = dry_run
        self.checks = 0

    # ── talking to the deployment ────────────────────────────────────────────

    def _npx(self, args):
        cmd = ["npx", "convex"] + args
        if self.dry_run:
            print("  $ " + " ".join(shlex.quote(part) for part in cmd))
            return None
        proc = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=180)
        if proc.returncode != 0:
            raise SmokeFailure("npx convex %s failed:\n%s" % (args[0], proc.stderr.strip()[-600:]))
        return proc.stdout

    def run(self, function, args=None, subject=None):
        """One function call. `convex run` prints nothing for a null result."""
        cmd = ["run"]
        if self.prod:
            cmd.append("--prod")
        if subject:
            cmd += ["--identity", json.dumps({"subject": subject, "issuer": ISSUER})]
        cmd += [function, json.dumps(args or {})]
        out = self._npx(cmd)
        if out is None:
            return None
        out = out.strip()
        return None if out == "" else json.loads(out)

    def env_value(self, name):
        """Read an env var into memory. Never printed; empty means unset."""
        cmd = ["env", "get"] + (["--prod"] if self.prod else []) + [name]
        out = self._npx(cmd)
        return (out or "").strip()

    # ── checking ─────────────────────────────────────────────────────────────

    def check(self, what, condition):
        self.checks += 1
        if self.dry_run:
            print("    check: " + what)
            return
        if not condition():
            raise SmokeFailure("FAILED: " + what)
        print("  ok   " + what)

    def no_forbidden_keys(self, what, value):
        self.check("%s carries none of %s" % (what, ", ".join(sorted(FORBIDDEN))),
                   lambda: not forbidden_keys(value))

    # purge:sweep runs SWEEP_DELAY_MS (5 minutes, convex/lib/limits.ts) after the
    # shelf empties, and only the sweep deletes the erasures row, so shelf:mine
    # keeps answering erasing: true for at least that long by design. The first
    # dev run gave up at 180 s while the sweep was still pending and every row
    # the purge owns was already gone.
    PURGE_TIMEOUT_S = 180
    SWEEP_TIMEOUT_S = 5 * 60 + 120

    def wait_for_erasure(self, subject):
        """deleteMyData schedules the purge, and the purge schedules the sweep; wait for both."""
        if self.dry_run:
            print("    poll shelf:mine until remaining is 0 (the purge ran)")
            print("    then until erasing is false with no entries and no profile (the sweep, about 5 minutes later)")
            return
        deadline = time.time() + self.PURGE_TIMEOUT_S
        while True:
            mine = self.run("shelf:mine", subject=subject)
            if mine is not None and ((mine.get("erasing") and mine.get("remaining") == 0)
                                     or (not mine.get("erasing") and not mine.get("entries"))):
                break
            if time.time() > deadline:
                raise SmokeFailure("the purge did not empty the shelf within %d s" % self.PURGE_TIMEOUT_S)
            time.sleep(3)
        self.check("the purge emptied the shelf", lambda: True)

        print("  ...  waiting for purge:sweep, about 5 minutes after the shelf emptied")
        deadline = time.time() + self.SWEEP_TIMEOUT_S
        while True:
            mine = self.run("shelf:mine", subject=subject)
            if mine is not None and not mine.get("erasing") and not mine.get("entries") and mine.get("profile") is None:
                break
            if time.time() > deadline:
                raise SmokeFailure("purge:sweep did not finish within %d s" % self.SWEEP_TIMEOUT_S)
            time.sleep(15)
        self.check("the sweep finished: not erasing, no entries, no profile", lambda: True)


def entries_for(catalogue_id):
    """A catalogue book with every private field set, and one book added by hand."""
    return [
        {"key": "tf%d" % catalogue_id, "catalogId": catalogue_id, "shelf": "Smoke shelf",
         "note": "private smoke note", "listedAs": "private smoke listing", "added": "2026-09-14",
         "record": None},
        {"key": "own-smoke-hand-added", "catalogId": None, "shelf": "Smoke shelf", "note": None,
         "listedAs": None, "added": None,
         "record": {"title": "A smoke test book added by hand", "authors": ["Nobody"], "year": "2026",
                    "pages": 100, "publisher": None, "collection": None, "dimensions": None,
                    "cover_custom": None, "spine_custom": None}},
    ]


def dev_path(s, stamp, catalogue_id):
    subject = "user_vitrinadev%s" % stamp
    stranger = "user_vitrinadevb%s" % stamp
    handle = "dev-smoke-%s" % stamp

    print("\nPreconditions on dev")
    publishing = s.env_value("PUBLISHING")
    admins = s.env_value("ADMIN_SUBJECTS")
    s.check("PUBLISHING is open on dev (npx convex env set PUBLISHING open)", lambda: publishing == "open")
    s.check("ADMIN_SUBJECTS on dev includes %s" % DEV_ADMIN,
            lambda: DEV_ADMIN in [a.strip() for a in admins.split(",")])

    print("\nClaim, fill, publish")
    claimed = s.run("profiles:claimHandle", {"handle": handle.upper()}, subject)
    s.check("claimHandle answers ok with the normalised handle",
            lambda: claimed.get("ok") is True and claimed.get("handle") == handle)
    added = s.run("shelf:upsertEntries", {"entries": entries_for(catalogue_id)}, subject)
    s.check("upsertEntries adds both books", lambda: added.get("ok") is True and added.get("added") == 2)
    again = s.run("shelf:upsertEntries", {"entries": entries_for(catalogue_id)}, subject)
    s.check("the same chunk again adds nothing and skips both",
            lambda: again.get("ok") is True and again.get("added") == 0 and again.get("skipped") == 2)
    closed = s.run("profiles:setPublished", {"published": True}, subject)
    s.check("publishing without the age statement is refused",
            lambda: closed.get("ok") is False and closed.get("code") == "age-confirmation-required")
    published = s.run("profiles:setPublished", {"published": True, "confirmAge": True}, subject)
    s.check("publishing with the age statement succeeds",
            lambda: published.get("ok") is True and published.get("published") is True)

    print("\nWhat a stranger sees")
    public = s.run("profiles:byHandle", {"handle": handle})
    s.check("an anonymous byHandle returns the shelf",
            lambda: public is not None and public.get("handle") == handle)
    s.no_forbidden_keys("the anonymous answer", public)
    s.check("it lists only the catalogue book, with its shelf label",
            lambda: public.get("books") == [{"id": catalogue_id, "shelf": "Smoke shelf"}])
    s.check("it says nothing about ownership", lambda: "isOwner" not in public)
    s.check("a non-canonical handle answers null",
            lambda: s.run("profiles:byHandle", {"handle": handle.upper()}) is None)

    print("\nModeration")
    denied = s.run("admin:setSuspended", {"handle": handle, "suspended": True}, stranger)
    s.check("a non-admin cannot suspend", lambda: denied.get("ok") is False and denied.get("code") == "not-admin")
    suspended = s.run("admin:setSuspended", {"handle": handle, "suspended": True}, DEV_ADMIN)
    s.check("an admin can", lambda: suspended.get("ok") is True)
    s.check("a suspended shelf answers null to a stranger",
            lambda: s.run("profiles:byHandle", {"handle": handle}) is None)
    owner = s.run("profiles:byHandle", {"handle": handle}, subject)
    s.check("its owner still sees it, marked suspended",
            lambda: owner is not None and owner.get("isOwner") is True and owner.get("suspended") is True)
    s.no_forbidden_keys("the owner view", owner)
    s.run("admin:setSuspended", {"handle": handle, "suspended": False}, DEV_ADMIN)

    print("\nUnpublish and erase")
    unpublished = s.run("profiles:setPublished", {"published": False}, subject)
    s.check("unpublishing succeeds", lambda: unpublished.get("ok") is True and unpublished.get("published") is False)
    s.check("an unpublished shelf answers null to a stranger",
            lambda: s.run("profiles:byHandle", {"handle": handle}) is None)
    erasing = s.run("profiles:deleteMyData", {}, subject)
    s.check("deleteMyData starts the erasure", lambda: erasing.get("ok") is True)
    s.wait_for_erasure(subject)
    taken = s.run("profiles:claimHandle", {"handle": handle}, stranger)
    s.check("the erased handle is held, so a stranger cannot take it",
            lambda: taken.get("ok") is False and taken.get("code") == "handle-taken")
    released = s.run("admin:releaseHandle", {"handle": handle}, DEV_ADMIN)
    s.check("an admin can release the hold", lambda: released.get("ok") is True)


def prod_path(s, stamp, catalogue_id):
    subject = PROD_SUBJECT
    handle = "smoke-%s" % stamp[:8]

    print("\nPreconditions on prod")
    admins = s.env_value("ADMIN_SUBJECTS")
    publishing = s.env_value("PUBLISHING")
    s.check("the smoke subject is not a prod admin",
            lambda: subject not in [a.strip() for a in admins.split(",")])
    if not s.dry_run:
        print("  PUBLISHING on prod is %s" % ("open" if publishing == "open" else "not open"))

    print("\nClaim and fill, never publish")
    claimed = s.run("profiles:claimHandle", {"handle": handle}, subject)
    s.check("claimHandle answers ok (or same-handle from an earlier run today)",
            lambda: claimed.get("ok") is True or claimed.get("code") == "same-handle")
    added = s.run("shelf:upsertEntries", {"entries": entries_for(catalogue_id)}, subject)
    s.check("upsertEntries answers ok", lambda: added.get("ok") is True)

    print("\nThe owner view, unpublished")
    owner = s.run("profiles:byHandle", {"handle": handle}, subject)
    s.check("the owner gets an OwnerView of an unpublished shelf",
            lambda: owner is not None and owner.get("isOwner") is True and owner.get("published") is False)
    s.no_forbidden_keys("the owner view", owner)
    s.check("a stranger gets null", lambda: s.run("profiles:byHandle", {"handle": handle}) is None)
    if s.dry_run or publishing != "open":
        refused = s.run("profiles:setPublished", {"published": True, "confirmAge": True}, subject)
        s.check("while PUBLISHING is not open, publishing is refused as publishing-closed",
                lambda: refused.get("ok") is False and refused.get("code") == "publishing-closed")

    print("\nErase")
    erasing = s.run("profiles:deleteMyData", {}, subject)
    s.check("deleteMyData starts the erasure", lambda: erasing.get("ok") is True)
    s.wait_for_erasure(subject)


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--dev", action="store_true", help="the dev deployment .env.local names")
    target.add_argument("--prod", action="store_true", help="the production deployment")
    parser.add_argument("--dry-run", action="store_true", help="print the commands and checks, run nothing")
    opts = parser.parse_args()

    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d%H%M")
    s = Smoke(prod=opts.prod, dry_run=opts.dry_run)
    try:
        catalogue_id = first_catalogue_id()
        (prod_path if opts.prod else dev_path)(s, stamp, catalogue_id)
    except SmokeFailure as err:
        print("\n%s" % err, file=sys.stderr)
        sys.exit(1)
    print("\n%s: %d checks %s" % ("prod" if opts.prod else "dev", s.checks,
                                 "listed" if opts.dry_run else "passed"))


if __name__ == "__main__":
    main()
