// Handles: the name that follows the question mark in /u/?<handle> (plan
// section 3.5).
//
// This file is canonical. js/handles.js mirrors it so the Share dialog can say
// what is wrong with a handle before asking the server, and
// tests/handles-mirror.test.mjs runs both over one corpus: a rule changed here
// and not there, or there and not here, fails make validate.
//
// Unlike sash, a handle here can change. It is printed into nothing that leaves
// the site; the cost of a change is a dead link, and the 30-day hold is what
// stops that dead link from being picked up by somebody else.

/** 3 to 30 characters, a to z and digits, hyphens only singly and never at either end. */
export const HANDLE_RE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){2,29}$/;

/** Frozen. Paths the site serves, words a visitor would read as the site speaking, and the brands. */
export const RESERVED_HANDLES: readonly string[] = Object.freeze([
  "u", "shelf", "demo", "privacy", "tos", "admin", "api", "www", "css", "js", "data", "assets", "docs",
  "scripts", "tests", "templates", "index", "sitemap", "robots", "llms", "favicon", "manifest", "static",
  "img", "theme", "header", "footer", "via", "src", "yaml", "login", "logout", "signin", "sign-in",
  "signup", "sign-up", "account", "accounts", "auth", "oauth", "session", "clerk", "convex", "vitrina",
  "neorgon", "energon", "tercerafundacion", "tercera-fundacion", "la-tercera-fundacion", "owner",
  "official", "staff", "team", "mod", "moderator", "security", "abuse", "report", "legal", "terms",
  "contact", "about", "me", "you", "anon", "anonymous", "null", "undefined", "test", "help", "support",
  "settings", "system", "user", "users", "profile", "root", "verify", "claim", "embed", "policy", "ayuda",
  "soporte", "privacidad", "terminos", "cuenta", "usuario", "usuarios", "perfil", "administrador",
  "estanteria", "biblioteca", "catalogo", "prueba",
]);

// A handle with one of these as a whole hyphen-separated segment reads as a
// role ("vitrina-team", "tf-oficial"). Whole segments only, so "steam",
// "modesto" and "badminton" stay available.
const ROLE_WORDS: readonly string[] = Object.freeze([
  "admin", "administrador", "administrator", "staff", "team", "equipo", "mod", "moderator", "moderador",
  "official", "oficial", "support", "soporte", "help", "ayuda",
]);

// Substrings, after folding lookalike digits, because "neorg0n" and
// "la-tercera-fundacion-oficial" impersonate just as well as the exact word.
const BRANDS: readonly string[] = Object.freeze(["neorgon", "energon", "vitrina", "tercerafundacion"]);

export const HANDLE_MESSAGES = Object.freeze({
  "handle-invalid": "Letters a to z without accents or ñ, digits and single hyphens, 3 to 30 characters, not only digits.",
  "handle-reserved": "That address is reserved. Try another.",
});

/**
 * The one canonical form. Case, surrounding space and the "@" people type out
 * of habit do not make a different handle; "%40" is that "@" after a link
 * encoder has been at it.
 */
export function normalizeHandle(raw: unknown): string {
  if (typeof raw !== "string") return "";
  let handle = raw.trim();
  if (handle.startsWith("%40")) handle = "@" + handle.slice(3);
  if (handle.startsWith("@")) handle = handle.slice(1);
  return handle.trim().toLowerCase();
}

// 1 folds both ways because it stands in for i and for l equally well.
function lookalikes(handle: string): string[] {
  const folded = handle
    .replace(/-/g, "")
    .replace(/0/g, "o")
    .replace(/3/g, "e")
    .replace(/4/g, "a")
    .replace(/5/g, "s");
  return [folded.replace(/1/g, "i"), folded.replace(/1/g, "l")];
}

/** An error code, or null when the (already normalised) handle may be claimed. */
export function handleProblem(handle: string): "handle-invalid" | "handle-reserved" | null {
  if (typeof handle !== "string" || !HANDLE_RE.test(handle) || /^[0-9]+$/.test(handle)) return "handle-invalid";
  if (RESERVED_HANDLES.includes(handle)) return "handle-reserved";
  if (lookalikes(handle).some((folded) => BRANDS.some((brand) => folded.includes(brand)))) return "handle-reserved";
  if (handle.split("-").some((segment) => ROLE_WORDS.includes(segment))) return "handle-reserved";
  return null;
}
