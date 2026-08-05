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
  const script = `\n<script data-attn-runtime>${DOC_RUNTIME_SOURCE}</script>\n`;
  const closing = /<\/body\s*>/i;
  return closing.test(html) ? html.replace(closing, `${script}</body>`) : html + script;
}

/** A rectangle in the *shell's* coordinate space. */
export interface ShellRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AnnotationBridgeEvents {
  /** The frame booted and is ready to paint. */
  onReady?: () => void;
  /** The user selected text, or picked an element scope. */
  onProposal?: (proposal: AnchorProposal, rects: ShellRect[], caret: ShellRect | null) => void;
  onProposalCleared?: () => void;
  /** Hovering a block offered this scope chain, innermost first. */
  onScopeHover?: (chain: ScopeCandidate[]) => void;
  /** Anchors were (re-)resolved; drives rail card position and confidence. */
  onResolved?: (results: AnchorResolution[], toShellRects: (r: DocRect[]) => ShellRect[]) => void;
  /** Geometry moved (scroll/resize/reflow). */
  onGeometry?: (results: { anchorId: string; rects: ShellRect[] }[]) => void;
  /** The user clicked a pin or overlay chip in the document. */
  onAnchorActivated?: (anchorId: string) => void;
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
  /** Queued until the port exists, so callers need not await the handshake. */
  #pending: RenderableAnchor[] | null = null;

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

    if (this.#pending) {
      this.renderAnchors(this.#pending);
      this.#pending = null;
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
        this.#events.onProposal?.(
          message.proposal,
          this.toShellRects(message.rects),
          this.toShellRect(message.caret),
        );
        break;
      case 'scopePicked':
        this.#events.onProposal?.(message.proposal, this.toShellRects(message.rects), null);
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

  /** Full desired state; the frame diffs. Queued if the port is not up yet. */
  renderAnchors(anchors: RenderableAnchor[]): void {
    if (!this.#port) {
      this.#pending = anchors;
      return;
    }
    this.#port.postMessage({ type: 'renderAnchors', v: DOC_PROTOCOL_VERSION, anchors });
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
    this.#pending = null;
  }
}
