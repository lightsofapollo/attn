# Product

## Register

product

## Platform

web

## Users

The primary user is James — a one-man studio who lives in the tool daily, reviewing his own planning and design docs and sharing them for annotation. Design for a power user, not a first-timer: density, keyboard-first flow, and earned familiarity over hand-holding.

attn's review model has three roles that already exist in the surface (owner, invited reviewer, agent), and the interface must serve all three: the owner authoring and curating a document, an invited reviewer who joins by link to comment and suggest, and an agent whose suggestions land in the same encrypted thread as the humans'. The owner is the center of gravity — the accept/reject pipeline, the file tree, the outbox all belong to them — but a reviewer or agent should never feel like a second-class citizen in the margin.

## Product Purpose

attn is a native, end-to-end-encrypted collaborative markdown reviewer. It opens a file already on your disk (`attn <file>`) and lets you and others review it together in real time — inline comments, tracked-change suggestions, an accept/reject pipeline — without uploading the document to anyone's cloud. The relay only ever sees ciphertext; the plaintext never leaves the machines that are party to the review. Success is that a review — solo, with a person, or with an agent — happens entirely inside attn and the source file stays clean until the owner accepts a change.

## Positioning

The reviewer for agent-authored docs: the one place where you and your agents review the same document together, human comments and AI suggestions in a single end-to-end-encrypted thread, over files that never leave your machine in the clear. Every screen should reinforce that a review here is private by construction and that human and agent are peers in the same margin.

(*"in the clear"* added 2026-08-19, attn-08fa.3. Sharing publishes an encrypted copy, as the paragraph above already says precisely — so the unqualified form of this line was a claim the product's own share flow contradicts, and it was being quoted verbatim onto the landing hero. Surfaces may compress this positioning, but none of them may drop the qualifier.)

## Brand Personality

Warm surface, sharp behavior. The identity is editorial and tactile — warm paper, ink, a single rust-red for action, Source Serif for reading and Source Sans for the chrome, a faint paper grain — but the *feel in the hand* is a precision instrument: fast, exact, in-flow, keyboard-first, Linear/Raycast-grade responsiveness. The calm is in what you see; the sharpness is in what you do. The voice is quiet and confident: it states, it doesn't sell; it respects the reader's attention rather than competing for it.

## Anti-references

- **Google Docs / cloud-SaaS review tools.** Account walls, chrome-heavy toolbars, generic Material controls, and the assumption that your document lives on someone else's server. attn is the local-first, no-account, encrypted antidote to this — it must never read as a webapp login away from your files.
- **VS Code / IDE clutter.** Activity bars, panels-inside-panels, everything-is-a-toolbar density. attn is a reviewer, not an IDE; the reading surface is the hero and chrome earns its place.
- **Notion / rounded-pastel productivity.** Soft pastel blocks, emoji-forward headers, rounded-everything. Too soft and too playful for a precision tool; warmth here comes from paper and type, not from candy.
- (Borrow Linear's precision and keyboard flow, but reject the saturated-purple glassy gradient-glow "AI startup" dark theme that usually comes with it.)

## Design Principles

Warm surface, sharp behavior — pair editorial calm you can see with power-tool precision you can feel; never let the warmth slow the tool down or the speed strip the craft.

The tool disappears into the review — earned familiarity over invented affordances; standard patterns (command palette, tracked changes, accept/reject) done exceptionally well, no novelty for its own sake.

Private by construction, legible not loud — the E2E-encryption guarantee should be quietly evident in the UI (what's shared, with whom, what never leaves) without turning into a security-theater badge wall.

Human and agent are peers in one thread — comments, suggestions, and their authors share one vocabulary; an agent's suggestion and a person's suggestion look and behave the same way, distinguished by attribution, not by hierarchy.

Build for the daily user — optimize for the hundredth review, not the first: density where it earns its keep, every action keyboard-reachable, flow over onboarding.

## Accessibility & Inclusion

Target WCAG AA (body text ≥4.5:1, large text ≥3:1; the review chips and peer avatars are already tuned to clear AA for their monogram text) and keyboard-first operation: every action reachable and discoverable without a mouse via the command palette and shortcuts, matching the "fast, precise, in-flow" feel. Honor `prefers-reduced-motion` on every animation (the base stylesheet already blanket-disables transitions under it — prefer purposeful reduced-motion alternatives over a global kill as motion grows). Do not rely on color alone to distinguish comment vs. suggestion vs. confidence state.
