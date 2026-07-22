// Local user profile (onboarding display name). Seeded at startup from the
// init payload's `reviewProfile` and updated when the user sets a name through
// the NamePrompt modal or the edit affordance.
//
// The name lives on the Rust device identity (identity.json); this is the
// reactive view the UI binds to. `save()` persists via IPC and optimistically
// updates local state so the badge / prompt react immediately.

import { reviewSetColor, reviewSetDisplayName } from './ipc';
import {
  readStoredColor,
  readStoredDisplayName,
  writeStoredColor,
  writeStoredDisplayName,
} from './browser-profile';
import { sanitizeParticipantColor } from './participant-color';
import type { ReviewProfileInit } from './types';

/** True when running hosted in a plain browser (no wry IPC bridge). */
function isBrowserHosted(): boolean {
  return typeof window !== 'undefined' && window.ipc === undefined;
}

class UserProfile {
  /** The user's explicitly chosen name, or `null` if running on the default. */
  displayName = $state<string | null>(null);
  /** Resolved git/OS default used to pre-fill the prompt. Never empty. */
  defaultDisplayName = $state<string>('Anonymous');
  /** Whether the user has explicitly set a name (drives the first-time prompt). */
  isSet = $state<boolean>(false);
  /**
   * Picked identity color (attn-3gdd), or `null` for "Auto" — the
   * deterministic hash of the participant id. Validated on every write so a
   * corrupted stored value can never reach an inline style or the wire.
   */
  color = $state<string | null>(null);
  /**
   * The local device identity's stable participant id (native init payload
   * only — hosted surfaces mint per-session ids). Used to resolve the local
   * user's own hash color for carets before any roster exists.
   */
  participantId = $state<string | null>(null);

  /**
   * Set by any "Edit name" affordance (e.g. the connection badge) to ask the
   * app shell to open the NamePrompt in edit mode — avoids threading a modal
   * callback through every collab surface. The shell resets it on open.
   */
  editRequested = $state<boolean>(false);

  requestEdit(): void {
    this.editRequested = true;
  }

  /** The value to pre-fill the prompt with: the chosen name, else the default. */
  get suggestion(): string {
    return this.displayName ?? this.defaultDisplayName;
  }

  /** The name peers see for us right now: chosen name, else the default. */
  get effectiveName(): string {
    return this.displayName ?? this.defaultDisplayName;
  }

  hydrate(init: ReviewProfileInit | undefined): void {
    if (!init) return;
    this.displayName = init.displayName;
    this.defaultDisplayName = init.defaultDisplayName || 'Anonymous';
    this.isSet = init.displayNameSet;
    this.color = sanitizeParticipantColor(init.color);
    this.participantId = init.participantId;
  }

  /**
   * Persist a chosen name + identity color. Empty/whitespace name clears the
   * override back to the resolved default; `null` color clears back to the
   * automatic hash. Optimistically updates local state; the daemon writes are
   * fire-and-forget (the next Share/Join reads the updated identity).
   */
  save(name: string, color: string | null = this.color): void {
    const trimmed = name.trim();
    const validColor = sanitizeParticipantColor(color);
    void reviewSetDisplayName(trimmed);
    void reviewSetColor(validColor ?? '');
    if (isBrowserHosted()) {
      writeStoredDisplayName(trimmed || null);
      writeStoredColor(validColor);
    }
    this.color = validColor;
    if (trimmed) {
      this.displayName = trimmed;
      this.isSet = true;
    } else {
      this.displayName = null;
      this.isSet = false;
    }
  }
}

export const userProfile = new UserProfile();

// Hosted surfaces have no daemon identity to hydrate from — recover the
// browser-persisted name so comments, carets, and the people list carry it
// across visits (attn-sur). Native overwrites this via hydrate() at startup.
if (isBrowserHosted()) {
  const stored = readStoredDisplayName();
  if (stored) {
    userProfile.displayName = stored;
    userProfile.isSet = true;
  }
  userProfile.color = sanitizeParticipantColor(readStoredColor());
}
