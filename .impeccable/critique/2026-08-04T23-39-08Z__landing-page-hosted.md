---
target: landing page (hosted)
total_score: 20
max_score: 36
na_heuristics: 9
p0_count: 2
p1_count: 5
timestamp: 2026-08-04T23-39-08Z
slug: landing-page-hosted
---
Method: dual-agent (Assessment A design review and Assessment B detector/browser evidence run as isolated parallel sub-agents), plus a two-agent technical audit (a11y+responsive, perf+theming+integrity). Browser evidence via Playwright + system Chrome against the production build; the claude-in-chrome extension was not connected. No user-visible overlay was produced — the in-page detector ran headless.

## Design Health Score — 20/36 applicable

| # | Heuristic | Score | Key issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 2 | CopyCode aria-label frozen at "Copy <cmd>"; zero aria-live regions; nav has no active-section state |
| 2 | Match System / Real World | 2 | Four nouns (desk/workspace/room/document), "workspace" overloaded, "desk" used 4x defined 0x |
| 3 | User Control and Freedom | 3 | Anchors and theme persistence work; global smooth scroll; all nav links display:none <=680px |
| 4 | Consistency and Standards | 2 | Landing has forked four DESIGN.md named rules; five terracotta elements on the fold |
| 5 | Error Prevention | 3 | Little to get wrong; clipboard failure swallowed by an empty catch |
| 6 | Recognition Rather Than Recall | 2 | The one artifact showing what a review IS is cropped through its own text; unglossed protocol vocabulary |
| 7 | Flexibility and Efficiency | 1 | Page branches on readDeskCount() for returning users, then serves them the identical 6,100px scroll |
| 8 | Aesthetic and Minimalist Design | 3 | Genuinely restrained; 18 non-code mono strings; three identical /app#new CTAs in 1.5 screens |
| 9 | Error Recovery | n/a | Zero forms, zero inputs, zero user-visible async operations — no error surface exists |
| 10 | Help and Documentation | 2 | A no-account E2EE tool with no docs, no FAQ, no threat model, no security page |

Total 20/36 (56%) — Acceptable band. Visual craft sits well above that number; information architecture and the demonstration of behaviour drag it down.

## Design Specificity Verdict

Well-made and under-authored. Roughly 70% could ship for any local-first dev tool with the nouns swapped, and the 30% that is attn's is spent on the wrong argument.

The damning fact, verified: "agent" and "AI" appear ZERO times on the page. PRODUCT.md positions attn as "the reviewer for agent-authored docs… human comments and AI suggestions in a single end-to-end-encrypted thread". The page argues "private local markdown editor with sharing" — a category with a dozen occupants. Even the hero screenshot shows only human reviewer cards.

Interchangeable structures: the eyebrow->oversized-headline->lede->button-pair->micro-proof hero with a rotated window screenshot; the three-up entry triptych; numbered 01/02/03 how-it-works; the two-up comparison with one panel inverted to near-black; the brew-install section; accent-mono chapter indices.

Genuinely authored: the paper ground and grain, the two-tier h1 (line two at 0.78em), the 6rem serif masthead, the Surfaces ground-colour inversion. All surface. The brand is "warm surface, sharp behavior" and the page ships only the surface — two interactions in 6,100px of scroll, zero @keyframes.

Deterministic scan: CLI detector returns 0 findings on web/src/hosted/landing, but that zero is a scope artifact — the landing's styling lives in chrome.css/tokens.css outside the scanned paths, and the rules that matter are render-time. Injected into the live page the detector found 4: hero-eyebrow-chip (genuine), all-caps-body x2 (false positives — 31/32-char kickers, which is what the rule says uppercase is for), cream-palette (false positive — DESIGN.md specifies oklch(0.905 0.010 78) with chroma deliberately held at 0.010 to read as paper, not cream). All three eyebrow findings originate from one CSS rule at chrome.css:98-103.

## Audit Health Score — 14/20

| # | Dimension | Score | Key finding |
|---|-----------|-------|-------------|
| 1 | Accessibility | 3 | 37 text styles measured, one contrast failure (decorative window dots); five AA-tier defects |
| 2 | Performance | 3 | LCP 1932ms / CLS 0.0027 / TBT 5ms on Fast 3G+4x CPU; hero sizes over-fetches 1.5x; 7.5MB dead PNGs |
| 3 | Responsive Design | 3 | Zero overflow at eight widths; 184px h-scroll at 200% text; 500px breakpoint gap with a real collision |
| 4 | Theming | 2 | Zero hard-coded colours, but three named rules broken systemically plus the INK bootstrap flash |
| 5 | Implementation Integrity | 3 | Detector clean and verified real; hero crop; duplicated window chrome; a public alternate homepage |

## Priority Issues

- [P0] The positioning is absent from the positioning surface (zero mentions of agent/AI).
- [P0] The hero screenshot is cropped through its own text on both edges — object-fit:cover on a 1.333 source in a 1.025 box.
- [P1] E2EE asserted four times, demonstrated zero times; no threat model, no security page.
- [P1] Mobile navigation disappears entirely below 680px with no replacement.
- [P1] 200% text produces 184px of horizontal scroll and an unreachable CTA at 390px (four grids use 1fr instead of minmax(0,1fr)).
- [P1] Dark-mode visitors see a full paper-white paint before INK applies; no prefers-color-scheme fallback exists.
- [P1] Eight controls miss 44x44; four miss the WCAG 2.2 24px floor. Only .button carries a size rule.

## Persona Red Flags

Jordan: clicks "Open your desk" — a word used four times and defined zero times — and the nav surfaces the empty desk most prominently to the person least equipped to read it. Riley: tests the E2EE claim first and finds nothing testable; presses Copy with permission denied and gets silence. Casey: no navigation at all, 6,100px of scroll, the only reachable controls top-right and undersized. James (PRODUCT.md's primary user): the returning path is one swapped nav label; no recent files, no keyboard entry, no Cmd-K, on the homepage of a keyboard-first product.

## What's Working

Token discipline is real — zero hard-coded colours across landing.css and all ten landing components; dark mode is a second design rather than an inversion; AA holds at all 24-37 sampled roles in both themes with the AA-retune documented in-comment. Focus indication is complete: all 17 tabbable controls draw a 2px ring at 5.30-8.18:1. The route-bundle boundary is real and gated pre-deploy at 25.9KB brotli. The side-stripe antipattern was anticipated and avoided on purpose, with the reasoning written into the CSS.
