import { markdownParser } from '../schema';

/** Authored image URLs only; callers decide whether each may cross a boundary. */
export function markdownImageSources(content: string): string[] {
  const sources = new Set<string>();
  try {
    markdownParser.parse(content).descendants((node) => {
      if (node.type.name === 'image' && typeof node.attrs.src === 'string') sources.add(node.attrs.src);
    });
  } catch {
    // An invalid draft must not block editing or publishing the document; it
    // simply has no discoverable local-image dependencies until it parses.
  }
  return [...sources];
}

/** HTML snapshots use the same relative-path rules as Markdown images. */
export function htmlImageSources(content: string): string[] {
  if (typeof DOMParser === 'undefined') return [];
  const sources = new Set<string>();
  const document = new DOMParser().parseFromString(content, 'text/html');
  for (const image of document.querySelectorAll<HTMLImageElement>('img[src]')) {
    const src = image.getAttribute('src');
    if (src) sources.add(src);
  }
  for (const source of document.querySelectorAll<HTMLSourceElement>('img[srcset], source[srcset]')) {
    const srcset = source.getAttribute('srcset');
    if (!srcset) continue;
    for (const src of srcsetSources(srcset)) sources.add(src);
  }
  return [...sources];
}

export function srcsetSources(srcset: string): string[] {
  return srcset.split(',').flatMap((candidate) => {
    const match = /^\s*(\S+)/u.exec(candidate);
    return match ? [match[1]!] : [];
  });
}
