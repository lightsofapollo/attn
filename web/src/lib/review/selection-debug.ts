/**
 * Bounded, opt-in diagnostics for reviewer selection stability.
 *
 * Enable before reproducing with either `?attnSelectionDebug=1` on the
 * reviewer URL or `window.__attnSelectionDebug.enable()` in DevTools. The log
 * intentionally contains positions, element names, and truncated opaque IDs
 * only — never selected text, document content, or room capabilities.
 */

export interface ReviewSelectionDebugEvent {
  seq: number;
  at: number;
  kind: string;
  detail: Record<string, unknown>;
}

export interface ReviewSelectionDebugApi {
  enabled: boolean;
  consoleOutput: boolean;
  events: ReviewSelectionDebugEvent[];
  enable(options?: { console?: boolean }): void;
  disable(): void;
  clear(): void;
  dump(): string;
}

const MAX_EVENTS = 300;
const URL_REQUESTED = requestedByUrl();

type DebugHost = typeof globalThis & {
  __attnSelectionDebug?: ReviewSelectionDebugApi;
};

function requestedByUrl(): boolean {
  if (typeof location === 'undefined') return false;
  return new URLSearchParams(location.search).get('attnSelectionDebug') === '1';
}

function now(): number {
  const value = typeof performance === 'undefined' ? Date.now() : performance.now();
  return Math.round(value * 10) / 10;
}

function debugApi(): ReviewSelectionDebugApi {
  const host = globalThis as DebugHost;
  const existing = host.__attnSelectionDebug;
  if (existing) {
    if (URL_REQUESTED) {
      existing.enabled = true;
      existing.consoleOutput = true;
    }
    return existing;
  }

  let sequence = 0;
  const api: ReviewSelectionDebugApi = {
    enabled: URL_REQUESTED,
    consoleOutput: URL_REQUESTED,
    events: [],
    enable(options = {}) {
      api.enabled = true;
      api.consoleOutput = options.console ?? true;
    },
    disable() {
      api.enabled = false;
      api.consoleOutput = false;
    },
    clear() {
      api.events.length = 0;
      sequence = 0;
    },
    dump() {
      return JSON.stringify(api.events, null, 2);
    },
  };
  Object.defineProperty(host, '__attnSelectionDebug', {
    configurable: true,
    value: api,
  });
  Object.defineProperty(api, '__nextSequence', {
    configurable: false,
    enumerable: false,
    get: () => sequence,
    set: (value: number) => { sequence = value; },
  });
  return api;
}

export function reviewSelectionDebugEnabled(): boolean {
  return debugApi().enabled;
}

export function recordReviewSelectionDebug(
  kind: string,
  detail: Record<string, unknown> = {},
): void {
  const api = debugApi();
  if (!api.enabled) return;
  const sequenced = api as ReviewSelectionDebugApi & { __nextSequence: number };
  const event: ReviewSelectionDebugEvent = {
    seq: sequenced.__nextSequence + 1,
    at: now(),
    kind,
    detail,
  };
  sequenced.__nextSequence = event.seq;
  api.events.push(event);
  if (api.events.length > MAX_EVENTS) api.events.splice(0, api.events.length - MAX_EVENTS);
  if (api.consoleOutput) console.debug('[attn selection]', event);
}

// Install the DevTools surface as soon as the module is loaded, while keeping
// event collection dormant unless explicitly enabled.
debugApi();
