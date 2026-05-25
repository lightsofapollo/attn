// Lightweight "update available" check. On startup the app compares the running
// version against the latest published `attnmd` on npm and nudges the user with a
// toast if they're behind. Best-effort only: any network/parse failure is
// swallowed so it never disrupts startup, and there is NO auto-install.

const NPM_LATEST_URL = 'https://registry.npmjs.org/attnmd/latest';

/** True when `latest` is a strictly higher x.y.z version than `current`. */
export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string): number[] =>
    v
      .trim()
      .replace(/^v/, '')
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0);
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < 3; i++) {
    const da = a[i] ?? 0;
    const db = b[i] ?? 0;
    if (da !== db) return da > db;
  }
  return false;
}

export interface UpdateInfo {
  current: string;
  latest: string;
}

/**
 * Platform-appropriate upgrade instruction. Homebrew is macOS-only, so Linux
 * (and anything non-macOS) is pointed at npm only.
 */
export function upgradeHint(isMacOS: boolean): string {
  return isMacOS
    ? 'Update with `brew upgrade attn` or `npm i -g attnmd@latest`.'
    : 'Update with `npm i -g attnmd@latest`.';
}

/**
 * Check npm for a newer `attnmd` release. Resolves to the update info when one
 * is available, otherwise `null` (including on any network/parse error, so the
 * caller never has to guard). `fetchImpl` is injectable for tests.
 */
export async function checkForUpdate(
  current: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<UpdateInfo | null> {
  if (!current) return null;
  try {
    const res = await fetchImpl(NPM_LATEST_URL, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: unknown };
    const latest = typeof data.version === 'string' ? data.version : null;
    if (!latest || !isNewerVersion(latest, current)) return null;
    return { current, latest };
  } catch {
    return null;
  }
}
