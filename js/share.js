// ── Share: your shelf's address, whether it is public, and deleting it all ───
//
// Opened from the header on /shelf/. Sign-in comes first, through the Auth Kit,
// and never over vitrina's own overlays: the kit's dialog is a native <dialog>
// in the top layer, and one opened over #modal or #drawer leaves two focus
// traps fighting over Tab. A completed sign-in reloads the page, so nothing
// here has to repaint an open dialog after one.
//
// What the dialog says comes from a fresh shelf:mine, read again after every
// change it makes, so it never shows an address or a setting the account does
// not have. Every string from the server or the person is escaped on its way in.

import { state } from './state.js';
import { $, escHtml, toast } from './utils.js';
import { openModal, closeModal, onModalClose, exportShelf } from './modals.js';
import { closeBook } from './detail.js';
import { FN } from './backend.js';
import { HANDLE_MESSAGES, handleProblem, normalizeHandle } from './handles.js';
import { changeHandleConfirm, deletionCopy, shareFacts, sharePreview } from './accountplan.js';
import { session } from './session.js';

const REASON = 'Sign in to keep your shelf in your account and reserve its address.';
const CLOSED = 'Public shelves are not open yet. You can reserve an address now; nobody else can see your shelf.';
const UNREACHED = 'That did not reach your account. Check your connection and try again.';
const TOKEN_REFUSED = "Your account did not accept this page's sign-in. Reload the page and try again.";
const DELETE_CONFIRM = 'Delete your Vitrina data? The books, notes and address kept in your account are deleted and cannot be brought back, and the address is held for 30 days so nobody else can take it.';
const POLL_MS = 2500;

let invoker = null;    // the header button, where focus goes back after a sign-in asked for from here
let facts = null;      // what the dialog last painted, from accountplan.shareFacts
let busy = false;      // a change is on its way; the dialog takes no second one meanwhile
let deleting = false;  // a deletion is running, so the dialog polls its progress
let pollTimer = null;
let opened = 0;        // moves as a dialog opens and as it closes, so work for a closed one paints and polls nothing

export async function openShare(button) {
  if (state.mode !== 'shelf') return;
  invoker = button || $('#shareBtn');
  const kit = session.kit;
  if (!kit || !session.call || !session.send) {
    toast('Sign-in is still loading. Try again in a moment.', 'bad');
    return;
  }
  // The kit settles first. While clerk-js loads nothing native is open, so the
  // page keeps its keys, and an overlay opened in that wait ended up under the
  // kit's dialog. Once it has settled, nothing can open between these closes
  // and the kit's showModal.
  await kit.start();
  closeBook();
  closeModal();
  if (!(await kit.requireSignIn({ reason: REASON, invoker }))) return;
  facts = null;
  busy = false;
  deleting = false;
  openModal('Share your shelf',
    '<div class="share" data-share><p class="dialog__lead">Reading your shelf\'s address</p></div>',
    '<button type="button" class="btn btn--primary" data-modal-close>Close</button>');
  opened += 1;
  const root = $('[data-share]');
  root.addEventListener('click', onClick);
  root.addEventListener('change', onToggle);
  root.addEventListener('input', onInput);
  root.addEventListener('submit', onSubmit);
  onModalClose(() => {
    opened += 1;
    stopPolling();
    deleting = false;
  });
  await refresh();
}

function stopPolling() {
  clearTimeout(pollTimer);
  pollTimer = null;
}

/** Read the account and paint the dialog from it, keeping focus on the control that had it. */
async function refresh() {
  const dialog = opened;
  let mine;
  try {
    mine = await session.call('query', FN.shelf.mine, {});
  } catch (err) {
    mine = undefined;
  }
  // Read for a dialog that has closed since. Closing hides #modal and keeps its
  // markup, so a poll out at the time repainted it and scheduled itself again,
  // for good once signed out.
  const root = dialog === opened ? $('[data-share]') : null;
  if (!root) return;
  if (mine && mine.erasing === true) {
    deleting = true;
    paintDeletion(root, mine);
    return;
  }
  if (deleting) {
    if (mine && Array.isArray(mine.entries)) {
      deleting = false;
      paintDeletion(root, mine);
    } else {
      schedulePoll();   // a poll that failed: the deletion runs on the server regardless
    }
    return;
  }
  facts = shareFacts(mine);
  if (!facts) {
    const hadFocus = root.contains(document.activeElement);
    root.innerHTML = `<p class="dialog__lead">Your account could not be reached, so nothing here can change right now.</p>
      <p class="share__row"><button type="button" class="btn btn--secondary btn--sm" data-share-act="reload">Try again</button></p>`;
    // The control that had focus went with the old markup, and focus would have fallen out of the dialog.
    if (hadFocus) root.querySelector('[data-share-act="reload"]').focus({ preventScroll: true });
    return;
  }
  const active = document.activeElement;
  const focusAt = root.contains(active) && active.id ? `#${active.id}`
    : (root.contains(active) && active.dataset && active.dataset.shareAct ? `[data-share-act="${active.dataset.shareAct}"]` : null);
  root.innerHTML = markup(facts);
  const again = focusAt ? root.querySelector(focusAt) : null;
  if (again) again.focus({ preventScroll: true });
}

function markup(f) {
  return `
    ${f.open ? '' : `<p class="share__notice" role="note">${escHtml(CLOSED)}</p>`}
    <section class="share__section" aria-labelledby="shareAddressTitle">
      <h3 class="share__title" id="shareAddressTitle">Address</h3>
      ${f.handle
        ? `<p class="share__url"><span class="share__base">vitrina.neorgon.com/u/?</span><strong>${escHtml(f.handle)}</strong></p>`
        : '<p class="share__hint">Choose the name that goes after the question mark. The address is yours whether or not the shelf is public.</p>'}
      <form class="share__claim" data-share-form novalidate>
        <label class="share__field">
          <span class="share__prefix" aria-hidden="true">/u/?</span>
          <input id="shareHandle" name="handle" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="40"
                 aria-label="${f.handle ? 'New address' : 'Address'}" aria-describedby="shareHandleNote">
        </label>
        <button type="submit" class="btn btn--secondary btn--sm" data-share-act="claim">${f.handle ? 'Change the address' : 'Reserve this address'}</button>
      </form>
      <p class="share__note" id="shareHandleNote" aria-live="polite"></p>
    </section>
    <section class="share__section" aria-labelledby="sharePublicTitle">
      <h3 class="share__title" id="sharePublicTitle">Public shelf</h3>
      ${f.open ? `<p class="share__preview">${escHtml(sharePreview(f.handle, f.catalogued))}</p>` : ''}
      ${f.suspended ? '<p class="share__note share__note--bad">A moderator has hidden this shelf. Nobody else can see it.</p>' : ''}
      ${f.open && !f.handle ? '<p class="share__hint">Reserve an address first.</p>' : ''}
      ${f.published ? '' : `<label class="check"><input type="checkbox" id="shareAge"${f.canPublish ? '' : ' disabled'}> <span>I am 16 or older</span></label>`}
      <label class="check"><input type="checkbox" role="switch" id="sharePublic"${f.published ? ' checked' : ''}${f.switchable ? '' : ' disabled'}> <span>Show this shelf at its address</span></label>
      ${f.copyable
        ? `<p class="share__row"><span class="share__link">${escHtml(f.link)}</span> <button type="button" class="btn btn--secondary btn--sm" data-share-act="copy">Copy link</button></p>`
        : '<p class="share__hint">The link works once your shelf is public.</p>'}
      <p class="share__note" id="sharePublicNote" aria-live="polite"></p>
    </section>
    <section class="share__section share__section--danger" aria-labelledby="shareDeleteTitle">
      <h3 class="share__title" id="shareDeleteTitle">Delete my Vitrina data</h3>
      <p class="share__hint">Deletes the books, notes and address kept in your account. The shelf kept in this browser is not touched. Export a copy first if you may want the books back.</p>
      <p class="share__row">
        <button type="button" class="btn btn--secondary btn--sm" data-share-act="export">Export my shelf</button>
        <button type="button" class="btn btn--danger btn--sm" data-share-act="delete">Delete my Vitrina data</button>
      </p>
      <p class="share__note" id="shareDeleteNote" aria-live="polite"></p>
    </section>`;
}

function note(id, text, bad = false) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = escHtml(text || '');
  el.classList.toggle('share__note--bad', Boolean(bad && text));
}

function said(answer) {
  return answer && typeof answer.message === 'string' && answer.message ? answer.message : UNREACHED;
}

/**
 * A change made from the dialog, sent through the page's write queue
 * (account.js), so none waits in the client's own queue while the kit swaps in
 * another person's token. A lost sign-in closes the dialog first and hands over
 * to the kit, whose dialog never opens over this one. While the kit still says
 * signed in, the deployment refused its token and requireSignIn would open
 * nothing, so the dialog stays and says so.
 */
async function act(name, args) {
  const dialog = opened;
  busy = true;
  const root = $('[data-share]');
  if (root) root.setAttribute('aria-busy', 'true');
  const answer = await session.send(name, args);
  busy = false;
  if (root) root.removeAttribute('aria-busy');
  const gone = dialog !== opened;
  if (answer && answer.code === 'not-signed-in') {
    if (session.kit.state.signedIn) return { gone, ok: false, answer: { ...answer, message: TOKEN_REFUSED } };
    closeModal();
    closeBook();
    await session.kit.requireSignIn({ reason: REASON, invoker });
    return { gone: true, ok: false, answer };
  }
  return { gone, ok: Boolean(answer && answer.ok === true), answer };
}

function onInput(ev) {
  if (ev.target.id !== 'shareHandle') return;
  // The server decides, with the same rules (js/handles.js mirrors them); this
  // only says what is wrong before a request goes out.
  const handle = normalizeHandle(ev.target.value);
  const problem = handle ? handleProblem(handle) : null;
  note('shareHandleNote', problem ? HANDLE_MESSAGES[problem] : '', true);
}

async function onSubmit(ev) {
  if (!ev.target.closest('[data-share-form]')) return;
  ev.preventDefault();
  if (busy || !facts) return;
  const input = $('#shareHandle');
  const handle = normalizeHandle(input ? input.value : '');
  const problem = handleProblem(handle);
  if (problem) {
    note('shareHandleNote', HANDLE_MESSAGES[problem], true);
    if (input) input.focus();
    return;
  }
  if (handle === facts.handle) {
    note('shareHandleNote', 'That is already your address.', true);
    return;
  }
  if (facts.handle && !window.confirm(changeHandleConfirm(facts.handle))) return;
  const { gone, ok, answer } = await act(FN.profiles.claimHandle, { handle });
  if (gone) return;
  if (!ok) {
    note('shareHandleNote', said(answer), true);
    return;
  }
  toast(`Your shelf's address is now vitrina.neorgon.com/u/?${answer.handle || handle}`);
  await refresh();
}

async function onToggle(ev) {
  const box = ev.target;
  if (box.id !== 'sharePublic' || !facts) return;
  const wanted = box.checked;
  if (busy) {
    box.checked = !wanted;
    return;
  }
  if (wanted) {
    if (!facts.canPublish) {
      box.checked = false;
      return;
    }
    const age = $('#shareAge');
    if (!age || !age.checked) {
      box.checked = false;
      note('sharePublicNote', 'Publishing needs your statement that you are 16 or older. Tick it first.', true);
      if (age) age.focus();
      return;
    }
  }
  const { gone, ok, answer } = await act(FN.profiles.setPublished, wanted ? { published: true, confirmAge: true } : { published: false });
  if (gone) return;
  if (!ok) {
    const again = $('#sharePublic');
    if (again) again.checked = !wanted;
    note('sharePublicNote', said(answer), true);
    return;
  }
  toast(wanted ? 'Your shelf is public at its address' : 'Your shelf is private again');
  await refresh();
}

function onClick(ev) {
  const button = ev.target.closest('[data-share-act]');
  if (!button || busy) return;
  const what = button.dataset.shareAct;
  if (what === 'copy') void copyLink();
  else if (what === 'export') exportShelf();
  else if (what === 'delete') void deleteData(true);
  else if (what === 'retry-delete') void deleteData(false);
  else if (what === 'reload') void refresh();
}

async function copyLink() {
  if (!facts || !facts.copyable) return;
  try {
    await navigator.clipboard.writeText(facts.link);
    toast('Link copied');
  } catch (err) {
    // No clipboard here (an insecure context, or permission refused): the link is on screen to copy by hand.
    note('sharePublicNote', `Copy it by hand: ${facts.link}`);
  }
}

/** Export is offered next to Delete, before it. Retry skips the confirm the person already answered. */
async function deleteData(confirmFirst) {
  if (confirmFirst && !window.confirm(DELETE_CONFIRM)) return;
  const books = facts ? facts.books : 0;
  const { gone, ok, answer } = await act(FN.profiles.deleteMyData, {});
  const root = $('[data-share]');
  if (gone || !root) return;
  if (!ok) {
    note('shareDeleteNote', `Your Vitrina data was not deleted: ${said(answer)}`, true);
    const at = $('#shareDeleteNote');
    if (at && !root.querySelector('[data-share-act="retry-delete"]')) {
      at.insertAdjacentHTML('afterend', '<p class="share__row"><button type="button" class="btn btn--danger btn--sm" data-share-act="retry-delete">Retry</button></p>');
    }
    return;
  }
  deleting = true;
  // The shelf behind the dialog shows the deletion as well.
  if (session.refresh) void session.refresh();
  paintDeletion(root, { erasing: true, remaining: books });
}

function paintDeletion(root, mine) {
  let status = root.querySelector('#shareDeleting');
  if (!status) {
    // Delete, which has focus, goes with the markup; the progress it started takes focus instead.
    const hadFocus = root.contains(document.activeElement);
    root.innerHTML = '<p class="dialog__lead" id="shareDeleting" role="status" tabindex="-1"></p>';
    status = root.querySelector('#shareDeleting');
    if (hadFocus) status.focus({ preventScroll: true });
  }
  const text = deletionCopy(mine);
  // A status region reads out every change, so the same words are not written twice.
  if (status.textContent !== text) status.textContent = text;
  if (deleting) schedulePoll();
  else stopPolling();
}

function schedulePoll() {
  stopPolling();
  pollTimer = setTimeout(() => {
    pollTimer = null;
    void refresh();
  }, POLL_MS);
}
