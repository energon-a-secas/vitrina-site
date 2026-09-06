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
import { title, authorLine, bookHeight, spineFor, bookYear, hasSpine } from './data.js';

export const UNIT_PX = 15;          // pixels per centimetre of book height
const MIN_THICK_CM = 0.9;
const MAX_THICK_CM = 5.5;

/** Estimated thickness in cm from the page count, for reserving layout space. */
export function thicknessCm(entry) {
  const pages = (entry.record && entry.record.pages) || 0;
  if (!pages) return 1.6;
  return Math.min(MAX_THICK_CM, Math.max(MIN_THICK_CM, pages / 190));
}

export function spineMarkup(entry, { trueScale = true } = {}) {
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
    ? `<img class="spine__img" src="${escHtml(src)}" alt="" loading="lazy" decoding="async">`
    : '';

  return `<button type="button" class="spine${src ? '' : ' spine--drawn'}"
      data-key="${escHtml(entry.key)}"
      style="--h:${h * UNIT_PX}px; --est:${est}px; --hue:${hue};"
      title="${escHtml(label)}" aria-label="${escHtml(label)}">
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
      else fallback(btn, img);
    } else {
      img.addEventListener('load', apply, { once: true });
      img.addEventListener('error', () => fallback(btn, img), { once: true });
    }
  });
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
      <div class="shelfrow__case">
        <div class="shelfrow__books">${books}</div>
        <div class="shelfrow__board" aria-hidden="true"></div>
      </div>
    </section>`;
}

export function cssId(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x';
}
