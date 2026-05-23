// Local user profile (onboarding display name). Seeded at startup from the
// init payload's `reviewProfile` and updated when the user sets a name through
// the NamePrompt modal or the edit affordance.
//
// The name lives on the Rust device identity (identity.json); this is the
// reactive view the UI binds to. `save()` persists via IPC and optimistically
// updates local state so the badge / prompt react immediately.

import { reviewSetDisplayName } from '../ipc';
import type { ReviewProfileInit } from '../types';

class UserProfile {
  /** The user's explicitly chosen name, or `null` if running on the default. */
  displayName = $state<string | null>(null);
  /** Resolved git/OS default used to pre-fill the prompt. Never empty. */
  defaultDisplayName = $state<string>('Anonymous');
  /** Whether the user has explicitly set a name (drives the first-time prompt). */
  isSet = $state<boolean>(false);

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
  }

  /**
   * Persist a chosen name. Empty/whitespace clears the override back to the
   * resolved default. Optimistically updates local state; the daemon write is
   * fire-and-forget (the next Share/Join reads the updated identity).
   */
  save(name: string): void {
    const trimmed = name.trim();
    void reviewSetDisplayName(trimmed);
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
