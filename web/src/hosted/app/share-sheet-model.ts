import type {
  PersistenceMode,
  WorkspaceEntry,
  WorkspaceShareMode,
  WorkspaceShareRequest,
  WorkspaceShareSelection,
  WorkspaceShareTtlMs,
} from './types';

export const SHARE_TTL_ONE_HOUR: WorkspaceShareTtlMs = 3_600_000;
export const SHARE_TTL_ONE_DAY: WorkspaceShareTtlMs = 86_400_000;
export const SHARE_TTL_SEVEN_DAYS: WorkspaceShareTtlMs = 604_800_000;

export type ShareScopeChoice = 'file' | 'entries' | 'workspace';

export interface ShareManifestSummary {
  entryCount: number;
  markdownCount: number;
  htmlCount: number;
  previewableAssetCount: number;
  downloadOnlyAssetCount: number;
  totalBytes: number;
}

export interface ShareDurabilityState {
  allowed: boolean;
  hardBlocked: boolean;
}

export const SHARE_TTL_OPTIONS: ReadonlyArray<{
  value: WorkspaceShareTtlMs;
  label: string;
}> = [
  { value: SHARE_TTL_ONE_HOUR, label: '1 hour' },
  { value: SHARE_TTL_ONE_DAY, label: '24 hours' },
  { value: SHARE_TTL_SEVEN_DAYS, label: '7 days' },
];

export const SHARE_MODE_OPTIONS: ReadonlyArray<{
  value: WorkspaceShareMode;
  label: string;
  /** One line inside Advanced, where the label has room to be explained. */
  detail: string;
  /**
   * What the COLLAPSED summary says. "Hybrid" is our word for a transport
   * choice, and the collapsed row is the one place it appeared with nothing
   * around it to explain it — "Hybrid delivery" told the reader nothing they
   * could act on (attn-08fa.8). The label stays inside Advanced, next to its
   * detail line, which is where a configuration word belongs.
   */
  summary: string;
}> = [
  {
    value: 'hybrid',
    label: 'Hybrid',
    detail: 'Connect directly when possible, with the encrypted relay as a fallback.',
    summary: 'Live + resumable',
  },
  {
    value: 'async',
    label: 'Async',
    detail: 'Keep review available through the encrypted relay while the owner is offline.',
    summary: 'Resumable',
  },
  {
    value: 'live',
    label: 'Live',
    detail: 'Use a direct live session; review availability depends on the owner connection.',
    summary: 'Live only',
  },
];

export function durabilityState(mode: PersistenceMode): ShareDurabilityState {
  if (mode === 'quota-pressure' || mode === 'unavailable') {
    return {
      allowed: false,
      hardBlocked: true,
    };
  }
  return {
    allowed: true,
    hardBlocked: false,
  };
}

export function entriesForScope(
  entries: readonly WorkspaceEntry[],
  scope: ShareScopeChoice,
  activePath: string | undefined,
  selectedPaths: readonly string[],
): WorkspaceEntry[] {
  if (scope === 'workspace') return [...entries];
  if (scope === 'file') {
    return activePath ? entries.filter((entry) => entry.path === activePath) : [];
  }
  const selected = new Set(selectedPaths);
  return entries.filter((entry) => selected.has(entry.path));
}

export function summarizeEntries(entries: readonly WorkspaceEntry[]): ShareManifestSummary {
  const summary: ShareManifestSummary = {
    entryCount: entries.length,
    markdownCount: 0,
    htmlCount: 0,
    previewableAssetCount: 0,
    downloadOnlyAssetCount: 0,
    totalBytes: 0,
  };
  for (const entry of entries) {
    summary.totalBytes += entry.sizeBytes;
    if (entry.kind === 'markdown') summary.markdownCount += 1;
    else if (entry.kind === 'html') summary.htmlCount += 1;
    else if (entry.presentation === 'preview') summary.previewableAssetCount += 1;
    else summary.downloadOnlyAssetCount += 1;
  }
  return summary;
}

export function selectionForScope(
  scope: ShareScopeChoice,
  activePath: string | undefined,
  selectedPaths: readonly string[],
): WorkspaceShareSelection | null {
  if (scope === 'workspace') return { kind: 'workspace' };
  if (scope === 'file') return activePath ? { kind: 'file', path: activePath } : null;
  return selectedPaths.length > 0 ? { kind: 'entries', paths: [...selectedPaths] } : null;
}

export function createShareRequest(input: {
  scope: ShareScopeChoice;
  activePath?: string;
  selectedPaths: readonly string[];
  mode: WorkspaceShareMode;
  ttlMs: WorkspaceShareTtlMs;
}): WorkspaceShareRequest | null {
  const selection = selectionForScope(input.scope, input.activePath, input.selectedPaths);
  if (!selection) return null;
  return {
    selection,
    mode: input.mode,
    ttlMs: input.ttlMs,
  };
}

export function formatByteCount(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** unitIndex;
  const digits = unitIndex === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

export function maskInviteUrl(url: string): string {
  const fragmentStart = url.indexOf('#');
  if (fragmentStart < 0) return url;
  const prefix = url.slice(0, fragmentStart);
  const fragment = url.slice(fragmentStart + 1);
  const equals = fragment.indexOf('=');
  const keyName = equals < 0 ? 'key' : fragment.slice(0, equals);
  return `${prefix}#${keyName}=••••••••••••••••`;
}

export function remainingTimeLabel(expiresAt: number, now = Date.now()): string {
  const remaining = expiresAt - now;
  if (remaining <= 0) return 'Expired';
  const minutes = Math.ceil(remaining / 60_000);
  if (minutes < 60) return `${minutes} min remaining`;
  const hours = Math.ceil(remaining / 3_600_000);
  if (hours <= 48) return `${hours} hr remaining`;
  return `${Math.ceil(hours / 24)} days remaining`;
}
