// Image NodeView: the DOM is resolved, the node is not (attn-cgev).
//
// Run with:
//
//   cd web && npx tsx src/lib/prosemirror/image-nodeview.test.ts
//
// The NodeView reaches for the global `document`, as every NodeView in this
// directory does, so `withFakeDocument` swaps in the stub from
// components/ui/accordion/fake-dom.ts and the REAL `imageNodeView` runs
// against it. Two things are being proved:
//
//   1. `<img src>` carries the RESOLVED url while `node.attrs.src` keeps the
//      authored string. `image` has no serializer override in schema.ts, so
//      prosemirror-markdown writes `attrs.src` verbatim on save — a NodeView
//      that "helpfully" normalised it would rewrite the user's file.
//
//   2. The failure state is the document's own, not the platform's broken
//      image glyph: alt text plus a filename, gated on the <img>'s own error
//      event so a slow load is never mistaken for a missing file.
//
// A third group reads the two wiring sites as source text. Both are silent
// failures — the images simply resolve against the wrong directory, with no
// error anywhere — and neither is reachable from a NodeView unit test, so the
// source is the only thing left to hold them to.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { markdownParser } from '../schema';
import type { Node as PmNode } from 'prosemirror-model';
import type { DecorationSource } from 'prosemirror-view';
import { FakeElement, withFakeDocument } from '../components/ui/accordion/fake-dom';
import { resolveImageSrc } from '../markdown-layer';
import { imageFileName, imageNodeView } from './image-nodeview';

// ---------------------------------------------------------------------------
// Tiny harness (mirrors frontmatter-nodeview.test.ts)
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

const DOC = '/Users/me/notes/plan.md';

/** `update()` takes decoration arguments this view never reads. Passing an
 *  empty stand-in keeps the calls honest to the interface without building a
 *  DecorationSet the assertions would ignore. */
const NO_INNER_DECORATIONS = [] as unknown as DecorationSource;

function imageNode(md: string): PmNode {
  const doc = markdownParser.parse(md);
  assert(doc !== null, 'parser returned null');
  let found: PmNode | null = null;
  doc.descendants((node) => {
    if (found === null && node.type.name === 'image') found = node;
    return found === null;
  });
  assert(found !== null, `no image node in ${JSON.stringify(md)}`);
  return found as PmNode;
}

/** Build the view against the fake DOM and hand back the pieces every case
 *  wants: the wrapper, the <img>, and the placeholder subtree. */
const NATIVE_RESOLVER = (src: string) => resolveImageSrc(DOC, src);

/** `'none'` stands for the prop being omitted — passing `undefined` through a
 *  default parameter would silently reinstate the default resolver. */
function mount(node: PmNode, resolve: ((src: string) => string | null) | 'none' = NATIVE_RESOLVER) {
  const view = imageNodeView(node, resolve === 'none' ? undefined : resolve);
  const dom = view.dom as unknown as FakeElement;
  const img = dom.findAll('img')[0];
  assert(img !== undefined, 'no <img> in the view');
  const fallback = dom.findByClass('md-image-fallback')[0];
  assert(fallback !== undefined, 'no placeholder in the view');
  return { view, dom, img, fallback };
}

// ---------------------------------------------------------------------------
// 1. Resolved DOM, untouched node
// ---------------------------------------------------------------------------

defineCase('1. the DOM gets the resolved src', () =>
  withFakeDocument(() => {
    const node = imageNode('![A diagram](./diagram.png)');
    const { img } = mount(node);
    assertEq(
      img.getAttribute('src'),
      'attn://localhost/Users/me/notes/diagram.png',
      'displayed src',
    );
    assertEq(img.getAttribute('alt'), 'A diagram', 'alt is carried through');
  }),
);

defineCase('2. node.attrs.src is never written', () =>
  withFakeDocument(() => {
    const node = imageNode('![A diagram](./diagram.png)');
    const { view } = mount(node);
    assertEq(node.attrs.src, './diagram.png', 'attrs.src after construction');
    view.update?.(node, [], NO_INNER_DECORATIONS);
    assertEq(node.attrs.src, './diagram.png', 'attrs.src after update');
    // Also exposed on the wrapper, so automation can see what the resolver
    // was handed without reaching into ProseMirror state.
    const dom = view.dom as unknown as FakeElement;
    assertEq(dom.getAttribute('data-src'), './diagram.png', 'data-src is the authored string');
  }),
);

defineCase('3. with no resolver the authored src is used verbatim', () =>
  withFakeDocument(() => {
    // The hosted app and the reviewer-snapshot editor mount the view with no
    // resolver (cases 19 and 21). They get the card on failure but must never
    // get a URL nobody asked for, so "no resolver" has to mean "do nothing".
    const { img } = mount(imageNode('![a](./diagram.png)'), 'none');
    assertEq(img.getAttribute('src'), './diagram.png', 'unchanged');
  }),
);

defineCase('4. a src the resolver declines falls back to the authored string', () =>
  withFakeDocument(() => {
    const { img } = mount(imageNode('![a](./diagram.png)'), () => null);
    assertEq(img.getAttribute('src'), './diagram.png', 'null means "leave it alone"');
  }),
);

defineCase('5. absolute URLs reach the DOM untouched', () =>
  withFakeDocument(() => {
    const { img } = mount(imageNode('![a](https://example.com/x.png)'));
    assertEq(img.getAttribute('src'), 'https://example.com/x.png', 'passthrough');
  }),
);

defineCase('6. update() re-resolves when the src changes and rejects other types', () =>
  withFakeDocument(() => {
    const node = imageNode('![a](./diagram.png)');
    const { view, img } = mount(node);
    const moved = imageNode('![a](./nested/diagram.png)');
    assertEq(view.update?.(moved, [], NO_INNER_DECORATIONS), true, 'same type updates in place');
    assertEq(
      img.getAttribute('src'),
      'attn://localhost/Users/me/notes/nested/diagram.png',
      're-resolved',
    );
    const paragraph = markdownParser.parse('hello')?.firstChild;
    assert(paragraph !== null && paragraph !== undefined, 'no paragraph');
    assertEq(view.update?.(paragraph, [], NO_INNER_DECORATIONS), false, 'a different node type is rejected');
  }),
);

defineCase('7. an unchanged src is not re-written to the DOM', () =>
  withFakeDocument(() => {
    // Re-setting an identical src may not re-fire `load`, so clearing the
    // state flags on every update would strand a healthy image with neither
    // data-loaded nor data-broken set.
    const node = imageNode('![a](./diagram.png)');
    const { view, img, dom } = mount(node);
    img.fire('load');
    assertEq(dom.getAttribute('data-loaded'), 'true', 'loaded after the load event');
    view.update?.(node, [], NO_INNER_DECORATIONS);
    assertEq(dom.getAttribute('data-loaded'), 'true', 'still loaded after a no-op update');
  }),
);

// ---------------------------------------------------------------------------
// 2. The failure state
// ---------------------------------------------------------------------------

defineCase('8. the placeholder stays out of the way until the image fails', () =>
  withFakeDocument(() => {
    const { dom, img } = mount(imageNode('![A diagram that moved](./gone.png)'));
    assertEq(dom.getAttribute('data-broken'), null, 'not broken before the error fires');
    assertEq(img.getAttribute('hidden'), null, 'the img is visible while it loads');
    img.fire('error');
    assertEq(dom.getAttribute('data-broken'), 'true', 'broken after the error');
    assertEq(img.getAttribute('hidden'), '', 'the broken glyph is hidden');
    assertEq(dom.getAttribute('data-loaded'), null, 'not loaded');
  }),
);

defineCase('9. the placeholder carries the alt text and the filename', () =>
  withFakeDocument(() => {
    const { dom, img } = mount(imageNode('![A diagram that moved](./sub/gone%20away.png)'));
    img.fire('error');
    const alt = dom.findByClass('md-image-fallback-alt')[0];
    const name = dom.findByClass('md-image-fallback-name')[0];
    const label = dom.findByClass('md-image-fallback-label')[0];
    assert(alt !== undefined && name !== undefined && label !== undefined, 'placeholder parts');
    assertEq(alt.textContent, 'A diagram that moved', 'alt text');
    assertEq(name.textContent, 'gone away.png', 'filename, decoded for reading');
    // What the app observed, not a diagnosis: `error` also fires for a file
    // that is present but served with a MIME the webview will not decode.
    assertEq(label.textContent, 'Image didn’t load', 'label');
    assertEq(alt.getAttribute('hidden'), null, 'the alt line is shown when there is alt text');
  }),
);

defineCase('10. an image with no alt text hides the alt line rather than showing an empty one', () =>
  withFakeDocument(() => {
    const { dom, img } = mount(imageNode('![](./gone.png)'));
    img.fire('error');
    const alt = dom.findByClass('md-image-fallback-alt')[0];
    assert(alt !== undefined, 'no alt line');
    assertEq(alt.textContent, '', 'empty');
    assertEq(alt.getAttribute('hidden'), '', 'hidden');
  }),
);

defineCase('11. a recovered src clears the broken state', () =>
  withFakeDocument(() => {
    const node = imageNode('![a](./gone.png)');
    const { view, dom, img } = mount(node);
    img.fire('error');
    assertEq(dom.getAttribute('data-broken'), 'true', 'broken');
    view.update?.(imageNode('![a](./diagram.png)'), [], NO_INNER_DECORATIONS);
    assertEq(dom.getAttribute('data-broken'), null, 'a new src re-arms the view');
    assertEq(img.getAttribute('hidden'), null, 'the img is shown again');
  }),
);

defineCase('12. destroy() leaves no listeners behind, and is idempotent', () =>
  withFakeDocument(() => {
    const { view, dom } = mount(imageNode('![a](./diagram.png)'));
    const live = dom.listenerCount();
    assert(live > 0, 'expected load/error listeners while alive');
    view.destroy?.();
    assertEq(dom.listenerCount(), 0, 'destroy() left nothing behind');
    view.destroy?.();
    assertEq(dom.listenerCount(), 0, 'destroy() is idempotent');
    return `${live} listeners while alive, 0 after destroy`;
  }),
);

defineCase('13. no stopEvent and no ignoreMutation', () =>
  withFakeDocument(() => {
    // The image node is draggable and an inline leaf: swallowing events would
    // kill click-to-NodeSelection and with it keyboard deletion. A NodeView
    // with no contentDOM already ignores its own mutations by default.
    const { view } = mount(imageNode('![a](./diagram.png)'));
    assertEq(view.stopEvent, undefined, 'stopEvent must stay unset');
    assertEq(view.ignoreMutation, undefined, 'ignoreMutation must stay unset');
    assertEq(view.contentDOM, undefined, 'an image is a leaf');
  }),
);

defineCase('14. imageFileName reads the last segment of any src shape', () => {
  assertEq(imageFileName('./sub/a%20b.png'), 'a b.png', 'decoded');
  assertEq(imageFileName('diagram.png'), 'diagram.png', 'bare');
  assertEq(imageFileName('https://example.com/a/b.png'), 'b.png', 'remote');
  assertEq(imageFileName('./a%zz.png'), 'a%zz.png', 'undecodable falls back to raw');
  assertEq(imageFileName(''), '', 'empty');
  assertEq(imageFileName('/'), '/', 'nothing to name');
});

defineCase('15. an image with no alt text leaves the attribute off, as the stock spec does', () =>
  withFakeDocument(() => {
    // prosemirror-markdown declares `alt: { default: null }` and DOMSerializer
    // drops null attributes, so `![](x.png)` has never emitted an `alt`.
    // `alt=""` would say "decorative", which markdown cannot express and this
    // form does not mean.
    const { img } = mount(imageNode('![](./diagram.png)'));
    assertEq(img.getAttribute('alt'), null, 'no alt attribute at all');
    const withAlt = mount(imageNode('![A diagram](./diagram.png)'));
    assertEq(withAlt.img.getAttribute('alt'), 'A diagram', 'still set when there is one');
  }),
);

defineCase('16. the placeholder is announced as one image, not three loose runs', () =>
  withFakeDocument(() => {
    const { dom, fallback } = mount(imageNode('![A diagram that moved](./gone.png "Figure 3")'));
    assertEq(fallback.getAttribute('role'), 'img', 'the card is an image to assistive tech');
    assertEq(
      fallback.getAttribute('aria-label'),
      'Image didn\u2019t load. A diagram that moved. Figure 3. gone.png',
      'one composed announcement',
    );
    // The markdown title otherwise dies on the hidden <img>, in the one state
    // where that author-supplied context is worth most.
    assertEq(fallback.getAttribute('title'), 'Figure 3', 'the title survives the broken state');
    for (const cls of ['md-image-fallback-label', 'md-image-fallback-alt', 'md-image-fallback-name']) {
      const part = dom.findByClass(cls)[0];
      assert(part !== undefined, `missing ${cls}`);
      assertEq(part.getAttribute('aria-hidden'), 'true', `${cls} must not be double-read`);
    }
  }),
);

defineCase('17. an image with no alt still announces what happened', () =>
  withFakeDocument(() => {
    // `![](x.png)` is "the author wrote no alt text", not "decorative" — see
    // case 15 — so the card is not hidden from assistive tech either.
    const { fallback } = mount(imageNode('![](./gone.png)'));
    assertEq(fallback.getAttribute('aria-hidden'), null, 'not hidden from the a11y tree');
    assertEq(
      fallback.getAttribute('aria-label'),
      'Image didn\u2019t load. gone.png',
      'label and filename, no empty run between them',
    );
  }),
);

defineCase('18. update() re-composes the announcement', () =>
  withFakeDocument(() => {
    const node = imageNode('![before](./gone.png)');
    const { view, fallback } = mount(node);
    view.update?.(imageNode('![after](./also-gone.png "T")'), [], NO_INNER_DECORATIONS);
    assertEq(
      fallback.getAttribute('aria-label'),
      'Image didn\u2019t load. after. T. also-gone.png',
      'recomposed from the new node',
    );
  }),
);

// ---------------------------------------------------------------------------
// 3. The wiring that keeps a NodeView bound to the RIGHT directory
// ---------------------------------------------------------------------------

const libDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (rel: string): string => fs.readFileSync(path.join(libDir, rel), 'utf8');

defineCase("19. Editor's nodeView reactor tracks resolveAssetUrl", () => {
  // buildNodeViews() hands back fresh closures on every call, so ProseMirror's
  // identity comparison redraws as soon as the effect re-runs — but the effect
  // only re-runs for props it actually reads. Without this the images keep the
  // previous file's base directory and fail silently.
  const editor = read('Editor.svelte');
  const reactor = /React to injected plugins\/nodeViews[\s\S]*?\n  \}\);/.exec(editor);
  assert(reactor !== null, 'could not find the nodeView reactor effect in Editor.svelte');
  assert(
    /void resolveAssetUrl;/.test(reactor[0]),
    'the nodeView reactor must touch `resolveAssetUrl` so switching tabs rebuilds the image views',
  );
  // Unconditional: a surface with no resolver still gets the placeholder card
  // rather than the platform's broken-image glyph. A conditional here would
  // silently strand the hosted app on the stock `toDOM`.
  assert(
    /^\s*image: \(node: PmNode\) => imageNodeView\(node, resolveAssetUrl\),$/m.test(editor),
    'buildNodeViews() must register the image NodeView on every surface',
  );
  assert(
    !/resolveAssetUrl \? \{ image:/.test(editor),
    'the image NodeView must not be registered conditionally',
  );
});

defineCase('20. App passes a resolver whose identity actually changes', () => {
  // The trap this pins: `$derived((src) => resolveImageSrc(activePath, src))`
  // reads nothing while the derived evaluates, so it never recomputes and the
  // prop keeps one identity for the life of the editor. Reading the path
  // eagerly inside `$derived.by` is what makes the dependency real.
  const app = read('../App.svelte');
  const derived = /let resolveActiveAssetUrl = \$derived\.by\(\(\) => \{([\s\S]*?)\}\);/.exec(app);
  assert(derived !== null, 'App.svelte must build the resolver with $derived.by');
  assert(
    /const docPath = activePath;/.test(derived[1]),
    'the active path must be read while the derived evaluates, not only inside the closure',
  );
});

defineCase('21. the reviewer snapshot editor is left unresolved', () => {
  // That editor renders the OWNER's document; its relative srcs name files on
  // the owner's disk. Resolving them would mint a convincing attn:// URL for a
  // file that is not on this machine — worse than the authored src. It still
  // MOUNTS the view (registration is unconditional), so an unloadable src
  // there gets the card; what it must not have is a resolver.
  const app = read('../App.svelte');
  const bound = app.match(/resolveAssetUrl=\{resolveActiveAssetUrl\}/g) ?? [];
  assertEq(bound.length, 2, 'exactly the local markdown editor and the editor-only diagnostic');
  // Anchored on `<Editor`, not on the first `/>` after the branch opener: the
  // non-greedy form stopped at `<ReviewFileNav />` 436 characters in, so the
  // fragment it checked could never have contained the prop and the case
  // passed on a technicality.
  const snapshotEditor = /\{:else if isReviewerViewingSnapshot\}[\s\S]*?<Editor\b[\s\S]*?\/>/.exec(app);
  assert(snapshotEditor !== null, 'could not find the reviewer-snapshot editor');
  assert(/<Editor\b/.test(snapshotEditor[0]), 'the capture must reach the Editor tag itself');
  assert(
    !/resolveAssetUrl/.test(snapshotEditor[0]),
    'the reviewer-snapshot editor must not resolve against a local path',
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
  console.log(`\n${results.length - failed.length}/${results.length} image NodeView cases passed.`);
  if (failed.length > 0) process.exit(1);
}

runAllCases();
