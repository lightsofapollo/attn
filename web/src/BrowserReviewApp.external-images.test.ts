import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, 'BrowserReviewApp.svelte'), 'utf8');

assert(
  source.includes('let externalImagesEnabled = $state(false);'),
  'external image consent must start off for every reviewer tab',
);
assert(
  (source.match(/const allowExternalImages = externalImagesEnabled;/g) ?? []).length === 2,
  'Markdown and HTML share resolvers must both react to reviewer consent',
);
assert(
  (source.match(/if \(allowExternalImages && external !== null\) return external;/g) ?? []).length === 2,
  'only an explicitly enabled HTTPS image may bypass the verified-asset resolver',
);
assert(
  source.includes('data-slot="browser-review-external-images"'),
  'a document with external images must expose a reviewer control',
);
assert(
  source.includes('Those hosts may see your IP address.'),
  'the reviewer control must state the privacy consequence before it loads an external image',
);

console.log('browser-review external images: all assertions passed');
