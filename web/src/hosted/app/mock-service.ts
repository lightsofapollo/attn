// Mock workspace service (attn-7xl.1.3): fixture data matching the approved
// prototype (planning/web-authoring/prototype.html) so shell iteration stays
// independent of storage work. The `?shell=` query parameter selects a
// degraded scenario so every designed failure state is directly reachable:
//
//   /app?shell=private   Safari Private Browsing (session-only storage)
//   /app?shell=best-effort persistent storage request is denied
//   /app?shell=blocked   Lockdown/capability failure (no local storage)
//   /app?shell=quota     quota pressure (writes blocked, head preserved)
//   /app?shell=empty     first visit, no workspaces yet
//   /app?shell=review-paused  live review paused mid-publish (transient trouble)
//   /app?shell=review-failed  share resume failed with no room (hard trouble)

import type {
  EditingSession,
  ImportFileInput,
  ReviewProjectionHandle,
  ShareScope,
  StorageHealth,
  WorkspaceAppService,
  WorkspaceDetail,
  WorkspaceShareView,
  WorkspaceSummary,
} from './types';
import type { BrowserOwnerWorkspaceRuntimeState } from '../../lib/review/browser-owner-workspace-runtime';
import { resolveBrowserReviewBase } from './share-environment';
import { SAVE_STATE_AUTOSAVED, SAVE_STATE_STORAGE_ATTENTION } from '../../lib/save-state-copy';

const MOCK_SHARE_ID = 'yPJpJifC1HUQgHsJ_7speQ';

function mockInvite() {
  const browserOrigin = new URL(resolveBrowserReviewBase(
    import.meta.env.VITE_ATTN_SHARE_ORIGIN,
    import.meta.env.VITE_ATTN_RELAY_URL,
    typeof window === 'undefined' ? undefined : window.location.origin,
  )).origin;
  const invite = (tier: 'view' | 'comment' | 'suggest', key: string) => ({
    tier,
    browserUrl: `${browserOrigin}/s/${MOCK_SHARE_ID}#key=${key}`,
    nativeUrl: `attn://share/${MOCK_SHARE_ID}#key=${key}`,
    cliCommand: `npx attnmd review join 'attn://share/${MOCK_SHARE_ID}#key=${key}'`,
  });
  return {
    view: invite('view', 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc'),
    comment: invite('comment', 'CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg'),
    suggest: invite('suggest', 'CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk'),
  } as const;
}

/** 'real' (no ?shell= param) boots the storage-backed service; every other
 * scenario runs this mock so degraded states stay directly reachable. */
export type ShellScenario = 'real' | 'demo' | 'private' | 'best-effort' | 'blocked' | 'quota' | 'empty'
  | 'review-paused' | 'review-failed';

export function shellScenarioFromSearch(search: string): ShellScenario {
  const value = new URLSearchParams(search).get('shell');
  if (value === null) return 'real';
  return value === 'private' || value === 'best-effort' || value === 'blocked' || value === 'quota'
    || value === 'empty' || value === 'review-paused' || value === 'review-failed'
    ? value
    : 'demo';
}

const PRODUCT_DIRECTION: WorkspaceDetail = {
  id: 'ws-product',
  name: 'Product direction',
  openPath: 'direction.md',
  markdownCount: 3,
  htmlCount: 0,
  assetCount: 2,
  lastEditedLabel: 'Edited 8 min ago',
  sharing: 'shared',
  // Only the shared fixture carries review state: a local-only workspace has no
  // review log at all, which is why the row shows nothing rather than a zero
  // (attn-n01r.34).
  review: {
    openComments: 2,
    pendingSuggestions: 3,
    lastAuthorId: 'agent-7',
    lastActivityAt: Date.now() - 4 * 60_000,
  },
  sizeLabel: '2.4 MB',
  backupLabel: 'Backed up today',
  saveState: SAVE_STATE_AUTOSAVED,
  entries: [
    { path: 'direction.md', kind: 'markdown', presentation: 'editable', sizeBytes: 18_432, sizeLabel: '18 KB' },
    { path: 'principles.md', kind: 'markdown', presentation: 'editable', sizeBytes: 11_264, sizeLabel: '11 KB' },
    { path: 'open-questions.md', kind: 'markdown', presentation: 'editable', sizeBytes: 6_144, sizeLabel: '6 KB' },
    { path: 'images/desk.png', kind: 'asset', presentation: 'preview', sizeBytes: 1_992_294, sizeLabel: '1.9 MB', mediaType: 'image/png' },
    { path: 'data/notes.json', kind: 'asset', presentation: 'download-only', sizeBytes: 4_096, sizeLabel: '4 KB', mediaType: 'application/json' },
  ],
  reviewCards: [
    {
      author: 'JULES',
      ageLabel: '2 MIN',
      body: '“Around a revision” is important. Can we show that directly in the Share copy?',
    },
  ],
};

const LAUNCH_NOTES: WorkspaceDetail = {
  id: 'ws-launch',
  name: 'Launch notes',
  openPath: 'launch-notes.md',
  markdownCount: 1,
  htmlCount: 0,
  assetCount: 0,
  lastEditedLabel: 'Yesterday',
  sharing: 'local-only',
  sizeLabel: '48 KB',
  backupLabel: 'Never backed up',
  saveState: SAVE_STATE_AUTOSAVED,
  entries: [{ path: 'launch-notes.md', kind: 'markdown', presentation: 'editable', sizeBytes: 49_152, sizeLabel: '48 KB' }],
  reviewCards: [],
};

const RESEARCH_FOLIO: WorkspaceDetail = {
  id: 'ws-research',
  name: 'Research folio',
  openPath: 'index.md',
  markdownCount: 9,
  htmlCount: 0,
  assetCount: 3,
  lastEditedLabel: 'Jun 28',
  sharing: 'backed-up',
  sizeLabel: '14.2 MB',
  backupLabel: 'Backed up Jun 28',
  saveState: SAVE_STATE_AUTOSAVED,
  entries: [
    { path: 'index.md', kind: 'markdown', presentation: 'editable', sizeBytes: 9_216, sizeLabel: '9 KB' },
    { path: 'interviews/mara.md', kind: 'markdown', presentation: 'editable', sizeBytes: 22_528, sizeLabel: '22 KB' },
    { path: 'figures/latency.png', kind: 'asset', presentation: 'preview', sizeBytes: 2_306_867, sizeLabel: '2.2 MB', mediaType: 'image/png' },
  ],
  reviewCards: [],
};

export class MockWorkspaceService implements WorkspaceAppService {
  private readonly scenario: ShellScenario;
  private readonly workspaces: WorkspaceDetail[];
  private mockShare: WorkspaceShareView | null = null;

  constructor(scenario: ShellScenario) {
    this.scenario = scenario;
    // Clone the fixtures so per-instance mutation (rename/delete) can never
    // leak into other instances through the module constants.
    this.workspaces =
      scenario === 'empty' || scenario === 'blocked'
        ? []
        : structuredClone([PRODUCT_DIRECTION, LAUNCH_NOTES, RESEARCH_FOLIO]);
  }

  storageHealth(): StorageHealth {
    switch (this.scenario) {
      case 'private':
        return { mode: 'session-only', usedLabel: '2.1 MB', quotaLabel: 'this session', usedFraction: 0.02 };
      case 'best-effort':
        return { mode: 'best-effort', usedLabel: '18.7 MB', quotaLabel: '104 MB', usedFraction: 0.18 };
      case 'blocked':
        return { mode: 'unavailable', usedLabel: '0 B', quotaLabel: 'unavailable', usedFraction: 0 };
      case 'quota':
        return { mode: 'quota-pressure', usedLabel: '101 MB', quotaLabel: '104 MB', usedFraction: 0.97 };
      case 'empty':
        return { mode: 'best-effort', usedLabel: '0 B', quotaLabel: '104 MB', usedFraction: 0 };
      // These degrade the REVIEW, not storage: the whole point of them is a
      // healthy local desk with a broken relay connection.
      case 'review-paused':
      case 'review-failed':
      case 'demo':
      case 'real':
        return { mode: 'persistent', usedLabel: '18.7 MB', quotaLabel: '104 MB', usedFraction: 0.18 };
    }
  }

  async listWorkspaces(): Promise<WorkspaceSummary[]> {
    return this.workspaces;
  }

  async getWorkspace(workspaceId: string): Promise<WorkspaceDetail | undefined> {
    return this.workspaces.find((workspace) => workspace.id === workspaceId);
  }

  async readBodyText(workspaceId: string, path: string): Promise<string | null> {
    const workspace = this.workspaces.find((candidate) => candidate.id === workspaceId);
    const entry = workspace?.entries.find((candidate) => candidate.path === path);
    if (!entry || (entry.presentation !== 'editable' && entry.presentation !== 'html')) return null;
    if (entry.presentation === 'html') {
      return '<!doctype html><html><body><h1>Hosted HTML preview</h1><p>Review this document after sharing.</p></body></html>';
    }
    if (workspace?.id === 'ws-product' && path === 'direction.md') {
      return [
        '# Product direction',
        '',
        'Attn should feel like a private writing desk, not a cloud drive with the login form removed.',
        '',
        '## The source stays here',
        '',
        'A local workspace is the source of truth. Sharing creates a review room around a revision; it does not move ownership to the relay.',
        '',
        '- Create without a network request.',
        '- Autosave to the browser before showing “Saved.”',
        '- Export ordinary Markdown at any time.',
        '',
        ...Array.from({ length: 40 }, (_, index) =>
          `Paragraph ${index + 1}: the reader must stay legible on a phone, keep its measure, and never pan the page horizontally while long documents scroll.\n`,
        ),
      ].join('\n');
    }
    return `# ${workspace?.name ?? 'Untitled'}\n`;
  }

  async createWorkspace(): Promise<WorkspaceDetail> {
    const draft = this.newWorkspaceDraft();
    this.workspaces.unshift(draft);
    return draft;
  }

  async importFiles(name: string, files: ImportFileInput[]): Promise<WorkspaceDetail> {
    const markdown = files.filter((file) => file.kind === 'markdown');
    const html = files.filter((file) => file.kind === 'html');
    const detail: WorkspaceDetail = {
      id: `ws-import-${this.workspaces.length}`,
      name,
      openPath: markdown[0]?.path ?? html[0]?.path ?? files[0]?.path ?? 'untitled.md',
      markdownCount: markdown.length,
      htmlCount: html.length,
      assetCount: files.length - markdown.length - html.length,
      lastEditedLabel: 'Just now',
      sharing: 'local-only',
      sizeLabel: '—',
      backupLabel: 'Never backed up',
      saveState: SAVE_STATE_AUTOSAVED,
      entries: files.map((file) => ({
        path: file.path,
        kind: file.kind,
        presentation: file.kind === 'markdown' ? 'editable' : file.kind === 'html' ? 'html' : 'preview',
        sizeBytes: file.bytes.length,
        sizeLabel: `${file.bytes.length} B`,
        ...(file.mediaType === undefined ? {} : { mediaType: file.mediaType }),
      })),
      reviewCards: [],
    };
    this.workspaces.unshift(detail);
    return detail;
  }

  async renameWorkspace(workspaceId: string, name: string): Promise<void> {
    const workspace = this.workspaces.find((candidate) => candidate.id === workspaceId);
    if (workspace) workspace.name = name;
  }

  async deleteWorkspace(workspaceId: string): Promise<void> {
    const index = this.workspaces.findIndex((candidate) => candidate.id === workspaceId);
    if (index >= 0) this.workspaces.splice(index, 1);
  }

  async createMarkdownEntry(workspaceId: string, path: string): Promise<void> {
    const workspace = this.workspaces.find((candidate) => candidate.id === workspaceId);
    workspace?.entries.push({
      path,
      kind: 'markdown',
      presentation: 'editable',
      sizeBytes: 0,
      sizeLabel: '0 B',
    });
  }

  async addAssetFiles(workspaceId: string, files: ImportFileInput[]): Promise<void> {
    const workspace = this.workspaces.find((candidate) => candidate.id === workspaceId);
    for (const file of files) {
      workspace?.entries.push({
        path: file.path,
        kind: file.kind,
        presentation: file.kind === 'markdown' ? 'editable' : file.kind === 'html' ? 'html' : 'preview',
        sizeBytes: file.bytes.length,
        sizeLabel: `${file.bytes.length} B`,
        ...(file.mediaType === undefined ? {} : { mediaType: file.mediaType }),
      });
    }
  }

  async renameEntry(workspaceId: string, fromPath: string, toPath: string): Promise<void> {
    const workspace = this.workspaces.find((candidate) => candidate.id === workspaceId);
    const entry = workspace?.entries.find((candidate) => candidate.path === fromPath);
    if (entry) entry.path = toPath;
  }

  async deleteEntry(workspaceId: string, path: string): Promise<void> {
    const workspace = this.workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace) return;
    workspace.entries = workspace.entries.filter((candidate) => candidate.path !== path);
  }

  async readEntryBytes(
    _workspaceId: string,
    path: string,
  ): Promise<{ bytes: Uint8Array; mediaType?: string } | null> {
    // A 1x1 transparent PNG so demo previews render.
    const png = Uint8Array.from(
      atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='),
      (char) => char.charCodeAt(0),
    );
    return { bytes: png, mediaType: path.endsWith('.png') ? 'image/png' : 'application/octet-stream' };
  }

  async exportWorkspace(workspaceId: string): Promise<ImportFileInput[]> {
    const workspace = this.workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace) return [];
    const files: ImportFileInput[] = [];
    for (const entry of workspace.entries) {
      files.push({
        path: entry.path,
        bytes: new TextEncoder().encode(`demo: ${entry.path}`),
        kind: entry.presentation === 'editable' ? 'markdown' : 'asset',
      });
    }
    return files;
  }

  private rememberedRooms: string[] = ['7pmH1MwiTfQt9gecnT4HIA'];

  async markBackedUp(workspaceId: string): Promise<void> {
    const workspace = this.workspaces.find((candidate) => candidate.id === workspaceId);
    if (workspace) workspace.backupLabel = 'Backed up just now';
  }

  async requestPersistence(): Promise<boolean | null> {
    return this.scenario === 'private' || this.scenario === 'best-effort' || this.scenario === 'blocked'
      ? false
      : true;
  }

  async listRememberedRooms(): Promise<string[]> {
    return this.scenario === 'blocked' ? [] : [...this.rememberedRooms];
  }

  async forgetRoom(roomId: string): Promise<void> {
    this.rememberedRooms = this.rememberedRooms.filter((candidate) => candidate !== roomId);
  }

  async clearAllWorkspaces(): Promise<number> {
    const cleared = this.workspaces.length;
    this.workspaces.length = 0;
    return cleared;
  }

  async requestWriterHandoff(): Promise<void> {}

  async yieldEditing(): Promise<void> {}

  /** The mock holds no lease, heartbeat or transport to hand back. */
  async closeEditingRuntime(): Promise<void> {}

  async acknowledgeWriterHandoff(): Promise<void> {}

  async forceWriterLease(): Promise<void> {}

  async peekWriterLease(): Promise<number | null> {
    return null;
  }

  async joinLocalCollab(): Promise<null> {
    return null;
  }

  subscribeWorkspaceChanges(): () => void {
    return () => undefined;
  }

  announceReviewActivity(): void {}

  async openReviewProjection(): Promise<ReviewProjectionHandle> {
    // The mock never has a real share; an inert projection keeps EditorShell's
    // lifecycle host uniform (attn-whdh).
    return {
      getState: () => ({ roomId: null, bindings: [], replay: 'idle' as const }),
      subscribe: (subscriber) => {
        subscriber({ roomId: null, bindings: [], replay: 'idle' as const });
        return () => undefined;
      },
      refresh: async () => undefined,
      refreshShareRecord: async () => undefined,
      close: () => undefined,
    };
  }

  async beginEditing(workspaceId: string): Promise<EditingSession | null> {
    /* `review-paused` reaches the trouble chip and its dialog (attn-mkmz
       follow-up). This mock exists so every DESIGNED degraded state stays
       directly reachable for tests and screenshots, and the paused review had
       no scenario at all — which is part of why it shipped for months showing
       a raw engine string. The reason below is the literal one the owner
       reported seeing; review-trouble.ts classifies it as transient. */
    const paused = this.scenario === 'review-paused';
    const failed = this.scenario === 'review-failed';
    const ownerState: BrowserOwnerWorkspaceRuntimeState = {
      status: paused ? 'paused' : failed ? 'error' : 'active',
      leaseRole: 'owner',
      writable: true,
      liveEditingAvailable: false,
      localCollab: false,
      reason: paused || failed ? 'published source revision moved before promotion' : null,
      workspaceId,
      roomId: paused ? 'mock-room' : null,
      capId: paused ? 'mock-cap' : null,
      bindings: [],
      controllerGeneration: 0,
      authority: null,
    };
    return {
      commitText: async () => undefined,
      getOwnerState: () => structuredClone(ownerState),
      subscribeOwner: (listener) => {
        listener(structuredClone(ownerState));
        return () => undefined;
      },
      getController: () => null,
      getCollabSeed: async () => null,
      acceptSuggestion: async () => {
        throw new Error('Mock owner review actions are unavailable.');
      },
      applySuggestion: async () => {
        throw new Error('Mock owner reviewed actions are unavailable.');
      },
      rejectSuggestion: async () => {
        throw new Error('Mock owner review actions are unavailable.');
      },
      createComment: async () => { throw new Error('Mock review authoring is unavailable.'); },
      announceProfile: async () => {},
      replyToComment: async () => { throw new Error('Mock review authoring is unavailable.'); },
      resolveComment: async () => { throw new Error('Mock review authoring is unavailable.'); },
      reopenComment: async () => { throw new Error('Mock review authoring is unavailable.'); },
      retryReviewOutbox: async () => undefined,
      recoverReview: async () => undefined,
      inspectShare: async () => this.mockShare ? structuredClone(this.mockShare) : null,
      ensureShare: async (input) => {
        const invite = mockInvite();
        const workspace = this.workspaces.find((candidate) => candidate.id === workspaceId);
        const selection = input.selection;
        const paths = selection.kind === 'workspace'
          ? workspace?.entries.map((entry) => entry.path) ?? []
          : selection.kind === 'file'
            ? [selection.path]
            : selection.paths;
        this.mockShare = {
          workspaceId,
          capId: 'BwcHBwcHBwcHBwcHBwcHBw',
          shareId: 'yPJpJifC1HUQgHsJ_7speQ',
          roomId: 'nC6t29PRD0NcUGsRpkBpFg',
          scopeKind: selection.kind,
          paths,
          publication: 'published',
          mode: input.mode,
          expiresAt: Date.now() + input.ttlMs,
          expired: false,
          resumable: false,
          invite,
        };
        return structuredClone(this.mockShare!);
      },
      stopShare: async () => { this.mockShare = null; },
      release: async () => undefined,
    };
  }

  private newWorkspaceDraft(): WorkspaceDetail {
    const saveState = this.scenario === 'quota' ? SAVE_STATE_STORAGE_ATTENTION : SAVE_STATE_AUTOSAVED;
    return {
      id: 'ws-untitled',
      name: 'Untitled',
      openPath: 'untitled.md',
      markdownCount: 1,
      htmlCount: 0,
      assetCount: 0,
      lastEditedLabel: 'Just now',
      sharing: 'local-only',
      sizeLabel: '0 B',
      backupLabel: 'Never backed up',
      saveState,
      entries: [{ path: 'untitled.md', kind: 'markdown', presentation: 'editable', sizeBytes: 0, sizeLabel: '0 B' }],
      reviewCards: [],
    };
  }

  shareScopeFor(workspace: WorkspaceDetail): ShareScope {
    const entryCount = workspace.entries.length;
    return {
      kind: 'workspace',
      markdownCount: workspace.markdownCount,
      htmlCount: workspace.htmlCount,
      assetCount: workspace.assetCount,
      label: `Share the whole workspace · ${entryCount} ${entryCount === 1 ? 'entry' : 'entries'}`,
    };
  }
}
