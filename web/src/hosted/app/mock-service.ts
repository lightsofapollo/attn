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

import type {
  EditingSession,
  ImportFileInput,
  ShareScope,
  StorageHealth,
  WorkspaceAppService,
  WorkspaceDetail,
  WorkspaceShareView,
  WorkspaceSummary,
} from './types';
import type { BrowserOwnerWorkspaceRuntimeState } from '../../lib/review/browser-owner-workspace-runtime';

const MOCK_INVITE = {
  view: {
    tier: 'view',
    browserUrl: 'https://attn.sh/s/yPJpJifC1HUQgHsJ_7speQ#key=BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc',
    nativeUrl: 'attn://share/yPJpJifC1HUQgHsJ_7speQ#key=BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc',
    cliCommand: "npx attnmd review join 'attn://share/yPJpJifC1HUQgHsJ_7speQ#key=BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc'",
  },
  comment: {
    tier: 'comment',
    browserUrl: 'https://attn.sh/s/yPJpJifC1HUQgHsJ_7speQ#key=CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg',
    nativeUrl: 'attn://share/yPJpJifC1HUQgHsJ_7speQ#key=CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg',
    cliCommand: "npx attnmd review join 'attn://share/yPJpJifC1HUQgHsJ_7speQ#key=CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg'",
  },
  suggest: {
    tier: 'suggest',
    browserUrl: 'https://attn.sh/s/yPJpJifC1HUQgHsJ_7speQ#key=CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk',
    nativeUrl: 'attn://share/yPJpJifC1HUQgHsJ_7speQ#key=CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk',
    cliCommand: "npx attnmd review join 'attn://share/yPJpJifC1HUQgHsJ_7speQ#key=CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk'",
  },
} as const;

/** 'real' (no ?shell= param) boots the storage-backed service; every other
 * scenario runs this mock so degraded states stay directly reachable. */
export type ShellScenario = 'real' | 'demo' | 'private' | 'best-effort' | 'blocked' | 'quota' | 'empty';

export function shellScenarioFromSearch(search: string): ShellScenario {
  const value = new URLSearchParams(search).get('shell');
  if (value === null) return 'real';
  return value === 'private' || value === 'best-effort' || value === 'blocked' || value === 'quota' || value === 'empty'
    ? value
    : 'demo';
}

const PRODUCT_DIRECTION: WorkspaceDetail = {
  id: 'ws-product',
  name: 'Product direction',
  openPath: 'direction.md',
  markdownCount: 3,
  assetCount: 2,
  lastEditedLabel: 'Edited 8 min ago',
  sharing: 'shared',
  sizeLabel: '2.4 MB',
  backupLabel: 'Backed up today',
  saveState: 'Saved on this device',
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
  assetCount: 0,
  lastEditedLabel: 'Yesterday',
  sharing: 'local-only',
  sizeLabel: '48 KB',
  backupLabel: 'Never backed up',
  saveState: 'Saved on this device',
  entries: [{ path: 'launch-notes.md', kind: 'markdown', presentation: 'editable', sizeBytes: 49_152, sizeLabel: '48 KB' }],
  reviewCards: [],
};

const RESEARCH_FOLIO: WorkspaceDetail = {
  id: 'ws-research',
  name: 'Research folio',
  openPath: 'index.md',
  markdownCount: 9,
  assetCount: 3,
  lastEditedLabel: 'Jun 28',
  sharing: 'backed-up',
  sizeLabel: '14.2 MB',
  backupLabel: 'Backed up Jun 28',
  saveState: 'Saved on this device',
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
    if (!entry || entry.presentation !== 'editable') return null;
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
    const detail: WorkspaceDetail = {
      id: `ws-import-${this.workspaces.length}`,
      name,
      openPath: markdown[0]?.path ?? files[0]?.path ?? 'untitled.md',
      markdownCount: markdown.length,
      assetCount: files.length - markdown.length,
      lastEditedLabel: 'Just now',
      sharing: 'local-only',
      sizeLabel: '—',
      backupLabel: 'Never backed up',
      saveState: 'Saved on this device',
      entries: files.map((file) => ({
        path: file.path,
        kind: file.kind,
        presentation: file.kind === 'markdown' ? 'editable' : 'preview',
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
        presentation: file.kind === 'markdown' ? 'editable' : 'preview',
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

  async beginEditing(workspaceId: string): Promise<EditingSession | null> {
    const ownerState: BrowserOwnerWorkspaceRuntimeState = {
      status: 'active',
      leaseRole: 'owner',
      writable: true,
      liveEditingAvailable: false,
      reason: null,
      workspaceId,
      roomId: null,
      capId: null,
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
      replyToComment: async () => { throw new Error('Mock review authoring is unavailable.'); },
      resolveComment: async () => { throw new Error('Mock review authoring is unavailable.'); },
      retryReviewOutbox: async () => undefined,
      inspectShare: async () => this.mockShare ? structuredClone(this.mockShare) : null,
      ensureShare: async (input) => {
        const invite = MOCK_INVITE;
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
    const saveState = this.scenario === 'quota' ? 'Storage needs attention' : 'Saved on this device';
    return {
      id: 'ws-untitled',
      name: 'Untitled',
      openPath: 'untitled.md',
      markdownCount: 1,
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
      assetCount: workspace.assetCount,
      label: `Share the whole workspace · ${entryCount} ${entryCount === 1 ? 'entry' : 'entries'}`,
    };
  }
}
