/**
 * Attachment helpers
 * -------------------------------------------------------
 * The content an upload's `_attachment@1` record is written with, shared by
 * Stack.putAttachment() and ScopedStack.putAttachment(); which of a
 * fileId's metadata records answers for it, shared with servers through
 * `@haverstack/core/wire`; and the cleanup half — deleting unreferenced
 * metadata on an adapter with no atomic way to do it, and the garbage
 * sweep that finds what is unreferenced. The cleanup runs over an unscoped Stack's public API; Stack.deleteAttachment()
 * and collectAttachmentGarbage() carry the contract. See
 * docs/spec/attachments.md § Deleting attachments.
 */

import { StackConflictError, StackNotFoundError } from '../errors.js';
import { queryAllPages } from './reads.js';
import { SYSTEM_TYPES } from '../types/index.js';
import type {
  ActorOptions,
  AttachmentContent,
  FileId,
  PutAttachmentOptions,
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

/** The `_attachment@1` content describing bytes just stored as `fileId`. */
export function uploadContent(
  fileId: FileId,
  data: Uint8Array,
  { mimeType, filename }: PutAttachmentOptions,
): AttachmentContent {
  return { fileId, mimeType, size: data.byteLength, ...(filename && { filename }) };
}

/**
 * Which `_attachment@1` record establishes a fileId's mimeType — the
 * "first-recorded" rule of docs/spec/attachments.md, as a total order:
 * earliest `createdAt`, ties broken by the lower `id`.
 *
 * The tiebreak is what makes it a rule rather than a coincidence of scan
 * order. Rejecting a conflicting mimeType at write time is check-then-act
 * with no storage-level uniqueness behind it, so two racing first uploads
 * of the same bytes can both land on a concurrent server. Determinism
 * doesn't depend on that never happening — it depends on every reader
 * ordering the records the same way, which is why core's write-time
 * conflict check and a server's serving choice both come through here.
 *
 * Generic over the record shape so a server can pass its own row type.
 * Records for other fileIds must be filtered out by the caller.
 */
export function firstRecordedAttachment<T extends { id: string; createdAt: Date }>(
  records: readonly T[],
): T | undefined {
  return records.reduce<T | undefined>(
    (first, record) => (!first || compareRecordedAttachments(record, first) < 0 ? record : first),
    undefined,
  );
}

/**
 * The same total order as a comparator, for a caller handing back the whole
 * candidate set rather than the winner — sorted this way, the winner is
 * element zero. Package-internal: `core/wire` re-exports the selection,
 * since the ordering is only useful to something that already has every
 * record.
 */
export function compareRecordedAttachments<T extends { id: string; createdAt: Date }>(
  a: T,
  b: T,
): number {
  const delta = a.createdAt.getTime() - b.createdAt.getTime();
  if (delta !== 0) return delta;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Which `_attachment` record describes a *reference* to a fileId, as
 * opposed to the fileId itself: the association's own
 * `attachmentRecordId`, else the requester's own upload, else the
 * first-recorded record. Where `filename` comes from on a download when
 * `?filename` is not given, and the name a consumer shows for an
 * attachment association. See docs/spec/attachments.md § Naming the upload
 * a reference came from.
 *
 * Every step falls back rather than failing: a pointer at a record that is
 * gone, or at nothing this caller collected, lands on the same answer a
 * reference with no pointer at all gets.
 *
 * Generic over the record shape, like firstRecordedAttachment(), so a
 * server can pass its own row type. Records for other fileIds must be
 * filtered out by the caller.
 */
export function resolveReferencedAttachment<
  T extends { id: string; createdAt: Date; createdBy?: { subjectId: string } },
>(
  records: readonly T[],
  opts: { attachmentRecordId?: string; requesterEntityId?: string } = {},
): T | undefined {
  if (opts.attachmentRecordId) {
    const named = records.find((record) => record.id === opts.attachmentRecordId);
    if (named) return named;
  }
  if (opts.requesterEntityId) {
    const own = records.filter((record) => record.createdBy?.subjectId === opts.requesterEntityId);
    if (own.length > 0) return firstRecordedAttachment(own);
  }
  return firstRecordedAttachment(records);
}

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
