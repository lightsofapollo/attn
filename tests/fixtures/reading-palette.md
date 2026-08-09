---
title: Reading palette probe
author: attn
status: fixture
---

# Reading Palette

A plain body paragraph establishing the baseline ink for running prose. It is
long enough to wrap so the measurement is taken on real text rather than a
fragment, and it contains [an inline link](https://example.com) mid-sentence so
the link can be measured against the body text immediately around it.

Another paragraph with `inline code` sitting on the page surface.

> A blockquote. This is still prose and must read in the same ink as the body —
> the left bar and the indent already say it is quoted.

- A list item in a bullet list
- A second item with [a link](https://example.com) inside it

## Second Heading

| Feature | Status | Notes |
| --- | --- | --- |
| Tables | Done | plain cell text |
| Nested code | Done | a `chip` inside a cell |
| Links | Done | [in a cell](https://example.com) |

```rust
// A code block, for the recessed code surface and syntax highlighting.
fn main() {
    let greeting: &str = "Hello from attn";
    println!("{greeting}");
}
```

Final paragraph, closing the sample.
