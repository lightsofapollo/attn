// Invite-link validation for the desk's Join panel (Theme v2, attn-ri1).
// An invite is either a hosted HTTPS link whose path is a review entry
// (/review/:roomId or /s/:shareId — the room key rides in the fragment and
// MUST be preserved), or a native attn:// URL we hand to the OS protocol
// handler. Anything else is rejected rather than navigated blindly.

export interface ParsedInvite {
  href: string;
  kind: 'hosted' | 'native';
}

export function parseInviteUrl(raw: string): ParsedInvite | null {
  const input = raw.trim();
  if (input.length === 0) return null;

  if (input.startsWith('attn://')) {
    return { href: input, kind: 'native' };
  }

  let url: URL;
  try {
    url = new URL(input, window.location.origin);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!/^\/(review|s)\//.test(url.pathname)) return null;
  return { href: url.href, kind: 'hosted' };
}
