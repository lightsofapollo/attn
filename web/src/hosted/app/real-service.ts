// Storage-backed WorkspaceAppService adapter (attn-7xl.3.2).
//
// Maps BrowserWorkspaceService (attn-7xl.3.1) onto the view contract the
// shells render. This module pulls the crypto/storage graph, so the app
// entry loads it via dynamic import only — the route bundle gate forbids it
// from the static graph.

import type {
  EditingSession,
  ImportFileInput,
  PersistenceMode,
  ShareScope,
  StorageHealth,
  WorkspaceAppService,
  WorkspaceDetail,
  WorkspaceEntry,
  WorkspaceSummary,
} from './types';
import {
  BrowserWorkspaceService,
  sizeLabel,
  type BrowserWorkspaceServiceOptions,
} from './workspace-service';
import { quotaPressure } from '../../lib/review/browser-storage-probe';
import type { WorkspaceEntryRecord } from '../../lib/review/browser-workspace-schema';

/** Safe raster types that may render inline (epic scope note 2026-07-10). */
const INLINE_SAFE_MEDIA = /^image\/(?:png|jpeg|gif|webp|avif)$/iu;

export class RealWorkspaceAppService implements WorkspaceAppService {
  private readonly service: BrowserWorkspaceService;

  private constructor(service: BrowserWorkspaceService) {
    this.service = service;
  }

  static async open(options: BrowserWorkspaceServiceOptions = {}): Promise<RealWorkspaceAppService> {
    return new RealWorkspaceAppService(await BrowserWorkspaceService.open(options));
  }

  close(): void {
    this.service.close();
  }

  storageHealth(): StorageHealth {
    const capabilities = this.service.capabilities();
    const estimate = capabilities.estimate;
    const usage = estimate?.usage;
    const quota = estimate?.quota;
    const mode: PersistenceMode = this.service.persistenceMode();
    return {
      mode,
      usedLabel: usage === undefined ? '—' : sizeLabel(usage),
      quotaLabel: quota === undefined ? 'unknown' : sizeLabel(quota),
      usedFraction:
        usage !== undefined && quota !== undefined && quota > 0
          ? Math.min(1, usage / quota)
          : quotaPressure(estimate)
            ? 1
            : 0,
    };
  }

  async listWorkspaces(): Promise<WorkspaceSummary[]> {
    return this.service.listWorkspaces();
  }

  async getWorkspace(workspaceId: string): Promise<WorkspaceDetail | undefined> {
    const loaded = await this.service.loadWorkspace(workspaceId);
    if (!loaded) return undefined;
    const summaries = await this.service.listWorkspaces();
    const summary = summaries.find((candidate) => candidate.id === workspaceId);
    return {
      ...(summary ?? {
        id: workspaceId,
        name: loaded.workspace.name,
        markdownCount: 0,
        assetCount: 0,
        lastEditedLabel: 'Just now',
        sharing: 'local-only' as const,
        sizeLabel: '—',
        backupLabel: 'Never backed up',
        openPath: loaded.workspace.activePath ?? 'untitled.md',
      }),
      entries: loaded.entries.map(toViewEntry),
      saveState: 'Saved on this device',
      reviewCards: [],
    };
  }

  async readBodyText(workspaceId: string, path: string): Promise<string | null> {
    const loaded = await this.service.loadWorkspace(workspaceId);
    const entry = loaded?.entries.find((candidate) => candidate.path === path);
    if (!entry || entry.kind !== 'markdown') return null;
    return this.service.readHeadText(workspaceId, path);
  }

  async createWorkspace(): Promise<WorkspaceDetail> {
    const created = await this.service.createWorkspace();
    const detail = await this.getWorkspace(created.workspace.workspaceId);
    if (!detail) throw new Error('created workspace vanished');
    return detail;
  }

  async importFiles(name: string, files: ImportFileInput[]): Promise<WorkspaceDetail> {
    const imported = await this.service.importWorkspace(name, files);
    const detail = await this.getWorkspace(imported.workspace.workspaceId);
    if (!detail) throw new Error('imported workspace vanished');
    return detail;
  }

  async renameWorkspace(workspaceId: string, name: string): Promise<void> {
    await this.service.renameWorkspace(workspaceId, name);
  }

  async deleteWorkspace(workspaceId: string): Promise<void> {
    await this.service.deleteWorkspace(workspaceId);
  }

  async beginEditing(workspaceId: string): Promise<EditingSession | null> {
    const holder = new Uint8Array(9);
    crypto.getRandomValues(holder);
    const holderId = `tab-${Array.from(holder, (b) => b.toString(16).padStart(2, '0')).join('')}`;
    const runtime = await this.service.beginOwnerRuntime(workspaceId, holderId);
    if (runtime.getState().leaseRole !== 'owner') {
      await runtime.close();
      return null;
    }
    return {
      async commitText(path: string, text: string): Promise<void> {
        // The runtime serializes this with accepted suggestions and authority
        // rollovers. Let that single fenced queue choose the current head;
        // a UI-side cached CAS becomes stale immediately after either path.
        await runtime.commit({
          path,
          body: new TextEncoder().encode(text),
        });
      },
      getOwnerState: () => runtime.getState(),
      subscribeOwner: (listener) => runtime.subscribe(listener),
      getController: () => runtime.controller,
      getCollabSeed: (path) => runtime.getCollabSeed(path),
      acceptSuggestion: (input) => runtime.accept(input),
      applySuggestion: (input) => runtime.applySuggestion(input),
      rejectSuggestion: (input) => runtime.reject(input),
      replyToComment: (anchor, body, threadId) => runtime.replyToComment(anchor, body, threadId),
      resolveComment: (threadId) => runtime.resolveComment(threadId),
      retryReviewOutbox: () => runtime.retryOutbox(),
      async release(): Promise<void> {},
    };
  }

  async createMarkdownEntry(workspaceId: string, path: string): Promise<void> {
    await this.service.createMarkdown(workspaceId, path, '');
  }

  async addAssetFiles(workspaceId: string, files: ImportFileInput[]): Promise<void> {
    for (const file of files) {
      if (file.kind === 'markdown') {
        await this.service.createMarkdown(workspaceId, file.path, new TextDecoder().decode(file.bytes));
      } else {
        await this.service.addAsset(workspaceId, file.path, file.bytes, file.mediaType);
      }
    }
  }

  async renameEntry(workspaceId: string, fromPath: string, toPath: string): Promise<void> {
    await this.service.renameEntry(workspaceId, fromPath, toPath);
  }

  async deleteEntry(workspaceId: string, path: string): Promise<void> {
    await this.service.deleteEntry(workspaceId, path);
  }

  async readEntryBytes(
    workspaceId: string,
    path: string,
  ): Promise<{ bytes: Uint8Array; mediaType?: string } | null> {
    const loaded = await this.service.loadWorkspace(workspaceId);
    const entry = loaded?.entries.find((candidate) => candidate.path === path);
    if (!entry) return null;
    const bytes = await this.service.readHeadBytes(workspaceId, path);
    return { bytes, ...(entry.mediaType === undefined ? {} : { mediaType: entry.mediaType }) };
  }

  async exportWorkspace(workspaceId: string): Promise<ImportFileInput[]> {
    return this.service.exportWorkspace(workspaceId);
  }

  async markBackedUp(workspaceId: string): Promise<void> {
    await this.service.markBackedUp(workspaceId);
  }

  async requestPersistence(): Promise<boolean | null> {
    return this.service.requestPersistence();
  }

  async listRememberedRooms(): Promise<string[]> {
    return this.service.listRememberedRooms();
  }

  async forgetRoom(roomId: string): Promise<void> {
    await this.service.forgetRoom(roomId);
  }

  async clearAllWorkspaces(): Promise<number> {
    return this.service.clearAllWorkspaces();
  }

  shareScopeFor(workspace: WorkspaceDetail): ShareScope {
    const entryCount = workspace.entries.length;
    return {
      kind: 'workspace',
      markdownCount: workspace.markdownCount,
      assetCount: workspace.assetCount,
      label: `Share the whole workspace · ${entryCount} ${entryCount === 1 ? 'entry' : 'entries'}`,
    };
  }
}

function toViewEntry(entry: WorkspaceEntryRecord): WorkspaceEntry {
  return {
    path: entry.path,
    presentation:
      entry.kind === 'markdown'
        ? 'editable'
        : entry.mediaType !== undefined && INLINE_SAFE_MEDIA.test(entry.mediaType)
          ? 'preview'
          : 'download-only',
    sizeLabel: sizeLabel(entry.sizeBytes),
  };
}
