// Every site module must parse AS A MODULE. Run with: make validate
//
// This exists because `node --check js/foo.js` is not that check. Node treats a
// bare .js as CommonJS, where `import` is invalid anyway, and it let a genuine
// double comma inside an import list through while reporting OK. The browser
// then refused the whole module graph with "Unexpected token ','" and the page
// silently lost every event handler.
//
// Copying to a .mjs first is what makes node parse it under module rules.

import { execFileSync } from 'node:child_process';
import { readdirSync, copyFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DIR = new URL('../js/', import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), 'vitrina-syntax-'));
let failed = 0;
let checked = 0;

for (const name of readdirSync(DIR).filter((f) => f.endsWith('.js')).sort()) {
  // The vendored kits are someone else's build; this repo does not edit them.
  if (name.startsWith('neorgon-')) continue;
  const as = join(tmp, name.replace(/\.js$/, '.mjs'));
  copyFileSync(join(DIR, name), as);
  checked += 1;
  try {
    execFileSync(process.execPath, ['--check', as], { stdio: 'pipe' });
    console.log(`ok   ${name} parses as a module`);
  } catch (err) {
    failed += 1;
    const msg = String(err.stderr || err.message).split('\n').slice(0, 3).join('\n  ');
    console.error(`FAIL ${name}\n  ${msg}`);
  }
}

console.log(failed ? `\n${failed} of ${checked} failed` : `\nall ${checked} parsed`);
process.exit(failed ? 1 : 0);
