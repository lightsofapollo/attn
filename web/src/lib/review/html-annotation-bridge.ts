/**
 * Shell side of the HTML annotation bridge.
 *
 * Owns the handshake with the document frame, validates everything that comes
 * back, and converts the frame's viewport coordinates into shell coordinates so
 * the existing review rail can lay cards out unchanged.
 *
 * The frame is untrusted (`amendments.md` #20): it may *propose* anchors and
 * *report* geometry, and this module never lets it do more than that. There is
 * deliberately no inbound message that creates, mutates, or resolves review
 * state — comment bodies and the submit action live in shell-owned UI.
 *
 * @see planning/collab/html-annotation.md §1, §3, §5
 */

import {
  DOC_HELLO,
  DOC_PROTOCOL_VERSION,
  SHELL_INIT,
  parseDocMessage,
  type AnchorProposal,
  type AnchorRenderState,
  type AnchorResolution,
  type DocMessage,
  type DocRect,
  type RenderableAnchor,
  type ScopeCandidate,
} from './doc-protocol';
import { DOC_RUNTIME_SOURCE } from './doc-runtime.generated';

/**
 * Splice the runtime into a document's source.
 *
 * Appended at the very end rather than parsed-and-inserted: the input is
 * arbitrary, possibly malformed HTML, and any attempt to understand its
 * structure risks corrupting it. A trailing script is placed in `<body>` by
 * every HTML parser and runs after the document above it has been parsed,
 * which is exactly the ordering the runtime needs.
 */
export function injectDocRuntime(html: string): string {
  // A document that already carries the runtime (saved after a previous
  // injection, then re-shared) must not get a second copy: two instances
  // would race the handshake and the loser's empty geometry would flap the
  // rail. The runtime also guards itself with a window global, but skipping
  // here avoids doubling the payload at all.
  if (html.includes('data-attn-runtime')) return html;
  const script = `\n<script data-attn-runtime>${DOC_RUNTIME_SOURCE}</script>\n`;
  // Splice before the LAST `</body>`: the first occurrence may sit inside a
  // comment, a script string, or an attribute value, where the runtime would
  // never execute — and in the script/attribute cases would corrupt the
  // document. The real closing tag is the last one in any document that has
  // one at all.
  const closing = /<\/body\s*>/gi;
  let lastMatch: RegExpExecArray | null = null;
  for (let m = closing.exec(html); m !== null; m = closing.exec(html)) lastMatch = m;
  if (!lastMatch) return html + script;
  // String concatenation, never String.replace with a string argument — the
  // runtime source is an arbitrary payload where `$'`-style replacement
  // patterns would splice document text into the script.
  return html.slice(0, lastMatch.index) + script + html.slice(lastMatch.index);
}

/**
 * Flatten an anchor to plain, structured-cloneable data.
 *
 * Anchors are assembled from the review store, where Svelte 5 hands out a
 * PROXY for every object it tracks — and `postMessage` serialises with
 * structured clone, which throws `DataCloneError` on a proxy. The throw
 * surfaces nowhere useful: the frame simply never receives the anchor set, so
 * no pin is painted, no resolution comes back, and the rail has no geometry to
 * align to. Every symptom points at the document, and nothing points here.
 *
 * Flattening also states the boundary's contract honestly — it carries values,
 * never live objects — so nothing reactive can leak into an untrusted frame.
 */
function plainAnchor(anchor: RenderableAnchor): RenderableAnchor {
  const html = anchor.html;
  return {
    anchorId: anchor.anchorId,
    state: anchor.state,
    quote: anchor.quote,
    prefix: anchor.prefix,
    suffix: anchor.suffix,
    label: anchor.label,
    html: {
      v: html.v,
      target: html.target,
      cssSelector: html.cssSelector,
      fallbackSelectors: html.fallbackSelectors ? [...html.fallbackSelectors] : undefined,
      textPosition: html.textPosition ? { ...html.textPosition } : undefined,
      range: html.range ? { ...html.range } : undefined,
      context: {
        tagName: html.context.tagName,
        scopePreview: html.context.scopePreview,
        role: html.context.role,
        domPath: html.context.domPath ? [...html.context.domPath] : undefined,
      },
    },
  };
}

/** A rectangle in the *shell's* coordinate space. */
export interface ShellRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One anchor the frame is offering, in shell coordinates. */
export interface ProposalEvent {
  proposal: AnchorProposal;
  rects: ShellRect[];
  /** Where a composer should float; null for element picks (use `rects`). */
  caret: ShellRect | null;
  /**
   * The person asked for this — pressed the Comment pill, clicked an element,
   * chose a scope on the breadcrumb — rather than merely dragging a selection.
   *
   * A shell that cannot open a composer owes an explicit proposal an
   * explanation; staying silent is what "I clicked Comment and nothing
   * happened" is made of. Passive proposals carry no such debt.
   *
   * The frame sets this, and the frame is untrusted — but the worst a hostile
   * one gains is raising a composer the user did not ask for, which it could
   * already do before this flag existed (every proposal opened one). The
   * composer is shell-owned: the body is typed there and the event is created
   * there, so this grants no authorship. @see amendments.md #20.
   */
  explicit: boolean;
}

export interface AnnotationBridgeEvents {
  /** The frame booted and is ready to paint. */
  onReady?: () => void;
  /** The user selected text, or picked an element scope. */
  onProposal?: (event: ProposalEvent) => void;
  onProposalCleared?: () => void;
  /** Hovering a block offered this scope chain, innermost first. */
  onScopeHover?: (chain: ScopeCandidate[]) => void;
  /** Anchors were (re-)resolved; drives rail card position and confidence. */
  onResolved?: (results: AnchorResolution[], toShellRects: (r: DocRect[]) => ShellRect[]) => void;
  /** Geometry moved (scroll/resize/reflow). */
  onGeometry?: (results: { anchorId: string; rects: ShellRect[] }[]) => void;
  /** The user clicked a pin or overlay chip in the document. */
  onAnchorActivated?: (anchorId: string) => void;
  /**
   * Pointer entered a committed anchor in the document, or left one
   * (`anchorId: null`). Drives the document→card half of hover linking
   * (attn-bb6t.3).
   */
  onAnchorHover?: (anchorId: string | null) => void;
}

/**
 * Manage one document frame's annotation channel.
 *
 * Construct it with the iframe, call {@link connect} once the frame is in the
 * DOM, and {@link dispose} when it goes away.
 */
export class HtmlAnnotationBridge {
  #frame: HTMLIFrameElement;
  #events: AnnotationBridgeEvents;
  #port: MessagePort | null = null;
  #onWindowMessage: ((event: MessageEvent) => void) | null = null;
  /**
   * The full desired overlay state. Keeping it after the first send matters:
   * a watched path-mode document can reload in place, replacing its runtime
   * and port while the shell's review threads have not changed.
   */
  #rendered: RenderableAnchor[] | null = null;
  /** Anchor currently painted as hovered, so it can be restored on exit. */
  #hoveredAnchorId: string | null = null;
  /**
   * Retained for the same reason as `#rendered`: a reloaded frame boots with
   * inspection off, and a document that silently stopped answering clicks after
   * a live-reload would read as broken.
   */
  #inspect = false;

  constructor(frame: HTMLIFrameElement, events: AnnotationBridgeEvents) {
    this.#frame = frame;
    this.#events = events;
  }

  get connected(): boolean {
    return this.#port !== null;
  }

  /** Begin listening for the frame's `hello`. Safe to call before it loads. */
  connect(): void {
    if (this.#onWindowMessage) return;
    this.#onWindowMessage = (event: MessageEvent) => {
      // The frame is on an opaque origin, so `event.origin` is the string
      // "null" and carries no information. Identity comes from `event.source`
      // being this exact frame — a nested frame, a sibling, or an opened window
      // cannot satisfy it — after which the private port carries everything.
      if (event.source !== this.#frame.contentWindow) return;
      const data = event.data as { type?: unknown; v?: unknown } | undefined;
      if (!data || data.type !== DOC_HELLO || data.v !== DOC_PROTOCOL_VERSION) return;
      this.#establish();
    };
    window.addEventListener('message', this.#onWindowMessage);
  }

  #establish(): void {
    const target = this.#frame.contentWindow;
    if (!target) return;
    this.#port?.close();

    const channel = new MessageChannel();
    this.#port = channel.port1;
    this.#port.onmessage = (event: MessageEvent) => this.#receive(event.data);
    this.#port.start();

    // targetOrigin must be '*' — an opaque origin cannot be named. The message
    // carries no secret; its only payload is the port itself.
    target.postMessage({ type: SHELL_INIT, v: DOC_PROTOCOL_VERSION }, '*', [channel.port2]);

    if (this.#inspect) {
      this.#port.postMessage({ type: 'inspect', v: DOC_PROTOCOL_VERSION, enabled: true });
    }

    if (this.#rendered) {
      this.#port.postMessage({
        type: 'renderAnchors',
        v: DOC_PROTOCOL_VERSION,
        anchors: this.#rendered,
      });
    }
  }

  #receive(raw: unknown): void {
    const message = parseDocMessage(raw);
    // Malformed, oversized, or unknown-type payloads are dropped silently —
    // that is both the security posture and how forward-compatibility works.
    if (!message) return;
    this.#dispatch(message);
  }

  #dispatch(message: DocMessage): void {
    switch (message.type) {
      case 'ready':
        this.#events.onReady?.();
        break;
      case 'selection':
        this.#events.onProposal?.({
          proposal: message.proposal,
          rects: this.toShellRects(message.rects),
          caret: this.toShellRect(message.caret),
          explicit: message.explicit,
        });
        break;
      case 'scopePicked':
        this.#events.onProposal?.({
          proposal: message.proposal,
          rects: this.toShellRects(message.rects),
          caret: null,
          explicit: message.explicit,
        });
        break;
      case 'selectionCleared':
        this.#events.onProposalCleared?.();
        break;
      case 'scopeHover':
        this.#events.onScopeHover?.(message.chain);
        break;
      case 'anchorsResolved':
        this.#events.onResolved?.(message.results, (rects) => this.toShellRects(rects));
        break;
      case 'geometry':
        this.#events.onGeometry?.(
          message.results.map((result) => ({
            anchorId: result.anchorId,
            rects: this.toShellRects(result.rects),
          })),
        );
        break;
      case 'anchorActivated':
        this.#events.onAnchorActivated?.(message.anchorId);
        break;
      case 'anchorHover':
        this.#events.onAnchorHover?.(message.anchorId);
        break;
      default:
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Coordinates
  // -------------------------------------------------------------------------

  /**
   * The frame reports rects in its own viewport space. The shell cannot observe
   * that frame's scroll across origins, which is why the frame re-reports on
   * every reflow rather than the shell computing it.
   */
  toShellRect(rect: DocRect): ShellRect {
    const frameRect = this.#frame.getBoundingClientRect();
    return {
      x: rect.x + frameRect.left,
      y: rect.y + frameRect.top,
      width: rect.width,
      height: rect.height,
    };
  }

  toShellRects(rects: DocRect[]): ShellRect[] {
    const frameRect = this.#frame.getBoundingClientRect();
    return rects.map((rect) => ({
      x: rect.x + frameRect.left,
      y: rect.y + frameRect.top,
      width: rect.width,
      height: rect.height,
    }));
  }

  // -------------------------------------------------------------------------
  // Shell → document
  // -------------------------------------------------------------------------

  /**
   * Full desired state; the frame diffs. It is retained and replayed after
   * every successful hello, so a frame reload never drops existing pins.
   */
  renderAnchors(anchors: RenderableAnchor[]): void {
    // Flattened once, on the way in: the retained copy is replayed after every
    // reload, so storing the live proxies would just move the DataCloneError
    // to the next handshake.
    this.#rendered = anchors.map(plainAnchor);
    if (!this.#port) {
      return;
    }
    this.#port.postMessage({
      type: 'renderAnchors',
      v: DOC_PROTOCOL_VERSION,
      anchors: this.#rendered,
    });
  }

  /**
   * Card → document hover (attn-bb6t.3). Owned by the bridge rather than each
   * shell because un-hovering has to restore the anchor's BASE state, and the
   * retained `#rendered` specs are the only record of what that was —
   * `setAnchorState` overwrites the frame's copy, so a caller that forgot
   * would leave a resolved anchor painted as unresolved.
   *
   * Deliberately not a `renderAnchors` re-send: that re-resolves every anchor
   * in the document, which is far too much work for a mouseenter.
   */
  setHoveredAnchor(anchorId: string | null): void {
    if (anchorId === this.#hoveredAnchorId) return;
    const previous = this.#hoveredAnchorId;
    this.#hoveredAnchorId = anchorId;
    if (previous !== null) this.setAnchorState(previous, this.#baseStateOf(previous));
    if (anchorId !== null) this.setAnchorState(anchorId, 'hovered');
  }

  /** The state an anchor should carry when it is not hovered. */
  #baseStateOf(anchorId: string): AnchorRenderState {
    const spec = this.#rendered?.find((anchor) => anchor.anchorId === anchorId);
    // `hovered` is never a base state; if the last render said so, something
    // raced and `default` is the safe floor.
    if (!spec || spec.state === 'hovered') return 'default';
    return spec.state;
  }

  setAnchorState(anchorId: string, state: AnchorRenderState): void {
    this.#port?.postMessage({
      type: 'setAnchorState',
      v: DOC_PROTOCOL_VERSION,
      anchorId,
      state,
    });
  }

  focusAnchor(anchorId: string, scrollIntoView = true): void {
    this.#port?.postMessage({
      type: 'focusAnchor',
      v: DOC_PROTOCOL_VERSION,
      anchorId,
      scrollIntoView,
    });
  }

  pickScope(scopeId: string): void {
    this.#port?.postMessage({ type: 'pickScope', v: DOC_PROTOCOL_VERSION, scopeId });
  }

  /**
   * Whether clicking an element in the document commits to commenting on it.
   *
   * The frame always offers hover chrome, so the annotation model is visible on
   * any rendered document. Taking the click, though, means the page's own links
   * and buttons stop working — only correct once the document is genuinely
   * under review, which is a question only the shell can answer.
   */
  setInspect(enabled: boolean): void {
    this.#inspect = enabled;
    this.#port?.postMessage({ type: 'inspect', v: DOC_PROTOCOL_VERSION, enabled });
  }

  dismissSelection(): void {
    this.#port?.postMessage({ type: 'dismissSelection', v: DOC_PROTOCOL_VERSION });
  }

  setTheme(mode: 'paper' | 'ink'): void {
    this.#port?.postMessage({ type: 'theme', v: DOC_PROTOCOL_VERSION, mode });
  }

  dispose(): void {
    if (this.#onWindowMessage) {
      window.removeEventListener('message', this.#onWindowMessage);
      this.#onWindowMessage = null;
    }
    this.#port?.close();
    this.#port = null;
    this.#rendered = null;
    this.#inspect = false;
  }
}
