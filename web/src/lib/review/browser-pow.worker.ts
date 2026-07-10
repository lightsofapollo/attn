import { mineBrowserPow, type BrowserPowInputs } from './browser-pow';

interface WorkerScope {
  onmessage: ((event: MessageEvent<BrowserPowInputs>) => void) | null;
  postMessage(message: unknown): void;
}

const scope = globalThis as unknown as WorkerScope;

scope.onmessage = (event) => {
  try {
    const mined = mineBrowserPow(event.data);
    scope.postMessage({ token: mined.token });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'PoW mint failed';
    scope.postMessage({ error: message });
  }
};
