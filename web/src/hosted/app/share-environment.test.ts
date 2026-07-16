import { resolveBrowserReviewBase } from './share-environment';

function assertEq(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

assertEq(
  resolveBrowserReviewBase(undefined, undefined, 'http://127.0.0.1:5199'),
  'https://staging.attn.sh/review',
  'ordinary localhost shares use staging',
);
assertEq(
  resolveBrowserReviewBase(undefined, 'https://relay-staging.attn.sh', 'http://localhost:5199'),
  'https://staging.attn.sh/review',
  'explicit staging relay uses staging links',
);
assertEq(
  resolveBrowserReviewBase(undefined, 'http://localhost:8787', 'http://127.0.0.1:5199'),
  'http://127.0.0.1:5199/review',
  'explicit local relay keeps local links',
);
assertEq(
  resolveBrowserReviewBase(undefined, 'https://relay.attn.sh', 'http://127.0.0.1:5199'),
  'https://attn.sh/review',
  'explicit production relay uses production links',
);
assertEq(
  resolveBrowserReviewBase('https://preview.example/path', undefined, 'http://127.0.0.1:5199'),
  'https://preview.example/review',
  'explicit share origin wins',
);
assertEq(
  resolveBrowserReviewBase(undefined, 'https://relay-staging.attn.sh', 'https://staging.attn.sh'),
  'https://staging.attn.sh/review',
  'deployed app uses its own origin',
);

console.log('share-environment: all cases passed');
