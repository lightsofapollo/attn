// Browser entry point for the hosted review surface (attn-nnj.9.4).
//
// Loaded by `hosted/index.html` rather than the native Wry `index.html`, so
// the production review URL `https://attn.dev/review/<roomId>`
// boots straight into a reviewer-only Svelte app with no sidebar, no tabs,
// no share dialog, no editor write surface.
//
// Wire shape:
//
//   <html><body>
//     <div id="app"></div>
//     <script type="module" src="/src/browser-review.ts"></script>
//   </body></html>
//
// Keep this bootstrap deliberately narrow: relay policy is validated before
// loading the broad editor/UI graph. The invite itself is parsed and stripped
// synchronously by BrowserSession as soon as the component is constructed.

import {
  parseAndStripInviteFromUrl,
  stripFragment,
  zero,
  type ParsedInvite,
} from './lib/review/browser-invite';
import { validateBrowserRelayUrl } from './lib/review/browser-relay-url';
import {
  parseAndStripShareInvite,
  recoverStrippedShareInvite,
  type ParsedShareInvite,
} from './lib/review/browser-share';

async function bootstrapHostedReview(): Promise<void> {
  const durablePath = /^\/s\/([A-Za-z0-9_-]+)\/?$/u.test(window.location.pathname);
  if (durablePath) return bootstrapDurableShare();
  let parsedInvite: ParsedInvite | undefined;
  let inviteError: string | undefined;
  const hadFragment = window.location.hash.length > 1;
  try {
    parsedInvite = parseAndStripInviteFromUrl(window) ?? undefined;
    if (!parsedInvite && hadFragment) inviteError = 'invalid invite fragment';
  } catch (error) {
    inviteError = error instanceof Error ? error.message : 'invalid invite';
  }

  try {
    const relayUrl = validateBrowserRelayUrl(import.meta.env.VITE_ATTN_RELAY_URL);
    const [svelte, appModule] = await Promise.all([
      import('svelte'),
      import('./BrowserReviewApp.svelte'),
      import('./browser-review-styles'),
    ]);
    const target = document.getElementById('app');
    if (!target) throw new Error('missing browser review mount element');
    target.style.display = '';
    svelte.mount(appModule.default, {
      target,
      props: {
        relayUrl,
        parsedInvite,
        inviteError,
        rememberedRoomId: roomIdFromReviewPath(window.location.pathname),
      },
    });
  } catch (error) {
    if (parsedInvite?.version === 2) zero(parsedInvite.roomSecret);
    throw error;
  }
}

async function bootstrapDurableShare(): Promise<void> {
  let invite: ParsedShareInvite | null = null;
  try {
    const relayUrl = validateBrowserRelayUrl(import.meta.env.VITE_ATTN_RELAY_URL);
    const [svelte, appModule, production] = await Promise.all([import('svelte'), import('./BrowserReviewApp.svelte'),
      import('./lib/review/browser-share-production'), import('./browser-review-styles')]);
    const target = document.getElementById('app');
    if (!target) throw new Error('missing browser review mount element');
    target.style.display = '';
    const pathId = window.location.pathname.match(/^\/s\/([A-Za-z0-9_-]+)\/?$/u)?.[1];
    if (!pathId) throw new Error('invalid durable share path');
    // Fragment present → normal join (stashes the key in history.state).
    // Fragmentless → first try the key this tab stashed before a reload,
    // then the fragmentless push-notification binding as the last resort.
    const recovered = window.location.hash.length > 1 ? null : recoverStrippedShareInvite(window);
    const session = window.location.hash.length > 1
      ? new production.DurableShareBrowserSessionFacade({ relayUrl, invite: (invite = parseAndStripShareInvite(window)) })
      : recovered
        ? new production.DurableShareBrowserSessionFacade({ relayUrl, invite: (invite = recovered) })
        : new production.RememberedPushShareSessionFacade({ relayUrl, bindingId: pathId });
    svelte.mount(appModule.default, { target, props: { session } });
  } catch (error) {
    invite?.linkSecret.fill(0);
    throw error;
  }
}

function roomIdFromReviewPath(pathname: string): string | undefined {
  const match = pathname.match(/^\/review\/([A-Za-z0-9_-]+)\/?$/u);
  return match?.[1];
}

void bootstrapHostedReview().catch((error: unknown) => {
  // If configuration or chunk loading fails before BrowserSession starts, do
  // not leave a room secret in the address bar. Keep the visible error generic.
  const diagnostic = error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
  console.error('[attn] hosted bootstrap failed', diagnostic);
  stripFragment(window);
  const target = document.getElementById('app');
  if (!target) return;
  target.style.display = '';
  // Branded, actionable failure state (gate-35): the raw text fallback was an
  // unstyled dead-end. Cause stays generic (never leak why a key failed), but
  // the reader gets the brand, reassurance, and a way forward.
  target.setAttribute('role', 'alert');
  target.replaceChildren();
  const card = document.createElement('main');
  card.style.cssText =
    'max-width:32rem;margin:14vh auto 0;padding:0 1.5rem;font-family:var(--sans);color:var(--ink);text-align:left';
  const brand = document.createElement('p');
  brand.textContent = 'attn';
  brand.style.cssText =
    "font:700 1.05rem var(--serif);letter-spacing:-0.01em;margin:0 0 1.5rem";
  brand.innerHTML = 'attn<span style="color:var(--rust)">.</span>';
  const h = document.createElement('h1');
  h.textContent = 'This review link could not be opened';
  h.style.cssText = 'font:600 1.5rem/1.24 var(--serif);letter-spacing:-0.015em;margin:0 0 0.6rem';
  const p = document.createElement('p');
  p.textContent =
    'The link may be malformed, expired, or missing the part after # (the room key, which stays in your browser and never reaches the relay). Nothing was uploaded.';
  p.style.cssText = 'font:400 0.95rem/1.6 var(--sans);color:var(--hosted-muted);margin:0 0 1.4rem';
  const back = document.createElement('a');
  back.href = '/app';
  back.textContent = 'Go to your desk →';
  back.style.cssText =
    'display:inline-flex;align-items:center;min-height:44px;padding:0 1rem;border-radius:8px;background:var(--rust);color:var(--rust-contrast);font:700 0.9rem var(--sans);text-decoration:none';
  card.append(brand, h, p, back);
  target.appendChild(card);
});
