---
target: editor-polish prototype v3
total_score: 31
p0_count: 0
p1_count: 3
timestamp: 2026-07-12T15-14-36Z
slug: planning-design-prototypes-editor-polish-html
---
Method: dual-agent (A: design review via headless Playwright, 5 passes, 25+ screenshots · B: detector + canvas-resolved measurements)

# Critique — editor-polish.html v3 (wide sheet + scrollbars + delight pass)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Save chip/counts/toast excellent; comment posted on metrics.md shows zero visible result (misfiles into launch's hidden rail) |
| 2 | Match System / Real World | 4 | Margin notes, ledger diffs, "Nothing left this machine" — metaphor and copy genuinely good |
| 3 | User Control and Freedom | 2 | Undo everywhere (excellent) but one Esc closes ALL layers, composer drafts unrecoverable, resolve-all edits without asking |
| 4 | Consistency and Standards | 2 | ⌘⇧. dead on real keyboards (Shift+. emits ">"); T dies after any click; seeded ins not focusable while comment anchors are; Esc skips the drawer |
| 5 | Error Prevention | 2 | Resolve-all silently ACCEPTS suggestions; cross-file post misfiles silently; no right-edge clamp on popover/composer |
| 6 | Recognition Rather Than Recall | 4 | Shortcuts printed beside every action; teaching empty state |
| 7 | Flexibility and Efficiency | 3 | Real palette filter/↑↓/↵, ⌘J/⌘⇧S work; no ⌘↵ post; two fragile shortcuts |
| 8 | Aesthetic and Minimalist Design | 4 | Restrained, dense, warm; nothing decorative that isn't informative |
| 9 | Error Recovery | 4 | Share error state exemplary; undo notes name actor and consequence; verified under mid-animation stress |
| 10 | Help and Documentation | 3 | Inline hints carry it |
| **Total** | | **31/40** | **Good band — up from 22; keyboard-truth and semantic-trust gaps remain** |

## Anti-Patterns Verdict

5-second AND 15-second tests pass. Detector: all 11 CLI findings classified FP/documented; in-page residuals are polish-grade (figcaption line-height 1.2 + 76 uppercase chars, 10.85px metadata trio, rail overflow-clip by design). Zero horizontal overflow at 6 widths; no transition:all; coherent z ladder; 21-stop keyboard cycle with no ghost stops; every contrast pair passes AA in both themes (thinnest: PAPER monogram 4.54); INK's coolness is now real (hue 250–257, chroma 0.014); prose measures exactly 72.0ch with wide blocks at full pane (812px); webfonts load (network-dependent, Georgia fallback offline).

## What's Working

1. **The undo grammar** — every destructive action leaves "✓ Accepted by James · file updated · Undo" in place of the buttons; correct under accept→undo→accept and undo at 60ms mid-settle. Linear-grade, actually implemented.
2. **The share error state as brand** — "the share didn't complete. Nothing left this machine" earns the E2E positioning in a failure state; error→retry→success→copy verified.
3. **One token source that survives inversion** — SVG diagram, syntax tokens, diff washes, scrollbar tint all re-derive per theme; PAPER/INK are siblings, not negatives.

## Priority Issues

- **[P1] Cross-file misfile:** comment posted on metrics.md lands silently in launch-plan.md's hidden rail (badge jumps 2→3, no visible card). Fix: per-file card tracking or block posting when the target track is hidden.
- **[P1] Resolve-all silently accepts every suggestion** — a document edit under a resolution verb; observed mutilating a sentence via a half-typed user suggestion. Fix: resolve comments only, skip/ask for suggestions; single bulk undo.
- **[P1] ⌘⇧. dead on real keyboards** — handler checks e.key === '.', Shift+Period emits '>'. Fix: e.code === 'Period'.
- **[P2] Esc is a demolition charge** — closes all layers at once, loses composer drafts; doesn't close the mobile drawer. Fix: topmost-only Esc chain including drawer.
- **[P2] No keyboard authoring path** — comment creation gates on mouse selection. Fix: palette command "Comment on current paragraph" or caret-based selection.
- **[P2] Palette lacks AT semantics** — no listbox/aria-activedescendant; focus not returned to trigger on close.
- **[P2] Share dialog receives no focus on open** (activeElement stays BODY).
- **[P3] T toggle inert after any click** (guard requires body focus); seeded ins anchor not focusable; popover lacks right-edge clamp; unanchored accept still claims "file updated"; toast overlaps drawer at 390 (z 65 > 55).

## Persona Red Flags

Alex: the two showpiece shortcuts most likely to be tried first (⌘⇧., T) both fail under real conditions; resolve-all edits his document. Sam: reading experience genuinely accessible; writing experience mouse-only; palette selection invisible to AT. James: cross-file misfile bites daily multi-file review; no pointer affordance to reopen a hidden rail on desktop (⌘J span is inert).

## Minor Observations

Toast overlaps drawer at 390; popover can cover the selection near the top; save-chip hidden ≤700 leaves phones without save status; sidebar still says "never leaves this machine" after a successful share (the popover's ciphertext-vs-key framing is the honest one); rail cards park cleanly when anchors scroll off; reduced-motion verified end-to-end.

## Questions to Consider

1. What does "resolve" mean for a suggestion? Cleanup and merge need different names and confirmations.
2. Should the rail hug the 72ch prose edge when no wide block is in view, and retreat when one is? (At 1600 there's a ~450px gulf between anchor and card.)
3. When a share link exists, whose truth is "never leaves this machine"?
