# Images

A fixture for relative image resolution in attn. Every src below is authored
the way a human or an agent actually writes one; the viewer resolves each
against **this file's own directory**. Native attn serves local files through
the `attn://` protocol handler, while a browser workspace resolves the files
that were imported with it.

## Sibling, dot-slash

![A diagram](./diagram.png)

## Sibling, bare

![The same diagram, addressed without the dot](diagram.png)

## Subdirectory

![A diagram in a subdirectory](./nested/diagram.png)

## Vector

A referenced `.svg` is an ordinary image node — the browser loads it as an
image document. This is not the embedded-SVG path; that one is for raw `<svg>`
blocks written inline in the markdown source.

![A bar chart](./chart.svg)

## Remote source

Imported workspaces and encrypted shares resolve only files that arrived with
the workspace. A remote URL is not fetched by a reader&rsquo;s browser, so it cannot
silently contact an address chosen by the document author.

This source is deliberately unavailable. **Expect a placeholder card here** —
the test is the safe fallback, not remote pixels.

![A remote pixel](https://example.com/pixel.png)

## Missing file

The graceful state: alt text and a filename, not the platform's broken-image
glyph.

![A diagram that moved](./gone.png)
