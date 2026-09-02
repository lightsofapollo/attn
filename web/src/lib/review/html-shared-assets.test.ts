import { rewriteSrcset } from './html-shared-assets';

function assertEqual(actual: string, expected: string, message: string): void {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, got ${actual}`);
}

const resolve = (src: string): string | null => src === './chart.png' ? 'blob:verified-chart' : null;

assertEqual(
  rewriteSrcset('./chart.png 1x, remote.png 2x', resolve),
  'blob:verified-chart 1x, remote.png 2x',
  'srcset replaces only a verified local candidate',
);
assertEqual(
  rewriteSrcset(' data:image/png;base64,AAAA 1x', resolve),
  ' data:image/png;base64,AAAA 1x',
  'unresolved data source stays byte-for-byte intact',
);

console.log('html-shared-assets: 2 passed, 0 failed');
