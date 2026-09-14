#!/usr/bin/env python3
"""What scripts/routes.py guarantees about the pages it writes. Run with: make validate

The app decides whether a page may edit from <body data-mode>, and js/state.js
treats a mode it does not know as the editable shelf. So routes.py refuses a
route whose mode state.js does not list in MODES, and this trips that refusal in
a throwaway copy of the three files routes.py reads. It also pins what /u/ has to
carry in its head, and what no page may carry: a Convex deployment other than
production, or a connection opened early to the catalogue.
"""

import importlib.util
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SCRIPT = os.path.join(ROOT, "scripts", "routes.py")

spec = importlib.util.spec_from_file_location("routes", SCRIPT)
routes = importlib.util.module_from_spec(spec)
spec.loader.exec_module(routes)

failed = 0


def eq(actual, expected, what):
    global failed
    if actual == expected:
        print("ok   " + what)
    else:
        failed += 1
        print("FAIL %s\n  expected %r\n  got      %r" % (what, expected, actual), file=sys.stderr)


# ── The routes ────────────────────────────────────────────────────────────────
eq(routes.modes(), ["shelf", "demo", "profile"], "routes.py reads the page modes from js/state.js")
eq(sorted(values["MODE"] for values in routes.ROUTES.values()), ["demo", "profile", "shelf"], "one route per mode")
u = routes.ROUTES["u"]
eq((u["MODE"], u["URL"], u["ROBOTS"], u["TITLE"], u["SUBTITLE"], u["HIDE_OWNED"]),
   ("profile", "https://vitrina.neorgon.com/u/", "noindex, follow", "Vitrina | A shared shelf", "A shared shelf", "Hide what is on this shelf"),
   "the u route is the one plan section 3.8 describes")
eq(routes.CONVEX_URL, "https://fantastic-chickadee-557.convex.cloud", "the one deployment a page may name is production")

try:
    routes.check_modes({"u": dict(u, MODE="profiles")}, routes.modes())
    eq("accepted", "refused", "a mistyped mode is refused")
except SystemExit as refusal:
    eq("'profiles'" in str(refusal), True, "a mistyped mode is refused, by name")

# ── The pages ─────────────────────────────────────────────────────────────────
pages = {}
for route in routes.ROUTES:
    with open(os.path.join(ROOT, route, "index.html"), encoding="utf-8") as fh:
        pages[route] = fh.read()

# Every deployment host on the page and every neo-convex-url meta however its
# attributes are written, with patterns of this file's own, so a weakened
# pattern in routes.py cannot pass its own pages.
convex_host = re.compile(r"[a-z0-9-]+\.convex\.(?:cloud|site)", re.I)
convex_name = re.compile(r"""name\s*=\s*["']?neo-convex-url\b""", re.I)
PROD_HOST = routes.CONVEX_URL.split("//", 1)[1]
for route, expected in (("shelf", [PROD_HOST]), ("u", [PROD_HOST]), ("demo", [])):
    page = pages[route]
    eq((convex_host.findall(page), len(convex_name.findall(page)), page.count(routes.CONVEX_META.strip())),
       (expected, len(expected), len(expected)),
       "/%s/ names %s" % (route, "the production deployment, once, in one meta" if expected
                          else "no deployment at all, so no account shelf can be read there"))

head = pages["u"].split("</head>", 1)[0]
first_request = min(at for at in (head.find("<link "), head.find("<script")) if at >= 0)
for tag in ('<meta name="neo-analytics" content="off">', '<meta name="referrer" content="strict-origin">'):
    at = head.find(tag)
    eq(0 <= at < first_request, True, "/u/ carries %s before anything it requests" % tag)
for route in ("shelf", "demo"):
    eq('name="neo-analytics"' in pages[route] or 'name="referrer"' in pages[route], False, "/%s/ carries neither" % route)
eq(('<body data-mode="profile">' in pages["u"], 'data-profile-banner aria-live="polite"></div>' in pages["u"]), (True, True),
   "/u/ declares its mode and carries its empty banner")
eq([route for route, text in pages.items() if "tercerafundacion.net" in text.split("</head>", 1)[0]], [],
   "no page opens a connection to the catalogue from its head")
eq([route for route, text in pages.items() if text.count('data-keep-mobile') != 1], [],
   "every page keeps exactly one control in the phone header")

# ── The guard, tripped ────────────────────────────────────────────────────────
with open(os.path.join(ROOT, "js", "state.js"), encoding="utf-8") as fh:
    STATE = fh.read()
EXPORT = re.search(r"^export const MODES\b.*$", STATE, re.M).group(0)


with open(os.path.join(ROOT, "_templates", "app.html"), encoding="utf-8") as fh:
    TEMPLATE = fh.read()


def site_copy(tmp, state_source, template=TEMPLATE):
    for rel in ("scripts/routes.py", "_templates/app.html"):
        os.makedirs(os.path.dirname(os.path.join(tmp, rel)), exist_ok=True)
        shutil.copy(os.path.join(ROOT, rel), os.path.join(tmp, rel))
    with open(os.path.join(tmp, "_templates", "app.html"), "w", encoding="utf-8") as fh:
        fh.write(template)
    os.makedirs(os.path.join(tmp, "js"), exist_ok=True)
    with open(os.path.join(tmp, "js", "state.js"), "w", encoding="utf-8") as fh:
        fh.write(state_source)


tmp = tempfile.mkdtemp(prefix="vitrina-routes-")
try:
    site_copy(tmp, STATE.replace(EXPORT, EXPORT.replace(", 'profile'", "")))
    run = subprocess.run([sys.executable, os.path.join(tmp, "scripts", "routes.py")], capture_output=True, text=True)
    said = run.stdout + run.stderr
    eq(run.returncode != 0, True, "a route whose mode state.js no longer lists is refused")
    eq("'profile'" in said and "MODES" in said, True, "and the refusal names the mode and MODES")
    eq([route for route in routes.ROUTES if os.path.exists(os.path.join(tmp, route))], [],
       "and no page is written, not even for the routes that were fine")

    site_copy(tmp, STATE.replace(EXPORT, "const MODES = ['shelf', 'demo', 'profile'];"))
    run = subprocess.run([sys.executable, os.path.join(tmp, "scripts", "routes.py"), "--check"], capture_output=True, text=True)
    eq(run.returncode != 0 and "MODES" in run.stdout + run.stderr, True, "so is a state.js that stopped exporting MODES")

    # A second meta above the production one, which is the one backend.js would
    # read. The first guard matched a single spelling and let both of these out.
    for extra in ('<meta content="https://not-this-one-123.convex.cloud" name="neo-convex-url">',
                  "<meta name='neo-convex-url' content='https://not-this-one-123.convex.cloud'>"):
        site_copy(tmp, STATE, TEMPLATE.replace("{{CONVEX_META}}", "  %s\n{{CONVEX_META}}" % extra, 1))
        run = subprocess.run([sys.executable, os.path.join(tmp, "scripts", "routes.py")], capture_output=True, text=True)
        eq(run.returncode != 0 and "not-this-one-123.convex.cloud" in run.stdout + run.stderr, True,
           "a template carrying %s is refused, naming the deployment" % extra)
        eq([route for route in routes.ROUTES if os.path.exists(os.path.join(tmp, route))], [], "and no page is written")
finally:
    shutil.rmtree(tmp, ignore_errors=True)

print("\n%d failed" % failed if failed else "\nall passed")
sys.exit(1 if failed else 0)
