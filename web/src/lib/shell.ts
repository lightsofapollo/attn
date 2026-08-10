/* Which shell is this page running in? (attn-64iy.5)
 *
 * `App.svelte` serves two of them from one component tree:
 *
 *   - the wry desktop window, which on macOS overlays traffic-light buttons on
 *     the top-left of the content and lets a drag region move the window;
 *   - an ordinary browser tab (Vite dev server, no daemon), which has neither.
 *
 * It used to assume the first unconditionally, so a browser tab reserved 46px
 * of sidebar to clear traffic lights that were not there, and up to 6.5rem of
 * header indent for the same reason. That dead corner is what a user reported
 * as "move the logo and text into the top left corner of the screen", with the
 * clarifying note: "there is no title bar to avoid in web, only desktop".
 *
 * THE SIGNAL. `installMockIpc` sets `window.__attnMockIpc` only when it found
 * no real wry bridge to talk to, so it is precisely "there is no native host".
 * Testing `window.ipc` instead would be wrong: the mock installs its own
 * `window.ipc` shim, so that property is truthy in both shells. The flag is set
 * in `main.ts` before `mount(App, …)`, so it is readable from the first render.
 *
 * ONE CAVEAT, deliberately encoded in the names below. "Has a native host" and
 * "has traffic lights overlaying the content" are not the same predicate — a
 * wry window on Linux or Windows has an ordinary title bar and no overlay, so
 * it should reserve nothing either. Today attn ships macOS bundles and the two
 * coincide, so `reservesWindowControls` is derived from the host check; when a
 * platform hint reaches the init payload, this is the one place to refine, and
 * every call site follows without knowing.
 */

/**
 * True when a real wry host is behind this page (the desktop app), false in a
 * browser tab. Read `reservesWindowControls` instead for layout decisions.
 */
export function isNativeShell(): boolean {
  if (typeof window === 'undefined') return false;
  return !window.__attnMockIpc;
}

/**
 * Should chrome leave room for OS window controls drawn over the content?
 *
 * This is the question layout actually wants — the sidebar's drag strip and the
 * header's left indent both exist only to clear macOS traffic lights.
 */
export function reservesWindowControls(): boolean {
  return isNativeShell();
}

/**
 * Where does the attn brand live?
 *
 * - DESKTOP: nowhere (owner-directed, 2026-08-10 — "remove the attn text and
 *   logo on the desktop app, it's not needed, just show the name of the active
 *   file instead"). A desktop app does not need to tell you which app it is:
 *   the Dock icon, the window and the app menu all already say so, and the
 *   header's job is the document. This is why the placement is a THREE-way
 *   answer rather than a boolean — "no brand at all" is a real position, and
 *   it is the right one exactly where the OS supplies identity for free.
 * - BROWSER WITH A SIDEBAR: the top-left corner, above the project label. A
 *   tab has no Dock icon and the corner is free because there are no traffic
 *   lights to clear.
 * - BROWSER WITHOUT A SIDEBAR: the header, as the only place left. The app
 *   must not go unbranded in its own empty state — that screen is the file
 *   picker, where "what is this?" is a question a first-time visitor actually
 *   has.
 */
export function brandPlacement(hasSidebar: boolean): 'header' | 'sidebar' | 'none' {
  if (reservesWindowControls()) return 'none';
  return hasSidebar ? 'sidebar' : 'header';
}
