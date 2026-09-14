// Plain node, no install. Run with: make validate
//
// js/share.js is where a shelf becomes public, an address changes hands and an
// account's data is deleted. accountplan.shareFacts decides what the dialog may
// offer; this holds the dialog itself to it, and to the rules no pure function
// can hold: the kit's sign-in dialog never opens over vitrina's own, a refusal
// never ends in silence, focus never falls out of the dialog, and a poll never
// outlives it. It runs on the generated /shelf/ page with account.js started,
// against the fakes in tests/support/shelfworld.mjs.

import { openShelf, row, checker } from './support/shelfworld.mjs';

const t = checker();
const eq = t.eq;
const isOpen = (w) => w.$('#modal').classList.contains('is-open');

async function dialog({ profile = null, rows = [], publishingOpen = false } = {}) {
  const w = await openShelf({ publishingOpen });
  w.server.seed('u1', rows, profile);
  await w.kit.signIn('u1');
  await w.flush();
  w.share = await w.import('share.js');
  w.modals = await w.import('modals.js');
  await w.share.openShare(w.$('#shareBtn'));
  await w.flush();
  return w;
}

// ── What the dialog offers ──────────────────────────────────────────────────
for (const [label, profile, open, copyable] of [
  ['private', { handle: 'ana', published: false }, true, false],
  ['published', { handle: 'ana', published: true }, true, true],
  ['published but suspended', { handle: 'ana', published: true, suspended: true }, true, false],
  ['published while publishing is closed', { handle: 'ana', published: true }, false, false],
]) {
  const w = await dialog({ profile, publishingOpen: open, rows: [row(101)] });
  eq([isOpen(w), Boolean(w.$('[data-share-act="copy"]')), (w.text('#modalBody') || '').includes('The link works once your shelf is public.')], [true, copyable, !copyable],
    `a shelf ${label} ${copyable ? 'offers Copy link' : 'offers no link to copy, and says when it will'}`);
}
{
  const HOSTILE = '<img src=x onerror=alert(1)>';
  const w = await dialog({ profile: { handle: HOSTILE, published: true }, publishingOpen: true });
  eq(w.$('#modalBody').querySelectorAll('img').length, 0, 'a handle from the server is never markup in the Share dialog');
  eq([(w.text('.share__url') || '').includes(HOSTILE), (w.text('.share__link') || '').includes(HOSTILE)], [true, true], 'it is shown as the text it is, in the address and in the link');
}
{
  const w = await dialog({ profile: { handle: 'ana', published: false }, publishingOpen: true });
  const toggle = w.$('#sharePublic');
  toggle.checked = true;
  await w.fire(toggle, 'change');
  eq(w.server.calls('profiles:setPublished').length, 0, 'publishing without the age statement sends nothing');
  eq([w.$('#sharePublic').checked, w.text('#sharePublicNote')], [false, 'Publishing needs your statement that you are 16 or older. Tick it first.'],
    'the switch goes back off and the note says why');
  w.$('#shareAge').checked = true;
  w.$('#sharePublic').checked = true;
  await w.fire(w.$('#sharePublic'), 'change');
  eq(w.server.calls('profiles:setPublished').map((c) => c.args), [{ published: true, confirmAge: true }], 'with it ticked, publishing sends the statement with it');
}
{
  const w = await dialog({ profile: { handle: 'ana' }, rows: [row(101)] });
  w.confirmAnswer = false;
  w.$('[data-share-act="delete"]').click();
  await w.flush();
  eq([w.confirms.length, w.server.calls('profiles:deleteMyData').length], [1, 0], 'Delete my Vitrina data asks first, and No deletes nothing');
  eq(['cannot be brought back', 'held for 30 days'].map((words) => (w.confirms[0] || '').includes(words)), [true, true], 'the question says it cannot be undone and holds the address');
}

// ── Refusals, and where focus goes ──────────────────────────────────────────
{
  const w = await dialog();
  w.server.answer('profiles:claimHandle', { ok: false, code: 'not-signed-in', message: 'Sign in to do that.' }, { user: 'u1' });
  w.$('#shareHandle').value = 'ana-lee';
  await w.fire(w.$('[data-share-form]'), 'submit');
  eq([isOpen(w), w.kit.dialogs.length], [true, 0], 'a token the account refuses while the kit says signed in keeps the Share dialog open, with no sign-in dialog to hand over to');
  eq(w.text('#shareHandleNote'), "Your account did not accept this page's sign-in. Reload the page and try again.", 'and the note says what to do');
  eq(w.$('#shareHandle').value, 'ana-lee', 'keeping the address that was typed');
}
{
  const w = await dialog({ profile: { handle: 'ana' } });
  w.$('#shareHandle').value = 'ana-lee';
  w.server.fail('shelf:mine', { user: 'u1', times: 2 });
  w.$('[data-share-act="claim"]').focus();
  await w.fire(w.$('[data-share-form]'), 'submit');
  eq((w.text('#modalBody') || '').startsWith('Your account could not be reached'), true, 'an account that cannot be read after a change says so');
  eq(w.doc.activeElement.getAttribute('data-share-act'), 'reload', 'with focus on its Try again, not dropped out of the dialog');
}
{
  const w = await dialog({ profile: { handle: 'ana' }, rows: [row(101)] });
  const del = w.$('[data-share-act="delete"]');
  del.focus();
  del.click();
  await w.flush();
  eq([w.server.calls('profiles:deleteMyData').length, w.text('#shareDeleting')], [1, 'Deleting your books: 1 left'], 'a confirmed deletion is sent and its progress shown');
  eq(w.doc.activeElement.id, 'shareDeleting', 'with focus on that progress, not dropped out of the dialog with the button that went');

  const poll = w.server.hold('shelf:mine', { user: 'u1' });
  await w.advance(2500);
  eq(poll.taken, 1, 'the dialog polls the deletion');
  w.modals.closeModal();
  await w.flush();
  poll.release();
  await w.flush();
  await w.kit.signOut();
  await w.flush();
  const asked = w.server.calls('shelf:mine').length;
  await w.advance(2500 * 5);
  eq(w.server.calls('shelf:mine').length - asked, 0, 'a poll that was out when the dialog closed schedules no more, signed in or out');
}

// ── Never over vitrina's own overlays ───────────────────────────────────────
{
  const w = await openShelf({ cookie: '__client_uat=1757000000' });
  w.share = await w.import('share.js');
  w.modals = await w.import('modals.js');
  w.kit.onShowModal = () => ({ modal: isOpen(w), drawer: !w.$('#drawer').hidden });
  const opening = w.share.openShare(w.$('#shareBtn'));
  await w.flush();
  // What the a key does. While clerk-js loads nothing native is open, so the page still has its keys.
  w.modals.addDialog();
  await w.flush();
  eq(isOpen(w), true, 'Share pressed while clerk-js loads leaves the page its keys, and a dialog can open meanwhile');
  await w.kit.signOut();
  await w.flush();
  await opening;
  eq(w.kit.dialogs.map((d) => d.page), [{ modal: false, drawer: false }], "the kit's sign-in dialog opens only once vitrina's own overlays are closed");
}

t.done();
