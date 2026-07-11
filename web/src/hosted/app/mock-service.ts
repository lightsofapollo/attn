// Mock workspace service (attn-7xl.1.3): fixture data matching the approved
// prototype (planning/web-authoring/prototype.html) so shell iteration stays
// independent of storage work. The `?shell=` query parameter selects a
// degraded scenario so every designed failure state is directly reachable:
//
//   /app?shell=private   Safari Private Browsing (session-only storage)
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
  WorkspaceSummary,
} from './types';

/** 'real' (no ?shell= param) boots the storage-backed service; every other
 * scenario runs this mock so degraded states stay directly reachable. */
export type ShellScenario = 'real' | 'demo' | 'private' | 'blocked' | 'quota' | 'empty';

export function shellScenarioFromSearch(search: string): ShellScenario {
  const value = new URLSearchParams(search).get('shell');
  if (value === null) return 'real';
  return value === 'private' || value === 'blocked' || value === 'quota' || value === 'empty'
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
    { path: 'direction.md', presentation: 'editable', sizeLabel: '18 KB' },
    { path: 'principles.md', presentation: 'editable', sizeLabel: '11 KB' },
    { path: 'open-questions.md', presentation: 'editable', sizeLabel: '6 KB' },
    { path: 'images/desk.png', presentation: 'preview', sizeLabel: '1.9 MB' },
    { path: 'data/notes.json', presentation: 'download-only', sizeLabel: '4 KB' },
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
  entries: [{ path: 'launch-notes.md', presentation: 'editable', sizeLabel: '48 KB' }],
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
    { path: 'index.md', presentation: 'editable', sizeLabel: '9 KB' },
    { path: 'interviews/mara.md', presentation: 'editable', sizeLabel: '22 KB' },
    { path: 'figures/latency.png', presentation: 'preview', sizeLabel: '2.2 MB' },
  ],
  reviewCards: [],
};

export class MockWorkspaceService implements WorkspaceAppService {
  private readonly scenario: ShellScenario;
  private readonly workspaces: WorkspaceDetail[];

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
        presentation: file.kind === 'markdown' ? 'editable' : 'preview',
        sizeLabel: `${file.bytes.length} B`,
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

  async beginEditing(): Promise<EditingSession | null> {
    return {
      commitText: async () => undefined,
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
      entries: [{ path: 'untitled.md', presentation: 'editable', sizeLabel: '0 B' }],
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
