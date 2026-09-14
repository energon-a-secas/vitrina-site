// ── The signed-in account, as far as other modules need to know it ──────────
//
// account.js owns the account: it boots the Auth Kit, talks to Convex and keeps
// the account shelf in memory through state.js. render.js, modals.js,
// strips.js and share.js each need a few facts about it, or one of its
// functions, and importing account.js for them would make those modules and
// account.js import each other in a circle. So account.js writes here and the
// rest read. Nothing here is stored anywhere, and all of it is dropped when the
// person signs out or somebody else signs in.

export const session = {
  kit: null,         // NeoAuth, once the Auth Kit has loaded (every app page)
  call: null,        // call(kind, name, args) through the signed-in Convex client (/shelf/ only)
  send: null,        // send(name, args): a write counted against refetches, resolving its answer or null
  refresh: null,     // refresh({ quiet }): fetch shelf:mine again under the refetch rule
  lastCount: null,   // books in the last shelf:mine answer, null before one arrived
  erasing: null,     // { remaining } while shelf:mine says this account's data is being deleted
};

/** True when "Start from the demo shelf" may be offered: always for the browser shelf, and for an account only when it answered empty. */
export function offersDemoCopy(source) {
  if (source === 'local') return true;
  return source === 'account' && session.lastCount === 0;
}
