// Instance-scoped Svelte 5 state over BrowserWorkspaceService (attn-7xl.3.1).
//
// `.svelte.ts` because runes only compile outside components with this
// extension (see src/lib/review/store.svelte.ts precedent). This wrapper is
// deliberately thin: all logic lives in workspace-service.ts where tsx unit
// tests exercise it. Every field is an instance property — no module-level
// mutable state, so multiple app instances (tests, sheets, future embeds)
// never leak into each other.

import type { WorkspaceEntryRecord, WorkspaceRecord } from '../../lib/review/browser-workspace-schema';
import type { SaveState, PersistenceMode, WorkspaceSummary } from './types';
import {
  mapError,
  type BrowserWorkspaceService,
  type WorkspaceServiceError,
} from './workspace-service';

export interface CurrentWorkspaceState {
  workspace: WorkspaceRecord;
  entries: WorkspaceEntryRecord[];
  activePath: string | undefined;
  /** Decoded head body of the active Markdown entry, when one is selected. */
  bodyText: string | null;
}

export class WorkspaceUiState {
  status = $state<'loading' | 'ready' | 'error'>('loading');
  workspaces = $state<WorkspaceSummary[]>([]);
  persistence = $state<PersistenceMode>('best-effort');
  saveState = $state<SaveState>('Saved on this device');
  error = $state<WorkspaceServiceError | null>(null);
  current = $state<CurrentWorkspaceState | null>(null);

  private readonly service: BrowserWorkspaceService;

  constructor(service: BrowserWorkspaceService) {
    this.service = service;
  }

  /** Load the desk: capability mode plus recent workspaces. */
  async refresh(): Promise<void> {
    try {
      this.persistence = this.service.persistenceMode();
      this.workspaces = await this.service.listWorkspaces();
      this.status = 'ready';
      this.error = null;
    } catch (error) {
      this.fail(error);
    }
  }

  /** One-click landing intent: create untitled.md and open it. */
  async createAndOpen(): Promise<string | null> {
    try {
      const created = await this.service.createWorkspace();
      await this.openWorkspace(created.workspace.workspaceId);
      return created.workspace.workspaceId;
    } catch (error) {
      this.fail(error);
      return null;
    }
  }

  async openWorkspace(workspaceId: string, path?: string): Promise<void> {
    try {
      const loaded = await this.service.loadWorkspace(workspaceId);
      if (!loaded) {
        this.current = null;
        this.status = 'ready';
        return;
      }
      const activePath = path ?? loaded.workspace.activePath ?? loaded.entries[0]?.path;
      const activeEntry = loaded.entries.find((entry) => entry.path === activePath);
      const bodyText =
        activeEntry?.kind === 'markdown'
          ? await this.service.readHeadText(workspaceId, activeEntry.path)
          : null;
      this.current = {
        workspace: loaded.workspace,
        entries: loaded.entries,
        activePath,
        bodyText,
      };
      this.status = 'ready';
      this.error = null;
    } catch (error) {
      this.fail(error);
    }
  }

  /** Durable outcomes drive the visible save state — never optimistic. */
  async commitActiveBody(text: string): Promise<void> {
    const current = this.current;
    if (!current?.activePath) return;
    this.saveState = 'Saving…';
    try {
      const committed = await this.service.commitText(
        current.workspace.workspaceId,
        current.activePath,
        text,
      );
      this.current = {
        ...current,
        workspace: committed.workspace,
        entries: current.entries.map((entry) =>
          entry.path === committed.entry.path ? committed.entry : entry,
        ),
        bodyText: text,
      };
      this.saveState = 'Saved on this device';
      this.error = null;
    } catch (error) {
      this.saveState = 'Storage needs attention';
      this.fail(error, /* keepStatus */ true);
    }
  }

  private fail(error: unknown, keepStatus = false): void {
    this.error = mapError(error).info;
    if (!keepStatus) this.status = 'error';
  }
}
