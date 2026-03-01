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

export type FileType = 'markdown' | 'image' | 'video' | 'audio' | 'directory' | 'unsupported';

export interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children?: TreeNode[];
  fileType: FileType;
}

/** @deprecated Use TreeNode instead */
export type FileEntry = TreeNode;

export interface ContentPayload {
  markdown?: string;
  structure?: PlanStructure;
  filePath: string;
  fileTree?: TreeNode[];
  rootPath?: string;
  knownProjects?: string[];
  activeProjectPath?: string;
  contentMtimeMs?: number;
  contentBytes?: number;
}

export interface UpdatePayload {
  markdown?: string;
  structure?: PlanStructure;
  filePath?: string;
  fileTree?: TreeNode[];
  rootPath?: string;
  knownProjects?: string[];
  activeProjectPath?: string;
  changedPaths?: string[];
  contentMtimeMs?: number;
  contentBytes?: number;
}

export type IpcMessageType =
  | 'checkbox_toggle'
  | 'navigate'
  | 'switch_project'
  | 'edit_save'
  | 'theme_change'
  | 'open_external'
  | 'open_devtools'
  | 'drag_window'
  | 'js_log'
  | 'js_error';

export interface CheckboxToggleMessage {
  type: 'checkbox_toggle';
  line: number;
  checked: boolean;
}

export interface NavigateMessage {
  type: 'navigate';
  path: string;
}

export interface SwitchProjectMessage {
  type: 'switch_project';
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

export interface OpenExternalMessage {
  type: 'open_external';
  path: string;
}

export interface DragWindowMessage {
  type: 'drag_window';
}

export interface OpenDevtoolsMessage {
  type: 'open_devtools';
}

export interface JsLogMessage {
  type: 'js_log';
  level: string;
  message: string;
  source?: string;
  stack?: string;
}

export interface JsErrorMessage {
  type: 'js_error';
  message: string;
  source: string;
  line?: number;
  column?: number;
  stack?: string;
}

export type IpcMessage =
  | CheckboxToggleMessage
  | NavigateMessage
  | SwitchProjectMessage
  | EditSaveMessage
  | ThemeChangeMessage
  | OpenExternalMessage
  | OpenDevtoolsMessage
  | DragWindowMessage
  | JsLogMessage
  | JsErrorMessage;

export type AppMode = 'read' | 'edit';

export type ThemeName = 'light' | 'dark';
export type DiagMode = 'full' | 'editor_only' | 'minimal';

export interface InitPayload {
  markdown?: string;
  structure?: PlanStructure;
  filePath?: string;
  fileTree?: TreeNode[];
  rootPath?: string;
  knownProjects?: string[];
  activeProjectPath?: string;
  theme: ThemeName;
  diagMode?: DiagMode;
  contentMtimeMs?: number;
  contentBytes?: number;
}
