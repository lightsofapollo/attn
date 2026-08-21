# Plain style for comments

How to write the comments that survive triage. The rules are adapted from
ASD-STE100, a controlled-English standard written so that maintenance
technicians cannot misread an instruction. A comment has the same problem: one
reader, no author present, no chance to ask.

Apply this only to comments you keep or rewrite. Never restyle a directive, a
license header, or a quoted error string.

## Rules

| Rule | Do | Not |
| --- | --- | --- |
| One idea per comment | `// Lock: concurrent writers corrupt the cache.` | `// Lock for thread safety, and note the cache is also cleared on logout.` |
| Twenty words or fewer | `// Retries only on 5xx; a 4xx here means a bad token.` | A sentence that runs past the end of the line. |
| Active voice | `// The scheduler drops stale jobs.` | `// Stale jobs are dropped by the scheduler.` |
| Simple tense | `// We moved this behind the flag.` | `// This has been moved behind the flag.` |
| One word per meaning | Use `check` everywhere for the same act. | Rotate `check`, `verify`, `validate`, `confirm`. |
| Three-word noun groups at most | `// the queue priority handler` | `// the agent task queue priority handler` |
| Keep the subject and article | `// The upstream API 404s without it.` | `// 404s without it.` |
| No hedging | `// Fails on empty input.` | `// This might possibly fail sometimes.` |
| Plain word over jargon | `// Runs before the request finishes.` | `// Executes prior to request culmination.` |

## What "one line" means

One line means one line in the file, at the file's normal width. Not a
paragraph wrapped to look short, and not a run of `//` lines that reads as a
paragraph.

Three exceptions:

- A doc comment stating a contract (see rung 2 of [rules.md](rules.md)).
- A link, which may sit on its own line when it does not fit beside the text.
- A genuine algorithm note that no shorter form can carry. This is rare. If you
  reach for it twice in a file, the code is the problem — flag it.

## Worked rewrites

```python
# Before: 27 words, passive, two ideas
# We use a lock here to make sure that we don't have any race conditions when
# multiple threads are trying to write to the cache at the same time

# After
# Lock: concurrent writers corrupt the cache.
```

```javascript
// Before: hedged, no fact
// This is a bit of a hack but it seems to work for now

// After
// HACK: Safari fires resize before layout; one frame of delay fixes it.
```

```go
// Before: noun stack, passive
// The user session token refresh interval value is checked by this function

// After
// Returns how often to refresh the session token.
```

```rust
// Before: narrates, hedges, names the author
// I've updated this to handle the empty case, which I think was causing the
// panic you saw

// After
// Empty input panicked upstream: https://github.com/foo/bar/issues/123
```

## Reporting a rewrite

Show the before and after when you report, so the user can judge the loss. Keep
the longer form and flag it whenever shortening would drop a number, a
condition, a scope qualifier, or a safety warning. Losing precision to save
words is a bad trade.

## Source

ASD-STE100 Issue 9 (2025) — 53 writing rules and a controlled dictionary,
published by the AeroSpace and Defence Industries Association of Europe:
<https://www.asd-ste100.org/>. The condensation above follows
<https://github.com/danyuchn/asd-ste100-skill>, which applies the same standard
to agent output. Neither the official dictionary nor its word lists are
reproduced here.
