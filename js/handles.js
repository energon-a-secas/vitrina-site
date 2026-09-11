// ── Handle rules, in the browser ──────────────────────────────────────────────
//
// A mirror of convex/lib/handles.ts, which is canonical: the server decides
// what may be claimed, and this copy exists so the Share dialog can say what is
// wrong with a handle before a request goes out. It is plain JavaScript because
// the page has no build step. tests/handles-mirror.test.mjs imports both files
// and runs one corpus through each, so an edit to one rule list that misses the
// other fails make validate.
//
// handleFromSearch lives only here: reading the handle out of /u/?<handle> is
// the page's job, not the server's.

export const HANDLE_RE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){2,29}$/;

export const RESERVED_HANDLES = Object.freeze([
  'u', 'shelf', 'demo', 'privacy', 'tos', 'admin', 'api', 'www', 'css', 'js', 'data', 'assets', 'docs',
  'scripts', 'tests', 'templates', 'index', 'sitemap', 'robots', 'llms', 'favicon', 'manifest', 'static',
  'img', 'theme', 'header', 'footer', 'via', 'src', 'yaml', 'login', 'logout', 'signin', 'sign-in',
  'signup', 'sign-up', 'account', 'accounts', 'auth', 'oauth', 'session', 'clerk', 'convex', 'vitrina',
  'neorgon', 'energon', 'tercerafundacion', 'tercera-fundacion', 'la-tercera-fundacion', 'owner',
  'official', 'staff', 'team', 'mod', 'moderator', 'security', 'abuse', 'report', 'legal', 'terms',
  'contact', 'about', 'me', 'you', 'anon', 'anonymous', 'null', 'undefined', 'test', 'help', 'support',
  'settings', 'system', 'user', 'users', 'profile', 'root', 'verify', 'claim', 'embed', 'policy', 'ayuda',
  'soporte', 'privacidad', 'terminos', 'cuenta', 'usuario', 'usuarios', 'perfil', 'administrador',
  'estanteria', 'biblioteca', 'catalogo', 'prueba',
]);

// Whole hyphen-separated segments only, so "steam" and "badminton" stay free.
const ROLE_WORDS = Object.freeze([
  'admin', 'administrador', 'administrator', 'staff', 'team', 'equipo', 'mod', 'moderator', 'moderador',
  'official', 'oficial', 'support', 'soporte', 'help', 'ayuda',
]);

const BRANDS = Object.freeze(['neorgon', 'energon', 'vitrina', 'tercerafundacion']);

export const HANDLE_MESSAGES = Object.freeze({
  'handle-invalid': 'Letters a to z without accents or ñ, digits and single hyphens, 3 to 30 characters, not only digits.',
  'handle-reserved': 'That address is reserved. Try another.',
});

// Query keys the header kit reads for itself. "?theme=matrix&ana" is Ana's
// shelf in the Matrix palette, not a shelf called theme.
const KIT_KEYS = Object.freeze(['theme', 'header', 'footer', 'via', 'src', 'yaml']);

export function normalizeHandle(raw) {
  if (typeof raw !== 'string') return '';
  let handle = raw.trim();
  if (handle.startsWith('%40')) handle = '@' + handle.slice(3);
  if (handle.startsWith('@')) handle = handle.slice(1);
  return handle.trim().toLowerCase();
}

function lookalikes(handle) {
  const folded = handle
    .replace(/-/g, '')
    .replace(/0/g, 'o')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/5/g, 's');
  return [folded.replace(/1/g, 'i'), folded.replace(/1/g, 'l')];
}

export function handleProblem(handle) {
  if (typeof handle !== 'string' || !HANDLE_RE.test(handle) || /^[0-9]+$/.test(handle)) return 'handle-invalid';
  if (RESERVED_HANDLES.includes(handle)) return 'handle-reserved';
  if (lookalikes(handle).some((folded) => BRANDS.some((brand) => folded.includes(brand)))) return 'handle-reserved';
  if (handle.split('-').some((segment) => ROLE_WORDS.includes(segment))) return 'handle-reserved';
  return null;
}

function decode(text) {
  try {
    return decodeURIComponent(text);
  } catch (err) {
    return null;   // a malformed escape is still a candidate; it just names no valid shelf
  }
}

/**
 * The handle in a /u/ address, from location.search.
 *
 * found says whether the address names a shelf at all, which decides between
 * "this link is missing the shelf name" and "no public shelf here". handle is
 * the canonical form, or null when what was named can never be a handle, which
 * the page shows exactly like a shelf that does not exist.
 *
 * A bare segment wins over "key=": links pasted from chat apps grow tracking
 * parameters (?fbclid=x&ana), and a share sheet may turn ?ana into ?ana=.
 */
export function handleFromSearch(search) {
  const raw = String(search == null ? '' : search).replace(/^\?/, '');
  const segments = raw.split('&').filter(Boolean);

  let found = false;
  let candidate = null;
  for (const segment of segments) {
    if (segment.includes('=')) continue;
    const key = decode(segment);
    if (key !== null && KIT_KEYS.includes(key)) continue;
    found = true;
    candidate = key;
    break;
  }
  if (!found) {
    for (const segment of segments) {
      const at = segment.indexOf('=');
      // Only "key=" with nothing after it; "key=value" is somebody's parameter.
      if (at < 1 || at !== segment.length - 1) continue;
      const key = decode(segment.slice(0, at));
      if (key !== null && KIT_KEYS.includes(key)) continue;
      found = true;
      candidate = key;
      break;
    }
  }
  if (!found) return { found: false, handle: null };

  const handle = normalizeHandle(candidate);
  return { found: true, handle: handleProblem(handle) === null ? handle : null };
}
