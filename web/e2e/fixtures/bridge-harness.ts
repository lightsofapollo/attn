/**
 * Test harness that exposes the *real* shell-side annotation classes to a
 * Playwright page.
 *
 * The earlier runtime spec reimplemented the handshake inline, which proved the
 * document side works but said nothing about the code the app actually ships.
 * This entry is bundled and injected so the assertions run against
 * `HtmlAnnotationBridge` and `injectDocRuntime` themselves — including the
 * `event.source` binding and the validating parser, which are the two places a
 * regression would be silent and security-relevant.
 */

import {
  HtmlAnnotationBridge,
  injectDocRuntime,
} from '../../src/lib/review/html-annotation-bridge';
import type {
  AnchorProposal,
  AnchorResolution,
  RenderableAnchor,
} from '../../src/lib/review/doc-protocol';

interface HarnessWindow {
  __bridge?: HtmlAnnotationBridge;
  __ready: boolean;
  __proposals: AnchorProposal[];
  __resolutions: AnchorResolution[];
  __geometry: { anchorId: string; rects: { y: number }[] }[];
  __activated: string[];
  __boot: (docHtml: string) => void;
  __render: (anchors: RenderableAnchor[]) => void;
  __rawPost: (payload: unknown) => void;
}

const w = window as unknown as HarnessWindow;

w.__ready = false;
w.__proposals = [];
w.__resolutions = [];
w.__geometry = [];
w.__activated = [];

w.__boot = (docHtml: string) => {
  const frame = document.createElement('iframe');
  frame.id = 'doc';
  // Exactly how HtmlViewer renders an annotating frame: opaque origin.
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.style.cssText = 'width:800px;height:600px;border:0';
  frame.srcdoc = injectDocRuntime(docHtml);
  document.body.appendChild(frame);

  const bridge = new HtmlAnnotationBridge(frame, {
    onReady: () => {
      w.__ready = true;
    },
    onProposal: (proposal) => {
      w.__proposals.push(proposal);
    },
    onResolved: (results, toShellRects) => {
      w.__resolutions = results;
      w.__geometry = results.map((r) => ({
        anchorId: r.anchorId,
        rects: toShellRects(r.rects),
      }));
    },
    onGeometry: (results) => {
      w.__geometry = results;
    },
    onAnchorActivated: (anchorId) => {
      w.__activated.push(anchorId);
    },
  });
  bridge.connect();
  w.__bridge = bridge;
};

w.__render = (anchors) => w.__bridge?.renderAnchors(anchors);

/**
 * Post a raw payload straight at the parent as the frame would, to prove the
 * bridge ignores anything that is not a `hello` from this exact frame.
 */
w.__rawPost = (payload: unknown) => window.postMessage(payload, '*');
