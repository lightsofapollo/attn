import '../../src/browser-review';

// Registration is shell plumbing only. Push permission and subscription are
// still created exclusively by the explicit remember-room consent flow.
if ('serviceWorker' in navigator && !import.meta.env.DEV) {
  navigator.serviceWorker.register('/sw.js').catch(() => undefined);
}
