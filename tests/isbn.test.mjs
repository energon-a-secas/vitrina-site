// Plain node, no install. Run with: make validate
//
// This is the join key for scanning, so it is tested against the real
// catalogue's own numbers rather than invented ones. Every expectation below
// was computed from data/catalog.json before it was written down.

import { clean, isValid10, isValid13, check13, to13, key, looksValid, fromScan, isBookEan } from '../js/isbn.js';

let failed = 0;
function eq(actual, expected, what) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failed += 1; console.error(`FAIL ${what}\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(actual)}`); }
  else console.log(`ok   ${what}`);
}

// Cleaning: barcodes, catalogues and people all punctuate differently.
eq(clean('978-84-7735-049-1'), '9788477350491', 'hyphens are not part of the number');
eq(clean('  84 7735 049 3 '), '8477350493', 'spaces are not either');
eq(clean('847735049x'), '847735049X', 'a lowercase check digit is still ten');
eq(clean(null), '', 'nothing in, nothing out');

// Real numbers from this catalogue.
eq(isValid10('8477350493'), true, 'a real catalogue ISBN-10 checks out');
eq(isValid13('9788466653954'), true, 'a real catalogue ISBN-13 checks out');
eq(to13('8477350493'), '9788477350491', 'the real ISBN-10 converts to its real ISBN-13');
eq(check13('978847735049'), '1', 'the EAN check digit is computed, not guessed');

// The check digit actually catches a wrong digit, which is its only job.
eq(isValid10('8477350494'), false, 'a wrong ISBN-10 check digit is rejected');
eq(isValid13('9788466653955'), false, 'a wrong ISBN-13 check digit is rejected');
eq(isValid10('847735049'), false, 'nine digits is not an ISBN-10');
eq(isValid13('978846665395'), false, 'twelve digits is not an ISBN-13');

// X is a legitimate ISBN-10 check digit and must survive the whole path.
eq(isValid10('080442957X'), true, 'X is a valid check digit');
eq(to13('080442957X'), '9780804429573', 'and converts like any other');

// key() is what everything compares as.
eq(key('8477350493'), '9788477350491', 'an ISBN-10 keys as its ISBN-13');
eq(key('9788477350491'), '9788477350491', 'an ISBN-13 keys as itself');
eq(key('978-84-7735-049-1'), '9788477350491', 'punctuation does not change the key');
eq(key('not a book'), null, 'a non-ISBN has no key');
eq(key(''), null, 'nor does nothing');

// Deliberately lenient. The catalogue really does contain one ISBN that fails
// its check digit (9788410466962, El alma del emperador), and refusing to look
// it up would hide a book somebody may own.
eq(key('9788410466962'), '9788410466962', 'a bad check digit still resolves to a key');
eq(looksValid('9788410466962'), false, 'while looksValid reports the truth about it');
eq(looksValid('9788477350491'), true, 'and confirms a good one');

// A scanned book barcode often carries a five-digit price add-on.
eq(fromScan('9788477350491' + '51299'), '9788477350491', 'a price add-on is split off, not choked on');
eq(fromScan('9788477350491'), '9788477350491', 'a plain scan is unchanged');
eq(fromScan('8477350493'), '9788477350491', 'a typed ISBN-10 goes down the same path');

// 979 exists and is a book prefix too; 5 is a coffee packet.
eq(isBookEan('9788477350491'), true, '978 is a book');
eq(isBookEan('9791234567896'), true, '979 is a book as well');
eq(isBookEan('5012345678900'), false, 'a non-book EAN is not');

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
