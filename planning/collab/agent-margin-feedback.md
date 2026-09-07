# For agent: feedback from the margin

**Proposal for review · 7 September 2026 · attn-qiwt**

[Visual product mockup](agent-margin-feedback.html) · [Still preview](agent-margin-feedback-preview.png) · Copy directly from the margin. Product implementation follows review.

**Outcome.** Mark margin comments **For agent**, copy one or a batch into any agent conversation, and get useful changes without re-explaining the document. An optional live mode delivers the same feedback automatically and brings replies back into the original threads.

## The experience

- Add **For agent** to the comment composer and existing thread menu. Keep the human author; show a small recipient badge. A marked thread includes its quoted passage and conversation.
- Offer **Copy** on each marked comment, inline checkboxes for **Copy selected**, and **Copy all**, scoped to a document or workspace. Each action writes directly to the clipboard: no review panel, preview step or confirmation. Show the selection count; exclude resolved threads by default. Copying never resolves a comment.
- Persist personal routing separately from shared events, keyed by workspace, room and thread. Marks survive reload on that device; comments retain their room visibility. Cross-device routing sync comes later.
- Support native, hosted-owner and reviewer surfaces, including Markdown and HTML comments. V1 uses existing review rooms; commenting on unshared local documents is a separate extension.

## One portable feedback format

Render one versioned packet as Markdown for paste or JSON for integrations. Include stable comment/thread IDs, relative source path, document version/hash, quote, heading or HTML selector, anchor confidence, request and relevant replies. Group by file and position. Split oversized batches explicitly; never export invitation secrets.

```text
Address this attn feedback in the available source files.
Verify each quote against the current file before editing.
If a source is unavailable or ambiguous, report it instead of guessing.
Return changes and unresolved questions by feedback ID.

[F-12] docs/plan.md · thread t-12 · snapshot s-4
Section: Rollout · anchor: exact
Quote: “Release to every workspace on Monday.”
Request: Start with an opt-in pilot and define the rollback trigger.
```

Editing requires source access. Browser-only documents include excerpts and request a proposed patch when no source mapping exists. HTML retains selector/quote context; automatic HTML suggestions need separate support.

## Delivery plan

| Stage | Deliverable | Exit evidence |
| --- | --- | --- |
| **1 · Mark and copy** | Durable personal routing, shared packet builder, direct Copy / Copy selected / Copy all actions, inline selection, document/workspace scope and clipboard fallback. | All three actions copy immediately with correct context across native/hosted/reviewer; reload, stale anchors, HTML, empty selection and large batches verified. |
| **2 · Agent tools** | Provider-neutral CLI to list/export feedback, wait after a cursor, acknowledge receipt, reply by thread ID and submit a diff. Add an MCP adapter over that same service. | A shell consumer and an MCP client use the same contract; replies land under the correct comment and suggestions retain human acceptance. |
| **3 · Listen** | Explicit workspace/session connection, pause/resume, queue and status. Native first; hosted comments require an explicitly paired local bridge or connected agent runner. | Two independent agent hosts, reconnect/replay, cancellation, duplicate delivery and follow-up feedback exercised end to end. |

Live mode batches posted comments marked by the connected user and queues follow-ups during work. Durable cursors, revisions and idempotency keys prevent duplicate replies/proposals. Agent replies never trigger themselves. States: **Queued → Received → Working → Responded / Needs input / Failed**; resolution stays human. Unmarking cancels queued work; in-flight cancellation is best effort. Human follow-ups create new feedback revisions.

**Provider independence.** attn delivers context; the agent host selects and runs the model. CLI/JSON is the baseline, MCP an adapter. Agents wait or check at task boundaries; immediate mid-run steering requires host support. A subscription cannot force arbitrary chat applications to run a model. [MCP interaction model](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)

**Implementation fit.** Extend [composers](../../web/src/lib/CommentComposer.svelte), [margin cards](../../web/src/lib/ReviewMarginCard.svelte) and native/browser persistence. Reuse existing thread anchors, replies and [diff/verdict tools](agent-cli-howto.md). The [headless client](../../src/review/agent.rs) supplies events; its placeholder anchors need a typed reply API. This refines the [earlier roadmap](agent-loop-roadmap.html).

**Review decisions.** Recommended defaults: personal routing, existing rooms for V1, source edits governed by the agent conversation's permissions, and human acceptance for attn suggestions. Ship Stage 1 independently; use its packet unchanged as the basis for Stages 2–3.
