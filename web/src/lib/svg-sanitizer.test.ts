// Direct unit tests for the embedded-SVG sanitiser (attn-vlmz.4.2).
//
// These are adversarial, not happy-path: every case below is a real published
// SVG XSS or exfiltration payload shape. The corpus is enumerated in
// planning/embedded-svg-threat-model.md §6 — keep the two in step.
//
// Run with:
//
//   cd web && npx tsx src/lib/svg-sanitizer.test.ts
//
// The harness matches the other web tests (defineCase/runAllCases, no vitest);
// the sanitiser is deliberately DOM-free so it runs under bare Node + tsx.

import { readFileSync } from 'node:fs';
import {
  decodeEntities,
  isAllowedAttribute,
  isAllowedElement,
  sanitizeSvg,
  type SanitizedElement,
  type SanitizedNode,
} from './svg-sanitizer';

// ---------------------------------------------------------------------------
// Tiny harness
// ---------------------------------------------------------------------------

interface CaseResult {
  name: string;
  ok: boolean;
  detail?: string;
}

const cases: Array<() => Promise<CaseResult> | CaseResult> = [];

function defineCase(name: string, fn: () => void | string | Promise<void | string>): void {
  cases.push(async () => {
    try {
      const note = await fn();
      return { name, ok: true, detail: typeof note === 'string' ? note : undefined };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { name, ok: false, detail: message };
    }
  });
}

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

// ---------------------------------------------------------------------------
// Assertions over the sanitised tree
// ---------------------------------------------------------------------------

const PREFIX = 'T-';

function clean(source: string): SanitizedElement {
  const result = sanitizeSvg(source, { idPrefix: PREFIX });
  assert(result.ok, `expected the block to survive, got rejection: ${result.ok ? '' : result.reason}`);
  return result.root;
}

function rejection(source: string): string {
  const result = sanitizeSvg(source, { idPrefix: PREFIX });
  assert(!result.ok, 'expected the block to be rejected outright, but it survived');
  return result.reason;
}

function walk(node: SanitizedNode, visit: (n: SanitizedNode) => void): void {
  visit(node);
  if (node.kind === 'element') for (const child of node.children) walk(child, visit);
}

function tags(root: SanitizedElement): string[] {
  const out: string[] = [];
  walk(root, (n) => {
    if (n.kind === 'element') out.push(n.tag);
  });
  return out;
}

function attrNames(root: SanitizedElement): string[] {
  const out: string[] = [];
  walk(root, (n) => {
    if (n.kind === 'element') for (const a of n.attrs) out.push(a.name);
  });
  return out;
}

/** Every attribute value anywhere in the tree, plus all text content. */
function allValues(root: SanitizedElement): string[] {
  const out: string[] = [];
  walk(root, (n) => {
    if (n.kind === 'element') for (const a of n.attrs) out.push(a.value);
    else out.push(n.text);
  });
  return out;
}

function assertNoTag(root: SanitizedElement, tag: string): void {
  assert(!tags(root).includes(tag), `<${tag}> survived sanitisation`);
}

function assertNoAttr(root: SanitizedElement, name: string): void {
  assert(!attrNames(root).includes(name), `attribute '${name}' survived sanitisation`);
}

function assertNoValueContaining(root: SanitizedElement, needle: string): void {
  const hit = allValues(root).find((v) => v.toLowerCase().includes(needle.toLowerCase()));
  assert(hit === undefined, `value containing '${needle}' survived: ${JSON.stringify(hit)}`);
}

// ---------------------------------------------------------------------------
// 1. Script execution
// ---------------------------------------------------------------------------

defineCase('<script> is dropped with its subtree', () => {
  const root = clean('<svg><script>alert(1)</script><rect/></svg>');
  assertNoTag(root, 'script');
  assertNoValueContaining(root, 'alert');
  assert(tags(root).includes('rect'), 'the sibling <rect> should still render');
});

defineCase('<SCRIPT> and <ScRiPt> are dropped (exact, case-sensitive matching)', () => {
  for (const variant of ['SCRIPT', 'ScRiPt', 'Script']) {
    const root = clean(`<svg><${variant}>alert(1)</${variant}></svg>`);
    assertNoTag(root, variant);
    assert(tags(root).length === 1, `only <svg> should remain, got ${tags(root).join(',')}`);
  }
});

defineCase('script content containing < rejects the whole block (fail closed)', () => {
  // The tokenizer is XML-strict, so `1<2` inside a script is unparseable. That
  // must reject rather than resynchronise on a guess.
  rejection('<svg><script>if(1<2)alert(1)</script></svg>');
});

defineCase('on* handlers are dropped in every casing', () => {
  const root = clean(
    '<svg onload="alert(1)" onLoad="alert(2)" ONLOAD="alert(3)">' +
      '<rect onclick="alert(4)" onerror="alert(5)" onbegin="alert(6)" fill="red"/>' +
      '</svg>',
  );
  for (const name of ['onload', 'onLoad', 'ONLOAD', 'onclick', 'onerror', 'onbegin']) {
    assertNoAttr(root, name);
  }
  assertNoValueContaining(root, 'alert');
  assert(attrNames(root).includes('fill'), 'the legitimate fill attribute should survive');
});

defineCase('<handler> and SVG 1.2 event elements are dropped', () => {
  const root = clean('<svg><handler type="text/ecmascript">alert(1)</handler></svg>');
  assertNoTag(root, 'handler');
});

// ---------------------------------------------------------------------------
// 2. URL schemes
// ---------------------------------------------------------------------------

defineCase('javascript: in xlink:href is dropped (<a> itself is not allowlisted)', () => {
  const root = clean('<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>');
  assertNoTag(root, 'a');
  assertNoValueContaining(root, 'javascript:');
});

defineCase('javascript: on <use> href is dropped, element kept', () => {
  const root = clean('<svg><use href="javascript:alert(1)"/></svg>');
  assert(tags(root).includes('use'), '<use> is allowlisted and should remain');
  assertNoAttr(root, 'href');
  assertNoValueContaining(root, 'javascript:');
});

defineCase('numeric-entity obfuscated javascript: is caught after decoding', () => {
  // &#106; is 'j' — the check must run on the DECODED value.
  const root = clean('<svg><use href="&#106;avascript:alert(1)"/></svg>');
  assertNoAttr(root, 'href');
  assertNoValueContaining(root, 'javascript:');
});

defineCase('hex-entity obfuscated javascript: is caught after decoding', () => {
  const root = clean('<svg><use xlink:href="&#x6a;avascript:alert(1)"/></svg>');
  assertNoAttr(root, 'xlink:href');
  assertNoValueContaining(root, 'javascript:');
});

defineCase('tab/newline obfuscated java\\tscript: is caught after normalisation', () => {
  const root = clean('<svg><use href="java\tscript\n:alert(1)"/></svg>');
  assertNoAttr(root, 'href');
});

defineCase('leading-whitespace javascript: is caught', () => {
  const root = clean('<svg><use href="   javascript:alert(1)"/></svg>');
  assertNoAttr(root, 'href');
});

defineCase('data:text/html and data:image/svg+xml hrefs are dropped', () => {
  for (const url of [
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'data:image/svg+xml;base64,PHN2Zz48c2NyaXB0PmFsZXJ0KDEpPC9zY3JpcHQ+PC9zdmc+',
  ]) {
    const root = clean(`<svg><use href="${url}"/></svg>`);
    assertNoAttr(root, 'href');
    assertNoValueContaining(root, 'data:');
  }
});

defineCase('<use href="http://…"> external reference is dropped', () => {
  const root = clean('<svg><use href="http://evil.example/x.svg#a"/></svg>');
  assertNoAttr(root, 'href');
  assertNoValueContaining(root, 'evil.example');
});

defineCase('protocol-relative //evil href is dropped', () => {
  const root = clean('<svg><use xlink:href="//evil.example/x.svg#a"/></svg>');
  assertNoAttr(root, 'xlink:href');
});

defineCase('a same-document #fragment href survives, id-prefixed', () => {
  const root = clean('<svg><defs><rect id="box"/></defs><use href="#box"/></svg>');
  const values = allValues(root);
  assert(values.includes(`${PREFIX}box`), `expected the prefixed id, got ${values.join(',')}`);
  assert(values.includes(`#${PREFIX}box`), `expected the prefixed ref, got ${values.join(',')}`);
});

// ---------------------------------------------------------------------------
// 3. HTML re-entry
// ---------------------------------------------------------------------------

defineCase('<foreignObject> is dropped with its entire HTML subtree', () => {
  const root = clean(
    '<svg><foreignObject width="100" height="100">' +
      '<body onload="alert(1)"><img src="x" onerror="alert(2)"/></body>' +
      '</foreignObject><circle r="5"/></svg>',
  );
  assertNoTag(root, 'foreignObject');
  assertNoTag(root, 'body');
  assertNoTag(root, 'img');
  assertNoValueContaining(root, 'alert');
  assert(tags(root).includes('circle'), 'the sibling <circle> should still render');
});

defineCase('<image> is dropped (fragment-only URLs leave it nothing to load)', () => {
  const root = clean('<svg><image href="http://evil.example/p.png" onerror="alert(1)"/></svg>');
  assertNoTag(root, 'image');
  assertNoValueContaining(root, 'evil.example');
});

// ---------------------------------------------------------------------------
// 4. External entities / DTD / XML constructs
// ---------------------------------------------------------------------------

defineCase('XXE: DOCTYPE with an external ENTITY rejects the block', () => {
  const reason = rejection(
    '<svg><!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><text>&xxe;</text></svg>',
  );
  assert(/DTD|DOCTYPE|CDATA/i.test(reason), `unexpected rejection reason: ${reason}`);
});

defineCase('billion laughs entity expansion rejects the block', () => {
  const reason = rejection(
    '<svg><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]>' +
      '<text>&lol2;</text></svg>',
  );
  assert(/DTD|DOCTYPE|CDATA/i.test(reason), `unexpected rejection reason: ${reason}`);
});

defineCase('an undefined named entity rejects the block', () => {
  const reason = rejection('<svg><text>&xxe;</text></svg>');
  assert(/unknown entity/i.test(reason), `unexpected rejection reason: ${reason}`);
});

defineCase('CDATA sections reject the block', () => {
  rejection('<svg><text><![CDATA[<script>alert(1)</script>]]></text></svg>');
});

defineCase('processing instructions reject the block', () => {
  const reason = rejection('<svg><?xml-stylesheet href="http://evil.example/x.xsl"?><rect/></svg>');
  assert(/processing instruction/i.test(reason), `unexpected rejection reason: ${reason}`);
});

defineCase('the five XML predefined entities decode, and only those', () => {
  assert(decodeEntities('&amp;&lt;&gt;&quot;&apos;') === '&<>"\'', 'predefined entities must decode');
  assert(decodeEntities('&#65;&#x42;') === 'AB', 'numeric references must decode');
});

defineCase('decoded &lt;script&gt; stays literal text, never an element', () => {
  const root = clean('<svg><text>&lt;script&gt;alert(1)&lt;/script&gt;</text></svg>');
  assertNoTag(root, 'script');
  const texts = allValues(root).filter((v) => v.includes('script'));
  assert(texts.length === 1 && texts[0] === '<script>alert(1)</script>', `unexpected text: ${texts.join('|')}`);
  // It is a TEXT node — the renderer emits it via createTextNode, so it can
  // never become markup.
});

// ---------------------------------------------------------------------------
// 5. CSS
// ---------------------------------------------------------------------------

defineCase('<style> inside SVG is dropped (it is not scoped to the SVG)', () => {
  const root = clean('<svg><style>* { display: none }</style><rect/></svg>');
  assertNoTag(root, 'style');
  assert(tags(root).includes('rect'), 'the sibling <rect> should still render');
});

defineCase('<style>@import url(…)</style> is dropped', () => {
  const root = clean('<svg><style>@import url("http://evil.example/x.css");</style></svg>');
  assertNoTag(root, 'style');
  assertNoValueContaining(root, 'evil.example');
});

defineCase('style="width:expression(alert(1))" is dropped', () => {
  const root = clean('<svg><rect style="width:expression(alert(1))"/></svg>');
  assertNoAttr(root, 'style');
  assertNoValueContaining(root, 'expression(');
});

defineCase('style with url(javascript:…) is dropped', () => {
  const root = clean('<svg><rect style="fill:url(javascript:alert(1))"/></svg>');
  assertNoAttr(root, 'style');
  assertNoValueContaining(root, 'javascript:');
});

defineCase('style with an external url() is dropped', () => {
  const root = clean('<svg><rect style="fill:url(http://evil.example/track.png)"/></svg>');
  assertNoAttr(root, 'style');
  assertNoValueContaining(root, 'evil.example');
});

defineCase('style with -moz-binding is dropped', () => {
  const root = clean('<svg><rect style="-moz-binding:url(http://evil.example/x.xml#e)"/></svg>');
  assertNoAttr(root, 'style');
});

defineCase('style comments and backslash escapes are refused', () => {
  const root = clean('<svg><rect style="fi/*x*/ll:red"/></svg>');
  assertNoAttr(root, 'style');
  const root2 = clean('<svg><rect style="fill:\\72 ed"/></svg>');
  assertNoAttr(root2, 'style');
});

defineCase('style var() is refused (it would resolve app custom properties)', () => {
  const root = clean('<svg><rect style="fill:var(--destructive)"/></svg>');
  assertNoAttr(root, 'style');
});

defineCase('a benign style survives, rebuilt from surviving declarations only', () => {
  const root = clean('<svg><rect style="fill: red; behavior: url(#x); stroke:#00ff00"/></svg>');
  const style = allValues(root).find((v) => v.includes('fill'));
  assert(style === 'fill: red; stroke: #00ff00', `unexpected rebuilt style: ${JSON.stringify(style)}`);
});

defineCase('style url(#id) is kept and id-prefixed', () => {
  const root = clean('<svg><rect style="fill:url(#grad)"/></svg>');
  const style = allValues(root).find((v) => v.includes('url('));
  assert(style === `fill: url(#${PREFIX}grad)`, `unexpected style: ${JSON.stringify(style)}`);
});

// ---------------------------------------------------------------------------
// 6. SMIL
// ---------------------------------------------------------------------------

defineCase('<animate> animating href into javascript: is dropped', () => {
  const root = clean(
    '<svg><use href="#a"><animate attributeName="href" to="javascript:alert(1)" begin="0s"/></use></svg>',
  );
  assertNoTag(root, 'animate');
  assertNoValueContaining(root, 'javascript:');
});

defineCase('<set> and <animateTransform> are dropped', () => {
  const root = clean(
    '<svg><rect><set attributeName="onload" to="alert(1)"/>' +
      '<animateTransform attributeName="transform" type="rotate"/></rect></svg>',
  );
  assertNoTag(root, 'set');
  assertNoTag(root, 'animateTransform');
  assertNoValueContaining(root, 'alert');
});

// ---------------------------------------------------------------------------
// 7. Spoofing / clobbering
// ---------------------------------------------------------------------------

defineCase('class is dropped (a document must not borrow app CSS)', () => {
  const root = clean('<svg><rect class="review-accept-button"/></svg>');
  assertNoAttr(root, 'class');
});

defineCase('xmlns is dropped — namespace is chosen at construction time', () => {
  const root = clean('<svg xmlns="http://www.w3.org/1999/xhtml" xmlns:xlink="http://www.w3.org/1999/xlink"><rect/></svg>');
  assertNoAttr(root, 'xmlns');
  assertNoAttr(root, 'xmlns:xlink');
});

defineCase('aria-* and role are dropped (no lying to a screen reader)', () => {
  const root = clean('<svg><rect role="button" aria-label="Accept all suggestions"/></svg>');
  assertNoAttr(root, 'role');
  assertNoAttr(root, 'aria-label');
});

defineCase('ids from two SVGs do not collide', () => {
  const source = '<svg><defs><linearGradient id="g"/></defs><rect fill="url(#g)"/></svg>';
  const a = sanitizeSvg(source, { idPrefix: 'a-' });
  const b = sanitizeSvg(source, { idPrefix: 'b-' });
  assert(a.ok && b.ok, 'both should sanitise');
  assert(allValues(a.root).includes('a-g'), 'first SVG keeps its own prefix');
  assert(allValues(b.root).includes('b-g'), 'second SVG keeps its own prefix');
  assert(allValues(a.root).includes('url(#a-g)'), 'the fill reference follows the prefix');
});

defineCase('default id prefixes are unique per call', () => {
  const source = '<svg><rect id="x"/></svg>';
  const a = sanitizeSvg(source);
  const b = sanitizeSvg(source);
  assert(a.ok && b.ok, 'both should sanitise');
  const idA = allValues(a.root).find((v) => v.endsWith('x'));
  const idB = allValues(b.root).find((v) => v.endsWith('x'));
  assert(idA !== idB, `two renders reused the same id prefix: ${idA}`);
});

// ---------------------------------------------------------------------------
// 8. Tokenizer strictness
// ---------------------------------------------------------------------------

defineCase('comments are dropped, and comment-hidden markup does not resurface', () => {
  const root = clean('<svg><!-- <script>alert(1)</script> --><rect/></svg>');
  assertNoTag(root, 'script');
  assertNoValueContaining(root, 'alert');
  assert(tags(root).join(',') === 'svg,rect', `unexpected tree: ${tags(root).join(',')}`);
});

defineCase('an unterminated comment rejects the block', () => {
  rejection('<svg><!-- never closed <rect/></svg>');
});

defineCase('an unquoted attribute value rejects the block', () => {
  const reason = rejection('<svg><rect fill=red /></svg>');
  assert(/unquoted/i.test(reason), `unexpected rejection reason: ${reason}`);
});

defineCase('a valueless attribute rejects the block', () => {
  const reason = rejection('<svg><rect disabled/></svg>');
  assert(/no value/i.test(reason), `unexpected rejection reason: ${reason}`);
});

defineCase('a mismatched close tag rejects the block', () => {
  rejection('<svg><g><rect/></svg></g>');
});

defineCase('an unclosed element rejects the block', () => {
  rejection('<svg><g><rect/></svg>');
});

defineCase('trailing content after </svg> rejects the block', () => {
  const reason = rejection('<svg><rect/></svg><script>alert(1)</script>');
  assert(/trailing content/i.test(reason), `unexpected rejection reason: ${reason}`);
});

defineCase('control characters in a value reject the block', () => {
  rejection('<svg><rect fill="re d"/></svg>');
});

defineCase('nesting past the depth cap rejects the block', () => {
  const deep = '<svg>' + '<g>'.repeat(80) + '</g>'.repeat(80) + '</svg>';
  const reason = rejection(deep);
  assert(/nesting/i.test(reason), `unexpected rejection reason: ${reason}`);
});

defineCase('an oversized source rejects the block', () => {
  const reason = rejection('<svg>' + '<rect/>'.repeat(200_000) + '</svg>');
  assert(/exceeds|elements/i.test(reason), `unexpected rejection reason: ${reason}`);
});

defineCase('a nested <svg> is handled and its script still dropped', () => {
  const root = clean('<svg><svg><script>alert(1)</script><rect/></svg></svg>');
  assertNoTag(root, 'script');
  assert(tags(root).join(',') === 'svg,svg,rect', `unexpected tree: ${tags(root).join(',')}`);
});

// ---------------------------------------------------------------------------
// 9. Bypass classes raised in review (attn-vlmz.4.1 follow-up)
//
// Each of these targets a named class rather than a single payload. The common
// answer is deny-by-default: `parseElement` computes
// `const keep = ALLOWED_ELEMENTS.has(tag)` and returns null for anything else,
// so an unrecognised construct cannot survive by being incompletely cleaned —
// there is no cleaning step, only inclusion.
// ---------------------------------------------------------------------------

// -- mXSS: the design never serialises, so there is no second parse ----------

defineCase('mXSS: the module never emits markup — no innerHTML on the whole path', () => {
  // A structural regression guard, not a payload. mutation-XSS needs a
  // serialise→reparse round trip; this design has none, and this test fails the
  // build if anyone reintroduces one.
  const here = new URL('.', import.meta.url).pathname;
  for (const file of ['svg-sanitizer.ts', 'embedded-svg-view.ts']) {
    const src = readFileSync(`${here}${file}`, 'utf8');
    assert(!/\.\s*(inner|outer)HTML/.test(src), `${file} assigns or reads innerHTML/outerHTML`);
    assert(!/insertAdjacentHTML/.test(src), `${file} uses insertAdjacentHTML`);
    assert(!/document\s*\.\s*write/.test(src), `${file} uses document.write`);
  }
});

defineCase('mXSS: sanitizeSvg returns a tree, never a markup string', () => {
  const root = clean('<svg><rect fill="red"/></svg>');
  assert(typeof root === 'object' && root.kind === 'element', 'the result must be a data tree');
  assert(!('outerHTML' in (root as object)), 'the result must not be a DOM node either');
});

defineCase('mXSS: comment-swallowed close tag does not resurface an element', () => {
  // The classic shape: a comment that appears to close the current element and
  // smuggles markup after it. The comment is dropped whole; nothing re-parses.
  const root = clean('<svg><desc><!--</desc><img src="x" onerror="alert(1)"/>--></desc><rect/></svg>');
  assertNoTag(root, 'img');
  assertNoValueContaining(root, 'alert');
  assert(tags(root).join(',') === 'svg,desc,rect', `unexpected tree: ${tags(root).join(',')}`);
});

defineCase('mXSS: <style> smuggling an <img onerror> drops the whole subtree', () => {
  const root = clean('<svg><style><img src="x" onerror="alert(1)"/></style><rect/></svg>');
  assertNoTag(root, 'style');
  assertNoTag(root, 'img');
  assertNoValueContaining(root, 'alert');
});

// -- Namespace confusion -----------------------------------------------------

defineCase('namespace: <math><annotation-xml encoding="text/html"> is dropped', () => {
  const root = clean(
    '<svg><math><annotation-xml encoding="text/html">' +
      '<svg><rect onload="alert(1)"/></svg>' +
      '</annotation-xml></math><circle r="1"/></svg>',
  );
  assertNoTag(root, 'math');
  assertNoTag(root, 'annotation-xml');
  assertNoValueContaining(root, 'alert');
  assert(tags(root).join(',') === 'svg,circle', `unexpected tree: ${tags(root).join(',')}`);
});

defineCase('namespace: a prefixed foreign element like <html:script> is dropped', () => {
  const root = clean('<svg><html:script>alert(1)</html:script><rect/></svg>');
  assertNoTag(root, 'html:script');
  assertNoValueContaining(root, 'alert');
});

defineCase('namespace: xmlns cannot relabel the document — it is dropped', () => {
  // The renderer builds every node with createElementNS(SVG_NS, …), so the
  // namespace is chosen by us and a document-supplied one is never consulted.
  const root = clean('<svg xmlns="http://www.w3.org/1999/xhtml"><rect xmlns="http://www.w3.org/1998/Math/MathML"/></svg>');
  assertNoAttr(root, 'xmlns');
  assertNoValueContaining(root, 'xhtml');
  assertNoValueContaining(root, 'MathML');
});

defineCase('namespace: <foreignObject> re-entering HTML is dropped, not unwrapped', () => {
  // Dropping the SUBTREE (not unwrapping it) is the point: unwrapping would
  // promote the HTML children into the SVG.
  const root = clean('<svg><foreignObject><div><rect/></div></foreignObject></svg>');
  assertNoTag(root, 'foreignObject');
  assertNoTag(root, 'div');
  assert(tags(root).join(',') === 'svg', `nothing inside should be promoted: ${tags(root).join(',')}`);
});

// -- <use> / fragment references --------------------------------------------

defineCase('<use> cannot reach an app element id — every ref is prefixed', () => {
  const root = clean('<svg><use href="#app-root"/></svg>');
  const values = allValues(root);
  assert(
    values.includes(`#${PREFIX}app-root`),
    `the ref must be rewritten into the SVG's own id space, got ${values.join(',')}`,
  );
  assert(!values.includes('#app-root'), 'the raw app id must not survive');
});

defineCase('<use> cannot reach another SVG block — refs are rewritten unconditionally', () => {
  // The prefix is guessable (`attn-svg-<n>-`), which does not matter: the
  // rewrite is unconditional, so an attacker cannot express a foreign prefix.
  const root = sanitizeSvg('<svg><use href="#attn-svg-1-secret"/></svg>', { idPrefix: 'b-' });
  assert(root.ok, 'should sanitise');
  const values = allValues(root.root);
  assert(values.includes('#b-attn-svg-1-secret'), `expected a re-prefixed ref, got ${values.join(',')}`);
});

defineCase('<use> can only clone allowlisted content (there is no other kind)', () => {
  // Anything a <use> could target has itself already passed the allowlist, so a
  // reference cannot reach a construct we refused.
  const root = clean('<svg><defs><script id="s">alert(1)</script></defs><use href="#s"/></svg>');
  assertNoTag(root, 'script');
  assertNoValueContaining(root, 'alert');
  const ids = allValues(root).filter((v) => v.endsWith('s') && !v.startsWith('#'));
  assert(ids.length === 0, `the script's id must not have been registered: ${ids.join(',')}`);
});

defineCase('href is refused on elements other than <use>', () => {
  const root = clean('<svg><rect href="#x"/><circle xlink:href="#y"/></svg>');
  assertNoAttr(root, 'href');
  assertNoAttr(root, 'xlink:href');
});

// -- Animation rewriting a validated attribute -------------------------------

defineCase('<set attributeName="href" to="javascript:…"> is dropped', () => {
  const root = clean('<svg><use href="#a"><set attributeName="href" to="javascript:alert(1)"/></use></svg>');
  assertNoTag(root, 'set');
  assertNoValueContaining(root, 'javascript:');
});

defineCase('every SMIL element is dropped, so nothing can rewrite a checked value', () => {
  for (const el of ['animate', 'animateTransform', 'animateMotion', 'set', 'mpath', 'discard']) {
    const root = clean(`<svg><rect><${el} attributeName="href" to="javascript:alert(1)"/></rect></svg>`);
    assertNoTag(root, el);
    assertNoValueContaining(root, 'javascript:');
  }
});

// -- <style> reaching outside the SVG ---------------------------------------

defineCase('<style> with a selector reaching app chrome is dropped', () => {
  const root = clean(
    '<svg><style>body .review-accept { display: none } html { background: red }</style><rect/></svg>',
  );
  assertNoTag(root, 'style');
  assertNoValueContaining(root, 'review-accept');
});

defineCase('<style> is dropped even when it is the only child', () => {
  const root = clean('<svg><style>@import url("//evil.example/x.css");</style></svg>');
  assert(tags(root).join(',') === 'svg', `nothing should survive: ${tags(root).join(',')}`);
});

// -- <script> with a non-standard type ---------------------------------------

defineCase('<script> is dropped regardless of its type attribute', () => {
  // The ELEMENT NAME is what is matched, so type-based execution tricks
  // (`type="module"`, `type="text/plain"` that some engines still run, unknown
  // types) are irrelevant — none of them reach the DOM.
  for (const type of [
    'module',
    'text/plain',
    'application/javascript',
    'text/ecmascript',
    '',
    'text/x-anything',
  ]) {
    const root = clean(`<svg><script type="${type}">alert(1)</script><rect/></svg>`);
    assertNoTag(root, 'script');
    assertNoValueContaining(root, 'alert');
  }
});

// -- Deny-by-default, stated as a property -----------------------------------

defineCase('deny-by-default: no dangerous element name is allowlisted', () => {
  const forbidden = [
    'script', 'foreignObject', 'style', 'a', 'image', 'iframe', 'embed', 'object',
    'animate', 'animateTransform', 'animateMotion', 'set', 'mpath', 'discard',
    'handler', 'listener', 'switch', 'metadata', 'filter', 'feImage', 'feFlood',
    'math', 'annotation-xml', 'body', 'div', 'img', 'form', 'input', 'audio', 'video',
  ];
  for (const tag of forbidden) {
    assert(!isAllowedElement(tag), `<${tag}> must not be allowlisted`);
  }
});

defineCase('deny-by-default: an invented element and attribute are refused', () => {
  // Nothing has to be enumerated for this to hold — inclusion is the only way in.
  assert(!isAllowedElement('totallyNewSvgThing'), 'unknown elements must be refused');
  assert(!isAllowedAttribute('rect', 'totallyNewAttr'), 'unknown attributes must be refused');
  assert(!isAllowedAttribute('rect', 'onanything'), 'on* must be refused');
  assert(isAllowedAttribute('use', 'href'), 'href is allowed on <use>');
  assert(!isAllowedAttribute('rect', 'href'), 'href is refused elsewhere');
});

// ---------------------------------------------------------------------------
// 10. Legitimate content still renders
// ---------------------------------------------------------------------------

defineCase("the bug reporter's preserveAspectRatio SVG survives intact", () => {
  const root = clean(
    '<svg preserveAspectRatio="xMinYMin meet" viewBox="0 0 640 360" ' +
      'xmlns="http://www.w3.org/2000/svg">' +
      '<rect x="0" y="0" width="640" height="360" fill="#f5f0e8"/>' +
      '<text x="320" y="180" text-anchor="middle" font-size="24" fill="#2b2b2b">attn</text>' +
      '</svg>',
  );
  const names = attrNames(root);
  assert(names.includes('preserveAspectRatio'), 'preserveAspectRatio must survive');
  assert(names.includes('viewBox'), 'viewBox must survive');
  assert(tags(root).join(',') === 'svg,rect,text', `unexpected tree: ${tags(root).join(',')}`);
  const text = allValues(root).find((v) => v === 'attn');
  assert(text === 'attn', 'the label text must survive');
});

defineCase('gradients, markers, clipPath and transforms survive', () => {
  const root = clean(
    '<svg viewBox="0 0 100 100">' +
      '<defs>' +
      '<linearGradient id="g" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff"/></linearGradient>' +
      '<clipPath id="c"><circle cx="50" cy="50" r="40"/></clipPath>' +
      '<marker id="m" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L6,3 L0,6 z"/></marker>' +
      '</defs>' +
      '<g transform="translate(5,5) rotate(15)" clip-path="url(#c)">' +
      '<path d="M10 10 H 90 V 90 H 10 Z" fill="url(#g)" marker-end="url(#m)" stroke-width="2"/>' +
      '</g></svg>',
  );
  for (const tag of ['linearGradient', 'stop', 'clipPath', 'circle', 'marker', 'path', 'g']) {
    assert(tags(root).includes(tag), `<${tag}> should have survived`);
  }
  const values = allValues(root);
  assert(values.includes(`url(#${PREFIX}g)`), 'fill reference must be prefixed');
  assert(values.includes(`url(#${PREFIX}c)`), 'clip-path reference must be prefixed');
  assert(values.includes('translate(5,5) rotate(15)'), 'transform must survive verbatim');
});

defineCase('removals are reported so the reader can be told', () => {
  const result = sanitizeSvg('<svg onload="alert(1)"><script>x</script><rect/></svg>', { idPrefix: PREFIX });
  assert(result.ok, 'should sanitise, not reject');
  assert(result.removed.elements.includes('script'), 'script must be reported as removed');
  assert(result.removed.attributes.includes('onload'), 'onload must be reported as removed');
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

interface NodeProcessShape {
  exit?: (code: number) => void;
}

async function runAllCases(): Promise<void> {
  let passed = 0;
  let failed = 0;
  for (const run of cases) {
    const r = await run();
    if (r.ok) {
      passed += 1;
      console.log(`  ok  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
    } else {
      failed += 1;
      console.error(`  FAIL ${r.name}\n        ${r.detail ?? '(no detail)'}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    const nodeProcess = (globalThis as unknown as { process?: NodeProcessShape }).process;
    nodeProcess?.exit?.(1);
  }
}

void runAllCases();
