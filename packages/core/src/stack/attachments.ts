/**
 * Attachment cleanup
 * -------------------------------------------------------
 * Deleting unreferenced attachment metadata on an adapter with no atomic
 * way to do it, and the garbage sweep that finds what is unreferenced.
 * Both run over an unscoped Stack's public API; Stack.deleteAttachment()
 * and collectAttachmentGarbage() carry the contract. See
 * docs/spec/attachments.md § Deleting attachments.
 */

import { StackConflictError, StackNotFoundError } from '../errors.js';
import { queryAllPages } from '../stack-reads.js';
import { SYSTEM_TYPES } from '../types/index.js';
import type {
  ActorOptions,
  AttachmentContent,
  FileId,
  StackAdapter,
  StackRecord,
} from '../types/index.js';
import type { CollectAttachmentGarbageOptions, CollectAttachmentGarbageResult } from './client.js';
import type { Stack } from './stack.js';

/**
 * Default grace period for Stack.collectAttachmentGarbage(), covering the
 * upload-then-associate window. See docs/spec/attachments.md § Garbage
 * collection.
 */
const DEFAULT_GC_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Whether any record references `fileId`. A soft-deleted or unlisted record
 * still counts — it must find its attachments intact on undelete or
 * relisting. See docs/spec/attachments.md § Deleting attachments.
 */
async function isFileReferenced(stack: Stack, fileId: FileId): Promise<boolean> {
  const { records } = await stack.query({
    filter: { referencesFileId: fileId, includeDeleted: true, includeUnlisted: true },
    limit: 1,
  });
  return records.length > 0;
}

/**
 * Non-atomic fallback for adapters that don't implement
 * deleteUnreferencedAttachmentRecords(): a concurrent associate() can
 * race between the reference check below and the deletes it guards.
 */
export async function deleteUnreferencedAttachmentRecordsFallback(
  stack: Stack,
  fileId: string,
  opts: ActorOptions = {},
): Promise<StackRecord[]> {
  if (await isFileReferenced(stack, fileId)) {
    throw new StackConflictError('Attachment is still referenced by one or more records');
  }

  // Soft-deleted, unlisted, and later-version metadata is cleaned up
  // too — none of it may be left pointing at deleted bytes.
  const metaRecords = await stack.getAttachmentRecords(fileId);

  for (const record of metaRecords) {
    await stack.delete(record.id, { purge: true, ...opts });
  }

  return metaRecords;
}

export async function collectAttachmentGarbage(
  stack: Stack,
  listBlobs: StackAdapter['listBlobs'],
  opts: CollectAttachmentGarbageOptions & ActorOptions,
): Promise<CollectAttachmentGarbageResult> {
  const graceMs = opts.graceMs ?? DEFAULT_GC_GRACE_MS;
  const dryRun = opts.dryRun ?? false;
  const now = Date.now();

  const metaRecords = await queryAllPages((q) => stack.query(q), {
    filter: { baseId: SYSTEM_TYPES.ATTACHMENT, includeDeleted: true, includeUnlisted: true },
  });

  // Newest metadata record's createdAt per fileId, and its size (constant
  // across records sharing a fileId, since content-addressing guarantees
  // identical bytes) — used for the grace check and reclaimedBytes.
  const metaByFile = new Map<string, { newestAt: number; size: number }>();
  for (const record of metaRecords) {
    const content = record.content as AttachmentContent;
    const createdAt = record.createdAt.getTime();
    const existing = metaByFile.get(content.fileId);
    if (!existing || createdAt > existing.newestAt) {
      metaByFile.set(content.fileId, { newestAt: createdAt, size: content.size });
    }
  }

  // Bare-bytes orphans: blobs with zero metadata records, only
  // discoverable if the blob adapter implements listBlobs().
  const blobByFile = new Map<string, { modifiedAt: number; size: number }>();
  if (listBlobs) {
    for (const file of await listBlobs()) {
      blobByFile.set(file.fileId, { modifiedAt: file.modifiedAt.getTime(), size: file.size });
    }
  }

  const candidateFileIds = new Set([...metaByFile.keys(), ...blobByFile.keys()]);

  const deletedFileIds: FileId[] = [];
  let reclaimedBytes = 0;

  for (const fileId of candidateFileIds) {
    if (await isFileReferenced(stack, fileId)) continue;

    const meta = metaByFile.get(fileId);
    const blob = blobByFile.get(fileId);
    const newestAt = meta?.newestAt ?? blob?.modifiedAt;
    if (newestAt !== undefined && now - newestAt < graceMs) continue;

    const size = meta?.size ?? blob?.size ?? 0;

    if (dryRun) {
      deletedFileIds.push(fileId);
      reclaimedBytes += size;
      continue;
    }

    try {
      await stack.deleteAttachment(fileId, { actor: opts.actor });
    } catch (err) {
      // Raced with a new reference, or another sweep/call already removed
      // it — not a sweep failure, just move on to the next candidate.
      if (err instanceof StackConflictError || err instanceof StackNotFoundError) continue;
      throw err;
    }
    deletedFileIds.push(fileId);
    reclaimedBytes += size;
  }

  return { deletedFileIds, reclaimedBytes };
}
