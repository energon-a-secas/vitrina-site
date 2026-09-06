// ── Event wiring. No inline onclick anywhere in the markup. ──────────────────

import { state, savePrefs } from './state.js';
import { $, debounce, toast } from './utils.js';
import { render } from './render.js';
import { openBook, closeBook, editNote, takeOff, closeIfGone } from './detail.js';
import { showMore, addFromCatalog, resetBrowsePaging } from './browse.js';
import {
  addDialog, saveFromAddDialog, closeModal, exportShelf, importDialog,
  applyImport, resetShelf, reportDialog,
} from './modals.js';

export function bindEvents() {
  // View switch
  $('#stage').closest('main').addEventListener('click', (ev) => {
    const tab = ev.target.closest('.viewswitch__btn');
    if (!tab) return;
    state.view = tab.dataset.view;
    resetBrowsePaging();
    savePrefs();
    render();
  });

  // Opening a book, adding one, paging the catalogue
  $('#stage').addEventListener('click', (ev) => {
    const add = ev.target.closest('[data-add]');
    if (add) { if (addFromCatalog(add.dataset.add)) render(); return; }
    if (ev.target.closest('#moreBtn')) { showMore(); render(); return; }
    const book = ev.target.closest('.spine, .cover');
    if (book) openBook(book.dataset.key);
  });

  // Controls
  $('#search').addEventListener('input', debounce((ev) => {
    state.query = ev.target.value.trim();
    resetBrowsePaging();
    render();
  }, 160));

  $('#groupBy').addEventListener('change', (ev) => {
    state.groupBy = ev.target.value; savePrefs(); render();
  });
  $('#sortBy').addEventListener('change', (ev) => {
    state.sortBy = ev.target.value; savePrefs(); render();
  });
  $('#browseCollection').addEventListener('change', (ev) => {
    state.browseCollection = ev.target.value; resetBrowsePaging(); render();
  });
  $('#hideOwned').addEventListener('change', (ev) => {
    state.hideOwned = ev.target.checked; savePrefs(); resetBrowsePaging(); render();
  });
  $('#trueScale').addEventListener('change', (ev) => {
    state.trueScale = ev.target.checked; savePrefs(); render();
  });

  // Header actions
  $('#addBtn').addEventListener('click', addDialog);
  $('#statsBtn').addEventListener('click', reportDialog);
  $('#exportBtn').addEventListener('click', exportShelf);
  $('#importBtn').addEventListener('click', importDialog);

  // Drawer
  $('#drawer').addEventListener('click', (ev) => {
    if (ev.target.closest('[data-drawer-close]')) { closeBook(); return; }
    const act = ev.target.closest('[data-act]');
    if (!act) return;
    if (act.dataset.act === 'note') editNote(act.dataset.key);
    if (act.dataset.act === 'remove' && takeOff(act.dataset.key)) render();
  });

  // Modal
  $('#modal').addEventListener('click', (ev) => {
    if (ev.target.closest('[data-modal-close]')) { closeModal(); return; }
    if (ev.target.closest('#addSave')) {
      if (saveFromAddDialog()) { closeModal(); render(); }
      return;
    }
    if (ev.target.closest('#importSave')) {
      const text = $('#importText').value.trim();
      if (!text) { $('#importFile').click(); return; }
      if (applyImport(text)) { closeModal(); closeIfGone(); render(); }
      return;
    }
    if (ev.target.closest('#resetShelf')) {
      if (resetShelf()) { closeModal(); closeIfGone(); render(); }
      return;
    }
    const toggle = ev.target.closest('#shortcutsToggle');
    if (toggle) {
      state.shortcuts = toggle.checked;
      savePrefs();
    }
  });

  $('#modal').addEventListener('change', (ev) => {
    const file = ev.target.closest('#importFile');
    if (!file || !file.files || !file.files[0]) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (applyImport(String(reader.result))) { closeModal(); closeIfGone(); render(); }
    };
    reader.readAsText(file.files[0]);
  });

  // A shelf that cannot be saved must not keep reporting that it was.
  document.addEventListener('vitrina:storage-blocked', () => {
    toast('This browser is not letting the page store anything, so the shelf will not be here next time', 'bad');
  });

  // Keyboard
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { closeModal(); closeBook(); return; }

    // While an overlay is open the shortcuts used to keep firing behind it,
    // so a stray `a` replaced the open dialog and `2` switched the view under
    // the scrim. Inside an overlay the only key with a job is Tab.
    const modalOpen = !$('#modal').hidden;
    const drawerOpen = !$('#drawer').hidden;
    if (modalOpen || drawerOpen) { trapFocus(ev, modalOpen ? '#modal' : '#drawer'); return; }

    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName) || ev.target.isContentEditable;
    if (typing || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    // WCAG 2.1.4: a single-character shortcut needs a way to switch it off.
    // The Shelf report carries the toggle and the choice persists.
    if (!state.shortcuts) return;

    if (ev.key === '/') { ev.preventDefault(); $('#search').focus(); return; }
    if (ev.key === 'a') { ev.preventDefault(); addDialog(); return; }
    const jump = { 1: 'shelf', 2: 'covers', 3: 'browse' }[ev.key];
    // resetBrowsePaging matters here too: without it, jumping to Browse with a
    // key kept whatever "show more" depth the last visit had left behind.
    if (jump) { state.view = jump; resetBrowsePaging(); savePrefs(); render(); return; }
    if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') step(ev);
  });
}

/**
 * Keep Tab inside the open overlay. Both surfaces declare aria-modal, which
 * tells a screen reader the rest of the page is inert but does nothing about
 * the focus order, so Tab walked out into content it had just hidden.
 */
function trapFocus(ev, sel) {
  if (ev.key !== 'Tab') return;
  const root = $(sel);
  const items = Array.from(root.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), textarea, select, summary, [tabindex]:not([tabindex="-1"])'
  )).filter((el) => el.offsetParent !== null);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (ev.shiftKey && (active === first || !root.contains(active))) {
    ev.preventDefault(); last.focus();
  } else if (!ev.shiftKey && active === last) {
    ev.preventDefault(); first.focus();
  }
}

/** Walk the open book along its row, so a shelf can be read left to right. */
function step(ev) {
  if (!state.selected) return;
  const items = Array.from(document.querySelectorAll('.spine, .cover'))
    .filter((el) => el.offsetParent !== null);
  const i = items.findIndex((el) => el.dataset.key === state.selected);
  if (i < 0) return;
  ev.preventDefault();
  const next = items[i + (ev.key === 'ArrowRight' ? 1 : -1)];
  if (next) { openBook(next.dataset.key); next.scrollIntoView({ block: 'nearest', inline: 'center' }); }
}
