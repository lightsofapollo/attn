// Browser-owner suggestion decisions (attn-7xl.4.4.3).
//
// The drift decision tree mirrors src/review/apply.rs. Persistence is kept
// behind one deliberately strong interface: implementations must commit the
// workspace revision/head, sealed action receipt, and exact sealed terminal
// event envelope in one fenced IndexedDB transaction. Splitting those writes
// would reintroduce the native write-before-event crash window.

import { sha256 } from '@noble/hashes/sha2.js';
import type {
  ApplyVerdict,
  EventId,
  ReviewEvent,
  RoomId,
  SuggestionAcceptedBody,
  SuggestionOperation,
  SuggestionRejectedBody,
  TextMatchKind,
} from '../types';
import {
  base64UrlEncode,
  deriveEventEnvelopeId,
  deriveEventId,
  toCanonicalBytes,
} from './browser-crypto';
import type { AssembledBrowserEvent } from './browser-envelope';
import type { MailboxEnvelope } from './browser-ws';
import { normalizeEntryPath } from './browser-workspace-schema';
import type { WorkspaceFence } from './browser-workspace-store';
import type { ResolvedAnchor } from '../types';

const APPLY_REVIEW_FLOOR = 0.7;
const ACTION_RECORD_VERSION = 1;

export type BrowserSuggestionTerminalBody = SuggestionAcceptedBody | SuggestionRejectedBody;

export interface ResolveBrowserSuggestionInput {
  roomId: RoomId;
  suggestionId: EventId;
  operation: SuggestionOperation;
  resolvedAnchor: ResolvedAnchor;
  currentMarkdownBytes: Uint8Array;
}

export interface BrowserReviewActionIdentity {
  workspaceId: string;
  roomId: RoomId;
  path: string;
  suggestionId: EventId;
}

export interface BrowserReviewActionReceipt extends BrowserReviewActionIdentity {
  v: 1;
  actionId: string;
  disposition: 'accepted' | 'rejected';
  terminalEvent: ReviewEvent;
  terminalEnvelope: MailboxEnvelope;
  terminalEnvelopeId: string;
  baseRevisionId?: string;
  baseBodyHash?: string;
  appliedRevisionId?: string;
  resultingHash?: string;
}

export type AtomicBrowserReviewActionCommit =
  | {
      disposition: 'accepted';
      identity: BrowserReviewActionIdentity;
      actionId: string;
      fence: WorkspaceFence;
      expectedHeadRevisionId: string;
      expectedBodyHash: string;
      revisionId: string;
      body: Uint8Array;
      bodyHash: string;
      terminal: AssembledBrowserEvent;
    }
  | {
      disposition: 'rejected';
      identity: BrowserReviewActionIdentity;
      actionId: string;
      fence: WorkspaceFence;
      expectedHeadRevisionId: string;
      terminal: AssembledBrowserEvent;
    };

/**
 * Required persistence boundary for crash-safe browser decisions.
 *
 * `commitReviewAction` MUST, in one readwrite transaction:
 * - re-check the active workspace lease and expected entry head;
 * - enforce one receipt per actionId (same receipt => replay, conflict otherwise);
 * - for acceptance, add the immutable revision and advance entry/workspace heads;
 * - add a workspace-key-sealed receipt; and
 * - add the exact supplied ciphertext envelope to the room outbox (or accept
 *   the identical row already in outbox/history).
 */
export interface AtomicBrowserReviewActionStore {
  getReviewActionReceipt(
    identity: BrowserReviewActionIdentity,
    actionId: string,
  ): Promise<BrowserReviewActionReceipt | null>;
  commitReviewAction(
    commit: AtomicBrowserReviewActionCommit,
  ): Promise<{ receipt: BrowserReviewActionReceipt; replayed: boolean }>;
}

export interface BrowserReviewActionBaseInput extends BrowserReviewActionIdentity {
  fence: WorkspaceFence;
  expectedHeadRevisionId: string;
  store: AtomicBrowserReviewActionStore;
  terminalPort: BrowserReviewTerminalPort;
}

export interface BrowserReviewTerminalPort {
  prepareTerminalEvent(body: BrowserSuggestionTerminalBody): AssembledBrowserEvent;
  adoptDurableEnvelope(envelope: MailboxEnvelope): Promise<void>;
}

export interface AcceptBrowserSuggestionInput
  extends BrowserReviewActionBaseInput,
    Omit<ResolveBrowserSuggestionInput, 'roomId' | 'suggestionId'> {}

export interface RejectBrowserSuggestionInput extends BrowserReviewActionBaseInput {
  reason?: string;
}

export type AcceptBrowserSuggestionResult =
  | { status: 'needs_review'; verdict: Exclude<ApplyVerdict, { kind: 'ready' }> }
  | {
      status: 'committed';
      receipt: BrowserReviewActionReceipt;
      event: ReviewEvent;
      replayed: boolean;
      deliveryPending: boolean;
      deliveryError?: string;
    };

export interface RejectBrowserSuggestionResult {
  status: 'committed';
  receipt: BrowserReviewActionReceipt;
  event: ReviewEvent;
  replayed: boolean;
  deliveryPending: boolean;
  deliveryError?: string;
}

export class BrowserReviewActionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserReviewActionConflictError';
  }
}

/** Native-parity suggestion drift resolution layered on a resolved anchor. */
export function resolveBrowserSuggestion(input: ResolveBrowserSuggestionInput): ApplyVerdict {
  const resolved = input.resolvedAnchor;
  if (resolved.status === 'ambiguous') {
    return {
      kind: 'ambiguous',
      suggestionId: input.suggestionId,
      candidates: resolved.candidates.map((candidate) => structuredClone(candidate)),
    };
  }
  if (resolved.status === 'stale') {
    return { kind: 'stale', suggestionId: input.suggestionId, reason: resolved.reason };
  }

  const confidence = resolved.confidence;
  const forceReview = resolved.status === 'remapped' && confidence < APPLY_REVIEW_FLOOR;
  const length = input.currentMarkdownBytes.length;
  const start = Math.min(Math.max(0, resolved.currentRange.byteRange[0]), length);
  const end = Math.max(start, Math.min(Math.max(0, resolved.currentRange.byteRange[1]), length));

  switch (input.operation.kind) {
    case 'replace':
      return decideTextOperation(
        input,
        start,
        end,
        input.operation.expectedText,
        input.operation.replacement,
        confidence,
        forceReview,
      );
    case 'delete':
      return decideTextOperation(
        input,
        start,
        end,
        input.operation.expectedText,
        '',
        confidence,
        forceReview,
      );
    case 'insert_before':
      return decideInsertion(input, start, input.operation.text, confidence, forceReview);
    case 'insert_after':
      return decideInsertion(input, end, input.operation.text, confidence, forceReview);
  }
}

/** Mirrors Rust `classify_text_match`, including deliberate CRLF mismatch. */
export function classifyBrowserSuggestionText(snapshot: string, current: string): TextMatchKind {
  if (snapshot === current) return 'exact';
  if ((!isAscii(snapshot) || !isAscii(current)) && snapshot.normalize('NFC') === current.normalize('NFC')) {
    return 'normalized_unicode';
  }
  if (trailingWhitespaceEqual(snapshot, current)) return 'trailing_whitespace';
  return 'mismatch';
}

/** Apply only a Ready verdict, preserving the native byte-indexed splice. */
export function applyBrowserReadyVerdict(
  currentMarkdownBytes: Uint8Array,
  verdict: ApplyVerdict,
): Uint8Array {
  if (verdict.kind !== 'ready') {
    throw new BrowserReviewActionConflictError(`verdict ${verdict.kind} is not directly applicable`);
  }
  const [start, end] = verdict.targetByteRange;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start > end ||
    end > currentMarkdownBytes.length ||
    !isUtf8Boundary(currentMarkdownBytes, start) ||
    !isUtf8Boundary(currentMarkdownBytes, end)
  ) {
    throw new BrowserReviewActionConflictError('target byte range is not a valid UTF-8 boundary');
  }
  const replacement = new TextEncoder().encode(verdict.replacement);
  const next = new Uint8Array(currentMarkdownBytes.length - (end - start) + replacement.length);
  next.set(currentMarkdownBytes.subarray(0, start), 0);
  next.set(replacement, start);
  next.set(currentMarkdownBytes.subarray(end), start + replacement.length);
  return next;
}

/** Stable, disposition-independent key enforcing one terminal decision. */
export function deriveBrowserReviewActionId(identity: BrowserReviewActionIdentity): string {
  return hashId('attn browser review-action v1', normalizeActionIdentity(identity), 32);
}

/** Stable revision id for the one accepted transition represented by actionId. */
export function deriveBrowserAppliedRevisionId(input: {
  identity: BrowserReviewActionIdentity;
  actionId: string;
  baseRevisionId: string;
  previousHash: string;
  resultingHash: string;
}): string {
  return hashId('attn browser accepted-revision v1', input, 16);
}

export function browserWorkspaceBodyHash(body: Uint8Array): string {
  return base64UrlEncode(sha256(body));
}

export function browserReviewActionRecoveryId(actionId: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(actionId)) {
    throw new BrowserReviewActionConflictError('review action id must be a 32-byte base64url id');
  }
  return `review-action:${actionId}`;
}

export function encodeBrowserReviewActionReceipt(
  receipt: BrowserReviewActionReceipt,
): Uint8Array {
  validateReceipt(
    receipt,
    actionIdentity(receipt),
    receipt.actionId,
    receipt.disposition,
  );
  return toCanonicalBytes(receipt);
}

export function decodeBrowserReviewActionReceipt(bytes: Uint8Array): BrowserReviewActionReceipt {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new BrowserReviewActionConflictError('sealed review action receipt is invalid');
  }
  if (!value || typeof value !== 'object') {
    throw new BrowserReviewActionConflictError('sealed review action receipt is invalid');
  }
  const receipt = value as BrowserReviewActionReceipt;
  validateReceiptShape(receipt);
  validateReceipt(receipt, normalizeActionIdentity(receipt), receipt.actionId, receipt.disposition);
  return receipt;
}

/** Resolve, apply, author, then hand the entire accepted transition to one transaction. */
export async function acceptBrowserSuggestion(
  input: AcceptBrowserSuggestionInput,
): Promise<AcceptBrowserSuggestionResult> {
  const identity = actionIdentity(input);
  const actionId = deriveBrowserReviewActionId(identity);
  const verdict = resolveBrowserSuggestion({
    roomId: input.roomId,
    suggestionId: input.suggestionId,
    operation: input.operation,
    resolvedAnchor: input.resolvedAnchor,
    currentMarkdownBytes: input.currentMarkdownBytes,
  });
  if (verdict.kind !== 'ready') return { status: 'needs_review', verdict };

  // Native requires the exact bytes used for resolution to be the bytes fed
  // to the guarded write. One input makes that invariant unrepresentable to
  // violate at this layer; the atomic store still CASes expectedHeadRevisionId.
  const nextBody = applyBrowserReadyVerdict(input.currentMarkdownBytes, verdict);
  const previousHash = browserWorkspaceBodyHash(input.currentMarkdownBytes);
  const resultingHash = browserWorkspaceBodyHash(nextBody);
  const revisionId = deriveBrowserAppliedRevisionId({
    identity,
    actionId,
    baseRevisionId: input.expectedHeadRevisionId,
    previousHash,
    resultingHash,
  });
  const replay = await replayReceipt(input.store, identity, actionId, 'accepted');
  if (replay) {
    if (
      replay.baseRevisionId !== input.expectedHeadRevisionId ||
      replay.baseBodyHash !== previousHash ||
      replay.appliedRevisionId !== revisionId ||
      replay.resultingHash !== resultingHash
    ) {
      throw new BrowserReviewActionConflictError('accepted action replay differs from requested transition');
    }
    return {
      status: 'committed', receipt: replay, event: replay.terminalEvent, replayed: true,
      ...(await adoptTerminal(input.terminalPort, replay)),
    };
  }
  const terminalBody: SuggestionAcceptedBody = {
    type: 'suggestion_accepted',
    suggestionId: input.suggestionId,
    appliedRevisionId: revisionId,
    resultingHash,
  };
  const terminal = assembleTerminalEvent(input, terminalBody);
  validateTerminal(terminal, input.roomId, terminalBody);
  const committed = await input.store.commitReviewAction({
    disposition: 'accepted',
    identity,
    actionId,
    fence: input.fence,
    expectedHeadRevisionId: input.expectedHeadRevisionId,
    expectedBodyHash: previousHash,
    revisionId,
    body: nextBody,
    bodyHash: resultingHash,
    terminal,
  });
  validateReceipt(committed.receipt, identity, actionId, 'accepted');
  return {
    status: 'committed',
    receipt: committed.receipt,
    event: committed.receipt.terminalEvent,
    replayed: committed.replayed,
    ...(await adoptTerminal(input.terminalPort, committed.receipt)),
  };
}

/** Persist rejection + exact outbox ciphertext before the caller dismisses UI. */
export async function rejectBrowserSuggestion(
  input: RejectBrowserSuggestionInput,
): Promise<RejectBrowserSuggestionResult> {
  const identity = actionIdentity(input);
  const actionId = deriveBrowserReviewActionId(identity);
  const body: SuggestionRejectedBody = {
    type: 'suggestion_rejected',
    suggestionId: input.suggestionId,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  };
  const replay = await replayReceipt(input.store, identity, actionId, 'rejected');
  if (replay) {
    if (
      replay.baseRevisionId !== input.expectedHeadRevisionId ||
      !sameCanonicalValue(replay.terminalEvent.body, body)
    ) {
      throw new BrowserReviewActionConflictError('rejected action replay differs from requested decision');
    }
    return {
      status: 'committed', receipt: replay, event: replay.terminalEvent, replayed: true,
      ...(await adoptTerminal(input.terminalPort, replay)),
    };
  }
  const terminal = assembleTerminalEvent(input, body);
  validateTerminal(terminal, input.roomId, body);
  const committed = await input.store.commitReviewAction({
    disposition: 'rejected',
    identity,
    actionId,
    fence: input.fence,
    expectedHeadRevisionId: input.expectedHeadRevisionId,
    terminal,
  });
  validateReceipt(committed.receipt, identity, actionId, 'rejected');
  return {
    status: 'committed',
    receipt: committed.receipt,
    event: committed.receipt.terminalEvent,
    replayed: committed.replayed,
    ...(await adoptTerminal(input.terminalPort, committed.receipt)),
  };
}

async function adoptTerminal(
  port: BrowserReviewTerminalPort,
  receipt: BrowserReviewActionReceipt,
): Promise<{ deliveryPending: false } | { deliveryPending: true; deliveryError: string }> {
  try {
    await port.adoptDurableEnvelope(structuredClone(receipt.terminalEnvelope));
    return { deliveryPending: false };
  } catch (error) {
    return {
      deliveryPending: true,
      deliveryError: error instanceof Error ? error.message : String(error),
    };
  }
}

function decideTextOperation(
  input: ResolveBrowserSuggestionInput,
  start: number,
  end: number,
  expected: string,
  replacement: string,
  confidence: number,
  forceReview: boolean,
): ApplyVerdict {
  const currentText = decodeUtf8(input.currentMarkdownBytes.subarray(start, end));
  const matchKind = classifyBrowserSuggestionText(expected, currentText);
  if (!forceReview && matchKind !== 'mismatch') {
    const confidenceNote = matchKindNote(matchKind);
    return {
      kind: 'ready',
      suggestionId: input.suggestionId,
      targetByteRange: [start, end],
      replacement,
      confidence,
      matchKind,
      ...(confidenceNote === undefined ? {} : { confidenceNote }),
    };
  }
  return {
    kind: 'requires_three_way',
    suggestionId: input.suggestionId,
    roomId: input.roomId,
    targetByteRange: [start, end],
    snapshotExpected: expected,
    currentText,
    proposedReplacement: replacement,
    confidence,
  };
}

function decideInsertion(
  input: ResolveBrowserSuggestionInput,
  cursor: number,
  replacement: string,
  confidence: number,
  forceReview: boolean,
): ApplyVerdict {
  if (forceReview) {
    return {
      kind: 'requires_three_way',
      suggestionId: input.suggestionId,
      roomId: input.roomId,
      targetByteRange: [cursor, cursor],
      snapshotExpected: '',
      currentText: '',
      proposedReplacement: replacement,
      confidence,
    };
  }
  return {
    kind: 'ready',
    suggestionId: input.suggestionId,
    targetByteRange: [cursor, cursor],
    replacement,
    confidence,
    matchKind: 'exact',
  };
}

function matchKindNote(kind: TextMatchKind): string | undefined {
  if (kind === 'normalized_unicode') return 'text matched after Unicode NFC normalization';
  if (kind === 'trailing_whitespace') return 'trailing whitespace differs from snapshot';
  if (kind === 'mismatch') return 'text mismatch (forwarded to three-way)';
  return undefined;
}

function trailingWhitespaceEqual(a: string, b: string): boolean {
  const aa = a.split('\n');
  const bb = b.split('\n');
  const shared = Math.min(aa.length, bb.length);
  let sawDifference = false;
  for (let index = 0; index < shared; index += 1) {
    const left = aa[index]!;
    const right = bb[index]!;
    const leftTrimmed = left.replace(/[ \t]+$/u, '');
    const rightTrimmed = right.replace(/[ \t]+$/u, '');
    if (leftTrimmed !== rightTrimmed) return false;
    if (leftTrimmed.length !== left.length || rightTrimmed.length !== right.length) {
      sawDifference = true;
    }
  }
  if (aa.length !== bb.length) {
    const longer = aa.length > bb.length ? aa : bb;
    if (longer.length !== shared + 1 || longer[shared] !== '') return false;
    sawDifference = true;
  }
  return sawDifference;
}

function isAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0x7f) return false;
  }
  return true;
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return '';
  }
}

function isUtf8Boundary(bytes: Uint8Array, position: number): boolean {
  if (position === bytes.length) return true;
  if (position < 0 || position > bytes.length) return false;
  return (bytes[position]! & 0xc0) !== 0x80;
}

function hashId(domain: string, value: unknown, byteLength: number): string {
  const encoded = toCanonicalBytes({ domain, value });
  try {
    return base64UrlEncode(sha256(encoded).subarray(0, byteLength));
  } finally {
    encoded.fill(0);
  }
}

function actionIdentity(input: BrowserReviewActionIdentity): BrowserReviewActionIdentity {
  return normalizeActionIdentity({
    workspaceId: input.workspaceId,
    roomId: input.roomId,
    path: input.path,
    suggestionId: input.suggestionId,
  });
}

async function replayReceipt(
  store: AtomicBrowserReviewActionStore,
  identity: BrowserReviewActionIdentity,
  actionId: string,
  disposition: BrowserReviewActionReceipt['disposition'],
): Promise<BrowserReviewActionReceipt | null> {
  const receipt = await store.getReviewActionReceipt(identity, actionId);
  if (!receipt) return null;
  validateReceipt(receipt, identity, actionId, disposition);
  return receipt;
}

function validateReceipt(
  receipt: BrowserReviewActionReceipt,
  identity: BrowserReviewActionIdentity,
  actionId: string,
  disposition: BrowserReviewActionReceipt['disposition'],
): void {
  validateReceiptShape(receipt);
  const canonicalIdentity = normalizeActionIdentity(identity);
  if (
    receipt.v !== ACTION_RECORD_VERSION ||
    receipt.actionId !== actionId ||
    receipt.actionId !== deriveBrowserReviewActionId(receipt) ||
    receipt.workspaceId !== canonicalIdentity.workspaceId ||
    receipt.roomId !== canonicalIdentity.roomId ||
    receipt.path !== canonicalIdentity.path ||
    receipt.suggestionId !== canonicalIdentity.suggestionId
  ) {
    throw new BrowserReviewActionConflictError('review action receipt does not match the request');
  }
  if (receipt.disposition !== disposition) {
    throw new BrowserReviewActionConflictError(
      `suggestion was already ${receipt.disposition}; cannot mark it ${disposition}`,
    );
  }
  if (
    !receipt.terminalEvent ||
    !receipt.terminalEnvelope ||
    receipt.terminalEvent.meta.roomId !== identity.roomId ||
    receipt.terminalEnvelope.roomId !== identity.roomId ||
    receipt.terminalEnvelopeId !== receipt.terminalEnvelope.envelopeId ||
    receipt.terminalEnvelope.envelopeId !==
      deriveEventEnvelopeId(identity.roomId, receipt.terminalEvent.meta.eventId)
  ) {
    throw new BrowserReviewActionConflictError('review action receipt terminal envelope is invalid');
  }
  const body = receipt.terminalEvent.body;
  if (!('suggestionId' in body) || body.suggestionId !== identity.suggestionId) {
    throw new BrowserReviewActionConflictError('review action receipt suggestion is invalid');
  }
  if (disposition === 'accepted') {
    if (
      body.type !== 'suggestion_accepted' ||
      body.appliedRevisionId !== receipt.appliedRevisionId ||
      body.resultingHash !== receipt.resultingHash ||
      receipt.baseRevisionId === undefined
    ) {
      throw new BrowserReviewActionConflictError('accepted action receipt is inconsistent');
    }
  } else if (body.type !== 'suggestion_rejected') {
    throw new BrowserReviewActionConflictError('rejected action receipt is inconsistent');
  }
}

function validateReceiptShape(receipt: BrowserReviewActionReceipt): void {
  if (!receipt || typeof receipt !== 'object' || receipt.v !== ACTION_RECORD_VERSION) {
    throw new BrowserReviewActionConflictError('review action receipt version is invalid');
  }
  for (const [label, value] of [
    ['actionId', receipt.actionId],
    ['workspaceId', receipt.workspaceId],
    ['roomId', receipt.roomId],
    ['path', receipt.path],
    ['suggestionId', receipt.suggestionId],
    ['terminalEnvelopeId', receipt.terminalEnvelopeId],
  ] as const) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
      throw new BrowserReviewActionConflictError(`review action receipt ${label} is invalid`);
    }
  }
  if (receipt.path !== normalizeEntryPath(receipt.path)) {
    throw new BrowserReviewActionConflictError('review action receipt path is not canonical');
  }
  if (receipt.disposition !== 'accepted' && receipt.disposition !== 'rejected') {
    throw new BrowserReviewActionConflictError('review action receipt disposition is invalid');
  }
  if (!receipt.terminalEvent || typeof receipt.terminalEvent !== 'object') {
    throw new BrowserReviewActionConflictError('review action receipt terminal event is invalid');
  }
  const { meta, body, auth } = receipt.terminalEvent;
  if (
    !meta ||
    meta.v !== 2 ||
    typeof meta.eventId !== 'string' ||
    typeof meta.roomId !== 'string' ||
    typeof meta.authorId !== 'string' ||
    typeof meta.deviceId !== 'string' ||
    !Number.isSafeInteger(meta.createdAt) ||
    meta.createdAt < 0 ||
    !Array.isArray(meta.parentEventIds) ||
    !auth ||
    typeof auth.signature !== 'string' ||
    typeof auth.signingKeyId !== 'string' ||
    deriveEventId(meta, body) !== meta.eventId
  ) {
    throw new BrowserReviewActionConflictError('review action receipt terminal event binding is invalid');
  }
  const envelope = receipt.terminalEnvelope;
  if (
    !envelope ||
    typeof envelope !== 'object' ||
    envelope.kind !== 'event' ||
    envelope.roomId !== meta.roomId ||
    envelope.authorId !== meta.authorId ||
    envelope.deviceId !== meta.deviceId ||
    envelope.createdAt !== meta.createdAt ||
    envelope.envelopeId !== deriveEventEnvelopeId(meta.roomId, meta.eventId)
  ) {
    throw new BrowserReviewActionConflictError('review action receipt terminal envelope binding is invalid');
  }
  if (receipt.disposition === 'accepted') {
    if (
      body.type !== 'suggestion_accepted' ||
      typeof receipt.baseRevisionId !== 'string' ||
      typeof receipt.baseBodyHash !== 'string' ||
      typeof receipt.appliedRevisionId !== 'string' ||
      typeof receipt.resultingHash !== 'string'
    ) {
      throw new BrowserReviewActionConflictError('accepted action receipt fields are invalid');
    }
  } else if (
    body.type !== 'suggestion_rejected' ||
    typeof receipt.baseRevisionId !== 'string' ||
    receipt.baseBodyHash !== undefined ||
    receipt.appliedRevisionId !== undefined ||
    receipt.resultingHash !== undefined
  ) {
    throw new BrowserReviewActionConflictError('rejected action receipt fields are invalid');
  }
}

function assembleTerminalEvent(
  input: BrowserReviewActionBaseInput,
  body: BrowserSuggestionTerminalBody,
): AssembledBrowserEvent {
  return input.terminalPort.prepareTerminalEvent(body);
}

function normalizeActionIdentity(
  identity: BrowserReviewActionIdentity,
): BrowserReviewActionIdentity {
  for (const [label, value] of [
    ['workspaceId', identity.workspaceId],
    ['roomId', identity.roomId],
    ['suggestionId', identity.suggestionId],
  ] as const) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
      throw new BrowserReviewActionConflictError(`${label} is invalid`);
    }
  }
  if (typeof identity.path !== 'string') {
    throw new BrowserReviewActionConflictError('path is invalid');
  }
  return {
    workspaceId: identity.workspaceId,
    roomId: identity.roomId,
    path: normalizeEntryPath(identity.path),
    suggestionId: identity.suggestionId,
  };
}

function validateTerminal(
  terminal: AssembledBrowserEvent,
  roomId: RoomId,
  expectedBody: BrowserSuggestionTerminalBody,
): void {
  if (
    terminal.event.meta.roomId !== roomId ||
    terminal.envelope.roomId !== roomId ||
    !sameCanonicalValue(terminal.event.body, expectedBody)
  ) {
    throw new BrowserReviewActionConflictError('authored terminal event does not match the action');
  }
  validateEnvelopeIdentity(terminal.envelope, terminal.event.meta.eventId);
}

function sameCanonicalValue(left: unknown, right: unknown): boolean {
  const a = toCanonicalBytes(left);
  const b = toCanonicalBytes(right);
  try {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let index = 0; index < a.length; index += 1) diff |= a[index]! ^ b[index]!;
    return diff === 0;
  } finally {
    a.fill(0);
    b.fill(0);
  }
}

function validateEnvelopeIdentity(envelope: MailboxEnvelope, eventId: EventId): void {
  if (
    envelope.kind !== 'event' ||
    envelope.envelopeId !== deriveEventEnvelopeId(envelope.roomId ?? '', eventId)
  ) {
    throw new BrowserReviewActionConflictError('terminal event envelope is invalid');
  }
}
