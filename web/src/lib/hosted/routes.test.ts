import { entryHtmlPath, entryRequestPath, hostedEntryForPath, parseAppRoute } from './routes';

function assertEq(actual: unknown, expected: unknown, label: string): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${label}: expected ${expectedJson}, got ${actualJson}`);
  }
}

// Entry selection.
assertEq(hostedEntryForPath('/'), 'landing', 'root');
assertEq(hostedEntryForPath('/index.html'), 'landing', 'root document');
assertEq(hostedEntryForPath('/unknown'), 'landing', 'unknown path falls to landing');
assertEq(hostedEntryForPath('/reviewer'), 'landing', 'prefix does not leak into review');
assertEq(hostedEntryForPath('/apple'), 'landing', 'prefix does not leak into app');
assertEq(hostedEntryForPath('/app'), 'app', 'app home without slash');
assertEq(hostedEntryForPath('/app/'), 'app', 'app home with slash');
assertEq(hostedEntryForPath('/app/storage'), 'app', 'storage page');
assertEq(hostedEntryForPath('/app/w/ws1/untitled.md'), 'app', 'deep workspace path');
assertEq(hostedEntryForPath('/app/w/ws1/docs/nested/notes.md'), 'app', 'nested workspace path');
assertEq(hostedEntryForPath('/open'), 'app', 'import handoff');
assertEq(hostedEntryForPath('/review'), 'review', 'review root');
assertEq(hostedEntryForPath('/review/abc-123'), 'review', 'review room');
assertEq(hostedEntryForPath('/review/abc-123/'), 'review', 'review room trailing slash');

// Entry documents.
assertEq(entryHtmlPath('landing'), '/index.html', 'landing document');
assertEq(entryHtmlPath('app'), '/app/index.html', 'app document');
assertEq(entryHtmlPath('review'), '/review/index.html', 'review document');

// Canonical worker request paths.
assertEq(entryRequestPath('landing'), '/', 'landing request path');
assertEq(entryRequestPath('app'), '/app/', 'app request path');
assertEq(entryRequestPath('review'), '/review/', 'review request path');

// App route parsing.
assertEq(parseAppRoute('/'), undefined, 'landing is not an app route');
assertEq(parseAppRoute('/review/abc'), undefined, 'review is not an app route');
assertEq(parseAppRoute('/app'), { view: 'home' }, 'app home');
assertEq(parseAppRoute('/app/'), { view: 'home' }, 'app home trailing slash');
assertEq(parseAppRoute('/app/storage'), { view: 'storage' }, 'storage');
assertEq(parseAppRoute('/open'), { view: 'open' }, 'open');
assertEq(
  parseAppRoute('/app/w/ws1'),
  { view: 'workspace', workspaceId: 'ws1', filePath: undefined },
  'workspace without file',
);
assertEq(
  parseAppRoute('/app/w/ws1/untitled.md'),
  { view: 'workspace', workspaceId: 'ws1', filePath: 'untitled.md' },
  'workspace with file',
);
assertEq(
  parseAppRoute('/app/w/ws1/docs/nested/notes.md'),
  { view: 'workspace', workspaceId: 'ws1', filePath: 'docs/nested/notes.md' },
  'workspace with nested file path',
);
assertEq(
  parseAppRoute('/app/w/ws%201/spaced%20name.md'),
  { view: 'workspace', workspaceId: 'ws 1', filePath: 'spaced name.md' },
  'percent-encoded segments decode',
);
assertEq(parseAppRoute('/app/w'), undefined, 'workspace prefix without id');
assertEq(parseAppRoute('/app/w/ws1/../escape.md'), undefined, 'dot-dot segments rejected');
assertEq(parseAppRoute('/app/w/ws1/%2e%2e/escape.md'), undefined, 'encoded dot-dot rejected');
assertEq(parseAppRoute('/app/unknown'), undefined, 'unknown app subpath');
assertEq(parseAppRoute('/open/extra'), undefined, 'open takes no subpath');

console.log('hosted routes: all cases passed');
