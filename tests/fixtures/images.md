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

An HTTPS image is a normal Markdown source. The workspace owner may load one
directly; an invited reader chooses whether to load external images for that
review session, so the image host cannot silently observe a reader&rsquo;s request.

This image is hosted remotely. The owner workspace should request it directly;
an invited reader should see the placeholder until they choose **Load images**.

![A remote landscape](https://images.pexels.com/photos/35227957/pexels-photo-35227957.jpeg)

## Missing file

The graceful state: alt text and a filename, not the platform's broken-image
glyph.

![A diagram that moved](./gone.png)
