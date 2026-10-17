/**
 * StackClient and the option types around it
 * -------------------------------------------------------
 * The app-facing record API that both `Stack` and `ScopedStack` implement,
 * with the option and result shapes its verbs take. Shapes only: the
 * behaviour behind them lives in stack.ts and scoped-stack.ts.
 */

import type {
  Actor,
  AppId,
  AssociationEdit,
  AttachmentContent,
  AuthorityAssociation,
  DataAssociation,
  EntityId,
  FileId,
  IfVersionOptions,
  JournalQuery,
  PutAttachmentOptions,
  QueryResult,
  RecordChange,
  RecordId,
  RecordJournalEntry,
  RecordVersion,
  StackCapabilities,
  StackQuery,
  StackRecord,
  SubscribeOptions,
  TypeId,
  Unsubscribe,
  VersionsQuery,
} from '../types/index.js';
import type { ContentOf, Migration, ReadonlyTypeSchema, TypeHandle } from '../type-handle.js';
import type { Collection } from '../collection.js';

export type CreateRecordOptions = {
  /**
   * Client-minted record ID. Must be 12 lowercase Crockford base-32
   * characters and may not use the reserved `_` prefix. Omit to let the
   * library generate one. See Stack.create() and ScopedStack.create()
   * for the validation each applies.
   */
  id?: RecordId;
  parentId?: RecordId;
  /**
   * The author. ScopedStack sets this from its own identities; callers of
   * plain Stack supply it only when reconstructing an attributed write.
   * See StackRecord.createdBy.
   */
  createdBy?: Actor;
  /** Reverse-DNS identifier of the writing software — see AppId. */
  appId?: AppId;
  permissions?: AuthorityAssociation[];
  associations?: DataAssociation[];
  /**
   * Create the record already unlisted, so the create event itself is
   * withheld from the feed — there is no window where the record exists
   * and is listed before a mutation catches up. See
   * docs/spec/unlisted.md.
   */
  unlisted?: boolean;
};
/**
 * CreateRecordOptions plus createdAt/updatedAt, for backdating on import.
 * ScopedStack.create() takes them only from the owner acting alone: anyone
 * else could forge a sort position with them, as with a raw `id`.
 * See docs/spec/data-model.md § Backdating on import.
 */
export type BackdatableCreateRecordOptions = CreateRecordOptions & {
  /**
   * The record's creation time. When `id` is also supplied, its embedded
   * timestamp must agree with this within `idTimestampSkewMs` (default 24h;
   * see StackOptions.idTimestampSkewMs) or the create throws
   * StackValidationError. Omit `id` to have it derived from this timestamp
   * instead. Defaults to now.
   */
  createdAt?: Date;
  /**
   * The record's last-modified time. Defaults to `createdAt` (or now, if
   * `createdAt` is omitted too) — never to the actual current time — so a
   * plain import doesn't fabricate a fake edit. Must not precede
   * `createdAt`.
   */
  updatedAt?: Date;
};

export type StackOptions = {
  /**
   * Ensures the owner's own `_entity` profile record exists, creating it on
   * first run. Idempotent — safe to pass on every open. See
   * docs/spec/identity.md § Entity.
   */
  ownerProfile?: { name: string; handle?: string };
  /**
   * Clock-skew tolerance (ms) between a client-supplied `id`'s timestamp
   * and the current time (a live scoped create) or an explicit `createdAt`
   * (a backdated one). Default: 24 hours; null disables both checks.
   * See docs/spec/data-model.md § Record IDs.
   */
  idTimestampSkewMs?: number | null;
  /**
   * Every migration this app knows, built with `migration()`. The chain is
   * complete before the first read, and one that cannot be walked — two
   * steps from one TypeId, or a cycle — is refused here. See
   * docs/spec/data-model.md § Type migrations.
   */
  migrations?: readonly Migration[];
};

export type CollectAttachmentGarbageOptions = {
  /**
   * How recent an unreferenced file must be to survive collection, covering
   * the upload-then-associate window. Default: 24 hours. Pass 0 to collect
   * anything unreferenced right now.
   */
  graceMs?: number;
  /** Compute what would be deleted without deleting anything. Default: false. */
  dryRun?: boolean;
};

export type CollectAttachmentGarbageResult = {
  /** The files collected — or, on a dry run, the ones that would be. */
  deletedFileIds: FileId[];
  reclaimedBytes: number;
};

export type GetRecordOptions = {
  /**
   * Records are returned exactly as stored by default. Pass "latest" to
   * apply the registered migration chain in memory — never written back.
   * See docs/spec/data-model.md § Type migrations.
   */
  presentAt?: 'stored' | 'latest';
  /**
   * Soft-deleted records are hidden by default, as query() hides them: a
   * tombstone reads as `null`. Pass true to read it back.
   * See docs/spec/versioning.md § Deletion.
   */
  includeDeleted?: boolean;
};

export type DeleteRecordOptions = IfVersionOptions & {
  /** If true, permanently remove the record and all its history. Default: false */
  purge?: boolean;
};

/**
 * What a delete reports back. The record is captured inside the same
 * atomic write as the delete, never read beforehand. `referencedFileIds`
 * is information, not action: a purge never touches the blob store. See
 * docs/spec/attachments.md § A purge strands the bytes it referenced.
 */
export type DeleteResult = {
  /**
   * The record as a soft delete left it — under ScopedStack, presented as
   * its tombstone — or as it stood immediately before destruction for a
   * purge, and `null` when there was nothing at `id` to purge.
   * See docs/spec/versioning.md § The tombstone is literal.
   */
  record: StackRecord | null;
  /**
   * The files the purged record referenced — its attachment associations
   * and its `file-ref` content fields, deduplicated. The purge removes the
   * only rows naming them, so this is the caller's one chance to hold the
   * argument `deleteAttachment()` takes. Empty on a soft delete, which
   * strands nothing: a tombstone's references stand.
   */
  referencedFileIds: FileId[];
};

/** Options for Stack.migrateAll(). */
export type MigrateAllOptions = {
  /**
   * `'all'` (the default) sweeps every record of the family, deleted and
   * unlisted included. `'listed'` sweeps only what a non-owner can
   * enumerate and read whole. See docs/spec/apps.md § Migrating an
   * installed app's types.
   */
  sweep?: 'all' | 'listed';
};

/** The argument to Stack.defineType(). */
export type DefineTypeOptions = {
  id: TypeId;
  name: string;
  /** A handle's `schema` is accepted as written, readonly members and all. */
  schema: ReadonlyTypeSchema;
  migratesFrom?: TypeId;
};

// -------------------------------------------------------
// StackClient interface
// -------------------------------------------------------

/**
 * The app-facing record API, implemented by both Stack and ScopedStack.
 * Accept this type in plugin or extension code to remain adapter-agnostic
 * and work equally well with a full Stack or a permission-scoped view.
 */
export interface StackClient {
  readonly capabilities: StackCapabilities;
  /**
   * Typed access to `handle`'s whole family, every record migrated in
   * memory to the handle's version. Throws `StackMigrationError` when the
   * handle's `migratesFrom` has no migration passed to `Stack.open()`.
   * See docs/spec/data-model.md § Type handles.
   */
  collection<S extends ReadonlyTypeSchema>(handle: TypeHandle<S>): Collection<ContentOf<S>>;
  create<T extends Record<string, unknown> = Record<string, unknown>>(
    typeId: TypeId,
    content: T,
    opts?: CreateRecordOptions,
  ): Promise<StackRecord & { content: T }>;
  get(id: RecordId, opts?: GetRecordOptions): Promise<StackRecord | null>;
  query(query?: StackQuery): Promise<QueryResult>;
  /**
   * Resolve a DID to its `_entity` card — family-wide and soft-deleted
   * inclusive, per docs/spec/identity.md § DID bindings. No caching.
   *
   * Under `ScopedStack`, `null` covers missing, unreadable, and (unless the
   * owner is acting alone) unlisted — never evidence the card is absent.
   */
  getEntityByDid(did: EntityId): Promise<StackRecord | null>;
  /** getEntityByDid() for the one DID every stack reserves: its own owner. */
  getOwnerEntity(): Promise<StackRecord | null>;
  /**
   * Merge a patch into a record's content, one level deep (`null` removes a
   * key). The only content edit, and the one write besides the lifecycle
   * verbs that bumps `version`. See docs/spec/data-model.md § Mutations.
   */
  patchContent(
    id: RecordId,
    patch: Record<string, unknown | null>,
    opts?: IfVersionOptions,
  ): Promise<StackRecord>;
  /**
   * Move a record under `parentId`, or to the root with `null`. See
   * docs/spec/data-model.md § Reparenting.
   */
  setParent(id: RecordId, parentId: RecordId | null, opts?: IfVersionOptions): Promise<StackRecord>;
  /** Withhold a record from enumeration, or restore it. See docs/spec/unlisted.md. */
  setUnlisted(id: RecordId, unlisted: boolean, opts?: IfVersionOptions): Promise<StackRecord>;
  /**
   * Apply adds and removes to a record's data associations as one write,
   * changing only what the list names. An add naming an attachment the
   * record already holds re-points it. See docs/spec/data-model.md § Mutations.
   */
  editAssociations(
    id: RecordId,
    edits: AssociationEdit[],
    opts?: IfVersionOptions,
  ): Promise<StackRecord>;
  /** Make a record's data associations exactly `associations`. */
  setAssociations(
    id: RecordId,
    associations: DataAssociation[],
    opts?: IfVersionOptions,
  ): Promise<StackRecord>;
  /**
   * editAssociations() for who reaches a record, so a downgrade (remove
   * `write`, keep `read`) is one change. `write` never implies `read`:
   * grant both. See docs/spec/access-control.md § Record-level permissions.
   */
  editAccess(id: RecordId, edits: AssociationEdit[], opts?: IfVersionOptions): Promise<StackRecord>;
  /** Make who reaches a record exactly `permissions`; `[]` is private. */
  setAccess(
    id: RecordId,
    permissions: AuthorityAssociation[],
    opts?: IfVersionOptions,
  ): Promise<StackRecord>;
  /**
   * Soft-delete a record, or purge it with its history, reporting the
   * record it acted on. See docs/spec/versioning.md § Deletion.
   */
  delete(id: RecordId, opts?: DeleteRecordOptions): Promise<DeleteResult>;
  undelete(id: RecordId, opts?: IfVersionOptions): Promise<StackRecord>;
  getVersions(id: RecordId, query?: VersionsQuery): Promise<RecordVersion[]>;
  getVersion(id: RecordId, version: number): Promise<RecordVersion | null>;
  restoreVersion(id: RecordId, version: number, opts?: IfVersionOptions): Promise<StackRecord>;
  /**
   * A record's change journal, oldest first, gated like getVersions().
   * Required of every adapter, so an empty log always means "nothing
   * changed". See docs/spec/journal.md § Reading it.
   */
  getJournal(id: RecordId, query?: JournalQuery): Promise<RecordJournalEntry[]>;
  /**
   * Commit a per-record migration: `typeId` and `content` together,
   * validated against `toTypeId`'s schema — the only way a record's typeId
   * changes after creation. See docs/spec/wire-format.md § Migration commit.
   */
  commitMigration(
    id: RecordId,
    toTypeId: TypeId,
    content: Record<string, unknown>,
    opts?: IfVersionOptions,
  ): Promise<StackRecord>;
  getAttachment(fileId: FileId): Promise<Uint8Array>;
  putAttachment(
    data: Uint8Array,
    opts: PutAttachmentOptions,
  ): Promise<StackRecord & { content: AttachmentContent }>;
  deleteAttachment(fileId: FileId): Promise<void>;
  collectAttachmentGarbage(
    opts?: CollectAttachmentGarbageOptions,
  ): Promise<CollectAttachmentGarbageResult>;
  subscribe(handler: (change: RecordChange) => void, opts?: SubscribeOptions): Promise<Unsubscribe>;
}
