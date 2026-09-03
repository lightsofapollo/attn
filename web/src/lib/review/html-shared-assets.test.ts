import { rewriteSrcset } from './html-shared-assets';
import { UNRESOLVED_SHARED_IMAGE_SRC } from './shared-image-policy';

function assertEqual(actual: string, expected: string, message: string): void {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, got ${actual}`);
}

const resolve = (src: string): string | null => src === './chart.png' ? 'blob:verified-chart' : null;

assertEqual(
  rewriteSrcset('./chart.png 1x, remote.png 2x', resolve),
  `blob:verified-chart 1x, ${UNRESOLVED_SHARED_IMAGE_SRC} 2x`,
  'srcset blocks every candidate without a verified local binding',
);
assertEqual(
  rewriteSrcset(' data:image/png;base64,AAAA 1x', resolve),
  ` ${UNRESOLVED_SHARED_IMAGE_SRC} 1x`,
  'unresolved data source becomes a no-network fallback',
);
assertEqual(
  rewriteSrcset('https://images.example.test/chart.png 1x', (src) => src.startsWith('https://') ? src : null),
  'https://images.example.test/chart.png 1x',
  'a caller-approved HTTPS source stays intact',
);

console.log('html-shared-assets: 3 passed, 0 failed');
