/**
 * Injectable suggestion actions shared by the native and hosted review rails.
 *
 * `undefined` at the ReviewMargin boundary means "use the native port". An
 * explicitly supplied object -- including an empty one -- is authoritative,
 * which lets a hosted shell represent a temporarily unavailable owner port
 * without accidentally falling through to Tauri IPC.
 */
export type SuggestionAction<T> = (value: T) => unknown | Promise<unknown>;

export interface SuggestionActionPort<T> {
  accept?: SuggestionAction<T>;
  reject?: SuggestionAction<T>;
}

export type SuggestionActionFeedback =
  | { status: 'idle' }
  | { status: 'pending'; action: 'accept' | 'reject' }
  | { status: 'error'; message: string }
  | { status: 'delivery_pending'; message: string };

export function selectSuggestionActionPort<T>(
  injected: SuggestionActionPort<T> | undefined,
  native: SuggestionActionPort<T>,
): SuggestionActionPort<T> {
  return injected ?? native;
}

export function isSuggestionDeliveryPending(
  result: unknown,
): result is Record<string, unknown> & { deliveryPending: true } {
  return isRecord(result) && result.deliveryPending === true;
}

export function shouldDismissSuggestionAfterAction(result: unknown): boolean {
  // `deliveryPending` still means the decision and its exact ciphertext are
  // durable in the local outbox. The outbox owns retry/status from that point;
  // only an action that explicitly requires more review remains actionable.
  return !(isRecord(result) && result.status === 'needs_review');
}

export async function runSuggestionAction(
  action: (() => unknown | Promise<unknown>) | undefined,
  kind: 'accept' | 'reject',
  report: (feedback: SuggestionActionFeedback) => void,
): Promise<void> {
  if (!action) return;

  report({ status: 'pending', action: kind });
  try {
    const result = await action();
    if (isSuggestionDeliveryPending(result)) {
      report({
        status: 'delivery_pending',
        message: deliveryMessage(result),
      });
      return;
    }
    report({ status: 'idle' });
  } catch (error) {
    report({
      status: 'error',
      message: error instanceof Error ? error.message : 'Could not save this decision',
    });
  }
}

function deliveryMessage(result: Record<string, unknown>): string {
  const detail = result.deliveryError;
  if (typeof detail === 'string' && detail.trim().length > 0) {
    return `Decision saved locally; delivery is pending. ${detail}`;
  }
  return 'Decision saved locally; delivery is pending.';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
