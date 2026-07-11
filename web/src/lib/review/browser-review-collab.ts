import type { BrowserCollabDelivery } from './browser-session';

export const BROWSER_OWNER_OFFLINE_STATUS = 'Owner offline · Review still available' as const;
export const MAX_BROWSER_REVIEWER_COLLAB_WAITERS = 64;

export interface BrowserReviewerAvailabilityInput {
  hasMarkdownSnapshot: boolean;
  ownerOnline: boolean;
  liveEditingAvailable: boolean;
  authoringReady: boolean;
}

export interface BrowserReviewerAvailability {
  collabReady: boolean;
  liveEditing: boolean;
  reviewAuthoring: boolean;
  ownerStatus: typeof BROWSER_OWNER_OFFLINE_STATUS | null;
}

/** Keep review authoring independent from ephemeral owner presence. */
export function browserReviewerAvailability(
  input: BrowserReviewerAvailabilityInput,
): BrowserReviewerAvailability {
  return {
    collabReady: input.hasMarkdownSnapshot,
    // Reviewer documents are always read-only. The collab plugin stays
    // mounted only to consume owner-authenticated broadcasts and keep cursor
    // presence; authored changes use durable comment/suggestion events.
    liveEditing: false,
    reviewAuthoring: input.authoringReady,
    ownerStatus:
      input.hasMarkdownSnapshot && !input.ownerOnline
        ? BROWSER_OWNER_OFFLINE_STATUS
        : null,
  };
}

/** BrowserSession supplies a directory-verified immutable sender record. */
export function rememberAuthenticatedOwnerDevice(
  ownerDeviceIds: Set<string>,
  delivery: BrowserCollabDelivery,
): boolean {
  if (delivery.sender.kind !== 'owner') return false;
  ownerDeviceIds.add(delivery.sender.deviceId);
  return true;
}

/** Prevent a newly-created epoch controller from binding the prior EditorView. */
export function browserReviewerViewMatchesEpoch(
  readyEpoch: number,
  currentEpoch: number,
): boolean {
  return Number.isSafeInteger(readyEpoch)
    && Number.isSafeInteger(currentEpoch)
    && readyEpoch === currentEpoch;
}

type DeliveryTarget = (delivery: BrowserCollabDelivery) => void;

interface Readiness {
  promise: Promise<void>;
  resolve(): void;
  reject(reason: Error): void;
}

function readiness(): Readiness {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

/**
 * Holds BrowserSession's onCollab callback open until the epoch-bound
 * reviewer controller is ready. A callback that rejects is not marked
 * dispatched by BrowserSession and remains recoverable from durable inbound.
 */
export class BrowserReviewerCollabGate {
  private target: DeliveryTarget | null = null;
  private ready = readiness();
  private waiting = 0;
  private closedError: Error | null = null;

  constructor(private readonly onOverflow?: (error: Error) => void) {}

  bind(target: DeliveryTarget): void {
    if (this.closedError) throw this.closedError;
    this.target = target;
    this.ready.resolve();
  }

  reset(): void {
    if (this.closedError) return;
    this.target = null;
    const previous = this.ready;
    this.ready = readiness();
    previous.resolve();
  }

  close(reason = new Error('browser reviewer collaboration closed')): void {
    if (this.closedError) return;
    this.closedError = reason;
    this.target = null;
    this.ready.reject(reason);
  }

  async route(delivery: BrowserCollabDelivery): Promise<void> {
    if (this.closedError) throw this.closedError;
    if (this.target) {
      this.requireTarget()(delivery);
      return;
    }
    if (this.waiting >= MAX_BROWSER_REVIEWER_COLLAB_WAITERS) {
      const error = new Error('too many collaboration deliveries are waiting for reviewer setup');
      this.onOverflow?.(error);
      throw error;
    }
    this.waiting += 1;
    try {
      while (!this.target) {
        if (this.closedError) throw this.closedError;
        const pending = this.ready;
        await pending.promise;
      }
      this.requireTarget()(delivery);
    } finally {
      this.waiting -= 1;
    }
  }

  private requireTarget(): DeliveryTarget {
    if (!this.target) throw new Error('browser reviewer collaboration is not bound');
    return this.target;
  }
}
