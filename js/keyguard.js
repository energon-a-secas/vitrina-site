// ── Whose keys these are ─────────────────────────────────────────────────────
//
// The page's keydown handler closes #modal and #drawer on Escape, keeps Tab
// inside them, and turns single keys into shortcuts. All three are wrong while
// something else owns the keyboard, and the Auth Kit brings two such things:
// its sign-in dialog, a native <dialog> in the top layer, and Clerk's account
// menu, a [role=dialog] of Clerk's own. With the Shelf report open under a
// native dialog, trapFocus swallowed Shift+Tab, and `a` typed inside the dialog
// opened Add a book behind it (plan section 1). A header menu is the third
// owner: its arrows and Escape are the menu's, and a stray `2` switched the view
// underneath it.
//
// Pure, taking the document and the event target it would read, so
// tests/keyguard.test.mjs holds the decision without a browser.

/** True when the page's own Escape, focus trap and shortcuts must leave this key alone. */
export function keysBelongElsewhere(doc, target) {
  if (doc && typeof doc.querySelector === 'function') {
    if (doc.querySelector('dialog[open]')) return true;
    if (doc.querySelector('.header-menu.open')) return true;
  }
  const box = target && typeof target.closest === 'function' ? target.closest('[role="dialog"]') : null;
  // #modal and #drawer are vitrina's own overlays, whose dialogs sit inside them.
  return Boolean(box && !box.closest('#modal, #drawer'));
}
