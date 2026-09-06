"""Parser and polite HTTP client for tercerafundacion.net.

Shared by scrape.py. Kept separate so the parsing can be unit-tested without
touching the network: every function below takes HTML text and returns data.

Site contract, measured 2026-09-06:
  book page       /biblioteca/ver/libro/{id}/
  work page       /biblioteca/ver/ficha/{id}      groups editions of one title
  collection      /biblioteca/ver/coleccion/{id}?p=libros&pag=N
  search          /biblioteca/buscar/?q=...&tipo=titulo|libro|isbn|persona|coleccion
  spine image     /imagenes/lomo/L-%08d.jpg       404 when never scanned
  cover image     /imagenes/portada/P-%08d.jpg

Search results and collection listings share one markup block,
`div.tf-libro-en-ficha`, and it already carries the full edition record. That is
why resolving a title costs one request rather than one per candidate.
"""

import html
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = "https://tercerafundacion.net"
SPINE = BASE + "/imagenes/lomo/L-%08d.jpg"
COVER = BASE + "/imagenes/portada/P-%08d.jpg"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) vitrina/1.0 (personal library catalogue)"

# One request every DELAY seconds. The site is a volunteer-run catalogue behind
# Cloudflare; there is no reason to crawl it faster than a person reads.
DELAY = 1.2
_last = [0.0]


class Fetcher:
    """Rate-limited GET with an on-disk cache, so a re-run costs nothing."""

    def __init__(self, cache_dir, delay=DELAY, refresh=False):
        self.cache_dir = cache_dir
        self.delay = delay
        self.refresh = refresh
        os.makedirs(cache_dir, exist_ok=True)
        self.hits = 0
        self.misses = 0

    def _path(self, url):
        safe = re.sub(r"[^A-Za-z0-9._-]", "_", url.replace(BASE, ""))[:180]
        return os.path.join(self.cache_dir, safe + ".html")

    def get(self, url):
        path = self._path(url)
        if os.path.exists(path) and not self.refresh:
            self.hits += 1
            with open(path, encoding="utf-8") as fh:
                return fh.read()
        wait = self.delay - (time.time() - _last[0])
        if wait > 0:
            time.sleep(wait)
        _last[0] = time.time()
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=30) as resp:
            text = resp.read().decode("utf-8", "replace")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)
        self.misses += 1
        return text

    def head_ok(self, url):
        """True when the URL serves a real image. Spines 404 as text/html."""
        wait = self.delay - (time.time() - _last[0])
        if wait > 0:
            time.sleep(wait)
        _last[0] = time.time()
        req = urllib.request.Request(url, headers={"User-Agent": UA}, method="HEAD")
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                return resp.status == 200 and resp.headers.get("Content-Type", "").startswith("image/")
        except urllib.error.HTTPError:
            return False
        except urllib.error.URLError:
            return False


# ── HTML helpers ─────────────────────────────────────────────────────────────

EN_VENTA = re.compile(r"\s*\bEN\s+VENTA\b\s*$", re.I)


def clean_title(t):
    """Drop the catalogue's `EN VENTA` for-sale marker from a stored title."""
    return EN_VENTA.sub("", t or "").strip()


def _text(fragment):
    """Strip tags and collapse whitespace.

    Tags become spaces, so the punctuation that sat against a closing tag ends
    up orphaned: `<a>Title</a>, novela` collapsed to `Title , novela`. Close
    those gaps, or every contents line reads like a typo."""
    fragment = re.sub(r"<script.*?</script>", " ", fragment, flags=re.S)
    fragment = re.sub(r"<style.*?</style>", " ", fragment, flags=re.S)
    fragment = re.sub(r"<[^>]+>", " ", fragment)
    out = re.sub(r"\s+", " ", html.unescape(fragment)).strip()
    out = re.sub(r"\s+([,;:.!?\)\]])", r"\1", out)
    out = re.sub(r"([\(\[])\s+", r"\1", out)
    return out


def _links(fragment):
    """[(id, label)] for every /ver/<kind>/<id> anchor in the fragment."""
    out = []
    for m in re.finditer(r'ver/(\w+)/(\d+)[^>]*>(.*?)</a>', fragment, re.S):
        label = _text(m.group(3))
        if label:
            out.append({"kind": m.group(1), "id": int(m.group(2)), "name": label})
    return out


def _dato(block, label):
    """The `div.tf-dato` whose `span.tf-etiqueta` is `label`, as raw HTML."""
    pattern = (r'<div class="tf-dato[^"]*">\s*(?:<[^>]+>\s*)*?'
               r'<span class="tf-etiqueta">' + re.escape(label) + r'[^<]*</span>(.*?)</div>')
    m = re.search(pattern, block, re.S)
    return m.group(1) if m else ""


def _numero(fragment):
    m = re.search(r'<span class="tf-numero">\s*([^<]+?)\s*</span>', fragment)
    return m.group(1).strip() if m else None


def _first_link(fragment):
    ls = _links(fragment)
    return ls[0] if ls else None


# ── Record parsing ───────────────────────────────────────────────────────────

def parse_record(block):
    """One `div.tf-libro-en-ficha` block, as it appears in search results and
    collection listings. Returns the same shape as parse_book, minus the fields
    that only exist on a detail page (back cover text, table of contents)."""
    m = re.search(r'ver/libro/(\d+)', block)
    if not m:
        return None
    book_id = int(m.group(1))

    title = ""
    year = None
    listed_number = None
    h = re.search(r'<h3 class="tf-titulo-libro-edicion">(.*?)</h3>', block, re.S)
    if h:
        inner = h.group(1)
        ym = re.search(r'<span class="tf-titulo-anio">\s*\((.*?)\)\s*</span>', inner)
        if ym:
            year = _text(ym.group(1))
            inner = inner.replace(ym.group(0), "")
        # On a COLLECTION page the number sits in the heading and the
        # `Coleccion:` field is omitted, because the page itself is the
        # collection. Left in place it becomes part of the title.
        nm = re.search(r'<span class="tf-numero-titulo">\s*N\S*\s*([^<]+?)\s*</span>', inner)
        if nm:
            listed_number = nm.group(1).strip()
            inner = inner.replace(nm.group(0), "")
        title = clean_title(_text(inner))

    rec = _common_fields(block, book_id, title, year)
    if listed_number and not rec.get("collection_number"):
        rec["collection_number"] = listed_number
    return rec


def _common_fields(block, book_id, title, year):
    authors_block = re.search(r'<div class="tf-dato tf-autores(?:-libro)?">(.*?)</div>', block, re.S)
    authors = _links(authors_block.group(1)) if authors_block else []

    publisher = _first_link(_dato(block, "Editorial:"))
    country = re.search(r'<span class="tf-editorial-pais">\s*\(([^)]+)\)', block)

    coll_frag = _dato(block, "Colección:")
    sub_frag = _dato(block, "Subcolección:")
    collection = _first_link(coll_frag)
    subcollection = _first_link(sub_frag)

    isbn_frag = _dato(block, "ISBN:")
    isbn = _text(isbn_frag) or None

    fmt = re.search(r'<div class="tf-dato tf-formato">(.*?)</div>', block, re.S)

    trans_frag = re.search(r'<div class="tf-dato tf-dato-traduccion">(.*?)</div>\s*</div>', block, re.S)
    translators = []
    tm = re.search(r'<span class="tf-etiqueta">Traducción[^<]*</span>(.*?)(?=</div>)', block, re.S)
    if tm:
        translators = [l for l in _links(tm.group(1)) if l["kind"] == "persona"]

    cover_art = []
    cm = re.search(r'<span class="tf-etiqueta">Ilustración de cubierta:</span>(.*?)(?=</div>)', block, re.S)
    if cm:
        cover_art = [l for l in _links(cm.group(1)) if l["kind"] == "persona"]

    series = []
    sm = re.search(r'<div class="tf-dato tf-dato-serie">(.*?)</div>', block, re.S)
    if sm:
        series = [l for l in _links(sm.group(1)) if l["kind"] == "termino"]

    awards = []
    for am in re.finditer(r'<div class="tf-dato tf-dato-premio">(.*?)</div>', block, re.S):
        awards.append(_text(am.group(1)))

    gm = re.search(r'<(?:span|div) class="tf-(?:genero-derecha|edicion-iconos-der)"[^>]*>(.*?)</(?:span|div)>\s*</(?:span|div)>',
                   block, re.S) or re.search(r'<(?:span|div) class="tf-(?:genero-derecha|edicion-iconos-der)"[^>]*>(.*?)</(?:span|div)>',
                                             block, re.S)
    genres = sorted({g for g in re.findall(r'class="tf-icono-genero" alt="([^"]+)"',
                                           gm.group(1) if gm else "")})

    rec = {
        "id": book_id,
        "title": title,
        "year": year,
        "authors": [a["name"] for a in authors],
        "author_ids": [a["id"] for a in authors],
        "publisher": publisher["name"] if publisher else None,
        "publisher_country": country.group(1) if country else None,
        "collection": collection["name"] if collection else None,
        "collection_id": collection["id"] if collection else None,
        "collection_number": _numero(coll_frag),
        "subcollection": subcollection["name"] if subcollection else None,
        "subcollection_id": subcollection["id"] if subcollection else None,
        "subcollection_number": _numero(sub_frag),
        "isbn": isbn,
        "format": _text(fmt.group(1)) if fmt else None,
        "translators": [t["name"] for t in translators],
        "cover_art": [c["name"] for c in cover_art],
        "series": [s["name"] for s in series],
        "series_ids": [s["id"] for s in series],
        "awards": awards,
        "genres": genres,
        "url": "%s/biblioteca/ver/libro/%d/" % (BASE, book_id),
        "spine": SPINE % book_id,
        "cover": COVER % book_id,
    }
    if rec["format"]:
        # Sizes are written with a decimal comma: `12,5×20 cm`, `11×17,5 cm`.
        # A plain \d+ matched `5×20` out of the first and nothing out of the
        # second, so 16 of 39 shelf books were mis-sized and four fell back to
        # the default height, standing as tall as a trade paperback.
        dm = re.search(r'(\d+(?:[.,]\d+)?\s*×\s*\d+(?:[.,]\d+)?)\s*cm', rec["format"])
        pm = re.search(r'(\d+)\s*páginas', rec["format"])
        rec["dimensions"] = dm.group(1) if dm else None
        rec["pages"] = int(pm.group(1)) if pm else None
    else:
        rec["dimensions"] = None
        rec["pages"] = None
    return rec


def parse_book(page):
    """A `/ver/libro/{id}/` detail page. Adds back cover text and contents."""
    m = re.search(r'<span class="tf-seccion-id">id:(\d+)</span>', page)
    if not m:
        return None
    book_id = int(m.group(1))

    title, year = "", None
    h = re.search(r'<h1 class="tf-titulo-ficha">(.*?)</h1>', page, re.S)
    if h:
        inner = h.group(1)
        ym = re.search(r'<span class="tf-titulo-anio">\s*\((.*?)\)\s*</span>', inner)
        if ym:
            year = _text(ym.group(1))
            inner = inner.replace(ym.group(0), "")
        title = clean_title(_text(inner))

    rec = _common_fields(page, book_id, title, year)

    work = re.search(r'<span class="tf-etiqueta">Otras ediciones de</span>\s*<a href="[^"]*ver/ficha/(\d+)"', page)
    rec["work_id"] = int(work.group(1)) if work else None

    # The back cover text is deliberately NOT captured. It is publisher
    # marketing copy, this repo is public, and the shelf links to the
    # catalogue record where it can be read in place. The table of contents
    # below is a different thing: page ranges and story titles are
    # bibliographic fact, and they are what makes an omnibus legible.
    contents = []
    for row in re.finditer(r'<tr>\s*<td class="tf-col-pag">(.*?)</td>\s*<td class="tf-col-contenido">(.*?)</td>', page, re.S):
        entry = _text(row.group(2))
        if entry:
            contents.append({"pages": _text(row.group(1)), "entry": entry})
    rec["contents"] = contents

    note = re.search(r'<div class="tf-nota tf-nota-normal">(.*?)</div>', page, re.S)
    text = _text(note.group(1)) if note else None
    if text:
        text = re.sub(r'^Nota de bibliotecario:?\s*', '', text, flags=re.I)
    rec["note"] = text or None
    return rec


def parse_records(page, context=None):
    """Every `div.tf-libro-en-ficha` on a search or collection page.

    `context` supplies what a collection listing leaves implicit: pass the
    header from `parse_collection_header` and each record gets the collection
    id, name and publisher the page itself stands for."""
    blocks = re.split(r'(?=<div class="tf-libro-en-ficha">)', page)
    out = []
    for b in blocks[1:]:
        b = b.split('<div class="tf-paginacion')[0].split("</main>")[0]
        rec = parse_record(b)
        if not rec:
            continue
        if context:
            if rec.get("collection_id") is None:
                rec["collection_id"] = context.get("id")
                rec["collection"] = context.get("name")
            if not rec.get("publisher"):
                rec["publisher"] = context.get("publisher")
        out.append(rec)
    return out


def parse_pagination(page):
    """(current, total) pages from a listing, or (1, 1) when unpaginated."""
    m = re.search(r'Página\s+(\d+)\s+de\s+(\d+)', page)
    return (int(m.group(1)), int(m.group(2))) if m else (1, 1)


def parse_collection_header(page):
    """Collection name, publisher and catalogued count from a collection page."""
    name = re.search(r'<h1 class="tf-titulo-ficha">\s*(.*?)\s*</h1>', page, re.S)
    cid = re.search(r'<span class="tf-seccion-id">id:(\d+)</span>', page)
    total = re.search(r'Total\s+(\d+)\s+elementos', page)
    pub = _first_link(_dato(page, "Editorial:"))
    return {
        "id": int(cid.group(1)) if cid else None,
        "name": _text(name.group(1)) if name else None,
        "publisher": pub["name"] if pub else None,
        "count": int(total.group(1)) if total else None,
    }



def parse_compact(page):
    """`li.tf-buscar-item` results, which is what `tipo=libro` returns.

    This block carries only the book id, its title and the author names. It is
    the only search mode that reliably finds every edition, so it is the entry
    point: match on it, then read the work page for the full records."""
    out = []
    for m in re.finditer(
            r'<li class="tf-buscar-item">\s*<a href="[^"]*ver/libro/(\d+)"[^>]*>(.*?)</a>'
            r'(?:\s*<span class="tf-buscar-extra">(.*?)</span>)?', page, re.S):
        authors = _text(m.group(3) or "")
        out.append({
            "id": int(m.group(1)),
            "title": _text(m.group(2)),
            "authors": [a.strip() for a in authors.split(",") if a.strip()] if authors else [],
        })
    return out


def work_url(fid):
    return "%s/biblioteca/ver/ficha/%d" % (BASE, fid)

def search_url(query, tipo="titulo"):
    params = urllib.parse.urlencode({"q": query, "tipo": tipo})
    return "%s/biblioteca/buscar/?%s" % (BASE, params)


def collection_url(cid, page=1):
    if page == 1:
        return "%s/biblioteca/ver/coleccion/%d?p=libros" % (BASE, cid)
    return "%s/biblioteca/ver/coleccion/%d?p=libros&pag=%d" % (BASE, cid, page)


def book_url(bid):
    return "%s/biblioteca/ver/libro/%d/" % (BASE, bid)


def dump(path, obj):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False, indent=1, sort_keys=False)
        fh.write("\n")
