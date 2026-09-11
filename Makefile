.DEFAULT_GOAL := help

PORT = 8881

# ── Help ──────────────────────────────────────────────────────────────────────
.PHONY: help
help:
	@echo ""
	@echo "  make serve    Start dev server → http://localhost:$(PORT)"
	@echo "  make kill     Kill this project's HTTP server"
	@echo "  make validate Run the tests (plain node, no install)"
	@echo "                Needs a Node that strips TypeScript types by default (verified on v25.4.0)"
	@echo "  make routes   Regenerate /shelf/ and /demo/ from _templates/app.html"
	@echo ""
	@echo "  make install  npm install, for the Convex CLI only; the site itself needs no install"
	@echo "  make push-dev Push convex/ to the dev deployment once"
	@echo "  make deploy   Deploy convex/ to production (a Claude session adds --yes and --message)"
	@echo "  make where    Print the Convex deployment the pages and .env.local name"
	@echo ""

# ── Dev server ────────────────────────────────────────────────────────────────
# scripts/serve.py is http.server plus Cache-Control: no-cache; a plain
# http.server sends only Last-Modified, so browsers keep stale ES modules after
# edits. Falls back to plain http.server outside the monorepo.
.PHONY: serve
serve:
	@echo "Serving → http://localhost:$(PORT)"
	@if [ -f ../../scripts/serve.py ]; then python3 ../../scripts/serve.py $(PORT); else python3 -m http.server $(PORT); fi

# ── Kill ──────────────────────────────────────────────────────────────────────
.PHONY: kill
kill:
	@lsof -ti :$(PORT) | xargs kill 2>/dev/null && echo "Stopped server on port $(PORT)" || echo "No server running on port $(PORT)"

# The backend tests import convex/lib/*.ts directly, so validate needs no
# npm install: only a Node that strips types by default.
.PHONY: validate
validate:
	@node tests/shelf.test.mjs
	@node tests/isbn.test.mjs
	@node tests/syntax.test.mjs
	@node tests/readonly.test.mjs
	@node tests/handles-mirror.test.mjs
	@node tests/convex-entries.test.mjs
	@node tests/convex-shelf.test.mjs
	@node tests/convex-profiles.test.mjs
	@node tests/convex-purge.test.mjs
	@node tests/convex-webhook.test.mjs
	@python3 scripts/catalog_ids.py --check
	@python3 scripts/routes.py --check

# ── Routes ────────────────────────────────────────────────────────────────────
.PHONY: routes
routes:
	@python3 scripts/routes.py

# ── Convex ────────────────────────────────────────────────────────────────────
# package.json exists only for the Convex CLI. Nothing above needs it.
.PHONY: install push-dev deploy where
install:
	npm install

# The dev deployment .env.local names. --once pushes and exits instead of watching.
push-dev:
	npx convex dev --once

# Production. Run by hand, it asks for confirmation. A Claude session has no TTY
# and must run npx convex deploy --yes --message "vitrina $(git rev-parse HEAD)"
# itself: --yes exists in convex 1.45.0 but is hidden from help, and without it a
# non-TTY deploy crashes on the prompt. Typecheck is skipped while typescript is
# not installed; if it ever is, pin it exactly and pass --typecheck=enable.
deploy:
	npx convex deploy

# Which deployment the shipped pages talk to, and which one this checkout pushes
# to. Only the CONVEX_DEPLOYMENT line is read from .env.local.
where:
	@for page in shelf/index.html u/index.html; do \
	  if [ -f "$$page" ]; then \
	    url=$$(grep -o '<meta[^>]*name="neo-convex-url"[^>]*>' "$$page" | grep -o 'content="[^"]*"' | head -1 | sed 's/^content="//; s/"$$//'); \
	    echo "$$page: $${url:-no neo-convex-url meta}"; \
	  fi; \
	done
	@if [ -f .env.local ]; then grep '^CONVEX_DEPLOYMENT=' .env.local || echo ".env.local: no CONVEX_DEPLOYMENT line"; fi
