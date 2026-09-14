// ── Event wiring. No inline onclick anywhere in the markup. ──────────────────

import { state, savePrefs, restoreSeed, storedShelfSize } from './state.js';
import { $, debounce, toast } from './utils.js';
import { render } from './render.js';
import { openBook, closeBook, editNote, takeOff, closeIfGone } from './detail.js';
import { showMore, addFromCatalog, resetBrowsePaging } from './browse.js';
import {
  addDialog, saveFromAddDialog, closeModal, exportShelf, importDialog,
  applyImport, resetShelf, reportDialog, scanDialog
} from './modals.js';
import { openShare } from './share.js';
import { keysBelongElsewhere } from './keyguard.js';

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
    if (ev.target.closest('[data-copy-demo]')) {
      if (state.readOnly) return;
      // A tab left open on the empty state knows nothing of a shelf filled in
      // another tab since, and copying the demo from here would overwrite it.
      // An account shelf is only ever added to, so it has nothing to overwrite,
      // and what storage holds is not that shelf anyway.
      if (state.source === 'local' && storedShelfSize() > 0) {
        toast('Your shelf has books added in another tab. Reload the page to see them.', 'bad');
        return;
      }
      const saved = restoreSeed();
      render();
      // The button that had focus went away with the empty state, which dropped
      // keyboard focus back to the top of the document. Land on the first book.
      const first = $('#stage').querySelector('.spine:not(.spine--ghost), .cover');
      if (first) first.focus();
      // A failed save has already said so; a success toast would replace it. An
      // account says what it added once it has answered, from its own totals.
      if (saved && state.source === 'local') toast('Your shelf now matches the demo shelf. Take off what you do not own.');
      return;
    }
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
  $('#showRuns').addEventListener('change', (ev) => {
    state.showRuns = ev.target.checked; savePrefs(); render();
  });

  // Header actions
  $('#addBtn').addEventListener('click', addDialog);
  $('#isbnBtn').addEventListener('click', scanDialog);
  $('#statsBtn').addEventListener('click', reportDialog);
  $('#exportBtn').addEventListener('click', exportShelf);
  $('#importBtn').addEventListener('click', importDialog);
  const share = $('#shareBtn');
  if (share) share.addEventListener('click', (ev) => { void openShare(ev.currentTarget); });
  bindShelfMenu();

  // Drawer
  $('#drawer').addEventListener('click', (ev) => {
    if (ev.target.closest('[data-drawer-close]')) { closeBook(); return; }
    const add = ev.target.closest('[data-add]');
    if (add) {
      if (addFromCatalog(add.dataset.add)) { closeBook(); render(); }
      return;
    }
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
    // Add by ISBN lists its editions as data-add buttons inside this dialog.
    // The stage and the drawer each had a branch for data-add and this handler
    // did not, so from the day scanning shipped, picking an edition did nothing.
    const add = ev.target.closest('[data-add]');
    if (add) {
      if (addFromCatalog(add.dataset.add)) { closeModal(); render(); }
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
  // Fires when anything reaches an edit on the demo: the `a` shortcut, or a
  // control that slipped past its CSS. Say where the editable shelf is rather
  // than failing silently.
  document.addEventListener('vitrina:read-only', () => {
    toast('This is a read-only shelf. Your own is at /shelf/.', 'bad');
  });

  document.addEventListener('vitrina:storage-blocked', () => {
    toast('This browser is not letting the page store anything, so the shelf will not be here next time', 'bad');
  });

  // Keyboard
  document.addEventListener('keydown', (ev) => {
    // Escape, the focus trap and the shortcuts below are for vitrina's own page
    // and overlays. A key meant for the Auth Kit's sign-in dialog, Clerk's
    // account menu or an open header menu is left to it (js/keyguard.js).
    if (keysBelongElsewhere(document, ev.target)) return;
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
 * Shelf report, Export and Import sit behind one header menu.
 *
 * The header kit styles .header-menu, but the only menus it opens, closes and
 * steers with the keyboard are the ones it builds itself (the ⋯ overflow and
 * the palette). A menu a site writes gets none of that, so it is done here:
 * toggle, arrow keys, Escape back to the trigger, a click anywhere else.
 *
 * At 700px and below the kit folds every header action without data-keep-mobile
 * into its ⋯ menu, and that menu closes on any click inside it, so a menu folded
 * into it could never be opened. There the three items leave this menu and are
 * handed to the kit's menu as rows of their own; at desktop width they come
 * back. They are moved, never cloned, so the listeners above survive, and so do
 * the ids the read-only CSS hides them by.
 *
 * Exported for tests/header-menu.test.mjs, which drives it on a stand-in header.
 */
export function bindShelfMenu() {
  const trigger = $('#shelfMenuBtn');
  const menu = $('#shelfMenu');
  if (!trigger || !menu) return;
  const group = trigger.parentElement;
  const actions = trigger.closest('.header-actions');
  const bar = trigger.closest('.header-bar');
  const items = Array.from(menu.children);

  const isOpen = () => menu.classList.contains('open');
  const open = () => { menu.classList.add('open'); trigger.setAttribute('aria-expanded', 'true'); };
  const close = () => {
    if (!isOpen()) return;
    menu.classList.remove('open');
    trigger.setAttribute('aria-expanded', 'false');
  };
  const rows = () => items.filter((el) => menu.contains(el) && el.offsetParent !== null);

  trigger.addEventListener('click', () => {
    if (isOpen()) { close(); return; }
    open();
    const first = rows()[0];
    if (first) first.focus();
  });
  trigger.addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
    ev.preventDefault();
    open();
    const list = rows();
    const target = ev.key === 'ArrowUp' ? list[list.length - 1] : list[0];
    if (target) target.focus();
  });
  menu.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      // Stopped here, so the page's own Escape handler does not run as well.
      ev.preventDefault();
      ev.stopPropagation();
      close();
      trigger.focus();
      return;
    }
    if (ev.key === 'Tab') { close(); return; }
    const list = rows();
    const at = list.indexOf(document.activeElement);
    let next = null;
    if (ev.key === 'ArrowDown') next = list[(at + 1) % list.length];
    else if (ev.key === 'ArrowUp') next = list[(at - 1 + list.length) % list.length];
    else if (ev.key === 'Home') next = list[0];
    else if (ev.key === 'End') next = list[list.length - 1];
    if (next) { ev.preventDefault(); next.focus(); }
  });
  // In the capture phase, so the menu is shut and focus is back on its trigger
  // before the item's own handler opens a dialog. A dialog hands focus back to
  // whatever held it when it opened, and an item in a closed menu cannot take it.
  menu.addEventListener('click', (ev) => {
    if (!ev.target.closest('button')) return;
    close();
    trigger.focus({ preventScroll: true });
  }, true);
  document.addEventListener('click', (ev) => {
    if (isOpen() && !group.contains(ev.target)) close();
  });
  // The app-mode header hides as the page scrolls down. The kit holds it on
  // screen while one of its own menus is open, which this one is not, or while
  // focus is inside the bar, which opening this menu always arranges. Focus can
  // still leave with the menu open (a click on the menu's own padding), and then
  // the bar would slide away with the menu in it and come back still open.
  window.addEventListener('scroll', () => {
    if (isOpen() && !(bar && bar.contains(document.activeElement))) close();
  }, { passive: true });

  const phone = window.matchMedia('(max-width: 700px)');
  const place = () => {
    close();
    if (phone.matches) {
      items.forEach((el) => actions.appendChild(el));
      group.hidden = true;
    } else {
      items.forEach((el) => menu.appendChild(el));
      group.hidden = false;
    }
    if (window.NeoHeader && typeof window.NeoHeader.syncOverflow === 'function') window.NeoHeader.syncOverflow();
    // Leaving the phone width, the kit puts every control it folded back in
    // front of its ⋯ toggle, which lands Add a book after Add by ISBN, the one
    // control it never folds. The template has Add a book first.
    const add = $('#addBtn');
    const isbn = $('#isbnBtn');
    if (!phone.matches && add && isbn && add.parentElement === actions && isbn.parentElement === actions) {
      actions.insertBefore(add, isbn);
    }
  };
  phone.addEventListener('change', place);
  place();
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
