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
import { parseAndStripShareInvite, type ParsedShareInvite } from './lib/review/browser-share';

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
    invite = parseAndStripShareInvite(window);
    const relayUrl = validateBrowserRelayUrl(import.meta.env.VITE_ATTN_RELAY_URL);
    const [svelte, appModule, production] = await Promise.all([import('svelte'), import('./BrowserReviewApp.svelte'),
      import('./lib/review/browser-share-production'), import('./browser-review-styles')]);
    const target = document.getElementById('app');
    if (!target) throw new Error('missing browser review mount element');
    target.style.display = '';
    const session = new production.DurableShareBrowserSessionFacade({ relayUrl, invite });
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
  target.textContent = 'This review link could not be opened.';
  target.setAttribute('role', 'alert');
});
