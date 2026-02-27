import { mount } from 'svelte';
import App from './App.svelte';
import { installMockIpc } from './lib/mock-ipc';

// In dev mode (no native wry IPC), install mock handlers
installMockIpc();

const app = mount(App, {
  target: document.getElementById('app')!,
});

export default app;
