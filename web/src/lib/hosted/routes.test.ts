import {
  entryHtmlPath,
  entryRequestPath,
  hostedEntryForPath,
  parseAppRoute,
  parseReviewRoute,
} from './routes';

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
assertEq(hostedEntryForPath('/homepage-alt'), 'landing', 'alternate landing');
assertEq(hostedEntryForPath('/unknown'), undefined, 'unknown path is not found');
assertEq(hostedEntryForPath('/reviewer'), undefined, 'prefix does not leak into review');
assertEq(hostedEntryForPath('/apple'), undefined, 'prefix does not leak into app');
assertEq(hostedEntryForPath('/app'), 'app', 'app home without slash');
assertEq(hostedEntryForPath('/app/'), 'app', 'app home with slash');
assertEq(hostedEntryForPath('/app/storage'), 'app', 'storage page');
assertEq(hostedEntryForPath('/app/w/ws1/untitled.md'), 'app', 'deep workspace path');
assertEq(hostedEntryForPath('/app/w/ws1/docs/nested/notes.md'), 'app', 'nested workspace path');
assertEq(hostedEntryForPath('/open'), 'app', 'import handoff');
assertEq(hostedEntryForPath('/review'), undefined, 'review root without room is not found');
assertEq(hostedEntryForPath('/review/abc-123'), 'review', 'review room');
assertEq(hostedEntryForPath('/review/abc-123/'), 'review', 'review room trailing slash');
assertEq(hostedEntryForPath('/s/AAAAAAAAAAAAAAAAAAAAAA'), 'review', 'durable share route');
assertEq(hostedEntryForPath('/share'), undefined, 'share prefix does not leak into review');
assertEq(hostedEntryForPath('/app/w'), undefined, 'malformed app route is not found');
assertEq(hostedEntryForPath('/s/AAAAAAAAAAAAAAAAAAAAAA/'), undefined, 'durable share trailing slash is not canonical');

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
assertEq(parseAppRoute('/s/abc'), undefined, 'durable share is not an app route');
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
assertEq(
  parseAppRoute('/app/w/ws1/'),
  { view: 'workspace', workspaceId: 'ws1', filePath: undefined },
  'workspace trailing slash',
);
assertEq(parseAppRoute('/app/w'), undefined, 'workspace prefix without id');
assertEq(parseAppRoute('/app/w/ws1/../escape.md'), undefined, 'dot-dot segments rejected');
assertEq(parseAppRoute('/app/w/ws1/%2e%2e/escape.md'), undefined, 'encoded dot-dot rejected');
assertEq(parseAppRoute('/app/w/ws1/docs/'), undefined, 'file path trailing slash rejected');
assertEq(parseAppRoute('/app/w/ws1/docs//notes.md'), undefined, 'file path empty segment rejected');
assertEq(parseAppRoute('/app/w/ws1/docs%2Fnotes.md'), undefined, 'encoded path separator rejected');
assertEq(parseAppRoute('/app/w/%E0%A4'), undefined, 'malformed percent escape rejected');
assertEq(parseAppRoute('/app/unknown'), undefined, 'unknown app subpath');
assertEq(parseAppRoute('/open/extra'), undefined, 'open takes no subpath');

// Review route parsing.
assertEq(parseReviewRoute('/review/room-123'), { view: 'room', roomId: 'room-123' }, 'review room');
assertEq(parseReviewRoute('/review/room-123/'), { view: 'room', roomId: 'room-123' }, 'review room trailing slash');
assertEq(
  parseReviewRoute('/s/AAAAAAAAAAAAAAAAAAAAAA'),
  { view: 'share', shareId: 'AAAAAAAAAAAAAAAAAAAAAA' },
  'canonical durable share',
);
assertEq(parseReviewRoute('/review'), undefined, 'review id required');
assertEq(parseReviewRoute('/review/room/extra'), undefined, 'review has one id segment');
assertEq(parseReviewRoute('/s/short'), undefined, 'share id has exact canonical length');
assertEq(parseReviewRoute('/s/AAAAAAAAAAAAAAAAAAAAAB'), undefined, 'share id has canonical trailing bits');
assertEq(parseReviewRoute('/s/AAAAAAAAAAAAAAAAAAAAAA/'), undefined, 'share trailing slash rejected');

console.log('hosted routes: all cases passed');
