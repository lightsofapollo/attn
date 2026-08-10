<script lang="ts">
  /* The attn mark: the same hash-on-paper tile the desktop app carries in the
     Dock (`icons/attn.icns`) and the browser tab (`favicon.png`), redrawn as
     vector so it stays crisp at chrome sizes. The hosted surfaces used to draw
     an unrelated "a." tile here, which is why the web and the native app read
     as two different products.

     Traced from `icons/attn-source-original.png`: the tile is a 21.6%-radius
     rounded square, and the hash is four bars sheared -9.52 degrees about the
     glyph's optical centre (y=47.9 in this 100-unit frame). The rasterised
     model agrees with the source art at IoU 0.985.

     The palette is deliberately FIXED rather than tokenised. An app icon does
     not repaint itself when the OS flips to dark, and neither does this — the
     mark reads the same on the paper header and the ink one, exactly as it
     does in the Dock.

     One departure from the source art, and it is on purpose: the 1024px icon
     fills the hash with cream (#FBF3E9), which is ~1.1:1 against the tile. That
     holds up at Dock size because the glyph is knocked out and the desktop
     shows through it, but at 29px in a header it collapses into a smudge. So
     the chrome mark inks the hash in the icon's own outline colour instead
     (#58524A — 5.8:1 on the tile), which is the shape the eye already reads the
     Dock icon as. The hairline does the same job for the tile: on the light
     theme the paper background sits within a hair of the tile fill, and without
     it the silhouette dissolves. */

  interface Props {
    /** Rendered edge length in px. The tile fills the whole box. */
    size?: number;
    class?: string;
  }

  const { size = 29, class: className = '' }: Props = $props();

  /* Unsheared bar geometry in the 100-unit tile frame: [x, y, w, h]. The two
     verticals and two horizontals are painted in one ink, so their overlaps
     fuse into a single silhouette without any boolean path work. */
  const BARS: ReadonlyArray<readonly [number, number, number, number]> = [
    [34.2, 18.2, 9.9, 59.5],
    [55.8, 18.2, 9.9, 59.5],
    [22.2, 31.4, 54.7, 9.25],
    [22.2, 53.8, 54.7, 9.15],
  ];

  const TILE = '#e7ddd3';
  const INK = '#58524a';
</script>

<svg
  class={className}
  width={size}
  height={size}
  viewBox="0 0 100 100"
  fill="none"
  xmlns="http://www.w3.org/2000/svg"
  data-slot="brand-mark"
  aria-hidden="true"
  focusable="false"
>
  <rect width="100" height="100" rx="21.6" fill={TILE} />
  <!-- Silhouette keeper for the light theme, where tile and paper nearly match. -->
  <rect
    x="0.75"
    y="0.75"
    width="98.5"
    height="98.5"
    rx="20.85"
    fill="none"
    stroke={INK}
    stroke-opacity="0.12"
    stroke-width="1.5"
  />
  <g fill={INK} transform="translate(0 47.9) skewX(-9.52) translate(0 -47.9)">
    {#each BARS as [x, y, w, h] (x + ':' + y)}
      <rect {x} {y} width={w} height={h} rx="1.6" />
    {/each}
  </g>
</svg>

<style>
  svg {
    display: block;
    flex: none;
  }
</style>
