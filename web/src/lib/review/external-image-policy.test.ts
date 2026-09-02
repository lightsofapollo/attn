import { approvedExternalImageUrl } from './external-image-policy';

function assertEq(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

assertEq(
  approvedExternalImageUrl('https://images.example.test/charts/q3.png?theme=dark'),
  'https://images.example.test/charts/q3.png?theme=dark',
  'HTTPS image is accepted',
);
assertEq(approvedExternalImageUrl('http://images.example.test/chart.png'), null, 'HTTP is rejected');
assertEq(approvedExternalImageUrl('//images.example.test/chart.png'), null, 'protocol-relative URL is rejected');
assertEq(approvedExternalImageUrl('data:image/png;base64,AAAA'), null, 'data URL is rejected');
assertEq(approvedExternalImageUrl('javascript:alert(1)'), null, 'script URL is rejected');
assertEq(approvedExternalImageUrl('https://reader:secret@images.example.test/chart.png'), null, 'URL credentials are rejected');
assertEq(approvedExternalImageUrl('./chart.png'), null, 'workspace-relative URL is not external');

console.log('external-image-policy: 7 passed');
