# test-vectors/

Cross-implementation crypto corpus for attn collab v2.

This directory is the **canonical contract** every implementation of the collab
crypto stack must satisfy. The Rust native client ships first; a browser/WASM
client will follow. Both must pass the same vectors, bit-for-bit, or
signature verification, AEAD decryption, and PoW validation will mystery-fail
in production.

The corpus must exist BEFORE the implementations — see
`planning/collab/crypto-spec.md` §Implementation Order.

## Files

| File                     | Spec section                                  | Filled by      |
| ------------------------ | --------------------------------------------- | -------------- |
| `kdf.json`               | §Key Derivation                               | attn-nnj.1.4   |
| `kdf-v3.json`            | §V3 Split Capability Tree                    | attn-02a.2.1   |
| `canonical-json.jsonl`   | §Canonical JSON (RFC 8785 JCS)                | attn-nnj.1.3   |
| `event-signature.json`   | §Signatures, §Canonical Bytes for Signature   | attn-nnj.1.6   |
| `event-id.json`          | §ID Construction → `EventId`                  | attn-nnj.1.8   |
| `aead.json`              | §Envelope Encryption (AEAD)                   | attn-nnj.1.5   |
| `envelope.json`          | end-to-end round-trip                         | attn-nnj.1.9   |
| `pow.json`               | §Hashcash Proof-of-Work                       | attn-nnj.1.7   |
| `anchor-cases/`          | §Anchor Resolution                            | attn-nnj.3.6   |

All seven files currently contain `_schema` metadata plus one or more
placeholder entries whose values are the literal string `"__PENDING__"`.
The owning issue replaces those placeholders with computed values and
adds whatever additional vectors it deems necessary.

Vector counts after the attn-nnj.11.6 corpus expansion pass (May 2026):

| File                     | Vectors | Notes                                          |
| ------------------------ | ------: | ---------------------------------------------- |
| `canonical-json.jsonl`   |   21    | + DEL boundary, 2^53 boundary, deep nesting, NFC/NFD |
| `kdf.json`               |    4    | + all-ones, ASCII-pattern roomSecret           |
| `kdf-v3.json`            |    4    | split read/write tree; same boundary inputs     |
| `aead.json`              |    5    | + signal, large 4 KiB, pure non-ASCII          |
| `event-signature.json`   |    5    | covers 5 distinct ReviewEventBody variants     |
| `event-id.json`          |    5    | parent-count edges (0, 1, 2, 3, 10)            |
| `envelope.json`          |    4    | event + 2 × signal + snapshot_blob             |
| `workspace-snapshot.json`|    4    | legacy text + asset + workspace manifest       |
| `pow.json`               |    6    | one vector per (method, path) the relay accepts |

`anchor-cases/` is a directory of hand-curated `(original.md, edited.md,
anchor.json, expected.json)` cases consumed by both the Rust
(`attn-nnj.3.4`) and TS (`attn-nnj.3.5`) anchor resolvers. See
`anchor-cases/README.md` for the corpus layout and contribution rules.

## Format conventions

- **Encoding**: All binary fields are **base64url with NO padding**
  (`A-Z`, `a-z`, `0-9`, `-`, `_`). Never standard base64. Never hex
  (except the `tokenHashHex` debug field in `pow.json`).
- **Timestamps**: Integer **milliseconds** since the Unix epoch. Never
  seconds. Never ISO-8601 strings inside signed payloads (timestamps are
  signed bytes and must not depend on a date-formatter).
- **Counters / lengths**: Integers. PoW counter is serialized as a string
  in case it exceeds `2^53` (unlikely at difficulty 16 but cheap insurance).
- **Canonical JSON**: object keys sorted ASCII-ascending, no insignificant
  whitespace, UTF-8 no BOM, absent fields are *omitted* (never `null`).
- **`_schema` blocks**: JSON has no comments, so each file embeds a
  top-level `_schema` object documenting field semantics and the spec
  section it pins. JSONL files put the `_schema` on the first line.

## How the Rust impl consumes the corpus

Each test module pulls the JSON in at compile time:

```rust
const KDF_VECTORS: &str = include_str!("../../planning/collab/test-vectors/kdf.json");
```

then parses with `serde_json` / `serde_jsonlines`. No filesystem access at
test time, no path drift between machines.

For the JSONL file, parse line-by-line and skip any line whose top-level
object contains `_schema`.

## How the future browser/WASM impl will consume it

Same files, fetched at test time (`fs.readFileSync` for vitest, or
bundled via `?raw` import for browser tests). The schema and field
encodings are identical — that is the entire point of the corpus.

## Contribution guidelines

Add a new vector when:

- A spec ambiguity surfaces during implementation (e.g. a string-escape
  edge case in canonical JSON). Add a vector that locks the chosen
  behavior.
- A new event kind, envelope kind, or PoW-protected route lands. Each
  `(method, path)` the relay accepts gets its own `pow.json` vector.
- A bug is fixed that was caused by Rust/TS divergence. Add a regression
  vector that would have caught it.

Do NOT add vectors that are merely permutations of existing inputs — the
corpus is a contract, not a fuzzing harness. Keep each file in the
single-digit-KB range; for truly large payloads use deterministic
generation in the test runner instead of inflating the JSON.

When you add or modify a vector, regenerate expected values from the
reference implementation (Rust, until a browser client exists), then run
every other implementation against the updated corpus to confirm
agreement.
