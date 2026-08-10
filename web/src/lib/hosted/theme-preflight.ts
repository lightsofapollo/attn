// Pre-paint theme stamp for the hosted surfaces (attn-n01r.22).
//
// The problem this solves, measured on the production build at 300 kbps with a
// dark-preference UA:
//
//   t =   14 ms   rgb(18,18,18)     UA dark canvas, no CSS yet
//   t = 2645 ms   rgb(226,223,215)  CSS painted — PAPER, the wrong theme
//   t = 3842 ms   rgb(9,13,19)      JS finally stamped .dark
//
// ~1.2 s of full-page paper-white for a dark-mode visitor. The hosted entries
// carry four blocking <link rel="stylesheet"> in <head>, so CSS paints the
// PAPER ground long before the deferred `type="module"` bundle runs
// initTheme(). No stylesheet carries a prefers-color-scheme fallback, so
// nothing covers the gap.
//
// The native app already solves this with an inline pre-paint script
// (web/index.html). The hosted build could not, because `script-src 'self'`
// forbids inline scripts — so the mechanism was simply lost when the surface
// moved to the browser.
//
// A CSP source hash reopens it safely: `'sha256-…'` admits exactly these bytes
// and nothing else, which is strictly narrower than a nonce. The script text
// lives here, once; `injectThemePreflight()` in vite.browser.config.ts stamps
// it into every hosted entry at build time, and csp.ts carries its hash. A
// test recomputes the hash from this constant so the two cannot drift — if
// they ever do, the script is silently blocked and the flash returns, which is
// exactly the kind of regression nobody notices for a year.
//
// A prefers-color-scheme CSS fallback was considered and rejected: it would
// duplicate ~90 lines of INK tokens (guaranteed to drift), and it cannot see
// localStorage, so a visitor on a light OS who explicitly chose dark would
// still get the flash. This covers both cases.
//
// Behaviour must stay identical to initTheme() in src/hosted/theme.svelte.ts.
// Keep it dependency-free, synchronous, and total — it runs before anything
// else and must never throw.

/** Storage key shared with `src/hosted/theme.svelte.ts`. */
export const THEME_STORAGE_KEY = 'attn-theme';

/**
 * The inline pre-paint script, minified by hand. Every byte is part of the
 * CSP hash, so edit this and `THEME_PREFLIGHT_SHA256` together — the test in
 * csp.test.ts fails loudly if they disagree.
 */
export const THEME_PREFLIGHT_SCRIPT =
  '(function(){try{var s=null;try{s=localStorage.getItem("attn-theme")}catch(e){}'
  + 'var t=s==="dark"||s==="light"?s:(window.matchMedia'
  + '&&window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");'
  + 'var r=document.documentElement;r.dataset.theme=t;'
  + 'r.classList.toggle("dark",t==="dark")}catch(e){}})();';

/**
 * Base64 SHA-256 of {@link THEME_PREFLIGHT_SCRIPT}, in the form CSP expects.
 * Regenerate with `node scripts/theme-preflight-hash.mjs`.
 */
export const THEME_PREFLIGHT_SHA256 = 'sha256-dlo6xal08xrjMN4e+6tndEheh4s1li+xaso+C0i6HO4=';
