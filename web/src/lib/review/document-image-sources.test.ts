import { markdownImageSources, srcsetSources } from './document-image-sources';

function equal(actual: readonly string[], expected: readonly string[], message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

equal(markdownImageSources('![Chart](assets/chart.png)\n![Chart](assets/chart.png)'), ['assets/chart.png'], 'Markdown dependencies are unique');
equal(markdownImageSources('remote ![Chart](https://example.test/chart.png)'), ['https://example.test/chart.png'], 'discovery leaves policy to its caller');
equal(srcsetSources('./chart.png 1x, ./chart@2x.png 2x'), ['./chart.png', './chart@2x.png'], 'srcset candidates retain URL tokens');

console.log('document-image-sources: 3 passed, 0 failed');
