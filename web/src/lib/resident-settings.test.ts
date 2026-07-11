// Focused wire test for the explicit launch-at-login toggle.
export {};

const sent: string[] = [];
const scope = globalThis as unknown as {
  window: { ipc: { postMessage(message: string): void } };
};
scope.window = {
  ipc: {
    postMessage(message: string): void {
      sent.push(message);
    },
  },
};

const { setResidentLaunchAtLogin } = await import('./ipc');
setResidentLaunchAtLogin(true);
setResidentLaunchAtLogin(false);

const decoded = sent.map((message) => JSON.parse(message) as Record<string, unknown>);
if (
  decoded.length !== 2
  || decoded[0]?.type !== 'resident_launch_at_login'
  || decoded[0]?.enabled !== true
  || decoded[1]?.type !== 'resident_launch_at_login'
  || decoded[1]?.enabled !== false
) {
  console.error('FAIL resident launch-at-login IPC wire', decoded);
  process.exit(1);
}

console.log('  ok  resident launch-at-login IPC uses explicit boolean wire');
