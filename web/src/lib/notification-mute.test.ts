// Focused wire/state test for the persisted per-room native notification toggle.
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

const { reviewNotificationMute } = await import('./ipc');
reviewNotificationMute('room-safe', true);
reviewNotificationMute('room-safe', false);

const decoded = sent.map((message) => JSON.parse(message) as Record<string, unknown>);
if (
  decoded.length !== 2
  || decoded[0]?.type !== 'review_notification_mute'
  || decoded[0]?.roomId !== 'room-safe'
  || decoded[0]?.muted !== true
  || decoded[1]?.muted !== false
) {
  console.error('FAIL native notification mute IPC wire', decoded);
  process.exit(1);
}

console.log('  ok  native notification mute uses an explicit per-room boolean wire');
