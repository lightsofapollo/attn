---
target: desk page (hosted /app)
total_score: 20
max_score: 40
na_heuristics: 
p0_count: 3
p1_count: 4
timestamp: 2026-08-04T23-40-27Z
slug: desk-page-hosted-app
---
Method: dual-agent (Assessment A design review and Assessment B detector/browser evidence as isolated sub-agents) plus a technical audit agent. Browser evidence via Playwright + system Chrome against the production build across empty / populated / invite-open / delete-confirm states in both themes; claude-in-chrome was not connected.

Register: OPERATE. Judged as a tool opened fifty times a week.

## Design Health Score — 20/40 (all ten applicable)

| # | Heuristic | Score | Key issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | best-effort returns warn:false, so "Backup recommended" paints the same green as "On this device" |
| 2 | Match System / Real World | 3 | U+21A5 glyph reads as mojibake; Local only / Backed up / Shared have no legend |
| 3 | User Control and Freedom | 2 | Escape does not close the join panel; closeJoin() never restores focus |
| 4 | Consistency and Standards | 1 | Join panel is a foreign system (10px radius, raw px) inside a rem/0-radius desk; serif buttons |
| 5 | Error Prevention | 2 | role="alertdialog" with no focus move and no Escape; rename commits on blur |
| 6 | Recognition Rather Than Recall | 2 | Mobile deletes file count and last-edited from a list titled "Recently on this device" |
| 7 | Flexibility and Efficiency | 0 | Zero keyboard affordances on the whole desk; no palette, filter, sort or search |
| 8 | Aesthetic and Minimalist Design | 2 | 558px of chrome before the first workspace name; 813px on iPhone — payload below the fold |
| 9 | Error Recovery | 3 | Join error copy is genuinely good and role="alert"-ed; import error is an inline-styled p |
| 10 | Help and Documentation | 2 | Nothing explains what "Backup recommended" wants you to do, or that Storage fixes it |

Total 20/40 — Acceptable band, and the 0 on heuristic 7 is the headline: this is a keyboard-first product's most-opened surface with no keyboard model.

## Design Specificity Verdict

Authored from the fold up; a generic "recent projects" list below it. The masthead is unmistakably attn — "Your desk" at 72px Source Serif over a hairline rule, mono storage line on the baseline, rust eyebrow. Then the payload arrives and the authorship stops: .workspace-row is a four-column div-table with no header, no hover (the hover CSS targets a.workspace-row and the element is a div — dead rule), no keyboard model, no search, and Rename/Delete stamped on every line. Strip the serif and it is any project list.

Three tells: the accent is spent on a static eyebrow and withheld from the primary action (One Pencil inverted); buttons are set in 400-weight serif (Read/Do violated); four chrome roles are set in mono while the system's label token is used zero times.

The deeper gap: the desk shows no review state at all, and WorkspaceSummary (types.ts:36-47) carries no review facts to show. A desk that lists files instead of reviews in flight is a file manager wearing attn's typeface.

## Audit evidence

Detector: 1 finding on web/src/hosted/app, verified false positive (blockquote rule using the neutral --rule token, not on the desk). Zero true positives.
Contrast: 31 text styles measured across four state/theme combinations — zero failures, lowest 5.23:1. The perceived washed-out metadata is small uppercase mono with wide tracking, not a WCAG problem.
Overflow: clean at 320/375/390/768/1024/1280, zero offending elements.
Console: zero errors, warnings or failed requests across all eight state/theme combinations.
Touch targets at 390: Rename 57.2x27.6, Delete 47.6x27.6 (0.6rem apart, destructive, irreversible), row-open 26px tall, join-go 60x37.

## Priority Issues

- [P0] Join panel has 64px above it and 0px below — .folio-label owns no margin and borrows it from .quick-actions via sibling collapse.
- [P0] No keyboard model at all on the surface a keyboard-first power user opens most.
- [P0] Rename/Delete announce no workspace name — a screen-reader user cannot tell which workspace is about to be irreversibly deleted.
- [P1] "Backup recommended" is painted in the safe-state green, and there is no backup affordance on the desk.
- [P1] The workspace row: dead hover CSS, a 200x28px open target in an 80,000px² row, resident admin controls heavier than the content.
- [P1] Mobile puts the first workspace at y=813 in an 844px viewport.
- [P1] The desk exposes no review state; the data model has nowhere to put one.

## What's Working

Colour token discipline is excellent and could not be broken — every text pair clears AA in both themes, most clear AAA, and the "never lighter than oklch(0.32 0.012 65)" floor is held exactly. Focus-visible is complete: 16 Tab stops, every one drawing a 2px ring, correctly recoloured to steel in INK. The privacy copy earns its place without a badge wall — "Shared · relay sees only ciphertext" and "The part after # is the room key — it never reaches the relay" are the best-written text in the product. The empty-desk composition (tilted sheet, "What deserves your attention?") is a genuinely authored moment.
