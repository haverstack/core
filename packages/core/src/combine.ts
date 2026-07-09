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
    updateRecord: (id, changes) => parts.record.updateRecord(id, changes),
    deleteRecord: (id, opts) => parts.record.deleteRecord(id, opts),
    undeleteRecord: (id) => parts.record.undeleteRecord(id),
    queryRecords: (q) => parts.record.queryRecords(q),

    associate: (id, assoc) => parts.record.associate(id, assoc),
    dissociate: (id, assoc) => parts.record.dissociate(id, assoc),

    getVersions: (id) => parts.record.getVersions(id),
    getVersion: (id, v) => parts.record.getVersion(id, v),
    saveVersion: (id, v) => parts.record.saveVersion(id, v),

    saveType: (t) => parts.record.saveType(t),
    getType: (id) => parts.record.getType(id),
    listTypes: () => parts.record.listTypes(),

    putAttachment: (data) => parts.blob.putAttachment(data),
    getAttachment: (id) => parts.blob.getAttachment(id),
    deleteAttachment: (id) => parts.blob.deleteAttachment(id),

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
