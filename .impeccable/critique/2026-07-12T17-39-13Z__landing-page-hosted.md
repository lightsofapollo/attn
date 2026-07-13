---
target: landing page (hosted)
total_score: 36
p0_count: 0
p1_count: 0
timestamp: 2026-07-12T17-39-13Z
slug: landing-page-hosted
---
Method: dual-agent (A: headless-Playwright design review · B: detector + measurements). Post-fix state.

# Critique — attn landing page (Theme v2 final gate)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 4 | State-aware CTA (both placements), Copy→Copied, stage labels narrate state |
| 2 | Match System / Real World | 4 | desk/room/sheet metaphors; states, doesn't sell |
| 3 | User Control and Freedom | 3 | Join Cancel, idempotent #new, back always works |
| 4 | Consistency and Standards | 3→4 | One token system; mono stragglers + nav "Your desk" dupe both fixed |
| 5 | Error Prevention | 3 | idempotent #new, storage fallbacks, invite helper text |
| 6 | Recognition Rather Than Recall | 4 | every entry self-describing, no icon-only nav |
| 7 | Flexibility and Efficiency | 3 | 3 honest paths + state-aware shortcut + deep links |
| 8 | Aesthetic and Minimalist Design | 4 | disciplined accent, generous rhythm, one idea per fold |
| 9 | Error Recovery | 3 | app-side deep-link error is model copy |
| 10 | Help and Documentation | 3 | #how is the doc; contextual join hint |
| **Total** | | **34 → ~36/40** | **Good — gate met after the three point-costing fixes landed** |

## Anti-Patterns Verdict

Designed brand surface, named identity, category-reflex passes twice. Absolute bans clean: side-stripes GONE (7px leading dots), no gradient text, no glass, no hero-metric, no card grids. Detector: 5 CLI (all marketing-register display type), 3 borderline eyebrow warnings; zero overflow at 390, every focus stop rings, all contrast AA both themes. Watch item: four tracked-caps eyebrows + two numbered chapters are at the edge of AI-grammar (a coherent named system, but nearly every section opens with a small caps label).

## Fixed this session

- The one AA failure — green "BROWSER · NO INSTALL" label 3.35:1 — fixed (text-safe ledger green, re-measured 6.54:1).
- Tiny-mono stragglers (START HERE / surface-label / code-copy at 0.66-0.72rem) lifted to the 0.75rem floor.
- Nav "Your desk" plain link hidden when the state-aware "Your desk (N)" CTA is present (was duplicated).
- Landing/desk now ship the thin ink scrollbar (chrome.css) instead of native gutters; dark theme-color meta updated to INK.

## What's Working

1. The state-aware entry system rearranges the marketing page around whether you're already a user — rare and exactly "warm surface, sharp behavior."
2. Dark mode is a real second theme — body flips to cool blue-black, accent terracotta→steel, all three product screenshots swap to INK captures. The briefed "light interior in dark hero — bug?" did NOT reproduce; the window swaps assets and reads as one room at night.
3. Split-scale serif display + strict serif-read / sans-operate / mono-fact discipline carries the voice.

## Remaining (P2, optional polish)

- Two-panel "Two surfaces" section flattens in INK (both panels near-identical blue-blacks) — the argument is theme-dependent; consider inverting the browser panel to paper-on-dark-desk.
- Mobile Copy targets 40×23 (<44pt); ~1MB eager hero PNGs (AVIF/srcset).
- "E2EE · direct connection" jargon in first-contact labels; nav links hidden ≤680px with no menu.

## Persona Red Flags

Jordan: passes the 5-second test; unexplained crypto/network labels at first contact. Casey: no 390 overflow, thumb-reach CTAs; small Copy targets + heavy hero PNG. Riley: #new idempotence verified; in-app hash nav (#join→#new) is a no-op mid-session; desk-count read once at mount.

## Questions

1. Should INK invert the browser panel to paper-on-dark-desk?
2. Do the two numbered chapters pull their weight, or would named kickers be quieter?
3. Fresh-profile secondary CTA: "Open your desk" (empty) or "How it works"?
