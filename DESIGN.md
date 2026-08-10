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
  panel-surface: "oklch(0.855 0.012 75)"
  header-surface: "{colors.primary}"
  panel-border: "oklch(0.14 0.008 55 / 16%)"
  rail-chip-surface: "oklch(0.88 0.012 75)"
  code-block: "oklch(0.885 0.010 78)"
  code-block-nested: "oklch(0.865 0.010 78)"
  border: "oklch(0.14 0.008 55 / 18%)"
  link: "oklch(0.48 0.14 28)"
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
  micro:
    fontFamily: "Source Sans 3 Variable, Source Sans 3, -apple-system, system-ui, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "normal"
  badge:
    fontFamily: "Source Sans 3 Variable, Source Sans 3, -apple-system, system-ui, sans-serif"
    fontSize: "0.625rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0.04em"
  chrome-xs:
    fontFamily: "Source Sans 3 Variable, Source Sans 3, -apple-system, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "normal"
  chrome-sm:
    fontFamily: "Source Sans 3 Variable, Source Sans 3, -apple-system, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "normal"
  meta:
    fontFamily: "Source Sans 3 Variable, Source Sans 3, -apple-system, system-ui, sans-serif"
    fontSize: "0.78rem"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "normal"
  control:
    fontFamily: "Source Sans 3 Variable, Source Sans 3, -apple-system, system-ui, sans-serif"
    fontSize: "0.95rem"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "normal"
  control-lg:
    fontFamily: "Source Sans 3 Variable, Source Sans 3, -apple-system, system-ui, sans-serif"
    fontSize: "1.15rem"
    fontWeight: 600
    lineHeight: 1.35
    letterSpacing: "normal"
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
  pill: "9999px"
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
    rounded: "{rounded.sm}"
    padding: "10px 12px 10px 13px"
---

# Design System: attn

## Overview

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
- Five typeset presets change the reading column only — app chrome never moves when you switch one.
- Three planes: chrome rails (sidebar + comments rail) recede equally, the document is the lit sheet between them, and review cards float above the rail.

## Colors

A warm parchment field carrying near-black ink and a single terracotta accent; cool review hues (green, amber, blue, violet) are quarantined to the collaboration layer so they never dilute the editorial ground. All values are canonical **OKLCH** — attn is OKLCH-native and the frontmatter carries OKLCH directly.

**Sources of truth** (consolidated 2026-08-08). `web/src/tokens.css` is canonical for every colour; the frontmatter above is a checked mirror of it — `design-doc-parity.test.ts` fails CI when they disagree, so a value quoted here is a value the code ships. Contrast **ratios** quoted anywhere in this document are measurements at the time of writing: the live measurement is `web/e2e/reading-palette.spec.ts`, which renders both themes and prints the full sweep on every run. When a quoted ratio and the probe disagree, the probe is right and the prose is due an update.

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
- **Panel Surface** (`oklch(0.855 0.012 75)`, INK `oklch(0.172 0.014 257)`): the chrome plane — the comments rail sits on it, deliberately the *same* value as the sidebar. Both edges of the workspace recede equally so the document reads as a lit sheet between two rails. In INK the move inverts (the rails lift off a darker ground rather than sinking into it).
- **Header Surface** (`{colors.primary}` — the accent itself): the app header is an ACCENT PLANE (owner-directed 2026-08-10). Two requests converged on it from opposite directions — the web header should match the `Choose file` button below it (`bg-primary`), and the desktop header should be "orange/blue", which is precisely what the accent is in the two themes. This is the header's fourth surface, and the trajectory is the argument: paper (invisible), panel-surface (vanished into the sidebar), a warm tinted plane (still too quiet), the accent. Shared by all three headers — one grammar, one plane. **Polarity flips between themes**, which is why nothing on it is hard-coded white: Paper's accent is dark (0.48) so its foreground is near-white; Ink's is light (0.72) so its foreground is near-black. Measured on the plane: doc name **6.65:1** Paper / **8.41:1** Ink, muted icons **4.84:1** / **6.29:1** (alpha-composited).
- **Rail Chip Surface** (`oklch(0.88 0.012 75)`, INK `oklch(0.205 0.013 257)`): fills for chips sitting *on* the panel plane. It exists because `--muted` lands 0.003 from `--panel-surface` in INK, so a `muted` chip on the rail is invisible there — a trap that has now been hit twice.
- **Code Block** (`oklch(0.885 0.010 78)`, INK `oklch(0.176 0.014 256)`): the **embedded** surface shared by `pre`, inline code, **tables** and the frontmatter card — these are the same class of object and must not read as different materials. It is *recessed*: on Paper it sits **below** the page, not above it. (Corrected 2026-08-08, attn-evme.3. It read `oklch(0.972)` — lighter than the page — and this line called it "the raised surface", while the Flat-Until-Lifted Rule below listed the same object among things "genuinely pressed into" the page and gave it an inset shadow. It wore a recessed shadow over a raised tone, and the doc licensed it, which is why nobody caught that a reading surface had a panel on it brighter than the paper.)
- **Code Block Nested** (`oklch(0.865 0.010 78)`, INK `oklch(0.204 0.014 256)`): the second step of the embedded tier, for a block inside a block — inline code in a table cell. It used to be `--background`, which was a step toward the ink only while the block was lighter than the page; it silently inverted when the block moved.
- **Border** (`oklch(0.14 0.008 55 / 18%)`): hairline dividers — ink at low alpha, never a solid gray line.

### Named Rules
**The One Pencil Rule.** The primary accent is a red pencil, not a highlighter. It appears on primary action, current selection, and focus — nowhere else. If two things on a screen are terracotta, one of them is wrong.

*Links are action* (clarified 2026-08-08, attn-evme.1). A hyperlink in prose carries the accent, and this is the existing "action" clause rather than a third exception — stated explicitly because the previous muted-brown `--link` was 0.24 lighter than body ink in the same hue and read as faded prose, and because someone reading only the rule would otherwise "fix" a terracotta link back to it. A prose link also carries a **rest-state underline**, and that is not decoration: on this palette no lightness satisfies both AA 4.5:1 against the page *and* G183's 3:1 against surrounding body text at the same time (Paper `--primary` is 3.78:1 on the page; darkening it to pass drops it to 2.60:1 against the text; Ink is 1.54:1 against the text). Colour alone provably cannot carry a link here, so the underline is load-bearing and may not be removed for tidiness. Chrome anchors — nav rows, breadcrumbs, buttons-as-links — are a different treatment and take no rest underline; their affordance is position and shape.

*The plane exception* (added 2026-08-10). The rule above governs MARKS made **on** a surface. The app header is a surface made **of** the accent, which is a different act: it is not one more terracotta thing competing with the others, it is a ground. On that ground the pencil inverts — `--foreground`, `--primary`, `--accent` and `--amber-deep` are all re-pointed at the on-accent foreground for the header's subtree (`app.css`, the `chrome-on-accent` block), so "active" still reads as a filled outlined pill and "muted" still reads as a step back, with the accent-on-accent invisibility that would otherwise follow designed out. The count still holds inside the reading column, which is what the rule is for: the header is chrome, and no second terracotta appears on the page beneath it. Floating cards that render *inside* the header subtree (ShareChip, SnapshotBadge, OutboxIndicator, PeerStrip) restore the ordinary palette — they are their own surface, not the plane.

*The two labelling exceptions* (added 2026-08-07, attn-bw2h.7 / attn-bw2h.8). The pencil also annotates. Two surfaces carry the accent while being none of action, selection, or focus, and they are the **complete** list — this is a closed enumeration, not a new category anyone may extend by analogy:

- **Frontmatter keys** (`.frontmatter-pairs dt`). In a two-column key/value grid the key *names* the content rather than being it. The tint does the job small caps do in print: it separates the columns by role so the pairs scan without a rule between them. Values stay `--foreground`. Measured on the card's own `--code-block` ground: **4.97:1** in Paper, **7.85:1** in Ink. (Re-measured 2026-08-08 after attn-evme.3 recessed that ground; it previously read 6.47:1 / 7.67:1. Paper now clears the 4.5:1 floor by less than half a step, so this pairing is the one to re-measure first if the embedded tier ever moves again — `reading-palette.spec.ts` prints it on every run.)
- **The saved save-state glyph** (`[data-slot="native-save-chip"]`, saved state only). This chip is the one piece of chrome that reports *where the user's work lives* — the product's entire claim in one glyph. On the ACCENT PLANE (2026-08-10) this exception is dormant rather than deleted: the header re-points `--primary` and `--amber-deep` at the on-accent foreground, so both save states render in the same on-plane ink and the glyph carries the whole signal — which DESIGN.md already said was the real signal, so nothing that was carrying meaning was lost. Measured on the plane: **6.65:1** Paper / **8.41:1** Ink, far past the 3:1 a 14px 2px-stroke glyph owes. The exception stays written down because the chip returns to a neutral plane the moment the header does.

What the exceptions do **not** license, so the rule keeps its teeth:

- **Not a control's rest state.** A tinted idle button lies about what is active. The header's active convention (attn-11g4.6) is tint **plus** `bg-primary/10` **plus** a `border-primary/35` hairline, arriving together. A bare tinted glyph is therefore only ever legible as *not a button* — which is exactly why the saved chip must never grow a fill or an outline.
- **Not emphasis inside the document.** Body text, headings, strong, and callout titles stay ink. Links are not an exception either — they have their own `--link` token precisely so the accent is not spent on them.
- **Not decoration.** A key is a label with a job; an icon beside a heading, a divider, or a stripe that means nothing is not, and the side-stripe prohibition below is unaffected.
- **Not a budget increase.** Two accented things on one screen is still one too many. This adds *roles*, not headroom — and since the saved chip is lit ~99% of the time, the app header's single accent is already spent. Anything new that wants the pencil up there must take it from the chip, not sit beside it.

**The Quarantine Rule.** Green, amber, and the peer hues belong to the collaboration layer only. They never appear as decoration on base chrome; their meaning (suggestion / comment / who) is the entire reason they exist.

**The Warm-Paper, Not-Cream Rule.** The ground holds chroma ≤ 0.012. The moment it drifts warmer it becomes the saturated AI cream default. Warmth is carried by the accent and the serif, not by the background.

## Typography

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
- **Micro** (500, `0.6875rem` / 11px): the standard chrome chip step — dock counts, ShareChip labels, composer hints, review-dock text. Sans. (Ratified 2026-08-08, design-system consolidation: 11px was the single most-used size in the app — 58 arbitrary `text-[11px]` utilities — while officially not existing. Reality won.)
- **Badge** (600, `0.625rem` / 10px, `0.04em`): popover eyebrows, badge counts, file-path metadata. Sans. **This is the floor: no visible text ships below 10px.** Anything that seems to need smaller text is a badge that should be a dot with its number in `title`/`aria-label`, or a chip that should grow.
- **Chrome-xs / Chrome-sm** (`0.75rem` / `0.875rem`): the component library's `text-xs`/`text-sm` steps, recognized rather than fought — the shadcn-derived UI layer ships them pervasively (dialogs, buttons, menus) and the tree rows and wordmark sit on `0.875rem` beside them. Documented so the ramp describes the whole app, not just the parts written by hand.
- **Mono** (400, `0.85rem`, 1.55): code blocks and inline code.

Utilities `text-micro`, `text-badge` and `text-meta` exist in the Tailwind theme (size-only, no line-height payload, so they compose with `leading-*` exactly as the arbitrary values they replaced did). New chrome text picks a step from this list; the design hook flags anything else.

### Typeset presets
The three cuts above are the **Editorial** preset — the default, and the shape every rule in this section describes. Settings offers four alternates (shadcn's typeset model: a preset is a complete reading system, never a pile of independent font knobs):

- **Editorial** — the default described above. Its values are the canonical tokens restated verbatim.
- **Modern** — sans for reading as well as chrome, with display sizes pulled in and tracking tightened (serif display scale reads oversized in sans). For readers who want a code-review tool rather than a manuscript.
- **Compact** — Editorial's fonts at a denser scale and leading, on a narrower measure. For dense ops docs.
- **Manuscript** (added 2026-08-06) — large serif on a short column (`660px`), 1.9 leading. The opposite pole from Compact: for reading a spec end to end rather than scanning it. It deliberately trades technical width for reading comfort, since wide blocks share the same narrow edge under the Wide-Sheet Rule.
- **Terminal** (added 2026-08-06) — monospace throughout, for diffs and config where column alignment *is* the content. Display sizes compress (a 2em mono h1 reads as shouting) and headings keep natural tracking, because negative letter-spacing fights a monospaced face.

Presets live in `web/styles/typeset.css`, keyed off `data-typeset` on `<html>`. They are orthogonal to light/dark (which owns color) and to the ⌘+/⌘- font scale — all three compose.

**The Chrome-Invariance Rule** (added 2026-08-06). A preset may set only *document-scoped* tokens: `--doc-font`, `--attn-doc-scale`, `--doc-leading`, `--doc-tracking`, and `--content-measure`. It may never touch `--attn-base-font-size` (the rem baseline for all app chrome) or the global `--serif`/`--sans`/`--mono` families. Presets originally did both, which meant choosing a typeset silently rescaled every header, dialog and control in the app — the rem baseline drives `html { font-size }`. Chrome now holds still and only the reading column reflows. Document type sizes are therefore `em` (relative to the doc's own scale) while margins stay `rem` (anchored to the app baseline), so a preset's margin override means the same thing at every scale.

Because every preset states its full hand — including Editorial — `[data-typeset]` is authoritative wherever it appears, including on a nested specimen in Settings. Declaring nothing was how the default preset's own specimen ended up rendering in whichever face happened to be active.

### Named Rules
**The Read/Do Rule.** If the user is reading it, it's serif. If the user is operating it, it's sans. There is no third case; a button never uses the serif, a heading in the document never uses the sans. (A preset may change *which* face reads as the serif — Modern makes it a sans — but never which role gets the reading face.)

*Product-chrome steps* (added 2026-08-05, attn-n01r.8). The six steps above describe the **document**. The app shell needs four more between `label` and `title`, and pretending otherwise is why `app-shell.css` had drifted to 33 distinct sizes with no rhythm — every new component invented a value because no existing one fit. The full chrome ramp is:

`0.7` label · `0.78` meta · `0.85` mono/caption · `0.95` control · `1` body · `1.15` control-lg · `1.25` title · `1.5` headline · `2` display

Nine steps, and nothing between them. This is an *extension* of the ramp, not an exemption from it: a size outside this list is still a defect, and the hosted app shell now uses exactly these nine.

(Corrected 2026-08-06: `meta`, `control` and `control-lg` existed only in this prose for two weeks, while the frontmatter carried the six document roles. Tokens are the normative layer — prose only contextualises them — so every chrome-ramp size read as off-ramp to any tool consuming this file, and `0.95rem` alone accounted for most of the drift reported against `app-shell.css`. All nine steps are now declared as frontmatter typography roles. **A ramp step that is not in the frontmatter does not exist.**)

**The Scoped-Document Rule** (2026-08-04). Document typography is scoped to `.attn-doc` — the class the editor mount and the viewer article carry. Bare `p` / `h1` / `ul` / `li` selectors are never global: chrome rendered in the same tree used to inherit 2rem heading gaps and absolutely-positioned list bullets that escaped their card, and each leak got patched individually until an opt-out class existed purely to undo the defaults. Type the document, not the page.

**The Fixed-Scale Rule.** Product register: headings are fixed rem, not `clamp()`. Users view at consistent DPI inside panes and windows; a fluid h1 that shrinks in a sidebar looks worse, not better.

*Marketing carve-out* (added 2026-08-05, attn-n01r.18). The rule's rationale is panes and sidebars, which the hosted **landing** does not have — it is a full-bleed Persuade surface viewed at whatever width the visitor brings. Display headings there may `clamp()`, in two tiers only: the hero `h1` at `clamp(3.2rem, 5.2vw, 6rem)` and every section head at `clamp(2.6rem, 4.4vw, 4.6rem)`. Two tiers, not per-section values — a third coefficient is how the `h1` ended up rendering *smaller* than two `h2`s at 1440px. Everything else, including the desk and the app shell, stays on the fixed ramp. The landing had already forked this by 3x with nothing written down; this records the fork rather than pretending it isn't there.

**The Wide-Sheet Rule** (decided 2026-07-12). The reading surface is full-width and left-set, never a centered narrow column: all content — running prose *and* wide blocks (mermaid diagrams, tables, code) — shares one column capped at the `--content-measure` token (**960px**); oversized tables/code scroll inside it. (Revised 2026-07-13 from the original split layout — 72ch prose beside full-pane blocks — which read as ragged whenever a wide block was on screen. Retuned 1100px → 960px, and corrected here 2026-08-06 where the doc still said 1100.) The `micro` (2px) radius is the mark family for inline review marks, focus rings, and accent bars.

*Measure is a preset's to move, but only when the column IS the preset's identity* (2026-08-06). Changing `--content-measure` re-wraps every line and moves the document's right edge — the most disruptive thing a preset can do — and 960px is a reviewed decision, not a neutral default. So Manuscript sets it (660px; a short measure is the entire point of a book column) and Compact keeps its long-standing 880px. Everything else inherits 960px. Modern and Terminal briefly carried 920/900px: arbitrary nudges that re-litigated a settled decision, and Terminal's was backwards, since monospace fits *fewer* characters per pixel and a narrower column shortens the line twice over.

**The Measure-Is-Opt-Out Rule** (open, 2026-08-06). The shared column is currently applied by a hand-maintained *allowlist* of element selectors, so anything not named in it silently escapes the measure. Two blocks were found escaping in one sweep (the frontmatter card and the math container), and on the viewer side the list can never be complete, because comrak passes raw HTML through — an author writing `<div>` or `<details>` in markdown lands an arbitrary element outside the column. The durable shape is `article.attn-doc > *` with explicit opt-outs for the wrappers that need a `min()` clamp. Recorded as the intent; not yet implemented.

## Elevation & Depth

A hybrid: mostly flat tonal layering (chrome recedes by being a step darker than content, not by floating), with a small, restrained shadow vocabulary reserved for genuinely-lifted surfaces — review cards, dialogs, dropdowns — and soft *inset* shadows that make code blocks and inputs read as pressed into the paper. The paper-grain overlay (a fixed fractal-noise SVG at `--grain-opacity`) sits above everything as the unifying texture; it is not elevation but it is why nothing looks like flat plastic.

### Shadow Vocabulary
- **Review-card lift** (`box-shadow: 0 16px 42px oklch(0.20 0.02 55 / 16%), 0 1px 0 oklch(1 0 0 / 45%) inset`): the margin review cards — a diffuse ambient drop plus a top inset highlight so the card reads as a physical slip of paper laid on the page.
- **Panel soft** (`0 20px 60px rgba(48,41,34,0.10)`) / **Panel strong** (`0 30px 90px rgba(48,41,34,0.16)`): floating dialogs and the shared-window chrome.
- **Pressed inset** (`inset 0 1px 3px oklch(0 0 0 / 4%)`): code blocks and search inputs — a slight recess, not a raise.

### Named Rules
**The Flat-Until-Lifted Rule.** Surfaces are flat and tonal at rest. A shadow appears only when something is genuinely floating above the page (a card, a dialog, a menu) or genuinely pressed into it (an input, a code block). Shadow is a statement about physical position, never a decorative gradient of depth.

**The Two-Tier Surface Rule** (added 2026-08-08, attn-evme.3). Every surface belongs to one of two tiers, and the tier decides which way its tone moves:

- **Embedded** — a surface *inside* the reading column: code blocks, tables, the frontmatter card, inputs. It steps **toward the foreground**: darker on Paper, lighter in Ink. Both directions mean the same thing — *more ink here*. It carries the pressed inset, never a lift.
- **Floating** — a surface *above* the page: review cards, dialogs, popovers, menus. It may step away from the foreground, and earns a lift shadow when it does.

And the line that makes the Paper half unambiguous: **nothing on Paper is lighter than the page.** Paper is the lightest thing a reading surface has; a panel brighter than it reads as backlit glass, which is the one material this system is not made of.

This rule is descriptive, not aspirational — it predicts the values already in the system. Sidebar and Panel Surface recede on Paper and lift in Ink because they are a *chrome plane* rather than either tier. Review cards are lighter than the page on Paper because they genuinely float. Only the reading-column blocks were ever on the wrong side of it, and that was the "too stark" report of 2026-08-08.

*Why it needed writing down:* the tier was previously implied by two separate statements that disagreed — the shadow vocabulary called code blocks recessed while the colour section called the same token "the raised surface". A surface with a recessed shadow and a raised tone is not a style choice anyone made; it is two rules failing to meet.

**The Layer Order** (added 2026-08-08, design-system consolidation). One cascade order, declared in `app.css` before Tailwind can declare its own: `theme < base < chrome < doc < components < utilities`. `base` is the app ground (preflight, html/body, grain); `chrome` is the hosted shell's bare-tag resets — below `doc` by design, so a reset can never erase document grammar; `doc` is everything `.attn-doc`-scoped in base.css; `components` is editor mechanics, syntax highlighting and component chrome; `utilities` is Tailwind, so a margin utility on a doc element genuinely wins. The `doc` tier is why the table surface exists exactly once and why the prose-link rule no longer hides outside the layers. Rules still outside every layer are a closed, justified list: the Truth Rule (must beat tw-animate), the sidebar hard overrides (beat utility classes), and the scrollbar rules (native-widget override). `doc-surface-parity.test.ts` pins the order, the ownership split, and the mount's `attn-doc` hinge class.

**The Truth Rule** (behavioral, attn-hg5). Pixels always equal state: no user-visible fact — a modal open, a comment arrived, a file saved — may depend on an animation completing or a debounce flushing. Closed overlays are `display: none` in plain CSS (`[data-state="closed"]`); theme flips are atomic (transitions suppressed for the flip frame); animation is enhancement, never the carrier of state. Occluded windows freeze the animation clock, so anything less soft-locks the app.

**The Topmost-Escape Rule.** Escape closes exactly one layer — the topmost (palette → composer → dialog → popover → drawer) — and never destroys a draft. Every overlay stores focus on open and restores it on close.

## Components

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
- **Review margin card** (signature): the primary container. Near-opaque raised paper (`oklch(0.94 0.010 76 / 96%)`), `6px` radius, `10px 12px 10px 13px` padding (the asymmetric left leaves room for the accent), the review-card lift shadow, and a top hairline border.
- **The accent strip** (corrected 2026-08-06): a `3px` full-height strip on the card's left edge, **square at both ends** even though the card's corners are round. It carries `--rmc-accent` — the comment author's personal color, with kind (comment amber / suggestion green) and state (stale / low-confidence) overrides layered after. Implemented as an absolutely-positioned `::before` at `border-radius: 0`, with `isolation: isolate` on the card so its negative `z-index` cannot escape. It was previously an `inset` box-shadow, which the card's radius necessarily clipped into a tapered curve at both ends; the strip is information (who, and what kind), so it must not read as a decorative flourish. The card must never gain `overflow: hidden` — that would re-clip the strip and bring the curve back.
- **General panels:** flat, one tonal step off the content surface, hairline `18%`-ink borders. No nested cards.
- **Tables** are code blocks: same `--code-block` fill, 1px border, `6px` radius and inset lip. Achieved with `border-collapse: separate` + `border-spacing: 0` (a collapsed table merges cell borders into the table box and squares off the radius) and **no cell backgrounds** — a filled header row would re-square the top corners and cover the inset lip, so header distinction is carried by ink weight instead.

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

## Do's and Don'ts

### Do:
- **Do** keep the terracotta/steel accent to action, selection, and focus — the One Pencil Rule — plus its two enumerated labelling exceptions (frontmatter keys, the saved save-state glyph) and nothing else. Everything else is ink, paper, and the second neutral layer.
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
- **Don't** use a colored side-stripe on a card or callout as *decoration* — the AI-UI tell is a thick tinted border that means nothing. The **one** sanctioned exception is the review margin card's `3px` accent strip, which is load-bearing: it encodes the comment's author and its kind/state, and removing it deletes an information channel. (Amended 2026-08-06: this previously read as a flat ">1px" prohibition, which the shipped card had never satisfied — the rule described an intent the product had already outgrown. If a new stripe cannot say what it *means*, it is decoration and the prohibition stands.)
- **Don't** use gradient text, glassmorphism as a default, or the drift toward a warm-cream background — all are prohibited.
- **Don't** let muted body text go lighter than ~`oklch(0.32 0.012 65)` on paper; light-gray-for-elegance is the fastest way to fail the 4.5:1 floor.
- **Don't** fluidly `clamp()` UI headings; the product type scale is fixed rem.
