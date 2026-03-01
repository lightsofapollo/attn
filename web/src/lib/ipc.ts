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

export function checkboxToggle(line: number, checked: boolean): void {
  send({ type: 'checkbox_toggle', line, checked });
}

export function navigate(path: string): void {
  send({ type: 'navigate', path });
}

export function switchProject(path: string): void {
  send({ type: 'switch_project', path });
}

export function editSave(content: string): void {
  send({ type: 'edit_save', content });
}

export function themeChange(theme: string): void {
  send({ type: 'theme_change', theme });
}

export function openExternal(path: string): void {
  send({ type: 'open_external', path });
}

export function openDevtools(): void {
  send({ type: 'open_devtools' });
}

/** Mousedown handler for drag regions — skips interactive child elements. */
export function dragWindow(e: MouseEvent): void {
  const target = e.target as HTMLElement;
  if (target.closest('a, button, input, select, textarea')) return;
  send({ type: 'drag_window' });
}
