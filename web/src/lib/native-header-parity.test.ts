import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const libDir = path.dirname(fileURLToPath(import.meta.url));
const source = (relative: string): string => fs.readFileSync(path.join(libDir, relative), 'utf8');

const app = source('../App.svelte');
const frame = source('WorkspaceEditorFrame.svelte');
const hostedFrame = source('../hosted/app/HostedDesktopWorkspaceFrame.svelte');

assert(app.includes('{#snippet nativeHeader()}'), 'native app must own one in-flow header');
assert(app.includes('data-slot="native-header"'), 'native header needs a stable automation slot');
assert(app.includes('Saved on this device'), 'native save copy must match the mobile masthead');
assert(app.includes('railToggle={true}'), 'native comments toggle must live in the shared header');
assert(app.includes('inline={true}'), 'native ReviewBar must render in header flow');
assert(
  app.indexOf('data-slot="native-save-chip"') < app.indexOf('data-slot="native-header-share"'),
  'native status must precede Share in the right-side action cluster',
);

assert(
  frame.indexOf('{@render chrome?.()}') < frame.indexOf('{@render banner?.()}'),
  'workspace chrome must span the content and review rail before the body',
);
assert(frame.includes('{#if railToggleInHeader}'), 'rail-local toggle must collapse when header owns it');

assert(
  hostedFrame.indexOf('{@render actions()}') < hostedFrame.indexOf('data-slot="owner-header-share"'),
  'hosted desktop must keep status and Share together like mobile and native',
);

console.log('  ok  native/mobile header grammar stays aligned');
