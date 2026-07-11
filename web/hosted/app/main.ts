// Local workspace app entry (attn-7xl.1.1). Placeholder shell: it proves the
// route→entry boundary (deep /app/* and /open paths land here with their own
// bundle graph) and exposes the parsed route. attn-7xl.1.3 replaces the DOM
// below with the designed Svelte shells behind a mock workspace service.
import { parseAppRoute, type AppRoute } from '../../src/lib/hosted/routes';
import '../styles/app-placeholder.css';

function describeRoute(route: AppRoute | undefined): string {
  if (!route) return 'Unknown app path';
  switch (route.view) {
    case 'home':
      return 'On this device';
    case 'storage':
      return 'Storage & recovery';
    case 'open':
      return 'Import into your desk';
    case 'workspace':
      return route.filePath
        ? `Workspace ${route.workspaceId} — ${route.filePath}`
        : `Workspace ${route.workspaceId}`;
  }
}

const route = parseAppRoute(window.location.pathname);
const target = document.getElementById('app');
if (!target) throw new Error('missing app mount element');

const main = document.createElement('main');
main.className = 'landing';
main.dataset.appView = route?.view ?? 'unknown';

const heading = document.createElement('h1');
heading.textContent = describeRoute(route);

const note = document.createElement('p');
note.textContent =
  'The local workspace desk is under construction. Documents you create here will stay on this device.';

const back = document.createElement('p');
const backLink = document.createElement('a');
backLink.href = '/';
backLink.textContent = 'Back to attn.sh';
back.appendChild(backLink);

main.append(heading, note, back);
target.appendChild(main);
document.body.dataset.hydrated = 'true';
