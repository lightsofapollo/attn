import { mount } from 'svelte';
import App from './App.svelte';
import { installMockIpc } from './lib/mock-ipc';
import '@fontsource-variable/source-serif-4';
import '@fontsource-variable/source-serif-4/opsz-italic.css';
import '@fontsource-variable/source-sans-3';
import '@fontsource-variable/source-code-pro';
import './app.css';
import '../styles/base.css';
import '../styles/prosemirror.css';
import '../styles/syntax.css';

type ConsoleLevel = 'debug' | 'log' | 'info' | 'warn' | 'error';

function installJsBridge(): void {
  const win = window as Window & { __attnJsBridgeInstalled?: boolean };
  if (win.__attnJsBridgeInstalled) return;
  win.__attnJsBridgeInstalled = true;

  const MAX_MESSAGE_LENGTH = 32_768;
  const RATE_WINDOW_MS = 1_000;
  const RATE_LIMIT = 200;
  let windowStart = performance.now();
  let sentInWindow = 0;
  let droppedInWindow = 0;
  let posting = false;

  const trim = (text: string): string => (
    text.length <= MAX_MESSAGE_LENGTH
      ? text
      : `${text.slice(0, MAX_MESSAGE_LENGTH)}...[truncated]`
  );

  const stringifyArg = (value: unknown): string => {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (value instanceof Error) {
      return trim(value.stack ?? `${value.name}: ${value.message}`);
    }
    if (typeof value === 'string') return trim(value);
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
      return String(value);
    }
    if (typeof value === 'function') {
      return `[function ${value.name || 'anonymous'}]`;
    }
    try {
      return trim(JSON.stringify(value));
    } catch {
      return trim(String(value));
    }
  };

  const post = (payload: unknown): void => {
    if (posting) return;
    if (!window.ipc) return;
    try {
      posting = true;
      window.ipc.postMessage(JSON.stringify(payload));
    } catch {
      // Ignore bridge errors in dev/browser mode.
    } finally {
      posting = false;
    }
  };

  const rotateWindow = (): void => {
    const now = performance.now();
    if (now - windowStart <= RATE_WINDOW_MS) return;
    if (droppedInWindow > 0) {
      post({
        type: 'js_log',
        level: 'warn',
        message: `Dropped ${droppedInWindow} console messages in the previous ${RATE_WINDOW_MS}ms window`,
        source: 'console_bridge',
      });
    }
    windowStart = now;
    sentInWindow = 0;
    droppedInWindow = 0;
  };

  const postConsole = (level: ConsoleLevel, args: unknown[]): void => {
    rotateWindow();
    if (sentInWindow >= RATE_LIMIT) {
      droppedInWindow += 1;
      return;
    }
    sentInWindow += 1;
    post({
      type: 'js_log',
      level,
      message: trim(args.map((arg) => stringifyArg(arg)).join(' ')),
      source: 'console',
    });
  };

  const wrapConsole = (level: ConsoleLevel): void => {
    const original = console[level].bind(console);
    console[level] = ((...args: unknown[]) => {
      original(...args);
      postConsole(level, args);
    }) as typeof console[ConsoleLevel];
  };

  wrapConsole('debug');
  wrapConsole('log');
  wrapConsole('info');
  wrapConsole('warn');
  wrapConsole('error');

  window.addEventListener('error', (event) => {
    const err = event.error;
    post({
      type: 'js_error',
      message: trim(event.message || stringifyArg(err)),
      source: event.filename || 'window.onerror',
      line: event.lineno || 0,
      column: event.colno || 0,
      stack: err && err.stack ? trim(String(err.stack)) : undefined,
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    post({
      type: 'js_error',
      message: trim(stringifyArg(reason)),
      source: 'unhandledrejection',
      line: 0,
      column: 0,
      stack: reason && reason.stack ? trim(String(reason.stack)) : undefined,
    });
  });
}

const target = document.getElementById('app');
if (!target) {
  throw new Error('attn: missing #app mount element');
}

target.style.display = '';
installJsBridge();

// In dev mode (no native wry IPC), install mock handlers
installMockIpc();
mount(App, { target });
