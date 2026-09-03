import { UNRESOLVED_SHARED_IMAGE_SRC } from './shared-image-policy';

/**
 * Rewrites HTML image URLs through the caller's policy. The source remains
 * inside a sandboxed opaque-origin iframe; rejected sources become a
 * non-decodable local fallback. Reviewers may explicitly approve HTTPS images
 * for a session, but that must never make data or unsafe schemes fetchable.
 */
export function rewriteSharedHtmlImageSources(
  content: string,
  resolveAssetUrl: ((src: string) => string | null) | undefined,
): string {
  if (!resolveAssetUrl || typeof DOMParser === 'undefined') return content;
  const document = new DOMParser().parseFromString(content, 'text/html');
  for (const image of document.querySelectorAll<HTMLImageElement>('img')) {
    const src = image.getAttribute('src');
    if (src !== null) {
      const resolved = resolveAssetUrl(src);
      image.setAttribute('src', resolved ?? UNRESOLVED_SHARED_IMAGE_SRC);
    }
    image.setAttribute('referrerpolicy', 'no-referrer');
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
  return splitSrcsetCandidates(srcset).map((candidate) => {
    const match = /^(\s*)(\S+)([\s\S]*)$/u.exec(candidate);
    if (!match) return candidate;
    const resolved = resolveAssetUrl(match[2]!);
    return `${match[1]}${resolved ?? UNRESOLVED_SHARED_IMAGE_SRC}${match[3]}`;
  }).join(',');
}

/** A comma separates srcset candidates, except for the one literal comma in
 * a data URL's metadata/payload boundary. We reject data URLs during rewrite,
 * but must keep that boundary intact long enough to replace it as one source
 * rather than accidentally minting two fallback candidates. */
function splitSrcsetCandidates(srcset: string): string[] {
  const candidates: string[] = [];
  let start = 0;
  let dataBoundarySeen = false;
  for (let index = 0; index < srcset.length; index += 1) {
    if (srcset[index] !== ',') continue;
    const isData = srcset.slice(start).trimStart().toLowerCase().startsWith('data:');
    if (isData && !dataBoundarySeen) {
      dataBoundarySeen = true;
      continue;
    }
    candidates.push(srcset.slice(start, index));
    start = index + 1;
    dataBoundarySeen = false;
  }
  candidates.push(srcset.slice(start));
  return candidates;
}
