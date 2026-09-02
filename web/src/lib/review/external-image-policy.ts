/**
 * A remote image is an ordinary Markdown affordance, but it is also a direct
 * request from the reader's browser to an author-selected host. Keep the
 * accepted surface deliberately narrow: HTTPS, no embedded credentials, and
 * no protocol-relative or locally-resolved lookalikes.
 *
 * Callers decide *when* this capability is spent. The owner workspace permits
 * it while a reviewer share requires an explicit, session-only choice.
 */
export function approvedExternalImageUrl(src: string): string | null {
  if (!/^https:\/\//iu.test(src)) return null;
  try {
    const url = new URL(src);
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null;
    return url.href;
  } catch {
    return null;
  }
}
