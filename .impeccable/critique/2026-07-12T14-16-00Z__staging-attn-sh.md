---
target: staging.attn.sh (hosted web)
total_score: 19
p0_count: 2
p1_count: 3
timestamp: 2026-07-12T14-16-00Z
slug: staging-attn-sh
---
Method: dual-agent (A: staging design review · B: hosted detector/browser evidence)

# Critique — staging.attn.sh (hosted web build)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Save/share chips excellent; owner gets zero indication reviewer comments exist (silent 400) |
| 2 | Match System / Real World | 3 | Desk/room metaphors strong; "Encrypted mailbox", "Hybrid delivery" protocol-speak leaks into first-run UI |
| 3 | User Control and Freedom | 1 | New-workspace accumulation has no undo; delete confirm renders below fold; no keyboard route editor→desk |
| 4 | Consistency and Standards | 1 | Same object is workspace/project/desk/room; desktop edits sans, mobile edits serif; #join dead |
| 5 | Error Prevention | 1 | `#new` is a GET-that-mutates; nothing prevents minting identical empty Untitled workspaces |
| 6 | Recognition Rather Than Recall | 1 | Four identical `Untitled · 1 file · Local only` rows; no auto-name from H1; no previews |
| 7 | Flexibility and Efficiency | 1 | Cmd+K dead everywhere; no visible shortcuts; Cmd+B works but undiscoverable |
| 8 | Aesthetic and Minimalist Design | 3 | Landing/desk/storage disciplined; editor an empty void; share dialog ~12 options in one modal |
| 9 | Error Recovery | 3 | "NOT ON THIS DEVICE" deep-link state is model copy; comment-sync 400 completely silent |
| 10 | Help and Documentation | 2 | Good inline markdown hint (that confesses missing rules); reviewer gets no "select text to comment" |
| **Total** | | **19/40** | **Poor — major UX work required on the working surfaces** |

## Anti-Patterns Verdict

Split verdict. Landing/desk/storage/mobile-reader would pass a Linear/Figma-fluent sniff test: real editorial identity (Source Serif display, paper `rgb(233,228,218)`, ink, rust CTAs, mono micro-labels), confident copy, zero stock gradients. The **desktop editor** is where a fluent eye says "shadcn default": all-sans body, measured `max-width: 1078px` (~135 CPL), browser-blue selection, grey Comment pill overlapping text, blue-accented thread cards in a rust/ink product.

Detector (198 findings over hosted source): 101 off-palette colors (heavily `var(--x, #2563eb/#dc2626/#16a34a)` shadcn-blue fallback literals in review components), 65 off-ramp font sizes (9–18px px-regime in review components/badges), 27 off-scale radii, 5 side-tab accent stripes (2 are conventional blockquotes = FP). Live-page injection (CSP forced CDP evaluate; worked): landing 9 findings (eyebrow chips, 11px tiny-text, 3px stage-label stripes, skipped h1→h3), editor 6 (transition:width on sidebar = layout thrash, 10.85px hint text, flat type hierarchy, nested cards). `confirm()/alert()`: 0. Muted text 5.7:1 (passes) but rendered at 11–12px.

## Priority Issues

- **[P0] Owner never receives reviewer comments in the hosted editor.** Reviewer posts via share link; owner reopens: no rail, no badge, silent console 400. The core promise fails invisibly. Fix: persistent owner review rail + synced thread count + arrival toast; surface mailbox errors first-class.
- **[P0] "New workspace" always creates.** Landing's primary (and mobile-only) CTA → `/app#new` unconditionally mints workspace + untitled.md; bookmarks/back re-trigger; empties never coalesced; never auto-named. Fix: state-aware CTA ("Your desk (4)" primary when workspaces exist), idempotent #new (reuse most recent empty Untitled), auto-name from first H1.
- **[P1] "Join a review" is a dead click** — landing card and desk card both navigate to `/app#join` which renders the desk unchanged. Fix: paste-a-link modal or remove the card.
- **[P1] Editing surface off-brand and typographically unbounded** — sans body, 135 CPL; mobile edit mode is serif, proving intent. Fix: centered ~68ch serif column matching mobile reader.
- **[P1] Markdown affordance mismatch** — `**bold**` stays literal, lists render without visible markers; toolbar hint admits only 3 block rules. Fix: full inline input rules + paste-as-markdown + visible markers.
- **[P2] Review affordances unstyled at the emotional core** — blue selection, grey overlapping Comment pill, blue thread cards, unbranded reviewer bar. Fix: brand tokens for selection/highlight/composer; wordmark in reviewer bar.
- **[P2] Delete confirm below the fold; no undo anywhere.** Fix: modal or row-anchored popover + 10s undo toast.
- **[P2] No command palette, no shortcut surface.** Fix: ⌘K palette + `?` shortcut sheet.

## Persona Red Flags

- **Alex (power user):** ⌘K dead; "All workspaces" buried two clicks deep; no bulk-delete for the Untitled pile; leaves for a folder of .md files.
- **Jordan (first-timer from a link):** unbranded reviewer page, "Encrypted mailbox" jargon, passive "No review threads on this file.", nothing says select-text-to-comment, no link home.
- **Sam (keyboard/SR):** good landmarks/focus rings/Escape; but 4 identical "Untitled" accessible names, icon-only share control, below-fold delete confirm is a focus hazard.
- **James (daily owner):** the review never arrives (P0); agent markdown renders half-literal; 135-char lines tire long-doc review; Untitled pile is the "pieces, not product" failure mode.

## Minor Observations

Share dialog shows stale `0 B` size at first open; "Search projects..." is the only "projects" in the app; teal "Backup recommended" is a fourth accent used nowhere else; editor empty state is a void; full-width unicode ＋↥↗ glyphs read tofu-risk; desk row actions 28px tall (<44px); zero animations at idle (no motion system); typed text can vanish on fast navigate (debounced save without flush); thread card not aligned to its anchor.

## Questions to Consider

1. Should the browser build have "workspaces" at all — or just "your documents," flat, auto-named, deduped?
2. Why does the owner edit in a different typeface than everyone reads?
3. What is the first 60 seconds of a comment's life — and who tells the owner it exists?

## Theme Assessment

Palette is 90% on-brand (paper/ink/rust light; warm brown-black dark with salmon CTA). Gap: the desktop editor abandons serif, measure, and brand tokens; zero motion so "sharp behavior" has no felt texture; teal status accent off-palette; hosted dark (warm brown) disagrees with DESIGN.md INK (cool blue-black).
