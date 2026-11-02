/**
 * Blob listing windows
 * -------------------------------------------------------
 * `listBlobs()` reads in `fileId` order and pages forward from
 * `afterFileId`, on every adapter. An adapter whose storage hands back an
 * unordered set of names windows it here, so the order and the cursor mean
 * the same thing whatever stores the bytes. See docs/spec/data-model.md
 * § List order.
 */

import type { BlobsQuery, FileId } from '../types/index.js';

/** The `fileId`s a `listBlobs(query)` answers with, out of every one stored. */
export function blobWindow(fileIds: Iterable<FileId>, query: BlobsQuery = {}): FileId[] {
  const { afterFileId, limit } = query;
  const after = [...fileIds].filter((id) => afterFileId === undefined || id > afterFileId).sort();
  return limit === undefined ? after : after.slice(0, limit);
}
