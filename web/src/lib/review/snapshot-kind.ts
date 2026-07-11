import type { ReviewSnapshot } from '../types';

/**
 * Only text documents belong in the review editor and its navigation model.
 * Asset and workspace-manifest snapshots are authenticated metadata records.
 *
 * `docType` was optional before tagged snapshot plaintext. Keep content-bearing
 * legacy snapshots renderable while failing closed for explicitly inert types
 * and content-less pointer placeholders.
 */
export function isRenderableReviewSnapshot(snapshot: ReviewSnapshot): boolean {
  if (snapshot.docType === 'markdown' || snapshot.docType === 'html') return true;
  return snapshot.docType === undefined && typeof snapshot.content === 'string';
}

/** A pointer becomes hydrated once its authenticated payload has been seen. */
export function isHydratedReviewSnapshot(snapshot: ReviewSnapshot): boolean {
  return isRenderableReviewSnapshot(snapshot)
    || snapshot.docType === 'asset'
    || snapshot.docType === 'workspace_manifest';
}
