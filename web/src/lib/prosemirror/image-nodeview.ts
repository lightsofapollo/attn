// Image NodeView — resolves the DISPLAYED src, never the stored one (attn-cgev).
//
// prosemirror-markdown's stock `image` spec is `toDOM: (node) => ['img',
// node.attrs]`, which puts the authored markdown src straight into `<img src>`.
// That is correct for `https:`/`data:` and wrong for everything else: the
// native document is served from attn://app, so `./diagram.png` resolves
// against the app origin instead of the markdown FILE's directory. This view
// exists to break that identity — the DOM gets a resolved URL, the node keeps
// the authored string.
//
// The distinction is load-bearing. `image` has no serializer override in
// schema.ts, so prosemirror-markdown writes `node.attrs.src` verbatim on every
// save (`serializeAccepted`). There is no interception point between the attr
// and the file, which means the ONLY way `![](./x.png)` survives a round-trip
// is for nothing to ever write `attrs.src`. Nothing here does.
//
// Note this is the `![](x.svg)` path, not the embedded-SVG path: a REFERENCED
// svg is an ordinary image node loaded by the browser as an image document
// (scripts inert), so `svg-sanitizer.ts` is not — and does not need to be —
// involved. Raw `<svg>` blocks written inline in the markdown are a different
// node entirely (`embedded_svg`).
//
// The `<img>` is wrapped in a span so the failure state has somewhere to live:
// an asset that would not load renders alt text and a filename in the
// document's own voice instead of the platform's broken-image glyph. The
// wrapper is `display: block; width: fit-content` in CSS, which keeps the
// healthy case laying out as it did before the wrapper existed AND keeps the
// wrapper hugging the picture — prosemirror puts `ProseMirror-selectednode`
// and `draggable` on the NodeView's own element rather than the inner one, so
// a full-measure wrapper would draw the selection ring across the whole
// reading column and make blank paper to the right of a thumbnail a drag
// handle for it.
//
// This view is registered ONLY when a resolver is supplied (Editor.svelte's
// buildNodeViews). Callers with no local file behind the document — the hosted
// app, the reviewer viewing an owner's snapshot — keep the stock `toDOM`, so
// their DOM is byte-identical to what it was before this file existed.

import type { Node as PmNode } from 'prosemirror-model';
import type { NodeView } from 'prosemirror-view';

/** Last path segment of an authored src, decoded for display. Used only in the
 *  placeholder — a reader recognises `diagram.png`, not the whole URL. */
export function imageFileName(src: string): string {
  const trimmed = src.replace(/\/+$/, '');
  const segment = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  if (!segment) return src;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * NodeView for the `image` node.
 *
 * @param node            the image node
 * @param resolveAssetUrl maps an authored src onto something the webview can
 *                        load, or `null` when it cannot be resolved. Optional
 *                        so the view stays testable without one; in the app
 *                        the view is not registered at all when there is no
 *                        resolver.
 */
export function imageNodeView(
  node: PmNode,
  resolveAssetUrl?: (src: string) => string | null,
): NodeView {
  const dom = document.createElement('span');
  dom.className = 'md-image';

  const img = document.createElement('img');

  // Built once and only ever re-texted, so `update()` never has to remove
  // children — and so the placeholder occupies no space until it is needed.
  const fallback = document.createElement('span');
  fallback.className = 'md-image-fallback';
  const fallbackLabel = document.createElement('span');
  fallbackLabel.className = 'md-image-fallback-label';
  // What the app actually observed, not a diagnosis it cannot make. `error`
  // fires for a file that is missing, for one served with a MIME the webview
  // will not decode as an image (`mime_from_extension` in src/main.rs is
  // narrower than `files::detect_file_type`), and for a malformed SVG — the
  // file is very much found in the last two.
  fallbackLabel.textContent = 'Image didn’t load';
  const fallbackAlt = document.createElement('span');
  fallbackAlt.className = 'md-image-fallback-alt';
  const fallbackName = document.createElement('span');
  fallbackName.className = 'md-image-fallback-name';
  // The card is one thing to a screen reader, not three loose text runs. The
  // eyebrow/serif/mono hierarchy carries the three roles visually; read aloud
  // it would be an undifferentiated string with nothing marking it as standing
  // in for an image, so the pieces are hidden and the wrapper carries a single
  // composed label (built in `render`, where alt and title are known).
  fallback.setAttribute('role', 'img');
  fallbackLabel.setAttribute('aria-hidden', 'true');
  fallbackAlt.setAttribute('aria-hidden', 'true');
  fallbackName.setAttribute('aria-hidden', 'true');
  fallback.appendChild(fallbackLabel);
  fallback.appendChild(fallbackAlt);
  fallback.appendChild(fallbackName);

  dom.appendChild(img);
  dom.appendChild(fallback);

  const onLoad = (): void => {
    dom.removeAttribute('data-broken');
    dom.setAttribute('data-loaded', 'true');
    img.removeAttribute('hidden');
  };

  const onError = (): void => {
    dom.removeAttribute('data-loaded');
    dom.setAttribute('data-broken', 'true');
    // Hidden rather than removed, so a src change can put the same element
    // (and its listeners) straight back to work. Note this is NOT a retry
    // path: an `update()` carrying the SAME src returns early below without
    // touching `img.src`, so a file that reappears on disk stays behind the
    // placeholder until the view is rebuilt. That is deliberate — re-arming
    // on every update would re-request a known-missing asset on every
    // transaction that redraws the node.
    img.setAttribute('hidden', '');
  };

  img.addEventListener('load', onLoad);
  img.addEventListener('error', onError);

  // The last src actually written to the DOM. Re-writing an identical src is
  // not a no-op worth making: the browser may not re-fire `load` for an
  // unchanged, already-decoded image, so clearing the state flags on every
  // update would strand a healthy image with neither flag set.
  let renderedSrc: string | null = null;

  function render(current: PmNode): void {
    const src = typeof current.attrs.src === 'string' ? current.attrs.src : '';
    const alt = typeof current.attrs.alt === 'string' ? current.attrs.alt : '';
    const title = typeof current.attrs.title === 'string' ? current.attrs.title : '';

    const resolved = resolveAssetUrl ? resolveAssetUrl(src) : null;
    // A src the resolver declines stays as authored: it may still be a URL the
    // webview understands, and a wrong-but-plausible attn:// URL would be a
    // worse answer than the authored one.
    const display = resolved ?? src;

    // Set only when there is one, matching the `title` handling below and the
    // stock spec: prosemirror-markdown declares `alt: { default: null }` and
    // DOMSerializer drops null attributes, so `![](x.png)` has always produced
    // an `<img>` with no `alt` at all. Emitting `alt=""` instead would declare
    // the image decorative — but markdown has no way to SAY decorative, and
    // `![](x.png)` overwhelmingly means "the author wrote no alt text", not
    // "skip this". Leaving the attribute off keeps assistive tech announcing
    // the filename, which is the more useful of the two readings.
    if (alt) img.setAttribute('alt', alt);
    else img.removeAttribute('alt');
    if (title) img.setAttribute('title', title);
    else img.removeAttribute('title');

    // The authored src, kept queryable for automation and for anyone reading
    // the DOM to check what the resolver was given.
    dom.setAttribute('data-src', src);

    fallbackAlt.textContent = alt;
    if (alt) fallbackAlt.removeAttribute('hidden');
    else fallbackAlt.setAttribute('hidden', '');
    fallbackName.textContent = imageFileName(src);
    // `title` is otherwise lost in the broken state — it lives on the hidden
    // <img>, and the broken state is where that author-supplied context is
    // most worth having. It joins the announcement and the card's own tooltip.
    if (title) fallback.setAttribute('title', title);
    else fallback.removeAttribute('title');
    fallback.setAttribute(
      'aria-label',
      [fallbackLabel.textContent, alt, title, fallbackName.textContent]
        .filter(Boolean)
        .join('. '),
    );

    if (display === renderedSrc) return;
    renderedSrc = display;
    // A fresh src re-arms both handlers; until one fires, the view is neither
    // loaded nor broken.
    dom.removeAttribute('data-loaded');
    dom.removeAttribute('data-broken');
    img.removeAttribute('hidden');
    img.setAttribute('src', display);
  }

  render(node);

  // No `stopEvent` and no `ignoreMutation` on purpose. The image node is
  // `draggable` and an inline leaf, so swallowing events would kill
  // click-to-NodeSelection and with it keyboard deletion; and a NodeView with
  // no `contentDOM` already ignores its own DOM mutations by default.
  return {
    dom,
    update(updatedNode: PmNode): boolean {
      if (updatedNode.type !== node.type) return false;
      render(updatedNode);
      return true;
    },
    destroy(): void {
      img.removeEventListener('load', onLoad);
      img.removeEventListener('error', onError);
    },
  };
}
