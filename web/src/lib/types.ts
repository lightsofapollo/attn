export interface Progress {
  done: number;
  total: number;
}

export interface Phase {
  title: string;
  progress: Progress;
}

export interface Task {
  line: number;
  text: string;
  checked: boolean;
}

export interface PlanStructure {
  phases: Phase[];
  tasks: Task[];
  file_refs: string[];
}

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
}

export interface ContentPayload {
  html: string;
  rawMarkdown: string;
  structure: PlanStructure;
  filePath: string;
  fileTree?: FileEntry[];
}

export interface UpdatePayload {
  html: string;
  rawMarkdown: string;
  structure: PlanStructure;
}

export type IpcMessageType =
  | 'quit'
  | 'checkbox_toggle'
  | 'navigate'
  | 'edit_save'
  | 'theme_change';

export interface QuitMessage {
  type: 'quit';
}

export interface CheckboxToggleMessage {
  type: 'checkbox_toggle';
  index: number;
  checked: boolean;
}

export interface NavigateMessage {
  type: 'navigate';
  path: string;
}

export interface EditSaveMessage {
  type: 'edit_save';
  content: string;
}

export interface ThemeChangeMessage {
  type: 'theme_change';
  theme: string;
}

export type IpcMessage =
  | QuitMessage
  | CheckboxToggleMessage
  | NavigateMessage
  | EditSaveMessage
  | ThemeChangeMessage;

export type AppMode = 'read' | 'edit';

export type ThemeName = 'light' | 'dark' | 'system';
