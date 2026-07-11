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
  ShareScope,
  StorageHealth,
  WorkspaceDetail,
  WorkspaceService,
  WorkspaceSummary,
} from './types';

export type ShellScenario = 'default' | 'private' | 'blocked' | 'quota' | 'empty';

export function shellScenarioFromSearch(search: string): ShellScenario {
  const value = new URLSearchParams(search).get('shell');
  return value === 'private' || value === 'blocked' || value === 'quota' || value === 'empty'
    ? value
    : 'default';
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

export class MockWorkspaceService implements WorkspaceService {
  private readonly scenario: ShellScenario;
  private readonly workspaces: WorkspaceDetail[];

  constructor(scenario: ShellScenario) {
    this.scenario = scenario;
    this.workspaces =
      scenario === 'empty' || scenario === 'blocked'
        ? []
        : [PRODUCT_DIRECTION, LAUNCH_NOTES, RESEARCH_FOLIO];
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
      case 'default':
        return { mode: 'persistent', usedLabel: '18.7 MB', quotaLabel: '104 MB', usedFraction: 0.18 };
    }
  }

  listWorkspaces(): WorkspaceSummary[] {
    return this.workspaces;
  }

  getWorkspace(workspaceId: string): WorkspaceDetail | undefined {
    return this.workspaces.find((workspace) => workspace.id === workspaceId);
  }

  newWorkspaceDraft(): WorkspaceDetail {
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
