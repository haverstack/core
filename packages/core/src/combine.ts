import type { StackAdapter, StackRecordAdapter, StackBlobAdapter } from './types.js';

/**
 * Compose a StackRecordAdapter and a StackBlobAdapter into a single StackAdapter.
 * Use this when you want different backends for records and blobs, e.g.:
 *
 *   const adapter = combineAdapters({ record: sqliteAdapter, blob: s3Adapter });
 *   const stack = await Stack.create(adapter);
 */
export function combineAdapters(parts: {
  record: StackRecordAdapter;
  blob: StackBlobAdapter;
}): StackAdapter {
  return {
    get capabilities() {
      return parts.record.capabilities;
    },
    get ownerEntityId() {
      return parts.record.ownerEntityId;
    },
    get timezone() {
      return parts.record.timezone;
    },

    createRecord: (r) => parts.record.createRecord(r),
    getRecord: (id) => parts.record.getRecord(id),
    patchContent: (id, patch, opts) => parts.record.patchContent(id, patch, opts),
    deleteRecord: (id, opts) => parts.record.deleteRecord(id, opts),
    undeleteRecord: (id, opts) => parts.record.undeleteRecord(id, opts),
    queryRecords: (q) => parts.record.queryRecords(q),

    associate: (id, assoc, opts) => parts.record.associate(id, assoc, opts),
    dissociate: (id, assoc, opts) => parts.record.dissociate(id, assoc, opts),
    setPermissions: (id, permissions, opts) => parts.record.setPermissions(id, permissions, opts),
    setUnlisted: (id, unlisted, opts) => parts.record.setUnlisted(id, unlisted, opts),

    getVersions: (id) => parts.record.getVersions(id),
    getVersion: (id, v) => parts.record.getVersion(id, v),
    saveVersion: (id, v) => parts.record.saveVersion(id, v),
    restoreVersion: (id, v, opts) => parts.record.restoreVersion(id, v, opts),
    commitMigration: (id, toTypeId, content, opts) =>
      parts.record.commitMigration(id, toTypeId, content, opts),

    saveType: (t) => parts.record.saveType(t),
    getType: (id) => parts.record.getType(id),
    listTypes: () => parts.record.listTypes(),

    // Conditionally spread so an unimplemented optional capability stays
    // absent on the combined adapter, rather than silently becoming
    // "supported" via a wrapper that forwards to a missing method.
    ...(parts.record.deleteUnreferencedAttachmentRecords && {
      deleteUnreferencedAttachmentRecords: (fileId: string, metadataTypeIds: string[]) =>
        parts.record.deleteUnreferencedAttachmentRecords!(fileId, metadataTypeIds),
    }),

    // StackAdapter.putAttachmentWithMetadata is deliberately never
    // synthesized here: glued backends have no shared transaction to honor
    // its atomicity promise (docs/spec/adapters.md § Interface split).
    // Stack.putAttachment() falls back to bytes-then-create().
    putAttachment: (data) => parts.blob.putAttachment(data),
    getAttachment: (id) => parts.blob.getAttachment(id),
    deleteAttachment: (id) => parts.blob.deleteAttachment(id),
    ...(parts.blob.listFiles && {
      listFiles: () => parts.blob.listFiles!(),
    }),

    async flush() {
      await parts.record.flush?.();
      await parts.blob.flush?.();
    },
    async close() {
      await parts.record.close?.();
      await parts.blob.close?.();
    },
  };
}
