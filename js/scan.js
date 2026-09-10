/**
 * Resolve an ISBN against the local scan index.
 *
 * Nothing here talks to tercerafundacion.net. Their server sends no
 * access-control-allow-origin header, so a browser cannot query it and a static
 * site has no server to proxy through. Resolving locally is also the polite
 * shape: one scrape by the owner rather than a request to their server on
 * behalf of every stranger who scans a book.
 *
 * The index is loaded on demand, not at startup: it is 22 KB gzipped that only
 * matters once somebody opens the scanner.
 */

import { key, looksValid } from './isbn.js';

let indexPromise = null;

/** Load once, cache the promise so concurrent callers share one request. */
export function loadScanIndex() {
  if (!indexPromise) {
    indexPromise = fetch('/data/scan-index.json', { cache: 'no-cache' })
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return r.json();
      })
      .catch((err) => {
        indexPromise = null;           // let a later attempt retry
        throw err;
      });
  }
  return indexPromise;
}

/**
 * What a scanned or typed number resolves to.
 *
 * Always a LIST. An ISBN is not unique in this catalogue: 48 keys cover 109
 * editions and the worst holds four, so picking the first silently would put
 * the wrong printing on a shelf whose entire subject is which printing you own.
 *
 * @returns {Promise<{query: string, key: string|null, valid: boolean,
 *   candidates: Array<object>, reason: string|null}>}
 */
export async function resolveIsbn(raw) {
  const k = key(raw);
  const valid = looksValid(raw);
  if (!k) {
    return { query: String(raw ?? ''), key: null, valid: false, candidates: [], reason: 'not-an-isbn' };
  }

  let data;
  try {
    data = await loadScanIndex();
  } catch {
    return { query: String(raw ?? ''), key: k, valid, candidates: [], reason: 'index-unavailable' };
  }

  const hits = (data.isbn && data.isbn[k]) || [];
  const collections = data.collections || {};
  const candidates = hits.map((h) => ({
    id: h.i,
    title: h.t,
    author: h.a,
    year: h.y,
    collectionId: h.c,
    collectionNumber: h.n,
    dimensions: h.d,
    pages: h.p,
    collection: h.c != null && collections[String(h.c)]
      ? collections[String(h.c)].name
      : null,
    publisher: h.c != null && collections[String(h.c)]
      ? collections[String(h.c)].publisher
      : null,
  }));

  return {
    query: String(raw ?? ''),
    key: k,
    valid,
    candidates,
    reason: candidates.length ? null : 'not-in-catalogue',
  };
}

/** A one-line explanation a person can act on, rather than a code. */
export function explain(result) {
  if (!result) return '';
  switch (result.reason) {
    case 'not-an-isbn':
      return 'That is not an ISBN. A book barcode is 13 digits, and the number printed above it is 10 or 13.';
    case 'index-unavailable':
      return 'The scan index did not load. Run python3 scripts/scan_index.py, or reload the page.';
    case 'not-in-catalogue':
      return result.valid
        ? 'A real ISBN, but not in the collections scraped so far. Widen the scrape to cover its line.'
        : 'Not found, and the check digit does not add up either, so the number may be mistyped.';
    default:
      return result.candidates.length > 1
        ? `${result.candidates.length} editions share this ISBN. Pick the one you own.`
        : '';
  }
}
