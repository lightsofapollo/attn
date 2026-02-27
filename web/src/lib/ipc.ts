import type { IpcMessage } from './types';

interface WryIpc {
  postMessage(message: string): void;
}

declare global {
  interface Window {
    ipc?: WryIpc;
  }
}

function send(message: IpcMessage): void {
  if (window.ipc) {
    window.ipc.postMessage(JSON.stringify(message));
  }
}

export function quit(): void {
  send({ type: 'quit' });
}

export function checkboxToggle(index: number, checked: boolean): void {
  send({ type: 'checkbox_toggle', index, checked });
}

export function navigate(path: string): void {
  send({ type: 'navigate', path });
}

export function editSave(content: string): void {
  send({ type: 'edit_save', content });
}

export function themeChange(theme: string): void {
  send({ type: 'theme_change', theme });
}
