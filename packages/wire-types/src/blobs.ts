/**
 * Blobs
 * -------------------------------------------------------
 * `GET /blobs`: every blob the store holds, for the owner acting alone. It
 * is what lets a hosted stack be read in full, and so copied out.
 * See docs/spec/wire-format.md § Blobs.
 */

import type { BlobInfo } from '@haverstack/core/adapter';

/**
 * Whether a server lists its blobs at `GET /blobs`. Absent means it does
 * not, and `APIAdapter` then has no `listBlobs()`. An object for the same
 * reason `changes` is one.
 */
export type DiscoveryBlobs = {
  list: boolean;
};

/** Whether a server advertises `GET /blobs`. */
export function supportsBlobListing(discovery: { blobs?: DiscoveryBlobs }): boolean {
  return discovery.blobs?.list === true;
}

export type WireBlobInfo = {
  fileId: string;
  size: number;
  modifiedAt: string;
};

/**
 * The response envelope of `GET /blobs`, `fileId` ascending. `cursor` is
 * the only end-of-list signal, as on the journal: it carries the `fileId`
 * to send as the next `afterFileId`, and is null once nothing follows.
 */
export type WireBlobsResponse = {
  blobs: WireBlobInfo[];
  cursor: string | null;
};

export function serializeBlobInfo(b: BlobInfo): WireBlobInfo {
  return { fileId: b.fileId, size: b.size, modifiedAt: b.modifiedAt.toISOString() };
}
