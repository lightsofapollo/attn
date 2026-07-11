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
    let lease = await this.service.leases.acquire(workspaceId, holderId);
    if (!lease) return null;
    const heads = new Map<string, string>();
    // Heartbeat well inside the 15s lease so suspensions lose ownership fast
    // but active tabs never lapse.
    const heartbeat = setInterval(() => {
      void this.service.leases
        .heartbeat(lease!)
        .then((extended) => {
          lease = extended;
        })
        .catch(() => clearInterval(heartbeat));
    }, 5_000);
    const service = this.service;
    return {
      async commitText(path: string, text: string): Promise<void> {
        let expected = heads.get(path);
        if (expected === undefined) {
          const loaded = await service.loadWorkspace(workspaceId);
          expected = loaded?.entries.find((entry) => entry.path === path)?.headRevisionId;
        }
        const committed = await service.commitText(workspaceId, path, text, {
          fence: lease!,
          ...(expected === undefined ? {} : { expectedHeadRevisionId: expected }),
        });
        heads.set(path, committed.revision.revisionId);
      },
      async release(): Promise<void> {
        clearInterval(heartbeat);
        await service.leases.release(lease!).catch(() => undefined);
      },
    };
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
