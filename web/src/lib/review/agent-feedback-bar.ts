/**
 * View model for the agent-comments bar pinned to the bottom of the
 * comment rail (`AgentFeedbackBar.svelte`).
 *
 * The bar is one row: a label, a count bubble for the current copy scope,
 * a scope toggle and a copy-all button. Everything the row shows is a pure
 * function of three numbers and the scope, which is what this module
 * computes — kept out of the component so the rules (when the bar exists,
 * what the toggle says, when copy-all is disabled) run under plain Node in
 * the unit tests.
 */

export type FeedbackScope = 'file' | 'project';

export const AGENT_FEEDBACK_BAR_LABEL = 'Agent Comments';
export const COPY_ALL_TITLE = 'Copy all agent comments';
export const COPIED_TITLE = 'Copied';
export const SCOPE_TOGGLE_LABEL = 'Feedback copy scope';

/** The toggle's title names the scope a click switches TO. The glyph shows
 *  the scope in effect now (file vs open folder). */
export const SCOPE_TITLES: Record<FeedbackScope, string> = {
  file: 'Switch to Project Scope',
  project: 'Switch to File Scope',
};

/** Lucide icon the scope toggle shows for each scope. */
export const SCOPE_ICONS: Record<FeedbackScope, 'file' | 'folder-open'> = {
  file: 'file',
  project: 'folder-open',
};

export interface AgentFeedbackBarInput {
  scope: FeedbackScope;
  /** Marked, unresolved threads in the current scope. */
  scopeCount: number;
  /** Marked, unresolved threads anywhere in the room — the bar's trigger. */
  projectCount: number;
}

export interface AgentFeedbackBarModel {
  /** The bar exists only while the room has at least one marked thread. */
  visible: boolean;
  scope: FeedbackScope;
  count: number;
  scopeIcon: 'file' | 'folder-open';
  scopeTitle: string;
  /** `aria-pressed` for the toggle: on means "whole project". */
  projectScope: boolean;
  copyDisabled: boolean;
}

export function nextFeedbackScope(scope: FeedbackScope): FeedbackScope {
  return scope === 'file' ? 'project' : 'file';
}

export function describeAgentFeedbackBar(input: AgentFeedbackBarInput): AgentFeedbackBarModel {
  const count = Math.max(0, input.scopeCount);
  return {
    visible: input.projectCount > 0,
    scope: input.scope,
    count,
    scopeIcon: SCOPE_ICONS[input.scope],
    scopeTitle: SCOPE_TITLES[input.scope],
    projectScope: input.scope === 'project',
    copyDisabled: count === 0,
  };
}
