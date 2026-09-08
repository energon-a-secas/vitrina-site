// ── The shelf itself: spines standing at their real proportions ──────────────
//
// A spine scan is a narrow strip whose aspect ratio already encodes how thick
// the book is. So the only number the layout needs is the book's real height in
// centimetres: render at `unit * height`, let the image's own ratio decide the
// width, and a row of them comes out as uneven as the real shelf.
//
// Editions with no scan (54 of the 161 this shelf considered) get a drawn spine
// instead, wide in proportion to its page count. It is deliberately flat and
// typographic, so nobody mistakes it for the real cover.

import { escHtml, hueOf, numberOf } from './utils.js';
import { title, authorLine, bookHeight, spineFor, bookYear, hasSpine, localSpine, hasLocalSpine, spineUrl, hasThumbSpine } from './data.js';

export const UNIT_PX = 15;          // pixels per centimetre of book height
const MIN_THICK_CM = 0.9;
const MAX_THICK_CM = 5.5;

/** Estimated thickness in cm from the page count, for reserving layout space. */
export function thicknessCm(entry) {
  const pages = (entry.record && entry.record.pages) || 0;
  if (!pages) return 1.6;
  return Math.min(MAX_THICK_CM, Math.max(MIN_THICK_CM, pages / 190));
}

export function spineMarkup(entry, { trueScale = true, ghost = false, number = null } = {}) {
  const h = trueScale ? bookHeight(entry) : 19;
  const est = thicknessCm(entry) * UNIT_PX;
  // `has_spine: false` is the catalogue's own answer, recorded by
  // `scrape.py spines`. Honour it here rather than firing a request that is
  // known to 404 and only then falling back.
  const src = hasSpine(entry) ? spineFor(entry) : null;
  const t = title(entry);
  const label = `${t}, ${authorLine(entry)}${bookYear(entry) ? ', ' + bookYear(entry) : ''}`;
  const num = entry.record && entry.record.collection_number;
  const hue = hueOf(t);

  const inner = src
    ? `<img class="spine__img" src="${escHtml(src)}" alt="" loading="lazy" decoding="async" fetchpriority="low"${entry.record && entry.record.id != null ? ` data-book-id="${entry.record.id}"` : ''}>`
    : '';

  const cls = `spine${src ? '' : ' spine--drawn'}${ghost ? ' spine--ghost' : ''}`;
  const name = ghost ? `${label}. Not on your shelf` : label;
  return `<button type="button" class="${cls}"
      data-key="${escHtml(entry.key)}"${number != null ? ` data-number="${escHtml(number)}"` : ''}
      style="--h:${h * UNIT_PX}px; --est:${est}px; --hue:${hue};"
      title="${escHtml(name)}" aria-label="${escHtml(name)}">
      ${inner}
      <span class="spine__drawn" aria-hidden="true">
        <span class="spine__drawn-title">${escHtml(t)}</span>
        ${num && numberOf(num) !== Number.MAX_SAFE_INTEGER ? `<span class="spine__drawn-num">${escHtml(num)}</span>` : ''}
      </span>
    </button>`;
}

/**
 * Give each loaded spine an exact width from its own aspect ratio, and fall
 * back to the drawn spine when the scan turns out to be missing. The catalogue
 * answers a missing scan with an HTML 404 rather than an image, so `error` is
 * the only reliable signal and it has to be handled at render time.
 */
export function measureSpines(root) {
  root.querySelectorAll('.spine__img').forEach((img) => {
    const btn = img.closest('.spine');
    if (!btn || btn.dataset.measured) return;
    const apply = () => {
      if (!img.naturalWidth || !img.naturalHeight) return;
      const h = parseFloat(btn.style.getPropertyValue('--h')) || 19 * UNIT_PX;
      btn.style.setProperty('--w', `${Math.max(6, (img.naturalWidth / img.naturalHeight) * h)}px`);
      btn.dataset.measured = '1';
    };
    if (img.complete) {
      if (img.naturalWidth) apply();
      else onError(btn, img, apply);
    } else {
      img.addEventListener('load', apply, { once: true });
      img.addEventListener('error', () => onError(btn, img, apply), { once: true });
    }
  });
}

/**
 * One retry against the local cache before giving up on the image.
 * `data/images/` is written by `scrape.py cache-images` and is gitignored, so
 * on the published page this step simply 404s and the drawn spine takes over.
 */
/**
 * Walk down the sources for a spine, one step per failure.
 *
 *   our thumbnail  (only the shelf's own books have one, and it is the default)
 *   the catalogue  (every volume, and the only source for the other 525)
 *   the local cache (gitignored, so this step exists in development only)
 *   the drawn spine
 *
 * Each step is attempted at most once per image, tracked on the element, so a
 * source that fails twice cannot loop.
 */
function onError(btn, img, apply) {
  const id = img.dataset.bookId;
  const next = (mark, url) => {
    img.dataset[mark] = '1';
    img.addEventListener('load', apply, { once: true });
    img.addEventListener('error', () => onError(btn, img, apply), { once: true });
    img.src = url;
  };
  if (id) {
    if (hasThumbSpine(id) && !img.dataset.triedRemote) return next('triedRemote', spineUrl(id));
    if (hasLocalSpine(id) && !img.dataset.triedLocal) return next('triedLocal', localSpine(id));
  }
  fallback(btn, img);
}

function fallback(btn, img) {
  btn.classList.add('spine--drawn');
  btn.dataset.measured = '1';
  img.remove();
}

/** One shelf row: a board, its label, and the books standing on it. */
export function shelfMarkup(group, opts) {
  const books = group.books.map((e) => spineMarkup(e, opts)).join('');
  return `<section class="shelfrow" aria-labelledby="sh-${cssId(group.label)}">
      <header class="shelfrow__head">
        <h2 class="shelfrow__label" id="sh-${cssId(group.label)}">${escHtml(group.label)}</h2>
        <span class="shelfrow__count">${group.books.length}</span>
      </header>
      <div class="shelfrow__case-wrap">
        <div class="shelfrow__case">
          <div class="shelfrow__books">${books}</div>
          <div class="shelfrow__board" aria-hidden="true"></div>
        </div>
      </div>
    </section>`;
}

/**
 * Which edges of a scrollable row still have books beyond them.
 * Pure, so it can be tested without a browser: the DOM half below is wiring.
 */
export function scrollState(scrollLeft, scrollWidth, clientWidth) {
  const slack = scrollWidth - clientWidth;
  if (slack <= 2) return 'none';
  if (scrollLeft <= 2) return 'start';
  if (scrollLeft >= slack - 2) return 'end';
  return 'middle';
}

/**
 * Tell each row whether it continues past its edges, so the fade can say so.
 * A 365-volume row scrolls sideways with nothing on screen admitting it: no
 * scrollbar until you touch it, no edge, no hint that Nova reaches 363.
 *
 * `scrollWidth` and `clientWidth` are cached and refreshed by the observer
 * rather than read per scroll event, because reading them forces layout and a
 * trackpad flick delivers a lot of events.
 */
export function markScrollable(root) {
  root.querySelectorAll('.shelfrow__case').forEach((el) => {
    let sw = el.scrollWidth;
    let cw = el.clientWidth;
    const paint = () => {
      const next = scrollState(el.scrollLeft, sw, cw);
      if (next === 'none') el.removeAttribute('data-scroll');
      else if (el.dataset.scroll !== next) el.dataset.scroll = next;
    };
    const remeasure = () => { sw = el.scrollWidth; cw = el.clientWidth; paint(); };
    el.addEventListener('scroll', paint, { passive: true });
    // Spine widths are only known once their images decode, so the row keeps
    // growing after first paint. Watch it rather than measuring once.
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(remeasure);
      ro.observe(el);
      const books = el.querySelector('.shelfrow__books');
      if (books) ro.observe(books);
    }
    remeasure();
  });
}

export function cssId(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x';
}

/** One collection, whole: every catalogued volume with the owned ones lit. */
export function runMarkup(run, opts) {
  const books = run.volumes.map((v) => spineMarkup(
    { key: v.key, record: v.record },
    { ...opts, ghost: !v.owned, number: v.number }
  )).join('');
  return `<section class="shelfrow shelfrow--run" aria-labelledby="run-${cssId(run.label)}">
      <header class="shelfrow__head">
        <h2 class="shelfrow__label" id="run-${cssId(run.label)}">${escHtml(run.label)}</h2>
        <span class="shelfrow__count">${run.filtered
          ? `${run.total} of ${run.full} match`
          : `${run.owned} of ${run.total}`}</span>
        <span class="shelfrow__hint">${run.filtered
          ? `${run.owned} of them yours`
          : 'the lit ones are yours'}</span>
      </header>
      <div class="shelfrow__case-wrap">
        <div class="shelfrow__case">
          <div class="shelfrow__books">${books}</div>
          <div class="shelfrow__board" aria-hidden="true"></div>
        </div>
      </div>
    </section>`;
}
