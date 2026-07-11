import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import WebSocket from 'ws';

import { sha256 } from '@noble/hashes/sha2.js';
import { base64UrlEncode } from '../src/lib/review/browser-crypto';
import { parseShareInvite } from '../src/lib/review/browser-share';
import { createBrowserDurableShareResolver, createProductionDurableShareSession } from '../src/lib/review/browser-share-production';
import { base64UrlEncodePow, mineBrowserPow } from '../src/lib/review/browser-pow';
import type { BrowserShareSessionState, DurableShareOutboxTransition,
  PersistedShareOutboxEntry } from '../src/lib/review/browser-share-session';
import type { Anchor, ReviewEvent } from '../src/lib/types';

interface HarnessState {
  shareId: string;
  roomId: string;
  viewBrowser: string;
  commentBrowser: string;
  suggestBrowser: string;
  snapshotContent: string;
  importedCommentBodies: string[];
}

const statePath = required('ATTN_SHARE_E2E_STATE');
const relayUrl = required('ATTN_RELAY_URL');
const phase = required('ATTN_SHARE_BROWSER_PHASE');
const readyPath = process.env.ATTN_SHARE_E2E_BROWSER_READY;
const upgradedPath = process.env.ATTN_SHARE_E2E_BROWSER_UPGRADED;
const revokedPath = process.env.ATTN_SHARE_E2E_REVOKED;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for durable share E2E`);
  return value;
}

async function state(): Promise<HarnessState> {
  return JSON.parse(await readFile(statePath, 'utf8')) as HarnessState;
}

class MemoryPersistence {
  private floor = { epoch: -1, revision: -1, manifestDigest: '' };
  private readonly entries = new Map<string, PersistedShareOutboxEntry>();
  async atomicMax(input: { candidate: { epoch: number; revision: number; manifestDigest: string } }) {
    const candidate = input.candidate;
    if (candidate.epoch > this.floor.epoch || (candidate.epoch === this.floor.epoch && candidate.revision > this.floor.revision)) {
      this.floor = { ...candidate };
    }
    return { ...this.floor };
  }
  async hydrate(): Promise<PersistedShareOutboxEntry[]> { return [...this.entries.values()]; }
  async transition(_shareId: string, _bundleId: string, transition: DurableShareOutboxTransition): Promise<void> {
    if (transition.kind === 'enqueue' || transition.kind === 'retry_stale') this.entries.set(transition.record.envelopeId, transition.record);
    else if (transition.kind === 'ack') this.entries.delete(transition.envelopeId);
    else if (transition.kind === 'retryable') {
      const current = this.entries.get(transition.envelopeId);
      if (current && current.state !== 'stale') this.entries.set(transition.envelopeId, { ...current, state: 'retryable' });
    } else if (transition.kind === 'stale') {
      this.entries.delete(transition.envelopeId); this.entries.set(transition.record.draft.draftId, transition.record);
    } else this.entries.delete(transition.draftId);
  }
  dispose(): void { this.entries.clear(); }
}

async function waitFor(label: string, condition: () => boolean | Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function socketFactory(url: string, protocols: string[]): WebSocket {
  return new WebSocket(url, protocols, { origin: 'https://attn.sh' }) as WebSocket;
}

async function createSession(link: string, onOptimisticEvent?: (event: ReviewEvent) => void) {
  const invite = parseShareInvite(link);
  let latest: BrowserShareSessionState | undefined;
  const snapshots: Array<{ content: string; fileId: string; snapshotId: string; metadata?: unknown }> = [];
  const liveStore = { currentRoomId: null as string | null, applyEvent: (_event: ReviewEvent) => undefined,
    applySnapshot: () => undefined, setCurrentFile: () => undefined, setCurrentSnapshot: () => undefined };
  const session = await createProductionDurableShareSession({
    relayUrl,
    invite,
    tier: 'comment',
    persistence: new MemoryPersistence() as never,
    webSocketFactory: socketFactory as never,
    liveStore,
    disableWebRtc: true,
    mailboxMintPow: async ({ shareId, deviceId, path }) => mineBrowserPow({
      roomId: shareId, deviceId, method: 'POST', path, difficulty: 12,
      expiresAt: Date.now() + 300_000,
      rand: base64UrlEncodePow(crypto.getRandomValues(new Uint8Array(16))),
    }).token,
    onState: value => { latest = value; },
    onSnapshot: value => { snapshots.push(value); },
    onOptimisticEvent,
  });
  await session.start();
  await waitFor('browser durable resolution', () => {
    if (latest?.status === 'error') throw new Error(`browser durable resolution failed: ${latest.error ?? 'unknown error'}`);
    return latest?.status === 'ready';
  });
  return { session, latest: () => latest!, snapshots };
}

async function resolveRetainedSnapshot(link: string) {
  const persistence = new MemoryPersistence();
  const { resolver } = await createBrowserDurableShareResolver({
    relayUrl, invite: parseShareInvite(link), tier: 'comment', persistence: persistence as never,
  });
  const resolution = await resolver.resolve();
  persistence.dispose();
  return resolution.snapshots[0];
}

function anchorFor(snapshot: { fileId: string; snapshotId: string; content: string; metadata?: unknown }): Anchor {
  const metadata = snapshot.metadata as { baseHash?: unknown } | undefined;
  const baseHash = typeof metadata?.baseHash === 'string'
    ? metadata.baseHash
    : base64UrlEncode(sha256(new TextEncoder().encode(snapshot.content)));
  return {
    v: 2,
    fileId: snapshot.fileId,
    snapshotId: snapshot.snapshotId,
    baseHash,
    position: { byteRange: [0, 0], lineRange: [0, 0], pmRange: [0, 0] },
  };
}

if (phase === 'live') {
  const fixture = await state();
  const { session, latest } = await createSession(fixture.commentBrowser);
  await waitFor('initial live owner room', () => latest().ownerOnline === true);
  if (latest().roomId !== fixture.roomId) throw new Error('browser resolved a different room than the native owner');
  session.close();
  console.log('PASS production browser resolves native stable link and joins actual RoomDO live');
} else if (phase === 'offline_watch') {
  if (!readyPath || !upgradedPath || !revokedPath) throw new Error('offline watch sentinel paths are required');
  const fixture = await state();
  const retained = await resolveRetainedSnapshot(fixture.commentBrowser);
  if (retained?.content !== fixture.snapshotContent) throw new Error(`production resolver did not decrypt native XChaCha snapshot after room loss: expected ${JSON.stringify(fixture.snapshotContent)}, got ${JSON.stringify(retained?.content)}`);
  const optimistic: ReviewEvent[] = [];
  const { session, latest } = await createSession(fixture.commentBrowser, event => optimistic.push(event));
  if (latest().ownerOnline) throw new Error('destroyed RoomDO unexpectedly resolved live');
  const comment = await session.createComment(anchorFor(retained), 'offline across native restart');
  if (!comment || optimistic.length !== 1 || comment.body.type !== 'comment_created') {
    throw new Error('production browser did not author its signed offline CommentCreated event');
  }
  await waitFor('mailbox ACK', () => latest().pendingComments === 0);
  await writeFile(readyPath, 'mailbox accepted\n');

  await waitFor('native ReviewStore import', async () => (await state()).importedCommentBodies.includes('offline across native restart'));
  await waitFor('same-page live upgrade after owner restart', () => latest().ownerOnline === true);
  if (latest().roomId !== fixture.roomId) throw new Error('owner restart changed epoch room or stable link');
  await writeFile(upgradedPath, 'watch upgraded live\n');
  console.log('PASS offline production browser submission imports natively and existing watch upgrades live without reload');

  await waitFor('owner revoke phase', async () => {
    try { await readFile(revokedPath); return true; } catch { return false; }
  });
  await waitFor('terminal share watch close', () => latest().status === 'terminated');
  session.close();
  const response = await fetch(new URL(`/v3/shares/${fixture.shareId}`, relayUrl));
  if (response.status !== 404) throw new Error(`revoked stable link remained reachable (${response.status})`);
  console.log('PASS production revoke terminates existing browser and kills stable link immediately');
} else {
  throw new Error(`unknown ATTN_SHARE_BROWSER_PHASE ${phase}`);
}
