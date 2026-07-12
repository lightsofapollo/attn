// Storage-backed WorkspaceAppService adapter (attn-7xl.3.2).
//
// Maps BrowserWorkspaceService (attn-7xl.3.1) onto the view contract the
// shells render. This module pulls the crypto/storage graph, so the app
// entry loads it via dynamic import only — the route bundle gate forbids it
// from the static graph.

import { publishDeskCount, readDeskCount } from '../desk-count';
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
import { validateBrowserRelayUrl } from '../../lib/review/browser-relay-url';
import type { WorkspaceEntryRecord } from '../../lib/review/browser-workspace-schema';

/** Safe raster types that may render inline (epic scope note 2026-07-10). */
const INLINE_SAFE_MEDIA = /^image\/(?:png|jpeg|gif|webp|avif)$/iu;

const TAB_HOLDER_STORAGE_KEY = 'attn:browser-tab-holder:v1';
const TAB_IDENTITY_CHANNEL = 'attn:browser-tab-identity:v1';
const TAB_IDENTITY_PROBE_MS = 75;

type TabIdentityMessage =
  | { type: 'probe'; holderId: string; probeId: string }
  | { type: 'present'; holderId: string; probeId: string };

let tabHolderPromise: Promise<string> | null = null;
let tabHolderId: string | null = null;
let tabIdentityChannel: BroadcastChannel | null = null;

function randomHolderId(): string {
  const holder = new Uint8Array(9);
  crypto.getRandomValues(holder);
  return `tab-${Array.from(holder, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Keep the writer identity stable across a reload in one browsing context.
 *
 * `sessionStorage` has exactly the lifetime we need, but browsers copy it
 * when a tab is duplicated or opened by another same-origin tab. The small
 * BroadcastChannel probe detects that live copy and rotates the new tab's
 * identity before either page asks IndexedDB for the fenced writer lease.
 */
async function browserTabHolderId(): Promise<string> {
  if (tabHolderId) return tabHolderId;
  if (tabHolderPromise) return tabHolderPromise;

  tabHolderPromise = (async () => {
    let candidate = randomHolderId();
    try {
      candidate = sessionStorage.getItem(TAB_HOLDER_STORAGE_KEY) ?? candidate;
    } catch {
      // IndexedDB may still be available when sessionStorage is restricted.
    }

    if (typeof BroadcastChannel !== 'undefined') {
      try {
        const channel = new BroadcastChannel(TAB_IDENTITY_CHANNEL);
        tabIdentityChannel = channel;
        const probeId = crypto.randomUUID();
        let copiedFromLiveTab = false;

        channel.addEventListener('message', (event: MessageEvent<TabIdentityMessage>) => {
          const message = event.data;
          if (!message || message.holderId !== tabHolderId) return;
          if (message.type === 'probe') {
            channel.postMessage({
              type: 'present',
              holderId: tabHolderId,
              probeId: message.probeId,
            } satisfies TabIdentityMessage);
          }
        });
        const detectCopy = (event: MessageEvent<TabIdentityMessage>): void => {
          const message = event.data;
          if (
            message?.type === 'present'
            && message.holderId === candidate
            && message.probeId === probeId
          ) copiedFromLiveTab = true;
        };
        channel.addEventListener('message', detectCopy);
        channel.postMessage({ type: 'probe', holderId: candidate, probeId } satisfies TabIdentityMessage);
        await new Promise((resolve) => window.setTimeout(resolve, TAB_IDENTITY_PROBE_MS));
        channel.removeEventListener('message', detectCopy);
        if (copiedFromLiveTab) candidate = randomHolderId();

        window.addEventListener('pagehide', () => {
          channel.close();
          if (tabIdentityChannel === channel) tabIdentityChannel = null;
        }, { once: true });
      } catch {
        // BroadcastChannel can be policy-disabled even when the constructor
        // exists. Fencing remains safe; only duplicate-tab detection degrades.
        tabIdentityChannel?.close();
        tabIdentityChannel = null;
      }
    }

    try {
      sessionStorage.setItem(TAB_HOLDER_STORAGE_KEY, candidate);
    } catch {
      // Best-effort stability; the fenced lease remains safe without it.
    }
    tabHolderId = candidate;
    return candidate;
  })();

  return tabHolderPromise;
}

export class RealWorkspaceAppService implements WorkspaceAppService {
  private readonly service: BrowserWorkspaceService;

  private constructor(service: BrowserWorkspaceService) {
    this.service = service;
  }

  static async open(options: BrowserWorkspaceServiceOptions = {}): Promise<RealWorkspaceAppService> {
    // Establish the browsing-context identity while the shell opens, not only
    // on the first edit. That lets an idle desk tab answer a later duplicate's
    // collision probe before either one attempts to become the writer.
    const [service] = await Promise.all([
      BrowserWorkspaceService.open(options),
      browserTabHolderId(),
    ]);
    return new RealWorkspaceAppService(service);
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
    const summaries = await this.service.listWorkspaces();
    publishDeskCount(summaries.length);
    return summaries;
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
    publishDeskCount(readDeskCount() + 1);
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
    publishDeskCount(Math.max(0, readDeskCount() - 1));
    await this.service.deleteWorkspace(workspaceId);
  }

  async beginEditing(workspaceId: string): Promise<EditingSession | null> {
    const holderId = await browserTabHolderId();
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
      inspectShare: () => runtime.inspectShare(browserReviewBase()),
      ensureShare: async (input) => {
        const mode = this.storageHealth().mode;
        if (mode === 'unavailable' || mode === 'quota-pressure') {
          throw new Error('Local storage must be writable before creating a review room.');
        }
        if (mode !== 'persistent' && !input.riskAcknowledged) {
          throw new Error('Acknowledge the local recovery risk before sharing.');
        }
        const selection = input.selection;
        return runtime.ensureShare({
          relayUrl: validateBrowserRelayUrl(import.meta.env.VITE_ATTN_RELAY_URL),
          browserReviewBase: browserReviewBase(),
          scopeKind: selection.kind,
          paths: selection.kind === 'workspace'
            ? []
            : selection.kind === 'file'
              ? [selection.path]
              : selection.paths,
          mode: input.mode,
          ttlMs: input.ttlMs,
        });
      },
      stopShare: () => runtime.stopShare(),
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
    kind: entry.kind,
    presentation:
      entry.kind === 'markdown'
        ? 'editable'
        : entry.mediaType !== undefined && INLINE_SAFE_MEDIA.test(entry.mediaType)
          ? 'preview'
          : 'download-only',
    sizeBytes: entry.sizeBytes,
    sizeLabel: sizeLabel(entry.sizeBytes),
    ...(entry.mediaType === undefined ? {} : { mediaType: entry.mediaType }),
  };
}

function browserReviewBase(): string {
  if (typeof window === 'undefined') return 'https://attn.sh/review';
  return `${window.location.origin}/review`;
}
