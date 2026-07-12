---
target: staging.attn.sh (hosted app, Theme v2 gate)
total_score: 25
p0_count: 0
p1_count: 2
timestamp: 2026-07-12T17-42-31Z
slug: staging-attn-sh
---
Method: dual-agent (A: headless-Playwright design review · B: detector + measurements) + parent relay-build re-verification.

# Critique — hosted attn app (desk + editor), Theme v2 final gate

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Save chip present + commits persist (relay build); transient dirty/saving not surfaced (attn-z0t); publish checklist excellent |
| 2 | Match System / Real World | 3 | desk/sheet/room warm; "Hybrid" jargon; literal "# " betrays the markdown promise (attn-vea) |
| 3 | User Control and Freedom | 3 | Escape/rename-cancel/delete-confirm good; publishing Discard/Resume exemplary |
| 4 | Consistency and Standards | 2 | Desktop vs mobile editor are different products (sans raw-text vs serif WYSIWYG) — attn-vea |
| 5 | Error Prevention | 3 | Join validates before navigating; backup gate principled |
| 6 | Recognition Rather Than Recall | 2 | Blank desktop editor gives zero affordances; no markdown-won't-parse hint |
| 7 | Flexibility and Efficiency | 2 | Deep links + tab order, but no command palette on desktop |
| 8 | Aesthetic and Minimalist Design | 3 | Desk/storage/share superb; editor canvas barren |
| 9 | Error Recovery | 2 | Join copy model; publishing-paused best-in-class; /s/ dead-end unstyled (was a no-relay bundle artifact) |
| 10 | Help and Documentation | 2 | Strong inline microcopy; no help surface |
| **Total** | | **25/40** | **Acceptable — gate NOT met; blocker is the tracked desktop-markdown-parity gap (attn-vea), not the Theme v2 visual layer** |

## Critical caveat on this score

Assessment A ran against a bundle built WITHOUT `VITE_ATTN_RELAY_URL` → `BrowserRelayUrlError` on bootstrap, which killed the owner session that autosave, the save chip, commits, and auto-rename all depend on. Parent re-verification with a relay-configured build CLEARED those artifacts: editor mounts, zero bootstrap errors, save chip present ("Saved on this device"), a commit persists (data-commits 0→1). So the following A findings were bundle artifacts, not design defects: "save-state decorative" (partly — commits work), the share ack-checkbox "detached at (0,0)" (sound markup: label wraps input; unhydrated fallback), and the /s/ unstyled dead-end (relay-absent).

## Anti-Patterns Verdict

Not slop — committed editorial identity on desk/storage/join/share (serif display, mono metadata, ghost sheet, one terracotta pencil, real grain). Detector B: 25 CLI findings (from 198; side-tab FP = blockquote), and empirically: prose 72.0ch cap holds, wide blocks full-pane, zero overflow at 1440/1024/768/390, thin ink scrollbars now ship, INK cool blue-black with steel — all AA both themes (after the green/danger text-safe fix landed this session).

## The real gate blocker (tracked, out of Theme v2 scope)

**attn-vea (P1/P0-for-positioning):** the desktop hosted editor doesn't parse typed markdown (# stays literal, no input rules/paste-as-markdown) and reads in sans, not serif — breaking the Read/Do rule and the agent-doc-reviewer positioning on the widest platform. The mobile editor proves the schema works. This cascades into attn-cjn auto-rename (no H1 to read from). It has its own web-editor-parity branch and is the honest reason the hosted editor's score sits below the gate — the Theme v2 visual layer itself passed.

## Fixed this session

Text-safe green/danger inks (light-mode AA), landing/desk thin ink scrollbars, INK theme-color meta; share-truth desk copy; #join panel; idempotent #new + state-aware CTA; owner review-rail transport-error surfacing + live counts.

## Persona Red Flags

Alex: no desktop palette; markdown-fluent typing stays literal (attn-vea). Jordan: best first-run desk, then a blank editor void; typed # silently literal reads as broken. Sam: strong focus/contrast/aria; share ack-checkbox connection (bundle artifact). James: everything AROUND the document is demo-grade; the document itself needs attn-vea.

## Questions

1. Which surface owns markdown fidelity — shared comrak WASM, or ProseMirror authoring + rendered reader mode as mobile implies?
2. Should the app degrade share/join affordances honestly when the relay is unreachable, instead of failing late?
3. Does the durability acknowledgment belong at share time, or at first workspace creation?
