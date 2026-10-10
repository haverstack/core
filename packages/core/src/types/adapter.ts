/**
 * The storage adapter interfaces and the per-call options Stack hands them.
 */

import type { AssociationEdit, RecordChangeSet } from './associations.js';
import type { StackCapabilities } from './capabilities.js';
import type { RecordChange, Unsubscribe, SubscribeOptions } from './events.js';
import type { RecordId, TypeId, FileId, AppId, EntityId, Actor } from './ids.js';
import type { JournalEntryInput, RecordJournalEntry, JournalQuery } from './journal.js';
import type { StackQuery, QueryResult } from './query.js';
import type { StackRecord, RecordVersion, VersionsQuery } from './records.js';
import type { StackType } from './schema.js';

/**
 * Opt-in optimistic-concurrency precondition. On mismatch the mutation
 * throws StackVersionConflictError and changes nothing; an adapter checks
 * it atomically inside its write. See docs/spec/versioning.md § Optimistic
 * concurrency (`ifVersion`).
 */
export type IfVersionOptions = {
  ifVersion?: number;
};

/**
 * Accepted by every mutating StackRecordAdapter method. The adapter
 * persists this prior-state snapshot as part of the SAME atomic write as
 * the mutation, so a crash between the two can't leave an orphan versions
 * row. Server-backed adapters (already atomic per-request) can ignore it.
 */
export type SnapshotOptions = {
  snapshot?: RecordVersion;
};

/**
 * Whether a mutateRecord() call advances `version`/`updatedAt`. `Stack`
 * computes it from what the change set moves; absent means `true`.
 * See docs/spec/versioning.md § Version history.
 */
export type BumpVersionOptions = {
  bumpsVersion?: boolean;
};

/**
 * Who is performing a mutation, stamped onto the record in the same write.
 * `ScopedStack` supplies it from the request's identities; a caller of
 * plain `Stack` supplies it only when reconstructing an attributed write.
 * See docs/spec/data-model.md § Authorship and attribution.
 */
export type ActorOptions = {
  actor?: Actor;
};

/**
 * Accepted by every mutating StackRecordAdapter method. The adapter
 * appends the entry, allocating its `seq`, inside the SAME write as the
 * mutation, so a crash cannot leave a change unjournaled.
 */
export type JournalOptions = {
  journal?: JournalEntryInput;
};

/**
 * What every mutating StackRecordAdapter method that bumps `version` takes.
 * mutateRecord() adds BumpVersionOptions and deleteRecord() adds `purge`.
 */
export type MutateOptions = IfVersionOptions & SnapshotOptions & ActorOptions & JournalOptions;

/** The metadata an upload's `_attachment@1` record carries beside its bytes. */
export type PutAttachmentOptions = {
  mimeType: string;
  filename?: string;
  /** Attribution for the metadata record, as create()'s `appId`. */
  appId?: AppId;
};

/**
 * The record-storage half of an adapter: structured data, queries,
 * associations, versioning, type definitions, and stack identity.
 */
export interface StackRecordAdapter {
  readonly capabilities: StackCapabilities;

  /** DID of the stack owner. Set during adapter initialization. */
  readonly ownerEntityId: EntityId;
  /**
   * IANA timezone string for this stack, or undefined if never set.
   * Passthrough app metadata with no default — see docs/spec.md § The
   * `_config` record.
   */
  readonly timezone: string | undefined;

  // Records
  /**
   * Throws StackConflictError if `record.id` already exists — never a
   * silent overwrite. The check must be atomic with the write (a PK/unique
   * constraint or equivalent); Stack itself doesn't pre-check, so a raw
   * adapter that skips this enforces nothing.
   */
  createRecord(record: StackRecord, opts?: JournalOptions): Promise<StackRecord>;
  getRecord(id: RecordId): Promise<StackRecord | null>;
  /**
   * Apply a change set in one write — the only multi-aspect atomic write a
   * record has, so a publish cannot half-land. Never touches `typeId`; see
   * commitMigration(). `Stack` validates it and computes `bumpsVersion`,
   * and never hands an adapter a change set that changes nothing.
   * See docs/spec/data-model.md § Mutations.
   */
  mutateRecord(
    id: RecordId,
    changes: RecordChangeSet,
    opts?: MutateOptions & BumpVersionOptions,
  ): Promise<StackRecord>;
  /**
   * Returns the record this call acted on: as it now stands after a soft
   * delete, and as it stood immediately before destruction after a
   * purge — captured inside the same write, so nothing can observe or alter
   * it in between. Null when there was no record to delete, which is the
   * only case that mutates nothing.
   */
  deleteRecord(
    id: RecordId,
    opts?: { purge?: boolean } & MutateOptions,
  ): Promise<StackRecord | null>;
  /** Reverse a soft delete. Returns the record as it now stands. */
  undeleteRecord(id: RecordId, opts?: MutateOptions): Promise<StackRecord>;
  /**
   * `query.sort`, when present, always carries a `direction`: `Stack`
   * resolves the defaults before any adapter sees the query.
   */
  queryRecords(query: StackQuery): Promise<QueryResult>;

  // Associations
  /**
   * Apply a list of adds and removes as one write, all or none, removes
   * before adds. Never bumps `version`/`updatedAt` and never snapshots — a
   * set-add composes regardless of write order. A list mixing authority
   * and data elements is refused.
   * See docs/spec/adapters.md § Amending associations.
   */
  amendAssociations(
    id: RecordId,
    changes: AssociationEdit[],
    opts?: JournalOptions,
  ): Promise<StackRecord>;

  // Versions
  /**
   * Snapshots newest first; omitting `query` reads every version.
   * See docs/spec/versioning.md § Version history.
   */
  getVersions(id: RecordId, query?: VersionsQuery): Promise<RecordVersion[]>;
  getVersion(id: RecordId, version: number): Promise<RecordVersion | null>;
  /**
   * Standalone snapshot write, outside of a mutation's own atomic path.
   * Mutating methods above take a `snapshot` option instead, so the
   * snapshot and the mutation land in one write — see SnapshotOptions.
   */
  saveVersion(id: RecordId, version: RecordVersion): Promise<void>;

  /**
   * Read a record's change journal, oldest first — required, on the same
   * footing as getVersions(). A recovery mechanism an app cannot rely on is
   * most of the way to no mechanism at all, so an adapter with no journal
   * refuses the call rather than declining to have the method.
   * See docs/spec/journal.md § Reading it.
   */
  getJournal(id: RecordId, query?: JournalQuery): Promise<RecordJournalEntry[]>;
  /**
   * Restore a record to a previous version's `content` and `typeId` —
   * everything a snapshot carries. Containment, listing and associations
   * are left where they stand, there being nothing to restore them *from*.
   * Bumps version internally; throws StackNotFoundError if the version
   * doesn't exist.
   */
  restoreVersion(id: RecordId, version: number, opts?: MutateOptions): Promise<StackRecord>;

  /**
   * Commit a migration: write new content under a new typeId in one step.
   * This is the only way a record's typeId changes after creation — used by
   * Stack.commitMigration() and Stack.migrateAll(); Stack.mutate() never
   * changes typeId as a side effect. Bumps version internally.
   */
  commitMigration(
    id: RecordId,
    toTypeId: TypeId,
    content: Record<string, unknown>,
    opts?: MutateOptions,
  ): Promise<StackRecord>;

  // Types
  saveType(type: StackType): Promise<void>;
  getType(id: TypeId): Promise<StackType | null>;
  listTypes(): Promise<StackType[]>;

  /**
   * Atomically verify fileId is unreferenced and purge its metadata
   * records, returning them; StackConflictError if still referenced.
   * Optional — Stack.deleteAttachment() has a non-atomic fallback.
   * `metadataTypeIds` is the resolved `_attachment` family, so an adapter
   * needs no baseId concept. See docs/spec/attachments.md § Deleting attachments.
   */
  deleteUnreferencedAttachmentRecords?(
    fileId: FileId,
    metadataTypeIds: TypeId[],
  ): Promise<StackRecord[]>;

  /**
   * Relay changes that originated elsewhere — the inverse direction from
   * `Stack`, which emits every change made through it. Optional, and
   * absent on every local adapter: exactly one process owns a stack's
   * storage, so locally there is no third party whose writes could have
   * been missed. See docs/spec/events.md § Where events come from.
   */
  subscribeChanges?(
    opts: SubscribeOptions,
    handler: (change: RecordChange) => void,
  ): Promise<Unsubscribe>;

  // Lifecycle
  flush?(): Promise<void>;
  close?(): Promise<void>;
}

/** One stored blob, as reported by StackBlobAdapter.listBlobs(). */
export type BlobInfo = {
  fileId: FileId;
  size: number;
  /** When the blob was written. Used to apply a GC grace period to fresh, not-yet-associated uploads. */
  modifiedAt: Date;
};

/**
 * The blob-storage half of an adapter. Handles raw binary data only;
 * attachment metadata lives on _attachment@1 records in the record adapter.
 */
export interface StackBlobAdapter {
  // Bytes only — "attachment" is the record-backed concept at the Stack layer
  putBlob(data: Uint8Array): Promise<FileId>;
  /**
   * Returns a plain `Uint8Array` (never a subclass such as `Buffer`) that the
   * caller owns: changing it never changes the stored bytes.
   */
  getBlob(fileId: FileId): Promise<Uint8Array>;
  deleteBlob(fileId: FileId): Promise<void>;

  /**
   * Enumerate every blob currently in storage. Optional — without it,
   * garbage collection can't find bare-bytes orphans (bytes with no
   * metadata record at all). See docs/spec/attachments.md § Garbage
   * collection.
   */
  listBlobs?(): Promise<BlobInfo[]>;

  // Lifecycle
  flush?(): Promise<void>;
  close?(): Promise<void>;
}

/**
 * A complete adapter: record storage and blob storage combined.
 * Pass this to Stack.open(). Build one with combineAdapters() when you
 * want different backends for records and blobs (e.g. SQLite + S3).
 */
export type StackAdapter = StackRecordAdapter &
  StackBlobAdapter & {
    /**
     * Store bytes and create the accompanying _attachment@1 record as one
     * atomic operation. Optional; implement only when bytes and records
     * live behind a single boundary (today: APIAdapter alone), and never
     * synthesized by combineAdapters(). A security boundary, not an
     * efficiency shortcut — see docs/spec/adapters.md § Interface split.
     */
    putAttachmentWithMetadata?(data: Uint8Array, opts: PutAttachmentOptions): Promise<StackRecord>;
  };
