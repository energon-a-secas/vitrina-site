// ── Waiting out a deletion ───────────────────────────────────────────────────
//
// After Delete my Vitrina data, shelf:mine answers { erasing: true, remaining }
// until the server has finished, and two places wait on it: /shelf/ itself
// (account.js) and the Share dialog (share.js). Each asks again on a timer, and
// both used to ask at one fixed pace for as long as the page stayed open: 157
// requests in five minutes of an ordinary deletion with the dialog open, and no
// end at all once the deployment refused the page's token. This is the timer
// both use now, and it decides three things:
//
//   - once remaining reaches 0 only purge:sweep is left, which runs 5 minutes
//     after the shelf empties (plan section 3.3), so the pace drops to 30 s;
//   - a hidden tab asks nothing, and asks once as soon as it is shown again;
//   - an answer that says nothing about the deletion (null for a refused token,
//     or a request that threw) is a miss, and MISSES_ALLOWED of them in a row
//     stop the wait, so the page offers Try again instead of asking for good.
//
// It never asks shelf:mine itself. Each module sends its own request, drops an
// answer meant for a shelf or a dialog that has gone, and tells the wait what
// arrived.

/** The pace once no books remain and only the last sweep is left. */
export const SWEEP_PACE_MS = 30000;

/** Answers in a row that say nothing about the deletion, after which a wait stops. */
export const MISSES_ALLOWED = 5;

/** How long to wait before asking again: every while books remain, SWEEP_PACE_MS once none do. */
export function paceFor(every, remaining) {
  return Number.isSafeInteger(remaining) && remaining > 0 ? every : SWEEP_PACE_MS;
}

/**
 * One module's wait, asking at `every` ms while books remain.
 *
 * next(remaining, ask) follows an erasing answer: ask runs after the pace that
 * remaining calls for, and the count of misses starts again. missed(ask)
 * follows an answer that was not one: ask runs after the same pace as before,
 * unless that miss made MISSES_ALLOWED in a row, when the wait stops and
 * missed returns false. stop() ends the wait. One ask at most is ever waiting.
 */
export function deletionWait(every) {
  let timer = null;
  let parked = null;     // the ask a hidden tab put off until it is shown again
  let pace = every;
  let misses = 0;
  let listening = false;

  function clear() {
    clearTimeout(timer);
    timer = null;
    parked = null;
  }

  function shown() {
    if (!parked || document.visibilityState === 'hidden') return;
    const ask = parked;
    parked = null;
    void ask();
  }

  function schedule(ask) {
    clear();
    if (!listening) {
      listening = true;
      document.addEventListener('visibilitychange', shown);
    }
    timer = setTimeout(() => {
      timer = null;
      if (document.visibilityState === 'hidden') parked = ask;
      else void ask();
    }, pace);
  }

  return {
    next(remaining, ask) {
      misses = 0;
      pace = paceFor(every, remaining);
      schedule(ask);
    },
    missed(ask) {
      misses += 1;
      if (misses < MISSES_ALLOWED) {
        schedule(ask);
        return true;
      }
      clear();
      misses = 0;
      return false;
    },
    stop() {
      clear();
      misses = 0;
    },
  };
}
