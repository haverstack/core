/**
 * The storage adapter interfaces and the per-call options Stack hands them.
 */

import type {
  Association,
  AssociationEdit,
  AuthorityAssociation,
  DataAssociation,
} from './associations.js';
import type { StackCapabilities } from './capabilities.js';
import type { RecordChange, Unsubscribe, SubscribeOptions } from './events.js';
import type { RecordId, TypeId, BaseId, FileId, AppId, EntityId, Actor } from './ids.js';
import type { JournalEntryInput, RecordJournalEntry, JournalQuery } from './journal.js';
import type { StackQuery, QuerySort, QueryResult } from './query.js';
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
 * deleteRecord() adds `purge`.
 */
export type MutateOptions = IfVersionOptions & SnapshotOptions & ActorOptions & JournalOptions;

/**
 * What every write that never bumps `version` takes: the precondition,
 * checked atomically as a bumping write checks it, and the journal entry.
 * No actor: such a write stamps nothing on the record, so its requester
 * travels in the entry. See docs/spec/versioning.md § Version history.
 */
export type AspectWriteOptions = IfVersionOptions & JournalOptions;

/**
 * What the four element-set writes take: `expectSet` is the set `Stack`
 * read and checked its rules against. An adapter compares it with the
 * stored set inside its write and throws ElementSetMovedError on a
 * mismatch, changing nothing. Omitted, the write is unconditional.
 * See docs/spec/adapters.md § Editing associations.
 */
export type ElementWriteOptions<E extends Association> = AspectWriteOptions & {
  expectSet?: readonly E[];
};

/** A named sort as an adapter receives it: `Stack` has resolved its `direction`. */
export type AdapterSort = QuerySort & { direction: 'asc' | 'desc' };

/**
 * A query without `presentAt`, which applies migrations — app code no
 * adapter or server holds — with its defaults still open: what travels
 * on the wire, and what resolveQuery() takes.
 */
export type PlainQuery = Omit<StackQuery, 'presentAt'>;

/**
 * A query as an adapter receives it, from resolveQuery(): every default
 * resolved, so no adapter carries one. See docs/spec/data-model.md
 * § Sorting and pagination.
 */
export type AdapterQuery = Omit<PlainQuery, 'sort' | 'limit'> & {
  sort: AdapterSort;
  limit: number;
};

/**
 * The Records one scoped request may act on with one verb, as data matched
 * rather than rules applied: inside `fence` and inside `within`, where an
 * absent part constrains nothing. See docs/spec/access-control.md § Reach.
 */
export type Reach = {
  /** Only Records in these families are in reach. */
  fence?: BaseId[];
  /** Records meeting one of these are in reach. */
  within?: {
    /** Every Record in these families. */
    types: BaseId[];
    /** Records this subject authored in these families. */
    authored?: { subjectId: EntityId; types: BaseId[] };
    /** Records carrying every element of one of these sets, by association identity. */
    permissions: AuthorityAssociation[][];
  };
};

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
   * Merge a content patch, one level deep, into the content as it stands
   * when the write lands. Bumps `version` and snapshots. Never touches
   * `typeId`; see commitMigration(). See docs/spec/data-model.md § Mutations.
   */
  patchContent(
    id: RecordId,
    patch: Record<string, unknown | null>,
    opts?: MutateOptions,
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
  queryRecords(query: AdapterQuery): Promise<QueryResult>;
  /**
   * queryRecords() over the Records in `reach` alone: the reach is one
   * more condition of the query, so the page, its cursor and whether one
   * comes back are decided among those Records only. Optional — a stack
   * whose adapter lacks it cannot be scoped, as a server-backed one never
   * needs to be. See docs/spec/adapters.md § Querying within a reach.
   */
  queryReadable?(query: AdapterQuery, reach: Reach): Promise<QueryResult>;

  // Aspects that never bump `version`
  //
  // Each writes one aspect, never snapshots, and checks `ifVersion` inside
  // its own write. `Stack` hands an adapter only a write that moves
  // something. See docs/spec/adapters.md § Interface split.
  /** `null` moves the record to the root. */
  setParent(
    id: RecordId,
    parentId: RecordId | null,
    opts?: AspectWriteOptions,
  ): Promise<StackRecord>;
  /** Stamps `unlistedAt` fresh on `true`; clears it on `false`. */
  setUnlisted(id: RecordId, unlisted: boolean, opts?: AspectWriteOptions): Promise<StackRecord>;
  /**
   * Apply adds and removes to the record's data associations as one write.
   * See docs/spec/adapters.md § Editing associations.
   */
  editAssociations(
    id: RecordId,
    edits: AssociationEdit[],
    opts?: ElementWriteOptions<DataAssociation>,
  ): Promise<StackRecord>;
  /** Replace the record's data associations with exactly `associations`. */
  setAssociations(
    id: RecordId,
    associations: DataAssociation[],
    opts?: ElementWriteOptions<DataAssociation>,
  ): Promise<StackRecord>;
  /** editAssociations() over the record's permissions. */
  editAccess(
    id: RecordId,
    edits: AssociationEdit[],
    opts?: ElementWriteOptions<AuthorityAssociation>,
  ): Promise<StackRecord>;
  /** Replace the record's permissions with exactly `permissions`; `[]` is private. */
  setAccess(
    id: RecordId,
    permissions: AuthorityAssociation[],
    opts?: ElementWriteOptions<AuthorityAssociation>,
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
   * Stack.commitMigration() and Stack.migrateAll(); patchContent() never
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
   * The metadata records are those in the `metadataBaseId` family, matched
   * as `filter.baseId` matches one. See docs/spec/attachments.md § Deleting
   * attachments.
   */
  deleteUnreferencedAttachmentRecords?(
    fileId: FileId,
    metadataBaseId: BaseId,
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
