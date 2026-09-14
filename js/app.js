// ── Entry point ──────────────────────────────────────────────────────────────
// Loads the shelf, renders it, wires the interactions, then hands the page to
// the module that decides whose shelf it shows: account.js on /shelf/ and
// /demo/, profile.js on /u/. Neither is awaited, so the first paint never waits
// on sign-in, a CDN or a database.

import { state, hydrate } from './state.js';
import { loadData } from './data.js';
import { render } from './render.js';
import { bindEvents } from './events.js';
import { startAccount } from './account.js';
import { startProfile } from './profile.js';
import { $ } from './utils.js';

async function init() {
  const library = await loadData();
  hydrate(library, document.body.dataset.mode);

  $('#groupBy').value = state.groupBy;
  $('#sortBy').value = state.sortBy;
  $('#trueScale').checked = state.trueScale;
  $('#hideOwned').checked = state.hideOwned;
  $('#showRuns').checked = state.showRuns;

  render();
  bindEvents();
  if (state.mode === 'profile') startProfile(library);
  else startAccount(state.mode);
}

init();
