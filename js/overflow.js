// ── The header kit's ⋯ toggle, when none of its rows is drawn ────────────────
//
// At 700 px and below the header kit folds the header actions into its ⋯ menu
// and shows the toggle whenever that menu has children. It counts children, not
// rows anybody can see, and on /u/ outside the Shelf state every control it
// folds is hidden by vitrina's read-only CSS, so the toggle opened an empty
// panel. Counting drawn rows belongs in the kit (packages/neorgon-ui/header);
// until it does, vitrina runs this after each sync it asks for (events.js) and
// whenever /u/ changes state (profile.js). No CSS: it sets the same hidden
// property the kit sets, to the kit's own answer when a row is drawn.
//
// Takes the document and window it reads, so tests/header-menu.test.mjs runs
// it on a stand-in header.

export function hideEmptyOverflow(doc, view) {
  const overflow = doc && typeof doc.querySelector === 'function' ? doc.querySelector('.header-overflow') : null;
  if (!overflow || !view || typeof view.getComputedStyle !== 'function') return;
  const menu = Array.from(overflow.children).find((el) => el.classList.contains('header-overflow-menu'));
  if (!menu) return;
  overflow.hidden = !Array.from(menu.children).some((el) => !el.hidden && view.getComputedStyle(el).display !== 'none');
}
