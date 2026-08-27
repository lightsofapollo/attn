// Relative image src resolution for the native viewer (attn-cgev).
//
// Run with:
//
//   cd web && npx tsx src/lib/image-src-resolution.test.ts
//
// Three invariants, and they are independent:
//
//   1. WHAT THE PARSER HANDS US (cases 1-9). `resolveImageSrc` is specified
//      against `node.attrs.src`, not against the bytes an author typed —
//      markdown-it normalises hrefs through mdurl on the way in. These cases
//      run the REAL parser from schema.ts so the resolver's encoding policy is
//      pinned to the parser it actually sits behind, not to an assumption
//      about it.
//
//   2. THE ENCODING POLICY (cases 10-24). Exactly one level of percent-
//      encoding must survive to the Rust handler, which truncates at the first
//      '?' or '#' BEFORE decoding — so those two characters have to be escaped
//      even though they arrive literal, and everything mdurl already escaped
//      must NOT be escaped twice.
//
//   3. attrs.src IS NEVER REWRITTEN (cases 25-27). `image` has no serializer
//      override in schema.ts, so prosemirror-markdown writes `attrs.src`
//      verbatim on every save. The resolver is a pure function that returns a
//      new string; these cases prove the node it was derived from still
//      round-trips.

import { markdownParser, markdownSerializer } from './schema';
import type { Node as PmNode } from 'prosemirror-model';
import { resolveImageSrc } from './markdown-layer';

// ---------------------------------------------------------------------------
// Tiny harness (mirrors prosemirror/frontmatter-nodeview.test.ts)
// ---------------------------------------------------------------------------

interface CaseResult {
  name: string;
  ok: boolean;
  detail?: string;
}

const cases: Array<() => CaseResult> = [];

function defineCase(name: string, fn: () => void | string): void {
  cases.push(() => {
    try {
      const note = fn();
      return { name, ok: true, detail: typeof note === 'string' ? note : undefined };
    } catch (err) {
      return { name, ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  });
}

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function assertEq<T>(actual: T, expected: T, msg: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg}: expected ${b}, got ${a}`);
}

/** The `src` the parser stores for the first image in `md`. */
function parsedSrc(md: string): string | null {
  const doc: PmNode | null = markdownParser.parse(md);
  assert(doc !== null, 'parser returned null');
  let found: string | null = null;
  doc.descendants((node) => {
    if (found === null && node.type.name === 'image') found = node.attrs.src as string;
    return found === null;
  });
  return found;
}

const DOC = '/Users/me/notes/plan.md';

/** Resolve straight from markdown, so the parser sits in the loop. */
function resolveFromMarkdown(md: string, docPath = DOC): string | null {
  const src = parsedSrc(md);
  assert(src !== null, `no image node parsed from ${JSON.stringify(md)}`);
  return resolveImageSrc(docPath, src);
}

// ---------------------------------------------------------------------------
// 1. What the parser hands us
// ---------------------------------------------------------------------------

defineCase('1. dot-slash sibling resolves against the file, not the app origin', () => {
  assertEq(
    resolveFromMarkdown('![a](./diagram.png)'),
    'attn://localhost/Users/me/notes/diagram.png',
    './diagram.png',
  );
});

defineCase('2. bare sibling resolves the same as the dot-slash form', () => {
  assertEq(
    resolveFromMarkdown('![a](diagram.png)'),
    'attn://localhost/Users/me/notes/diagram.png',
    'diagram.png',
  );
});

defineCase('3. subdirectory', () => {
  assertEq(
    resolveFromMarkdown('![a](sub/diagram.png)'),
    'attn://localhost/Users/me/notes/sub/diagram.png',
    'sub/diagram.png',
  );
  assertEq(
    resolveFromMarkdown('![a](./sub/diagram.png)'),
    'attn://localhost/Users/me/notes/sub/diagram.png',
    './sub/diagram.png',
  );
});

defineCase('4. parent traversal walks up one directory per `..`', () => {
  assertEq(
    resolveFromMarkdown('![a](../assets/x.png)'),
    'attn://localhost/Users/me/assets/x.png',
    '../assets/x.png',
  );
  assertEq(
    resolveFromMarkdown('![a](../../assets/x.png)'),
    'attn://localhost/Users/assets/x.png',
    '../../assets/x.png',
  );
});

defineCase('5. `..` can never climb above the filesystem root', () => {
  assertEq(
    resolveImageSrc(DOC, '../../../../../../../../etc/passwd'),
    'attn://localhost/etc/passwd',
    'traversal is clamped at /',
  );
  assertEq(
    resolveImageSrc('/a.md', '../../../x.png'),
    'attn://localhost/x.png',
    'clamped from a root-level document',
  );
});

defineCase('6. interior `.` and `..` segments normalise', () => {
  assertEq(
    resolveImageSrc(DOC, './a/./b/../c/x.png'),
    'attn://localhost/Users/me/notes/a/c/x.png',
    'mixed . and ..',
  );
  assertEq(
    resolveImageSrc(DOC, 'a//b/x.png'),
    'attn://localhost/Users/me/notes/a/b/x.png',
    'empty segments collapse',
  );
});

defineCase('7. a leading slash is FILESYSTEM-absolute, not project-root-relative', () => {
  // Deliberate divergence from resolvePath() in App.svelte, which treats a
  // leading '/' in a LINK as project-root-relative. Documented at the resolver.
  assertEq(
    resolveFromMarkdown('![a](/Users/other/x.png)'),
    'attn://localhost/Users/other/x.png',
    'absolute src',
  );
  assertEq(
    resolveImageSrc('', '/tmp/x.png'),
    'attn://localhost/tmp/x.png',
    'an absolute src needs no document path',
  );
});

defineCase('8. absolute URLs and protocol-relative srcs pass through untouched', () => {
  for (const src of [
    'https://example.com/x.png',
    'http://example.com/x.png',
    'data:image/png;base64,iVBORw0KGgo=',
    'blob:attn://localhost/9a2f',
    'attn://localhost/Users/me/x.png',
    '//cdn.example.com/x.png',
  ]) {
    assertEq(resolveImageSrc(DOC, src), src, `passthrough ${src}`);
  }
  // Through the parser too, since mdurl could in principle rewrite them.
  assertEq(
    resolveFromMarkdown('![a](https://example.com/x.png)'),
    'https://example.com/x.png',
    'parsed https passthrough',
  );
  return '6 schemes';
});

defineCase('9. unresolvable srcs return null rather than inventing a URL', () => {
  assertEq(resolveImageSrc(DOC, ''), null, 'empty src');
  assertEq(resolveImageSrc(DOC, '#anchor'), null, 'bare fragment');
  assertEq(resolveImageSrc('', './x.png'), null, 'relative src, no document path');
  assertEq(resolveImageSrc('notes/plan.md', './x.png'), null, 'relative src, relative doc path');
  assertEq(resolveImageSrc(DOC, '.'), null, 'src that normalises to nothing');
  assertEq(resolveImageSrc(DOC, '/'), null, 'src that is only the root');
  // A directory is not an image; the handler would answer these with an empty
  // 404 and the URL would look convincing while doing it.
  assertEq(resolveImageSrc(DOC, './'), null, 'trailing slash on the current dir');
  assertEq(resolveImageSrc(DOC, '..'), null, 'bare parent');
  assertEq(resolveImageSrc(DOC, './assets/'), null, 'trailing slash on a subdirectory');
});

// ---------------------------------------------------------------------------
// 2. The encoding policy
// ---------------------------------------------------------------------------

defineCase('10. a space arrives pre-encoded and is NOT encoded again', () => {
  // markdown-it only produces an image node for a space when the src is
  // angle-wrapped; it hands back './my%20shot.png' either way.
  assertEq(parsedSrc('![a](<./my shot.png>)'), './my%20shot.png', 'angle form is normalised');
  assertEq(parsedSrc('![a](./my%20shot.png)'), './my%20shot.png', 'escaped form is preserved');
  assertEq(
    resolveFromMarkdown('![a](<./my shot.png>)'),
    'attn://localhost/Users/me/notes/my%20shot.png',
    'single encoding survives',
  );
  assertEq(
    resolveFromMarkdown('![a](./my%20shot.png)'),
    'attn://localhost/Users/me/notes/my%20shot.png',
    'no double encoding',
  );
});

defineCase('11. non-ASCII arrives pre-encoded and is NOT encoded again', () => {
  assertEq(parsedSrc('![a](./café.png)'), './caf%C3%A9.png', 'mdurl UTF-8 escapes');
  assertEq(
    resolveFromMarkdown('![a](./café.png)'),
    'attn://localhost/Users/me/notes/caf%C3%A9.png',
    'not %25C3%25A9',
  );
  // The same file addressed in its already-escaped form must land identically.
  assertEq(
    resolveFromMarkdown('![a](./caf%C3%A9.png)'),
    'attn://localhost/Users/me/notes/caf%C3%A9.png',
    'idempotent across both spellings',
  );
});

defineCase('12. a literal percent survives as exactly one escape', () => {
  assertEq(parsedSrc('![a](./100%.png)'), './100%25.png', 'lone % is repaired by mdurl');
  assertEq(
    resolveFromMarkdown('![a](./100%.png)'),
    'attn://localhost/Users/me/notes/100%25.png',
    'one level of encoding',
  );
  assertEq(
    resolveFromMarkdown('![a](./100%25.png)'),
    'attn://localhost/Users/me/notes/100%25.png',
    'the escaped spelling agrees',
  );
});

defineCase("13. '#' is escaped even though the parser leaves it literal", () => {
  // This is the whole reason encodeURI() is not usable here: the Rust handler
  // truncates the path at the first '#' BEFORE percent-decoding, so an
  // un-escaped one amputates the filename and 404s.
  assertEq(parsedSrc('![a](./weird#hash.png)'), './weird#hash.png', 'parser keeps it raw');
  assertEq(
    resolveFromMarkdown('![a](./weird#hash.png)'),
    'attn://localhost/Users/me/notes/weird%23hash.png',
    '# → %23',
  );
});

defineCase("14. '?' is escaped for the same reason", () => {
  assertEq(parsedSrc('![a](./q?uery.png)'), './q?uery.png', 'parser keeps it raw');
  assertEq(
    resolveFromMarkdown('![a](./q?uery.png)'),
    'attn://localhost/Users/me/notes/q%3Fuery.png',
    '? → %3F',
  );
});

defineCase('15. a query-looking suffix is filename bytes, not a query string', () => {
  // There is no server behind attn:// to interpret a query, and filenames
  // containing '?' are real. The bytes win — stated so the choice is pinned
  // rather than discovered.
  assertEq(
    resolveImageSrc(DOC, './x.png?v=2'),
    'attn://localhost/Users/me/notes/x.png%3Fv%3D2',
    'cache-buster is treated as part of the name',
  );
  assertEq(
    resolveImageSrc(DOC, './x.png#frag'),
    'attn://localhost/Users/me/notes/x.png%23frag',
    'trailing fragment likewise',
  );
});

defineCase("16. an encoded '/' is a separator, because the handler decodes it into one", () => {
  // src/main.rs percent-decodes the WHOLE path in a single call before
  // fs::read, so a `%2F` that survived to the URL reappears as a real
  // separator on the far side. Treating it as one here is what keeps the
  // emitted URL a truthful name for the file that actually gets opened.
  assertEq(parsedSrc('![a](./a%2Fb.png)'), './a%2Fb.png', 'parser preserves it');
  assertEq(
    resolveFromMarkdown('![a](./a%2Fb.png)'),
    'attn://localhost/Users/me/notes/a/b.png',
    'decoded into a directory step',
  );
  // The regression this pins: while `%2F` was kept inside a segment, the
  // normalisation walk saw no separators to walk, so the traversal below rode
  // straight past the clamp and the handler opened a file four directories
  // above the one the resolver claimed to have computed.
  assertEq(
    resolveImageSrc(DOC, 'a%2F..%2F..%2F..%2F..%2Fetc%2Fpasswd'),
    'attn://localhost/etc/passwd',
    'encoded traversal normalises exactly like the literal form',
  );
  assertEq(
    resolveImageSrc(DOC, 'a/../../../../etc/passwd'),
    resolveImageSrc(DOC, 'a%2F..%2F..%2F..%2F..%2Fetc%2Fpasswd'),
    'the two spellings name the same file',
  );
  assertEq(resolveImageSrc(DOC, './a%2F'), null, 'a src that decodes to a directory is declined');
});

defineCase("17. '%2E%2E' is normalised as traversal, not smuggled through", () => {
  // Decode happens before normalisation precisely so an encoded '..' cannot
  // slip past the segment walk as a literal filename.
  assertEq(
    resolveImageSrc(DOC, '%2E%2E/x.png'),
    'attn://localhost/Users/me/x.png',
    'encoded parent behaves like ..',
  );
});

defineCase('18. a malformed escape falls back to raw bytes instead of throwing', () => {
  // markdown-it repairs these, but attrs.src also arrives from paste and
  // DOM-parse paths that do not go through it.
  assertEq(
    resolveImageSrc(DOC, './a%zz.png'),
    'attn://localhost/Users/me/notes/a%25zz.png',
    'undecodable segment is encoded as literal bytes',
  );
  assertEq(
    resolveImageSrc(DOC, './%.png'),
    'attn://localhost/Users/me/notes/%25.png',
    'lone percent',
  );
});

defineCase('19. characters mdurl leaves literal are escaped when they must be', () => {
  assertEq(
    resolveImageSrc(DOC, "./a(b)'c!.png"),
    "attn://localhost/Users/me/notes/a(b)'c!.png",
    'encodeURIComponent leaves these alone, and so does the handler',
  );
  assertEq(
    resolveImageSrc(DOC, './a&b=c,d.png'),
    'attn://localhost/Users/me/notes/a%26b%3Dc%2Cd.png',
    'sub-delims are escaped, which the handler decodes back',
  );
});

defineCase('20. a directory component carrying a space is encoded too', () => {
  assertEq(
    resolveImageSrc(DOC, './my%20dir/x.png'),
    'attn://localhost/Users/me/notes/my%20dir/x.png',
    'per-segment, not whole-path',
  );
});

defineCase('21. the DOCUMENT path is raw bytes and is encoded exactly once', () => {
  // docPath comes from the daemon, never from mdurl. Decoding it would read a
  // literal '%' in a directory name as an escape.
  assertEq(
    resolveImageSrc('/Users/me/100% notes/plan.md', './x.png'),
    'attn://localhost/Users/me/100%25%20notes/x.png',
    'document directory encoded once',
  );
  assertEq(
    resolveImageSrc('/Users/me/a%2Fb/plan.md', './x.png'),
    'attn://localhost/Users/me/a%252Fb/x.png',
    'a literal %2F in a directory name is not an escape',
  );
});

defineCase('22. the emitted URL always has exactly one slash after the host', () => {
  // Two would be parsed as a host, and the handler would never see the path.
  for (const src of ['./x.png', '/x.png', '../x.png', 'sub/x.png']) {
    const url = resolveImageSrc(DOC, src);
    assert(url !== null, `expected a URL for ${src}`);
    assert(url.startsWith('attn://localhost/'), `${src}: wrong prefix — ${url}`);
    assert(!url.startsWith('attn://localhost//'), `${src}: doubled slash — ${url}`);
  }
  return '4 shapes';
});

defineCase('23. a Windows drive letter is not mistaken for a URL scheme', () => {
  // Windows is not a supported host; the point is only that `C:/…` must not
  // fall into the scheme passthrough and must not climb above the drive.
  assertEq(
    resolveImageSrc(DOC, 'C:/shots/x.png'),
    'attn://localhost/C%3A/shots/x.png',
    'drive-rooted path',
  );
  assertEq(
    resolveImageSrc(DOC, 'C:/../../x.png'),
    'attn://localhost/C%3A/x.png',
    'pinned at the drive',
  );
});

defineCase('24. a backslash is an ordinary filename byte on POSIX', () => {
  // Unlike resolvePath(), this does NOT rewrite '\' to '/': the only paths it
  // emits are POSIX ones for the attn:// handler, where a backslash is a legal
  // name character and rewriting it would address the wrong file.
  assertEq(
    resolveImageSrc(DOC, './a\\b.png'),
    'attn://localhost/Users/me/notes/a%5Cb.png',
    'escaped, not split',
  );
});

// ---------------------------------------------------------------------------
// 3. attrs.src is never rewritten
// ---------------------------------------------------------------------------

defineCase('25. the resolver does not mutate the node it reads from', () => {
  const doc = markdownParser.parse('![a](./diagram.png)');
  assert(doc !== null, 'parser returned null');
  let image: PmNode | null = null;
  doc.descendants((node) => {
    if (image === null && node.type.name === 'image') image = node;
    return image === null;
  });
  assert(image !== null, 'no image node');
  const before = (image as PmNode).attrs.src as string;
  const resolved = resolveImageSrc(DOC, before);
  assert(resolved !== before, 'resolution should have produced a different string');
  assertEq((image as PmNode).attrs.src, './diagram.png', 'attrs.src untouched');
});

defineCase('26. relative srcs round-trip byte-for-byte through the serializer', () => {
  // Scoped to the forms that are exact TODAY. The angle-bracket, café, 100%
  // and paren spellings are lossy in prosemirror-markdown before this issue
  // exists; chasing them here would pin a bug in place.
  const exact = [
    '![a](./diagram.png)',
    '![a](diagram.png)',
    '![a](../up/diagram.png)',
    '![a](sub/diagram.png)',
    '![a](./my%20shot.png)',
    '![a](./weird#hash.png)',
    '![a](./q?uery.png)',
    '![a](./a%2Fb.png)',
    '![a](/Users/x/abs.png)',
    '![a](//cdn.example.com/x.png)',
    '![a](https://example.com/x.png)',
    '![a](data:image/png;base64,iVBORw0KGgo=)',
    '![a](attn://localhost/Users/x/abs.png)',
  ];
  for (const md of exact) {
    const doc = markdownParser.parse(md);
    assert(doc !== null, 'parser returned null');
    assertEq(markdownSerializer.serialize(doc), md, `round-trip ${md}`);
  }
  return `${exact.length} forms`;
});

defineCase('27. resolution is a pure function of (docPath, src)', () => {
  const a = resolveImageSrc(DOC, './x.png');
  const b = resolveImageSrc(DOC, './x.png');
  assertEq(a, b, 'same inputs, same output');
  assertEq(
    resolveImageSrc('/Users/me/other/plan.md', './x.png'),
    'attn://localhost/Users/me/other/x.png',
    'a different document moves the base directory',
  );
});

// ---------------------------------------------------------------------------

function runAllCases(): void {
  const results = cases.map((run) => run());
  for (const result of results) {
    console.log(
      `${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.detail ? ` — ${result.detail}` : ''}`,
    );
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} image-src cases passed.`);
  if (failed.length > 0) process.exit(1);
}

runAllCases();
