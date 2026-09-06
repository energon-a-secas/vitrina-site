// ── Entry point ──────────────────────────────────────────────────────────────
// Loads the shelf, renders it, wires the interactions. Nothing else lives here.

import { state, hydrate } from './state.js';
import { loadData } from './data.js';
import { render } from './render.js';
import { bindEvents } from './events.js';
import { $ } from './utils.js';

async function init() {
  const library = await loadData();
  hydrate(library);

  $('#groupBy').value = state.groupBy;
  $('#sortBy').value = state.sortBy;
  $('#trueScale').checked = state.trueScale;
  $('#hideOwned').checked = state.hideOwned;
  $('#showRuns').checked = state.showRuns;

  render();
  bindEvents();
}

init();
