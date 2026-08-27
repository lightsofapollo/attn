import type { FileType, PlanStructure } from './types';

const EXTENSIONS_BY_TYPE: Record<FileType, string[]> = {
  markdown: ['md', 'markdown'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico'],
  video: ['mp4', 'webm', 'mov', 'avi'],
  audio: ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'],
  html: ['html', 'htm'],
  unsupported: [],
  directory: [],
};

const FILE_PATH_HINTS: string[] = [
  '.rs',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.py',
  '.go',
  '.java',
  '.md',
  '.css',
  '.html',
  '.json',
  '.toml',
  '.yaml',
  '.yml',
  '.sql',
  '.sh',
  '.bash',
  '.svelte',
  '.vue',
];

export function detectFileType(path: string): FileType {
  const ext = path.split('.').pop()?.toLowerCase();

  for (const [fileType, exts] of Object.entries(EXTENSIONS_BY_TYPE)) {
    if (exts.includes(ext ?? '') && fileType !== 'unsupported' && fileType !== 'directory') {
      return fileType as FileType;
    }
  }

  return 'unsupported';
}

export function looksLikeFilePath(token: string): boolean {
  if (token.length < 4 || !token.includes('/')) {
    return false;
  }

  return FILE_PATH_HINTS.some((ext) => token.endsWith(ext));
}

export function extractStructureFromMarkdown(markdown: string): PlanStructure {
  const phases: PlanStructure['phases'] = [];
  const tasks: PlanStructure['tasks'] = [];
  const fileRefs: string[] = [];
  const lines = markdown.split('\n');

  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();

    if (trimmed.startsWith('## ')) {
      phases.push({
        title: trimmed.replace(/^#+\s*/, ''),
        progress: { done: 0, total: 0 },
      });
    }

    if (trimmed.startsWith('- [x] ') || trimmed.startsWith('- [X] ')) {
      const text = trimmed.slice(6);
      tasks.push({ line: i + 1, text, checked: true });
      const phase = phases.at(-1);
      if (phase) {
        phase.progress.total += 1;
        phase.progress.done += 1;
      }
    } else if (trimmed.startsWith('- [ ] ')) {
      const text = trimmed.slice(6);
      tasks.push({ line: i + 1, text, checked: false });
      const phase = phases.at(-1);
      if (phase) {
        phase.progress.total += 1;
      }
    }

    for (const word of trimmed.split(/\s+/)) {
      const cleaned = word.replace(/^[`"'()]+|[`"'()]+$/g, '');
      if (looksLikeFilePath(cleaned)) {
        fileRefs.push(cleaned);
      }
    }
  }

  return { phases, tasks, file_refs: fileRefs };
}

export function markdownSourceUrl(path: string): string {
  return `attn://localhost${encodeURI(path)}`;
}

export async function loadMarkdownFromPath(path: string): Promise<string> {
  const response = await fetch(markdownSourceUrl(path), { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`failed to fetch markdown: ${response.status}`);
  }
  return response.text();
}

// --------------------------------------------------------------------------
// Relative image resolution (attn-cgev)
//
// A markdown image src is written relative to the FILE, but the native
// document is served from attn://app (or the Vite dev server under `task
// dev`), so `./diagram.png` resolves against the app origin and 404s. Every
// local asset has to go back through the attn:// custom protocol, which serves
// any absolute path: `attn://localhost/<abs-path>` (src/main.rs).
//
// ENCODING. This deliberately does NOT reuse `markdownSourceUrl`'s
// `encodeURI`, because the two functions take different input:
//
//   - `markdownSourceUrl` takes a RAW filesystem path straight from the daemon.
//   - this takes `node.attrs.src`, which markdown-it has already normalised
//     through mdurl: `./café.png` arrives as `./caf%C3%A9.png`, `<./my
//     shot.png>` as `./my%20shot.png`, a lone `%` as `%25`. Running encodeURI
//     over that double-encodes (`%C3%A9` → `%25C3%25A9`) and the handler then
//     looks for a file literally named `caf%C3%A9.png`.
//
// mdurl also leaves `#` and `?` LITERAL, and the handler truncates the path at
// the first of either (src/main.rs, the `raw_path.find(['?', '#'])` line)
// BEFORE percent-decoding — so an un-escaped `#` silently amputates the name.
// encodeURI escapes neither.
//
// The one policy that is coherent for both facts: decode each `/`-delimited
// piece exactly once, then re-encode each with encodeURIComponent — which does
// escape `#`, `?`, `%` and space, and never sees a `/` because the pieces are
// split apart first. Segments taken from `docPath` are NOT decoded: that
// string is raw filesystem bytes, so a document at `/Users/me/100%.md` must
// not have its `%` read as an escape.
//
// An encoded separator IS a separator. `./a%2Fb.png` becomes `a` + `b.png`,
// not one segment named `a/b.png`, because the handler percent-decodes the
// WHOLE path in one call (`percent_decode_str(raw_path)`) before `fs::read` —
// so a `%2F` this side of the wire is a real `/` on the other side no matter
// what we intend by it. Keeping it inside a segment would only make the
// normalisation walk below disagree with the file that actually gets opened:
// `a%2F..%2F..%2Fx.png` would look like an innocent filename here and open
// two directories up there. Decoding before the walk keeps the URL we emit a
// truthful name for the file the handler will read. The cost is that a file
// whose name literally contains the three characters `%2F` is unreachable —
// it is unreachable through this protocol regardless, since the handler's
// single decode leaves no way to spell one.
//
// A consequence worth stating: `![](x.png?v=2)` looks for a file literally
// named `x.png?v=2`. There is no server behind attn:// to interpret a query,
// and filenames containing `#`/`?` are real, so the bytes win.
//
// LEADING SLASH. `![](/img/x.png)` is treated as a FILESYSTEM-absolute path,
// which deliberately diverges from `resolvePath` in App.svelte — that one
// treats a leading `/` in a LINK as project-root-relative. The two disagree on
// purpose: a wrong link target lands the user in a "file not found" shell they
// can navigate out of, whereas a wrong image src renders a placeholder with no
// recourse, and in agent-authored docs an absolute image src is overwhelmingly
// a real path (`/Users/…`, `/tmp/…`) that a project-root join would destroy.
// If that ever needs to change, change it here and in `resolvePath` together.
// --------------------------------------------------------------------------

/** `scheme:` — RFC 3986, but requiring 2+ chars so a `C:` drive letter is not
 *  mistaken for a scheme (the Windows form is handled separately below). */
const URL_SCHEME = /^[a-zA-Z][a-zA-Z\d+\-.]+:/;

/** `C:/…` — recognised only so it is not read as a scheme. Windows is not a
 *  supported host today; the path is passed through as absolute rather than
 *  silently re-rooted. */
const WINDOWS_DRIVE = /^[a-zA-Z]:\//;

/** markdown-it repairs malformed escapes, so its output never throws here —
 *  but `attrs.src` also arrives from paste and DOM-parse paths that do not go
 *  through it, and a lone `%` there would throw. Raw bytes are the honest
 *  fallback. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Map a markdown image `src` onto a URL the webview can actually load.
 *
 * Returns `null` when the src cannot be resolved — an empty src, a bare
 * fragment, or a relative src with no absolute document path to resolve it
 * against. Callers render the authored src in that case and let the broken
 * state speak for itself; inventing a root-relative attn:// URL would be worse
 * than doing nothing (see `is_reserved_localhost_review` in src/main.rs).
 *
 * Absolute URLs (any scheme) and protocol-relative `//host/…` pass through
 * untouched — they already address something the webview can fetch, and
 * rewriting them would break remote images.
 *
 * @param docPath absolute filesystem path of the markdown file, raw/unencoded
 * @param src     `node.attrs.src` exactly as the parser produced it
 */
export function resolveImageSrc(docPath: string, src: string): string | null {
  if (!src) return null;

  // Protocol-relative and fully-qualified URLs are already loadable.
  if (src.startsWith('//')) return src;
  const windowsDrive = WINDOWS_DRIVE.test(src);
  if (!windowsDrive && URL_SCHEME.test(src)) return src;

  // A bare `#anchor` addresses a place in the document, never a file.
  if (src.startsWith('#')) return null;

  // Decoded first, then re-split: a `%2F` the parser preserved is a separator
  // to the handler, so it has to be one here too or the normalisation walk
  // below would be reasoning about a different path than the one opened.
  const srcSegments = src.split('/').flatMap((piece) => decodeSegment(piece).split('/'));

  // A src whose last segment names a directory (`.`, `..`, a trailing slash,
  // or a bare `/`) can never be an image. Left alone it would normalise to a
  // directory URL, which the handler answers with an empty 404 — a plausible
  // URL for a thing that is not a file.
  const last = srcSegments[srcSegments.length - 1];
  if (last === '' || last === '.' || last === '..') return null;

  // Segments that are pinned against `..` — the filesystem root has none, a
  // Windows drive has the drive itself. Escaping above either is nonsense, and
  // the handler does no confinement of its own.
  let pinned = 0;
  let segments: string[];
  if (windowsDrive) {
    segments = srcSegments;
    pinned = 1;
  } else if (src.startsWith('/')) {
    segments = srcSegments;
  } else {
    if (!docPath.startsWith('/')) return null;
    const slash = docPath.lastIndexOf('/');
    const dir = slash > 0 ? docPath.slice(0, slash) : '';
    segments = [...dir.split('/'), ...srcSegments];
  }

  const stack: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (stack.length > pinned) stack.pop();
      continue;
    }
    stack.push(segment);
  }
  if (stack.length === 0) return null;

  return `attn://localhost/${stack.map(encodeURIComponent).join('/')}`;
}
