<!--
  AmbiguousAnchorPicker — candidate-row picker rendered inside ambiguous
  ReviewMarginCards (attn-nnj.4.7 — orphan-tray extension).

  Per `planning/collab/data-model.md` §Anchor Resolution, an ambiguous
  resolution carries a ranked list of `ResolvedAnchorCandidate`s. The
  resolver could not pick one with sufficient confidence; the owner must
  choose. This component renders each candidate as a clickable row with
  a preview snippet and confidence value, and on click fires
  `reviewResolveAnchor` IPC with the chosen `currentRange` (a
  `PositionAnchor`).

  Wire path (success):
    user clicks row N
      -> reviewResolveAnchor IPC sent with candidates[N].currentRange
      -> Rust resolves the ambiguity, emits AnchorResolutionChanged
      -> bridge calls window.__attn__.reviewAnchorResolution(update)
      -> store.applyAnchorResolution flips this event's resolved.status
         to 'exact'/'remapped' (no longer 'ambiguous')
      -> ReviewMargin's ambiguousAnchors selector drops the event, the
         thread moves out of the orphan tray.

  Keyboard:
    - ArrowDown / ArrowUp navigate selection
    - Enter picks the currently-selected candidate
    - Tab moves focus out (standard browser default)

  No emoji, no window.confirm/alert. The component is presentational —
  the parent (ReviewMarginCard) owns the data and the post-success state.
-->

<script lang="ts">
  import { reviewResolveAnchor } from './ipc';
  import type { EventId, ResolvedAnchorCandidate, RoomId } from './types';

  interface Props {
    /** Room id the anchor belongs to. */
    roomId: RoomId;
    /** Event id whose anchor is being re-resolved. */
    eventId: EventId;
    /** Ranked candidate list from the resolver. */
    candidates: ResolvedAnchorCandidate[];
    /** Optional reason supplied by the resolver, surfaced for context. */
    reason?: string;
    /** Fires after a candidate is picked (the IPC has been sent). The
     *  parent uses this to visually disable / dim the card while the
     *  resolution round-trips back. */
    onPicked?: (candidate: ResolvedAnchorCandidate, index: number) => void;
  }

  let {
    roomId,
    eventId,
    candidates,
    reason,
    onPicked,
  }: Props = $props();

  // Currently keyboard-selected candidate. Defaults to the first row so
  // Enter is meaningful immediately on focus.
  let selectedIndex = $state(0);

  // True once the user has picked. The picker re-renders into a brief
  // success state ("resolving…") until the AnchorResolutionChanged event
  // fires back through the store and the orphan tray drops this card.
  // The parent card stays mounted only for as long as the thread is
  // still in `orphanThreads`; once the store flips status away from
  // 'ambiguous', the row vanishes naturally.
  let pickedIndex = $state<number | null>(null);

  // Reset internal state if the candidate set changes underneath us.
  // (e.g. resolver pushed a new ambiguous update with a different set.)
  $effect(() => {
    void candidates;
    selectedIndex = Math.min(selectedIndex, Math.max(0, candidates.length - 1));
  });

  function pickCandidate(index: number): void {
    const candidate = candidates[index];
    if (!candidate) return;
    if (pickedIndex !== null) return;
    pickedIndex = index;
    void reviewResolveAnchor(roomId, eventId, candidate.currentRange);
    if (onPicked) onPicked(candidate, index);
  }

  function handleRowClick(e: MouseEvent, index: number): void {
    e.stopPropagation();
    selectedIndex = index;
    pickCandidate(index);
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (candidates.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      selectedIndex = (selectedIndex + 1) % candidates.length;
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      selectedIndex = (selectedIndex - 1 + candidates.length) % candidates.length;
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      pickCandidate(selectedIndex);
      return;
    }
  }

  function formatConfidence(value: number): string {
    if (!Number.isFinite(value)) return '—';
    const pct = Math.round(value * 100);
    return `${pct}%`;
  }

  function truncate(s: string, n: number): string {
    if (s.length <= n) return s;
    return `${s.slice(0, n - 1)}…`;
  }
</script>

<section
  class="ambiguous-picker"
  data-testid="ambiguous-anchor-picker"
  data-event-id={eventId}
  data-candidate-count={candidates.length}
  data-picked={pickedIndex !== null ? 'true' : 'false'}
  aria-label={`Choose an anchor candidate — ${candidates.length} options`}
>
  {#if reason}
    <p class="ap-reason" data-testid="ambiguous-picker-reason">{reason}</p>
  {/if}

  <ul
    class="ap-list"
    role="listbox"
    tabindex="0"
    aria-activedescendant={`ap-row-${eventId}-${selectedIndex}`}
    onkeydown={handleKeydown}
  >
    {#each candidates as candidate, i (i)}
      <li
        id={`ap-row-${eventId}-${i}`}
        class="ap-row"
        role="option"
        data-testid="ambiguous-picker-row"
        data-candidate-index={i}
        data-selected={i === selectedIndex ? 'true' : 'false'}
        aria-selected={i === selectedIndex}
      >
        <button
          type="button"
          class="ap-row-btn"
          data-testid="ambiguous-picker-row-btn"
          onclick={(e) => handleRowClick(e, i)}
          disabled={pickedIndex !== null}
        >
          <span class="ap-row-preview" title={candidate.preview}>
            {truncate(candidate.preview, 80)}
          </span>
          <span class="ap-row-meta">
            <span
              class="ap-row-confidence"
              data-testid="ambiguous-picker-confidence"
            >
              {formatConfidence(candidate.confidence)}
            </span>
            {#if candidate.reason}
              <span class="ap-row-reason" title={candidate.reason}>
                · {truncate(candidate.reason, 24)}
              </span>
            {/if}
          </span>
        </button>
      </li>
    {/each}
  </ul>

  {#if pickedIndex !== null}
    <p class="ap-status" data-testid="ambiguous-picker-status">
      Resolving…
    </p>
  {/if}
</section>

<style>
  .ambiguous-picker {
    display: block;
    margin: 4px 0 6px;
    padding: 6px;
    border: 1px dashed var(--border, rgba(0, 0, 0, 0.12));
    border-radius: 4px;
    background: var(--muted, rgba(0, 0, 0, 0.02));
  }

  .ambiguous-picker[data-picked='true'] {
    opacity: 0.6;
  }

  .ap-reason {
    margin: 0 0 6px;
    padding: 0 2px;
    font-size: 11px;
    color: var(--muted-foreground, rgba(0, 0, 0, 0.55));
  }

  .ap-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    outline: none;
  }

  .ap-list:focus-visible {
    box-shadow: 0 0 0 2px var(--ring, rgba(37, 99, 235, 0.35));
    border-radius: 3px;
  }

  .ap-row {
    margin: 0;
    padding: 0;
  }

  .ap-row[data-selected='true'] .ap-row-btn {
    background: var(--accent, rgba(37, 99, 235, 0.08));
    border-color: var(--accent-foreground, var(--primary, #2563eb));
  }

  .ap-row-btn {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 2px;
    width: 100%;
    box-sizing: border-box;
    padding: 6px 8px;
    background: var(--popover, var(--background, #fff));
    border: 1px solid var(--border, rgba(0, 0, 0, 0.1));
    border-radius: 4px;
    color: inherit;
    cursor: pointer;
    text-align: left;
    font: inherit;
    line-height: 1.3;
  }

  .ap-row-btn:hover {
    background: var(--muted, rgba(0, 0, 0, 0.04));
  }

  .ap-row-btn:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .ap-row-preview {
    display: block;
    font-size: 12px;
    color: var(--foreground, inherit);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ap-row-meta {
    display: flex;
    align-items: baseline;
    gap: 4px;
    font-size: 11px;
    color: var(--muted-foreground, rgba(0, 0, 0, 0.55));
  }

  .ap-row-confidence {
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    color: var(--foreground, inherit);
  }

  .ap-row-reason {
    font-style: italic;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ap-status {
    margin: 6px 0 0;
    padding: 0 2px;
    font-size: 11px;
    font-style: italic;
    color: var(--muted-foreground, rgba(0, 0, 0, 0.55));
  }
</style>
