// Plain node, no install. Run with: make validate
//
// scrollState decides whether a shelf row admits that it continues past its
// edges. It is tested here rather than in a browser because the fade it drives
// is invisible until it is wrong, and because the row it exists for is 13,670px
// of Nova that no screenshot shows the end of.

import { scrollState, thicknessCm, cssId } from '../js/shelf.js';

let failed = 0;
function eq(actual, expected, what) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failed += 1; console.error(`FAIL ${what}\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(actual)}`); }
  else console.log(`ok   ${what}`);
}

// A row that fits needs no fade at all.
eq(scrollState(0, 1352, 1352), 'none', 'a row that fits is not marked');
eq(scrollState(0, 1353, 1352), 'none', 'a one-pixel overhang is not a fade');

// The Nova run: 13670px of spines in a 1232px case.
eq(scrollState(0, 13670, 1232), 'start', 'at rest, only the right edge continues');
eq(scrollState(800, 13670, 1232), 'middle', 'mid-scroll, both edges continue');
eq(scrollState(12438, 13670, 1232), 'end', 'at the far end, only the left continues');
eq(scrollState(12437, 13670, 1232), 'end', 'the last two pixels still count as the end');
eq(scrollState(2, 13670, 1232), 'start', 'the first two pixels still count as the start');
eq(scrollState(3, 13670, 1232), 'middle', 'past the tolerance it is mid-scroll');

// Sub-pixel widths are normal once spine images decide their own width.
eq(scrollState(0, 13670.4, 1231.6), 'start', 'fractional widths behave');

// Thickness reserves layout space before an image has decoded.
eq(thicknessCm({ record: { pages: 0 } }), 1.6, 'no page count falls back to a middling book');
eq(thicknessCm({ record: { pages: 190 } }), 1, '190 pages is one centimetre');
eq(thicknessCm({ record: { pages: 30 } }), 0.9, 'a pamphlet is clamped to the minimum');
eq(thicknessCm({ record: { pages: 9999 } }), 5.5, 'an omnibus is clamped to the maximum');

// Labels become ids, and collection names carry accents and parentheses.
eq(cssId('Ciencia Ficción (Zeta Bolsillo)'), 'ciencia-ficci-n-zeta-bolsillo', 'accents and brackets are stripped');
eq(cssId('!!!'), 'x', 'a label with nothing usable still yields an id');

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
