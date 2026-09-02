/**
 * Rewrites only share-bound HTML image URLs. The source remains inside a
 * sandboxed opaque-origin iframe; remote, data, and absent local references
 * remain untouched so no new network capability is introduced here.
 */
export function rewriteSharedHtmlImageSources(
  content: string,
  resolveAssetUrl: ((src: string) => string | null) | undefined,
): string {
  if (!resolveAssetUrl || typeof DOMParser === 'undefined') return content;
  const document = new DOMParser().parseFromString(content, 'text/html');
  for (const image of document.querySelectorAll<HTMLImageElement>('img[src]')) {
    const resolved = resolveAssetUrl(image.getAttribute('src') ?? '');
    if (resolved !== null) image.setAttribute('src', resolved);
  }
  for (const source of document.querySelectorAll<HTMLSourceElement>('img[srcset], source[srcset]')) {
    const srcset = source.getAttribute('srcset');
    if (srcset !== null) source.setAttribute('srcset', rewriteSrcset(srcset, resolveAssetUrl));
  }
  return `<!doctype html>\n${document.documentElement.outerHTML}`;
}

/** Keep each candidate descriptor intact while replacing its URL token. */
export function rewriteSrcset(
  srcset: string,
  resolveAssetUrl: (src: string) => string | null,
): string {
  return srcset.split(',').map((candidate) => {
    const match = /^(\s*)(\S+)([\s\S]*)$/u.exec(candidate);
    if (!match) return candidate;
    const resolved = resolveAssetUrl(match[2]!);
    return resolved === null ? candidate : `${match[1]}${resolved}${match[3]}`;
  }).join(',');
}
