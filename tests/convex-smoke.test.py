#!/usr/bin/env python3
"""What scripts/convex_smoke.py decides without a deployment. Run with: make validate

The script talks to Convex only through Smoke.run and Smoke.env_value, so these
tests replace those two with canned answers and never start npx. The dry runs
at the end start the script itself, and a dry run calls nothing either.

They cover a prod run that cannot go the happy way: a handle an earlier run
today still holds, an erasure still finishing, and a check that fails after the
claim, which must still erase the synthetic shelf the run wrote.
"""

import contextlib
import importlib.util
import io
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(os.path.dirname(HERE), "scripts", "convex_smoke.py")

spec = importlib.util.spec_from_file_location("convex_smoke", SCRIPT)
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)

failed = 0


def eq(actual, expected, what):
    global failed
    if actual == expected:
        print("ok   " + what)
    else:
        failed += 1
        print("FAIL %s\n  expected %r\n  got      %r" % (what, expected, actual), file=sys.stderr)


STAMP = "202609141035"
HANDLE = "smoke-20260914"
SUBJECT = smoke.PROD_SUBJECT
OWNER_VIEW = {"handle": HANDLE, "books": [{"id": 1, "shelf": "Smoke shelf"}], "isOwner": True,
              "published": False, "suspended": False, "publishingOpen": False}
TAKEN = {"ok": False, "code": "handle-taken", "message": "That address is taken. Try another."}


class Canned(smoke.Smoke):
    """A prod Smoke whose deployment is a dict of answers. Every call is logged."""

    def __init__(self, answers, admins="user_somebody_else"):
        super().__init__(prod=True, dry_run=False)
        self.answers = answers
        self.admins = admins
        self.calls = []

    def run(self, function, args=None, subject=None):
        self.calls.append((function, subject, args or {}))
        answer = self.answers.get(function)
        return answer(args or {}, subject) if callable(answer) else answer

    def env_value(self, name):
        return {"ADMIN_SUBJECTS": self.admins, "PUBLISHING": ""}.get(name, "")

    def called(self, function):
        return [subject for name, subject, _ in self.calls if name == function]


def answers(**over):
    """A prod deployment where every call answers the way it should."""
    canned = {
        "profiles:claimHandle": lambda args, subject: {"ok": True, "handle": args["handle"]},
        "shelf:upsertEntries": {"ok": True, "added": 2, "skipped": 0, "filled": 0, "total": 2},
        "profiles:byHandle": lambda args, subject: OWNER_VIEW if subject else None,
        "profiles:setPublished": {"ok": False, "code": "publishing-closed"},
        "profiles:deleteMyData": {"ok": True, "status": "erasing"},
        "shelf:mine": {"erasing": False, "profile": None, "entries": []},
    }
    canned.update({name.replace("__", ":"): answer for name, answer in over.items()})
    return canned


def outcome(s, handle=None):
    """'passed', or the text of the SmokeFailure the run raised. The script's own output is kept quiet."""
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        try:
            smoke.run_smoke(s, STAMP, 1, handle)
        except smoke.SmokeFailure as err:
            return str(err)
    return "passed"


def claimed_handles(s):
    return [args.get("handle") for name, _, args in s.calls if name == "profiles:claimHandle"]


# ── A run that goes the whole way ───────────────────────────────────────────
s = Canned(answers())
eq(outcome(s), "passed", "a prod run with every answer right passes")
eq(claimed_handles(s), [HANDLE], "claiming smoke-YYYYMMDD, the plan's handle")
eq(s.called("profiles:deleteMyData"), [SUBJECT], "and erasing the synthetic subject once, at the end")

s = Canned(answers(profiles__claimHandle={"ok": False, "code": "same-handle", "message": "That is already your address."}))
eq(outcome(s), "passed", "same-handle, left by an earlier run today that could not erase, is accepted")

# ── A second run on the same UTC day ────────────────────────────────────────
s = Canned(answers(profiles__claimHandle=TAKEN))
text = outcome(s)
eq(["handle-taken" in text, HANDLE in text, "--handle" in text], [True, True, True],
   "a handle held by an earlier run today fails saying so, and names --handle")
eq([s.called("shelf:upsertEntries"), s.called("profiles:deleteMyData")], [[], []],
   "and neither writes nor erases, since the claim wrote nothing")

s = Canned(answers(profiles__claimHandle={"ok": False, "code": "erasing", "message": "Your Vitrina data is being deleted."}))
text = outcome(s)
eq(["5 minutes" in text, "--handle" in text], [True, True], "an erasure still finishing says to wait, and how to run again after it")

s = Canned(answers())
eq(outcome(s, "smoke-20260914-2"), "passed", "--handle runs the same checks")
eq(claimed_handles(s), ["smoke-20260914-2"], "under the handle it names")

# ── A run that fails after its claim ────────────────────────────────────────
leaky = dict(OWNER_VIEW, note="private smoke note")
s = Canned(answers(profiles__byHandle=lambda args, subject: leaky if subject else None))
text = outcome(s)
eq(text.startswith("FAILED: the owner view carries none of"), True, "a failed check after the claim fails the run")
eq(s.called("profiles:deleteMyData"), [SUBJECT], "and still erases what the run wrote, once")


def boom(args, subject):
    raise RuntimeError("npx timed out")


s = Canned(answers(shelf__upsertEntries=boom))
with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
    try:
        smoke.run_smoke(s, STAMP, 1)
        text = "passed"
    except RuntimeError as err:
        text = str(err)
eq(text, "npx timed out", "an unexpected error after the claim is raised as it was")
eq(s.called("profiles:deleteMyData"), [SUBJECT], "after erasing what the run wrote")

s = Canned(answers(), admins="user_a, %s" % SUBJECT)
eq(outcome(s), "FAILED: the smoke subject is not a prod admin", "a smoke subject listed as a prod admin stops the run")
eq(s.calls, [], "before any function is called, so nothing is erased either")

# ── --handle, through the script itself, as dry runs ────────────────────────


def cli(*args):
    proc = subprocess.run([sys.executable, SCRIPT] + list(args), capture_output=True, text=True, timeout=60)
    return proc.returncode, proc.stdout


eq(cli("--prod", "--dry-run", "--handle", "ana")[0], 2, "--handle refuses a handle without smoke-, so a smoke run never holds a real name")
eq(cli("--prod", "--dry-run", "--handle", "smoke-Bad")[0], 2, "--handle refuses a handle that is not lowercase")
eq(cli("--dev", "--dry-run", "--handle", "smoke-20260914-2")[0], 2, "--handle is for --prod only")
code, out = cli("--prod", "--dry-run", "--handle", "smoke-20260914-2")
eq([code, '"handle": "smoke-20260914-2"' in out], [0, True], "a prod dry run with --handle lists the claim of that handle")

print("\n%d failed" % failed if failed else "\nall passed")
sys.exit(1 if failed else 0)
