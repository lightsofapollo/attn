// Remote participant carets for live co-typing.
//
// Renders each peer's caret as a widget decoration — a thin colored bar with a
// floating name chip — at their broadcast head position. The cursor data is
// pushed in via a meta transaction (keyed by `remoteCursorsKey`) by the
// CollabController whenever a `cursor` wire message arrives, so this plugin
// stays a pure view of that state.
//
// Spec: planning/collab/ui/presence-identity.md (live cursors).

import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';

import { hashParticipantColor, sanitizeParticipantColor } from '../participant-color';
import { caretStacks, clampPos, selectionSegments } from './remote-cursor-overlap';
import type { RemoteCursor } from './collab-controller';

/** Meta key the controller uses to push the current remote-cursor set in. */
export const remoteCursorsKey = new PluginKey<RemoteCursor[]>('attn-remote-cursors');

/** A peer's declared caret color, validated before it touches an inline
 * style (wire data — attn-3gdd's grammar). Junk degrades to a deterministic
 * palette color for the clientID so the caret stays personal, not broken. */
function safeColor(cursor: RemoteCursor): string {
  return sanitizeParticipantColor(cursor.color) ?? hashParticipantColor(cursor.clientID);
}

/** Build the floating caret DOM for one remote participant. `stack` is the
 * vertical slot among carets sharing this head position (attn-5xgz) —
 * label 0 sits in the usual spot, 1 above it, and so on, so two peers on
 * the same text never occlude each other's name. */
function buildCaretWidget(cursor: RemoteCursor, stack: number): HTMLElement {
  const color = safeColor(cursor);
  const wrap = document.createElement('span');
  wrap.className = 'attn-remote-caret';
  wrap.style.borderColor = color;
  wrap.setAttribute('data-client-id', cursor.clientID);

  const label = document.createElement('span');
  label.className = 'attn-remote-caret-label';
  label.style.backgroundColor = color;
  label.style.setProperty('--attn-caret-stack', String(stack));
  label.textContent = cursor.label;
  wrap.appendChild(label);

  return wrap;
}

/**
 * Plugin that renders remote carets. Its state is the cursor array, replaced
 * whenever a transaction carries a `remoteCursorsKey` meta payload.
 */
export function remoteCursorsPlugin(): Plugin {
  return new Plugin<RemoteCursor[]>({
    key: remoteCursorsKey,
    state: {
      init: () => [],
      apply(tr, prev) {
        const next = tr.getMeta(remoteCursorsKey) as RemoteCursor[] | undefined;
        if (next) return next;
        // Map each remote caret through LOCAL edits so it stays anchored to its
        // content instead of drifting when this user types (the head positions
        // are document offsets — without this they point at shifted text).
        if (!tr.docChanged || prev.length === 0) return prev;
        return prev.map((cursor) => ({
          ...cursor,
          head: tr.mapping.map(cursor.head),
          ...(cursor.anchor === undefined ? {} : { anchor: tr.mapping.map(cursor.anchor) }),
        }));
      },
    },
    props: {
      decorations(state) {
        const cursors = remoteCursorsKey.getState(state) ?? [];
        if (cursors.length === 0) return DecorationSet.empty;
        const max = state.doc.content.size;
        const stacks = caretStacks(cursors, max);
        const decos = cursors.map((cursor) => {
          const pos = clampPos(cursor.head, max);
          const stack = stacks.get(cursor.clientID) ?? 0;
          return Decoration.widget(pos, () => buildCaretWidget(cursor, stack), {
            // side:1 keeps the caret stable to the right of the position so it
            // doesn't get swallowed by adjacent text insertions.
            side: 1,
            // Ignore for ProseMirror's own position mapping/selection.
            ignoreSelection: true,
            key: `remote-caret-${cursor.clientID}-${pos}-${stack}`,
          });
        });
        // Peers' live SELECTIONS render as translucent bands in their colors —
        // you can see what a reviewer is highlighting before any comment lands.
        // Overlaps are resolved HERE, not by span nesting (attn-5xgz): the
        // selections are split into disjoint segments, and a segment covered
        // by 2+ peers draws ONE decoration with an explicit shared treatment
        // (striped weave of the first two peers' tints; labels disambiguate
        // any third).
        for (const segment of selectionSegments(cursors, max)) {
          const first = safeColor(segment.cursors[0]!);
          const ids = segment.cursors.map((c) => c.clientID).join('+');
          if (segment.cursors.length === 1) {
            decos.push(
              Decoration.inline(segment.from, segment.to, {
                class: 'attn-remote-selection',
                style: `--remote-selection-color: ${first};`,
              }, {
                key: `remote-selection-${ids}-${segment.from}-${segment.to}`,
              }),
            );
          } else {
            const second = safeColor(segment.cursors[1]!);
            decos.push(
              Decoration.inline(segment.from, segment.to, {
                class: 'attn-remote-selection attn-remote-selection-shared',
                style: `--remote-selection-color: ${first}; --remote-selection-color-2: ${second};`,
              }, {
                key: `remote-selection-shared-${ids}-${segment.from}-${segment.to}`,
              }),
            );
          }
        }
        return DecorationSet.create(state.doc, decos);
      },
    },
  });
}
