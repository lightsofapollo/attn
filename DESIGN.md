---
name: attn
description: A native, end-to-end-encrypted collaborative markdown reviewer — warm paper surface, precision-tool behavior.
colors:
  primary: "oklch(0.48 0.14 28)"
  primary-foreground: "oklch(0.98 0.005 78)"
  paper-bg: "oklch(0.905 0.010 78)"
  ink: "oklch(0.14 0.008 55)"
  muted-ink: "oklch(0.32 0.012 65)"
  card: "oklch(0.89 0.012 76)"
  sidebar: "oklch(0.855 0.012 75)"
  code-block: "oklch(0.885 0.012 73)"
  border: "oklch(0.14 0.008 55 / 18%)"
  link: "oklch(0.38 0.04 55)"
  destructive: "oklch(0.55 0.20 27)"
  suggestion-green: "oklch(0.58 0.15 150)"
  comment-amber: "oklch(0.62 0.13 82)"
  peer-owner: "oklch(0.58 0.14 32)"
  peer-reviewer: "oklch(0.56 0.11 235)"
  peer-agent: "oklch(0.57 0.13 295)"
  participant-clay: "oklch(0.58 0.14 32)"
  participant-amber: "oklch(0.60 0.12 70)"
  participant-olive: "oklch(0.58 0.11 110)"
  participant-green: "oklch(0.56 0.12 150)"
  participant-teal: "oklch(0.56 0.11 185)"
  participant-steel: "oklch(0.56 0.11 218)"
  participant-blue: "oklch(0.56 0.11 250)"
  participant-plum: "oklch(0.57 0.13 325)"
  participant-berry: "oklch(0.58 0.14 358)"
typography:
  display:
    fontFamily: "Source Serif 4 Variable, Source Serif 4, Georgia, serif"
    fontSize: "2rem"
    fontWeight: 700
    lineHeight: 1.18
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Source Serif 4 Variable, Source Serif 4, Georgia, serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.24
    letterSpacing: "-0.015em"
  title:
    fontFamily: "Source Serif 4 Variable, Source Serif 4, Georgia, serif"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Source Serif 4 Variable, Source Serif 4, Georgia, serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.72
    letterSpacing: "0.003em"
  label:
    fontFamily: "Source Sans 3 Variable, Source Sans 3, -apple-system, system-ui, sans-serif"
    fontSize: "0.7rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0.06em"
  mono:
    fontFamily: "Source Code Pro Variable, Source Code Pro, SF Mono, Consolas, monospace"
    fontSize: "0.85rem"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "normal"
rounded:
  micro: "2px"
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "14px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.md}"
    padding: "0.7rem 1.05rem"
    height: "46px"
  button-primary-hover:
    backgroundColor: "oklch(0.42 0.15 28)"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.md}"
  button-secondary:
    backgroundColor: "oklch(0.89 0.012 76 / 45%)"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0.7rem 1.05rem"
    height: "46px"
  input-field:
    backgroundColor: "oklch(0.905 0.010 78 / 84%)"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "6px 12px"
    height: "32px"
  review-card:
    backgroundColor: "oklch(0.94 0.010 76 / 96%)"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "16px"
---

# Design System: attn

## 1. Overview

**Creative North Star: "The Lit Reading Room"**

attn is a private study where documents are read closely and marked by hand — warm paper under a desk lamp, ink that dried a century ago, a single red pencil for the one mark that matters. The surface is unmistakably editorial: a true paper ground (`oklch(0.905 0.010 78)`), near-black ink, Source Serif for everything you *read*, and a faint fractal-noise grain laid over the whole window so it never reads as a flat webapp. But the *behavior* under that surface is a precision instrument. This is a tool its owner lives in daily; it must respond like Linear or Raycast — instant, exact, keyboard-first — while looking like a well-set page. **Warm surface, sharp behavior.** The calm is in what you see; the sharpness is in what you do.

The system runs two themes from one identity: **PAPER** (default, warm parchment, `color-scheme: light`) and **INK** (opt-in dark, a cool blue-black study, `color-scheme: dark`). They are not two designs — they are the same room at two times of day. The accent shifts with them: warm terracotta on paper, steel blue in the dark.

This system explicitly rejects three neighbors. It is **not a cloud-SaaS review tool** (Google Docs): no account-wall chrome, no toolbar density, no assumption the document lives on someone else's server. It is **not an IDE** (VS Code): no activity bars, no panels-in-panels, the reading column is the hero and chrome earns its place. And it is **not rounded-pastel productivity** (Notion): warmth here comes from paper and type, never from candy-colored blocks or emoji.

**Key Characteristics:**
- Serif for reading, sans for chrome, mono for code — a strict three-role split.
- One accent (terracotta / steel), spent only on action, selection, and state — never decoration.
- A real paper grain overlay unifies every surface, including the browser build.
- Fixed rem type scale (product register): headings don't fluidly resize in a sidebar.
- A dedicated review vocabulary: inline tracked-change marks, margin cards, role-colored peer avatars.

## 2. Colors

A warm parchment field carrying near-black ink and a single terracotta accent; cool review hues (green, amber, blue, violet) are quarantined to the collaboration layer so they never dilute the editorial ground. All values are canonical **OKLCH** — attn is OKLCH-native and the frontmatter carries OKLCH directly.

**Paper / Ink / System.** Appearance is a three-state preference (Settings → Appearance), defaulting to **System** — the app follows the OS appearance and tracks changes to it live. The preference is durable (`prefs.json`, next to the project registry) and is stamped into the page before the bundle loads, so launching never shows a frame of the wrong theme. `light`/`dark` are explicit overrides that ignore the OS.

### Primary
- **Terracotta Pencil** (`oklch(0.48 0.14 28)`, INK theme `oklch(0.72 0.10 220)` steel blue): the one accent. Primary buttons, current selection, checked checkboxes, focus rings, the "shared for review" marker. Warm red-clay on paper; it becomes a cool steel blue in dark mode because a saturated red-clay glows unpleasantly against a near-black ground.

### Secondary
- **Ledger Green** (`oklch(0.58 0.15 150)`): suggestion / insertion. Inline `ins` marks, the suggestion accent on review cards, "added" ghost text. Reads as *accepted into the record*.
- **Margin Amber** (`oklch(0.62 0.13 82)`): comment. The comment-highlight tint behind anchored text and the comment accent on review cards. Reads as *a note in the margin*, distinct from a proposed edit.

### Tertiary — Peer identity
Human participants each carry a **personal color** so two reviewers are never the same blue; agents keep a fixed violet. All hues share one envelope — L 0.56–0.60, C 0.11–0.14 — so white monogram text clears WCAG AA 4.5:1 on every swatch in both themes.

**The participant palette** (nine hues, ~35° apart, deliberately skipping the 280–310 violet band reserved for agents). A participant's color is their picked swatch if they chose one, else a deterministic hash of their participant id into this ramp — identical on every client, and identical across chips, carets, selections, and comment-card accents:
- **Clay** `oklch(0.58 0.14 32)` (also the legacy owner hue) · **Amber** `oklch(0.60 0.12 70)` · **Olive** `oklch(0.58 0.11 110)` · **Green** `oklch(0.56 0.12 150)` · **Teal** `oklch(0.56 0.11 185)` · **Steel** `oklch(0.56 0.11 218)` · **Blue** `oklch(0.56 0.11 250)` · **Plum** `oklch(0.57 0.13 325)` · **Berry** `oklch(0.58 0.14 358)`

Role is no longer a color channel for humans — shape carries it (round = human, hex = agent), and the self chip keeps its ring. Legacy role tokens remain for non-roster surfaces:
- **Owner Clay** (`oklch(0.58 0.14 32)`): legacy owner token (landing demos, sidebar badges).
- **Reviewer Steel** (`oklch(0.56 0.11 235)`): legacy reviewer token (generic "someone is here" badges, not personal identity).
- **Agent Violet** (`oklch(0.57 0.13 295)`): an agent participant — visibly non-human, never second-class. Never used for humans.

### Neutral
- **Paper** (`oklch(0.905 0.010 78)`): the body ground. Faintly warm, chroma held at 0.010 so it reads as paper, not cream.
- **Ink** (`oklch(0.14 0.008 55)`): body text, strong rules, the native side panel.
- **Muted Ink** (`oklch(0.32 0.012 65)`): secondary text, labels, table headers. Sits at ~4.5:1 on paper — the floor for body, never lighter.
- **Card / Sidebar** (`oklch(0.89 0.012 76)` / `oklch(0.855 0.012 75)`): the second neutral layer for chrome, a hair darker than the content surface so panels recede.
- **Code Block** (`oklch(0.885 0.012 73)`): inline code and `pre` ground.
- **Border** (`oklch(0.14 0.008 55 / 18%)`): hairline dividers — ink at low alpha, never a solid gray line.

### Named Rules
**The One Pencil Rule.** The primary accent is a red pencil, not a highlighter. It appears on primary action, current selection, and focus — nowhere else. If two things on a screen are terracotta, one of them is wrong.

**The Quarantine Rule.** Green, amber, and the peer hues belong to the collaboration layer only. They never appear as decoration on base chrome; their meaning (suggestion / comment / who) is the entire reason they exist.

**The Warm-Paper, Not-Cream Rule.** The ground holds chroma ≤ 0.012. The moment it drifts warmer it becomes the saturated AI cream default. Warmth is carried by the accent and the serif, not by the background.

## 3. Typography

**Reading Font:** Source Serif 4 Variable (with Georgia, serif)
**Chrome Font:** Source Sans 3 Variable (with system-ui)
**Code Font:** Source Code Pro Variable (with SF Mono, Consolas)

**Character:** One superfamily, three cuts, cleanly separated by *job*. The serif carries everything the user reads (document body, headings, the review prose); the sans carries everything that is *interface* (sidebar, nav, breadcrumbs, table headers, buttons, labels); the mono carries code. Because all three are Adobe's Source superfamily they share proportions and rhythm — the pairing is by contrast of role, not by clash of voice. Base size is a deliberate `15.5px`, user-scalable via ⌘+ / ⌘- / ⌘0.

### Hierarchy
- **Display / h1** (700, `2rem`, 1.18, `-0.02em`): document title, top of the reading column. Fixed rem — it must not fluidly shrink inside a pane.
- **Headline / h2** (600, `1.5rem`, 1.24, `-0.015em`): major section.
- **Title / h3** (600, `1.25rem`, 1.3, `-0.01em`): subsection.
- **Body** (400, `1rem`, **1.72**, `0.003em`): the reading surface. Generous leading and a whisper of tracking make long-form markdown restful. Serif.
- **Label** (600, `0.7rem`, `0.06em`, UPPERCASE): table headers, meta chips, sidebar section markers. Sans.
- **Mono** (400, `0.85rem`, 1.55): code blocks and inline code.

### Typeset presets
The three cuts above are the **Editorial** preset — the default, and the shape every rule in this section describes. Settings offers two alternates (shadcn's typeset model: a preset is a complete reading system, never a pile of independent font knobs):

- **Editorial** — the default described above. Declares no overrides, so it cannot drift from the canonical tokens.
- **Modern** — sans for reading as well as chrome, with display sizes pulled in and tracking tightened (serif display scale reads oversized in sans). For readers who want a code-review tool rather than a manuscript.
- **Compact** — Editorial's fonts at a denser scale and leading, on a narrower measure. For dense ops docs.

Presets live in `web/styles/typeset.css`, keyed off `data-typeset` on `<html>`, and only ever redefine existing tokens. They are orthogonal to light/dark (which owns color) and to the ⌘+/⌘- font scale (which multiplies `--attn-base-font-size`) — all three compose.

### Named Rules
**The Read/Do Rule.** If the user is reading it, it's serif. If the user is operating it, it's sans. There is no third case; a button never uses the serif, a heading in the document never uses the sans. (A preset may change *which* face reads as the serif — Modern makes it a sans — but never which role gets the reading face.)

**The Scoped-Document Rule** (2026-08-04). Document typography is scoped to `.attn-doc` — the class the editor mount and the viewer article carry. Bare `p` / `h1` / `ul` / `li` selectors are never global: chrome rendered in the same tree used to inherit 2rem heading gaps and absolutely-positioned list bullets that escaped their card, and each leak got patched individually until an opt-out class existed purely to undo the defaults. Type the document, not the page.

**The Fixed-Scale Rule.** Product register: headings are fixed rem, not `clamp()`. Users view at consistent DPI inside panes and windows; a fluid h1 that shrinks in a sidebar looks worse, not better.

**The Wide-Sheet Rule** (decided 2026-07-12). The reading surface is full-width and left-set, never a centered narrow column: all content — running prose *and* wide blocks (mermaid diagrams, tables, code) — shares one column capped at the `--content-measure` token (1100px); oversized tables/code scroll inside it. (Revised 2026-07-13 from the original split layout — 72ch prose beside full-pane blocks — which read as ragged whenever a wide block was on screen.) The `micro` (2px) radius is the mark family for inline review marks, focus rings, and accent bars.

## 4. Elevation

A hybrid: mostly flat tonal layering (chrome recedes by being a step darker than content, not by floating), with a small, restrained shadow vocabulary reserved for genuinely-lifted surfaces — review cards, dialogs, dropdowns — and soft *inset* shadows that make code blocks and inputs read as pressed into the paper. The paper-grain overlay (a fixed fractal-noise SVG at `--grain-opacity`) sits above everything as the unifying texture; it is not elevation but it is why nothing looks like flat plastic.

### Shadow Vocabulary
- **Review-card lift** (`box-shadow: 0 16px 42px oklch(0.20 0.02 55 / 16%), 0 1px 0 oklch(1 0 0 / 45%) inset`): the margin review cards — a diffuse ambient drop plus a top inset highlight so the card reads as a physical slip of paper laid on the page.
- **Panel soft** (`0 20px 60px rgba(48,41,34,0.10)`) / **Panel strong** (`0 30px 90px rgba(48,41,34,0.16)`): floating dialogs and the shared-window chrome.
- **Pressed inset** (`inset 0 1px 3px oklch(0 0 0 / 4%)`): code blocks and search inputs — a slight recess, not a raise.

### Named Rules
**The Flat-Until-Lifted Rule.** Surfaces are flat and tonal at rest. A shadow appears only when something is genuinely floating above the page (a card, a dialog, a menu) or genuinely pressed into it (an input, a code block). Shadow is a statement about physical position, never a decorative gradient of depth.

**The Truth Rule** (behavioral, attn-hg5). Pixels always equal state: no user-visible fact — a modal open, a comment arrived, a file saved — may depend on an animation completing or a debounce flushing. Closed overlays are `display: none` in plain CSS (`[data-state="closed"]`); theme flips are atomic (transitions suppressed for the flip frame); animation is enhancement, never the carrier of state. Occluded windows freeze the animation clock, so anything less soft-locks the app.

**The Topmost-Escape Rule.** Escape closes exactly one layer — the topmost (palette → composer → dialog → popover → drawer) — and never destroys a draft. Every overlay stores focus on open and restores it on close.

## 5. Components

### Buttons
- **Shape:** gently rounded (`8px`, `{rounded.md}`), `min-height: 46px`, sans-serif 700.
- **Primary:** solid terracotta (`{colors.primary}`) with paper-white text (`{colors.primary-foreground}`), `0.7rem 1.05rem` padding.
- **Secondary:** a translucent sheet fill (`oklch(0.89 0.012 76 / 45%)`) with a hairline border and ink text.
- **Hover / Focus:** `translateY(-2px)` lift plus a border/background darken (primary → `oklch(0.42 0.15 28)`); focus-visible draws a `2px` terracotta outline offset `2px`. All transitions 120–180ms ease.
- **Danger:** text-only in `destructive` red; no filled red button in normal flow.

### Chips & Badges
- **Peer avatar:** a `pill` monogram chip filled with the role hue (owner / reviewer / agent), white text tuned to AA. The presence dot on a shared file in the tree is the reviewer-steel variant.
- **Meta chip:** small pill, `0.56rem` uppercase label ink at ~9% on the foreground, for counts and file metadata.
- **Moved badge:** a muted neutral pill (`--moved-badge-bg`) marking a re-anchored suggestion.

### Cards / Containers
- **Review margin card** (signature): the primary container. Near-opaque raised paper (`oklch(0.94 0.010 76 / 96%)`), `10px` radius, `16px` padding, the review-card lift shadow, and a top hairline border. A left color accent identifies comment (amber) vs. suggestion (green) — carried as a small accent element, **not** a thick side-stripe border.
- **General panels:** flat, one tonal step off the content surface, hairline `18%`-ink borders. No nested cards.

### Inputs / Fields
- **Style:** `84%` paper fill, `10px` radius, hairline `12%`-ink border, `32px` high, sans-serif `0.82–0.95rem`, a top inset highlight.
- **Focus:** border darkens to `24%` ink and the inset highlight brightens; no glow. Focus-visible elsewhere is a `2px` ring in `--ring`.

### Navigation — Project Sidebar
- **Style:** the second neutral layer (`sidebar`), a subtle dotted radial texture, a `10%`-ink right border. Sans-serif throughout.
- **Tree rows:** `34px` tall, `9px` radius, `20px`-per-depth indent with a hairline guide line; hover fills `14%` ink, active fills `19%` ink with a `2px` accent bar at the left inset. File-type icons come from a VS Code icon pack, contrast-boosted.
- **States:** default / hover / active / focus-visible (a `2px` inset ring) are all specified — ship none of them half-done.

### Signature Component — Inline Tracked Changes
The editorial heart of the product. Reviewer edits render as attributed inline marks inside the ProseMirror surface, so the owner reads the proposed document in place and accepts/rejects while the source file stays clean:
- **Insertion** (`ins[data-id]`): ledger-green text on a `16%` green wash, `2px` radius, no underline. Dark mode brightens both.
- **Deletion** (`del[data-id]`): red strikethrough (`1px`) on a `13%` red wash.
- **Comment anchor:** amber highlight tint behind the running text, `box-decoration-break: clone` so it wraps cleanly across lines.
- **Confidence ramp & stale:** anchored suggestions carry a descending-presence background (high → low) in the accent hue; a stale anchor desaturates and switches to a dotted underline.

## 6. Do's and Don'ts

### Do:
- **Do** keep the terracotta/steel accent to action, selection, and focus only — the One Pencil Rule. Everything else is ink, paper, and the second neutral layer.
- **Do** use serif for everything read and sans for everything operated — no exceptions (the Read/Do Rule).
- **Do** hold the paper ground at chroma ≤ 0.012; carry warmth through the accent and the serif.
- **Do** keep the review hues (green / amber / peer colors) quarantined to the collaboration layer, distinguished by meaning and attribution — never decoration.
- **Do** specify default / hover / focus-visible / active / disabled for every interactive component; keyboard reachability is a requirement, not a nicety.
- **Do** honor `prefers-reduced-motion`; keep state transitions in the 120–250ms range and let motion convey state, not choreography.
- **Do** carry white-on-role-hue chips at their AA-tuned lightness; if you add a peer hue, tune it to clear 4.5:1 for its monogram.

### Don't:
- **Don't** let attn read like a **cloud-SaaS review tool** (Google Docs): no account-wall chrome, no toolbar-dense header, no "your doc lives in our cloud" framing.
- **Don't** let it read like an **IDE** (VS Code): no activity bars, no panels-in-panels, no everything-is-a-toolbar. The reading column is the hero.
- **Don't** let it drift toward **Notion rounded-pastel**: no candy-colored blocks, no emoji-forward headers, no soft-everything. Warmth is paper and type.
- **Don't** borrow the Linear-clone **saturated-purple glassy gradient-glow** dark theme; INK mode is a cool blue-black study, not neon.
- **Don't** use a `border-left`/`border-right` colored stripe > 1px on cards or callouts (the review card identifies comment vs. suggestion with a small accent element, not a side-stripe).
- **Don't** use gradient text, glassmorphism as a default, or the drift toward a warm-cream background — all are prohibited.
- **Don't** let muted body text go lighter than ~`oklch(0.32 0.012 65)` on paper; light-gray-for-elegance is the fastest way to fail the 4.5:1 floor.
- **Don't** fluidly `clamp()` UI headings; the product type scale is fixed rem.
