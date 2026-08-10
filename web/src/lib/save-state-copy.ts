/* The save-state vocabulary, in one place (design-system consolidation,
 * 2026-08-08 — issue 9 of the conflict inventory).
 *
 * WHY A MODULE FOR FOUR STRINGS. Before attn-yzsa the native chip said "Saved
 * on this device" while hosted /app said "Changes autosaved" — the same chip,
 * two sentences, and one of them was false on desktop. attn-yzsa made the
 * sentence true everywhere; this module makes it SINGULAR everywhere. The
 * hosted SaveState union derives from these constants, so the native chip and
 * the hosted shell cannot drift apart again without a type error, and a copy
 * change is one edit here rather than a grep across surfaces.
 *
 * The canonical state string is "Changes autosaved" (owner-confirmed,
 * 2026-08-08). It is TRUE on both surfaces: hosted /app has AutosaveController
 * (attn-7xl.3.3), the native window has NativeAutosave (attn-yzsa.1) — both
 * commit on a debounce with a ceiling.
 *
 * `save-state-copy.test.ts` pins that no orphan literal of these strings
 * survives outside this module, its consumers' sr-only fallbacks, and tests.
 */

/** The chip's resting state: work is on disk without a keystroke. */
export const SAVE_STATE_AUTOSAVED = 'Changes autosaved' as const;

/**
 * The chip's hover title. Carries the LOCAL half of the claim — autosaved,
 * and autosaved *here*, not to anyone's cloud. The short form drops "on this
 * device" only because the chip has no room; the title must not.
 */
export const SAVE_STATE_AUTOSAVED_TITLE = 'Changes autosaved on this device' as const;

/** A commit is in flight (debounce elapsed, write not yet done). */
export const SAVE_STATE_SAVING = 'Saving…' as const;

/** Hosted only: a durable commit REJECTED — quota, eviction, private mode. */
export const SAVE_STATE_STORAGE_ATTENTION = 'Storage needs attention' as const;

/**
 * The product's local-first claim, standing free of the save chip. It used to
 * be the chip's resting label doing two jobs in one string; the landing Hero
 * still says it because there it IS the claim ("Source · local"), not a save
 * state. Not part of the SaveState union.
 */
export const LOCAL_FIRST_CLAIM = 'Saved on this device' as const;
