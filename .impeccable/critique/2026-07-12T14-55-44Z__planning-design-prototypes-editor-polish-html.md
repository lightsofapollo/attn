---
target: editor-polish prototype (as committed)
total_score: 22
p0_count: 2
p1_count: 4
timestamp: 2026-07-12T14-55-44Z
slug: planning-design-prototypes-editor-polish-html
---
Method: dual-agent (A: design review via headless Playwright · B: detector + measured evidence)

# Critique — planning/design/prototypes/editor-polish.html (Theme v2 editor prototype, as first committed)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 2 | Save chip works; thread counts desync after Accept (rail "1 open" vs badge "2" vs doc-meta "2 open threads") |
| 2 | Match System / Real World | 4 | Review vocabulary and E2E-local copy genuinely excellent |
| 3 | User Control and Freedom | 2 | Accept is instant and irreversible; toast auto-dismisses with no recall |
| 4 | Consistency and Standards | 2 | Shortcut hints everywhere; only ⌘K/T/Esc actually work — hints that lie |
| 5 | Error Prevention | 1 | One-click irreversible "file write"; `t` hotkey fires while buttons have focus |
| 6 | Recognition Rather Than Recall | 3 | Palette lists commands + accelerators; sidebar/outline give scent but are dead |
| 7 | Flexibility and Efficiency | 1 | Palette typing/↑↓/↵ dead; all advertised accelerators dead; outline no-op |
| 8 | Aesthetic and Minimalist Design | 4 | 68ch measure, restrained accent, grain felt-not-seen — strongest axis |
| 9 | Error Recovery | 1 | Zero error states in an E2E-encrypted sync product |
| 10 | Help and Documentation | 2 | Palette footer legend good; "? all shortcuts" dead |
| **Total** | | **22/40** | **Acceptable band — static composition excellent, interaction collapses under contact** |

## Anti-Patterns Verdict

Visually no slop ("passes the 5-second test"); interactively partial theater ("fails the 15-second test"). Deepest honesty problem: no @font-face — the type identity silently rendered Georgia/system-ui/Courier (measured by glyph-width fingerprint). Detector: 9 CLI findings (7× 2px radius — 4 documented in DESIGN.md prose; em-dash and flat-type-hierarchy counts are FPs from CSS comments and unparsed `font:` shorthand). In-page: 8 findings/theme (cramped padding on toggle/badge rows, tiny-text at 10.85px), text-overflow on breadcrumb at 900px (intentional ellipsis).

## Priority Issues (as found)

- **[P0] No responsive story.** Fixed 232/1fr/300 grid, zero media queries: 768px → 140px prose column; 390px → 364px horizontal overflow, rail painted over prose.
- **[P0] Keyboard broken both directions.** Hidden popover/toast buttons ARE tab stops (opacity 0, still focusable); visible sidebar/outline rows and comment anchors are NOT focusable at all.
- **[P1] Command palette is a stage prop.** Typing filters nothing, arrows dead, Enter dead, items dead; role=dialog without aria-modal or focus trap.
- **[P1] Accept irreversible with no undo** — the product's one destructive action.
- **[P1] Fonts not shipped** — the entire stated type system was a fallback illusion.
- **[P1] INK fails AA in 6 places** (faint tier 3.46–3.90, monograms 3.29–3.37, code comments 3.67); PAPER amber badge 2.35:1.
- **[P2] Selection popover detaches on scroll; Comment/Suggest discard the selection silently.**
- **[P2] Rail cards not anchored to text** (259px vertical miss on t1) — the category-defining behavior missing.

## Persona Red Flags

Alex: dead palette discovered in seconds; every accelerator except ⌘K/T/Esc decorative; file switch no-op. Sam: ghost tab stops + unreachable nav; dialog without trap; INK metadata illegible. James: Courier code blocks; count desync; no relay-down state; Accept-no-undo hazardous for bulk agent-suggestion review.

## Minor Observations

Breadcrumb duplicates H1; "(4)" unlabeled; ⌘J chip unwired; veil too light; toast right hardcoded to rail width; peer avatars the only Notion-pastel note; grain z-order (above content, below floats) reads intentional and works.

## Questions

1. If the rail never aligns to anchors, why is it a rail?
2. What are the five verbs that must be instant, and why does the palette advertise "New file" instead of them?
3. Is the accent allowed to change hue across themes (terracotta→steel) as a deliberate identity statement?

## Theme fidelity

PAPER is the identity (all sampled pairs but the badge pass AA). INK measured effectively neutral-black (chroma 0.005 — "cool blue-black" was homeopathic) with 6 AA failures; steel accent correct.

---

*Post-critique fix pass (same session): fonts shipped via @font-face import; responsive collapse at 1100/900/700 (390px overflow 0); ghost stops removed (visibility) + rows/anchors focusable; palette made real (filter/↑↓/↵/actions/trap); undo on accept/reject/resolve; counts single-sourced; rail cards anchor-aligned (measured exact); INK re-tuned (faint 5.89, monograms 7.63, badge 7.06; bg chroma raised to 0.014); popover hides on scroll; composer posts real comments/suggestions; share flow with designed error→retry→success; delight: pencil-stroke strikethrough, check pop, anchor pulse, wordmark caret, console line. Re-run critique to score the fixed state.*
