/**
 * Attachment metadata records
 * -------------------------------------------------------
 * Which of a fileId's `_attachment` records answers for it: the one that
 * establishes its mimeType, and the one a given reference names. Pure and
 * generic over the record shape, so `Stack` and a server's own rows reach
 * the same answer — `@haverstack/core/wire` exports the selections, and
 * this module imports nothing so that entry point stays light.
 */

/**
 * Which `_attachment@1` record establishes a fileId's mimeType: earliest
 * `createdAt`, ties to the lower `id`. Two racing first uploads can both
 * land, so determinism rests on core's conflict check and every server
 * ordering through here. The caller filters to one fileId.
 * See docs/spec/attachments.md § Finding a `fileId`'s metadata records.
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
 * element zero. Package-internal: `core/wire` exports the selection,
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
 * Which `_attachment` record a *reference* to a fileId names: its
 * `attachmentRecordId`, else the requester's own upload, else the
 * first-recorded — each step falling back rather than failing.
 * See docs/spec/attachments.md § Naming the upload a reference came from.
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
