/**
 * ISBN identity.
 *
 * A scanned barcode is 13 digits. This catalogue is not: 406 of its 771 ISBNs
 * are ISBN-10 and 365 are ISBN-13, and 21 of the shelf's own 39 books are
 * ISBN-10. Matching a scan against the raw strings therefore misses the
 * majority of records, so everything is compared as ISBN-13 and nothing else.
 *
 * An ISBN is also not unique here. The catalogue holds several editions under
 * one number, so resolving a scan yields a LIST of candidates and the person
 * picks; silently taking the first would put the wrong printing on a shelf
 * whose whole point is which printing you own.
 */

/** Strip the punctuation people and barcodes disagree about. `X` is a digit. */
export function clean(raw) {
  return String(raw == null ? '' : raw).toUpperCase().replace(/[^0-9X]/g, '');
}

/** ISBN-10 check digit: weights 10..1, valid when the total is divisible by 11. */
export function isValid10(s) {
  const v = clean(s);
  if (!/^\d{9}[\dX]$/.test(v)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i += 1) sum += (10 - i) * Number(v[i]);
  sum += v[9] === 'X' ? 10 : Number(v[9]);
  return sum % 11 === 0;
}

/** EAN-13 check digit: alternating weights 1 and 3 over the first twelve. */
export function check13(first12) {
  let sum = 0;
  for (let i = 0; i < 12; i += 1) sum += Number(first12[i]) * (i % 2 ? 3 : 1);
  return String((10 - (sum % 10)) % 10);
}

export function isValid13(s) {
  const v = clean(s);
  if (!/^\d{13}$/.test(v)) return false;
  return check13(v.slice(0, 12)) === v[12];
}

/** ISBN-10 to ISBN-13: prefix 978, drop the old check digit, recompute. */
export function to13(s) {
  const v = clean(s);
  if (/^\d{13}$/.test(v)) return v;
  if (!/^\d{9}[\dX]$/.test(v)) return null;
  const body = '978' + v.slice(0, 9);
  return body + check13(body);
}

/**
 * The single form everything is compared as. Returns a 13-digit string, or null
 * when the input is not an ISBN at all.
 *
 * Deliberately lenient about the check digit: a catalogue typo and a smudged
 * scan are both real, and refusing to look up a number because its last digit
 * disagrees helps nobody. `looksValid` reports it separately so a caller can
 * warn without blocking.
 */
export function key(raw) {
  const v = clean(raw);
  if (/^\d{13}$/.test(v)) return v;
  if (/^\d{9}[\dX]$/.test(v)) return to13(v);
  return null;
}

/** Whether the number checks out, for a caller that wants to say so. */
export function looksValid(raw) {
  const v = clean(raw);
  if (/^\d{13}$/.test(v)) return isValid13(v);
  if (/^\d{9}[\dX]$/.test(v)) return isValid10(v);
  return false;
}

/**
 * A scanned EAN-13 may carry a 5-digit price add-on (the 978... 51299 shape).
 * Split it off rather than failing: the book half is the part that identifies.
 */
export function fromScan(raw) {
  const v = clean(raw);
  if (/^\d{18}$/.test(v)) return key(v.slice(0, 13));
  return key(v);
}

/** Group ISBNs into 978 (book) and 979 (newer book) prefixes, for display. */
export function isBookEan(raw) {
  const v = clean(raw);
  return /^\d{13}$/.test(v) && (v.startsWith('978') || v.startsWith('979'));
}
