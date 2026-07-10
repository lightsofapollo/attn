import { htmlViewerSandbox } from './html-viewer-sandbox';

if (htmlViewerSandbox(false) !== '') {
  throw new Error('hosted shared HTML must use a sandbox with no script token');
}
if (htmlViewerSandbox(true) !== 'allow-scripts') {
  throw new Error('native/local HTML script behavior must remain enabled');
}

console.log('html-viewer-sandbox: hosted and native policies passed');
