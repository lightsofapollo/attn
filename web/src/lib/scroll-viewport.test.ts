import { scrollTopForViewportAnchor } from './scroll-viewport';

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

console.log('scroll-viewport: all assertions passed');
