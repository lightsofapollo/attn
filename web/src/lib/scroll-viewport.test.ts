import { scrollTopForViewportAnchor, viewportSampleX } from './scroll-viewport';

function assertEqual(actual: number, expected: number, message: string): void {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, got ${actual}`);
}

assertEqual(
  scrollTopForViewportAnchor(580),
  500,
  'jump preserves the remote 80px reading-band inset',
);
assertEqual(
  scrollTopForViewportAnchor(45),
  0,
  'jump clamps anchors near the start of the document',
);
assertEqual(
  viewportSampleX(100, 900, 300, 700),
  500,
  'viewport probe uses the center of the visible editor band',
);
assertEqual(
  viewportSampleX(100, 900, 0, 400),
  250,
  'viewport probe accounts for a horizontally clipped editor',
);

console.log('scroll-viewport: all assertions passed');
