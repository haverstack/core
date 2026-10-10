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
  RecordChangeSet,
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
import type {
  ContentOf,
  Migration,
  PatchOf,
  ReadonlyTypeSchema,
  TypedChange,
  TypedChangeSet,
  TypedQuery,
  TypedRecord,
  TypedSubscribeOptions,
  TypeHandle,
} from '../type-handle.js';

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
 * What a delete reports back. Information, not action: a purge never
 * touches the blob store, and nothing here is deleted by having been
 * named. See docs/spec/attachments.md § A purge strands the bytes it
 * referenced.
 */
export type DeleteResult = {
  /**
   * The files the purged record referenced — its attachment associations
   * and its `file-ref` content fields, deduplicated. The purge removes the
   * only rows naming them, so this is the caller's one chance to hold the
   * argument `deleteAttachment()` takes. Empty on a soft delete, which
   * strands nothing: a tombstone's references stand.
   */
  referencedFileIds: FileId[];
};

/**
 * What deleteAndReturn() reports back — DeleteResult plus the record itself,
 * captured inside the same atomic operation as the destroy rather than a
 * read beforehand. See Stack.deleteAndReturn().
 */
export type DeleteAndReturnResult = DeleteResult & {
  /**
   * The record as it stood at the moment of deletion: immediately before
   * destruction for a purge, or the resulting tombstone for a soft
   * delete. Null only for the purge no-op — there was nothing to
   * delete, and nothing to report; every other outcome throws instead of
   * returning null (see Stack.delete()'s own no-op cases).
   */
  record: StackRecord | null;
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
  create<S extends ReadonlyTypeSchema>(
    handle: TypeHandle<S>,
    content: ContentOf<S>,
    opts?: CreateRecordOptions,
  ): Promise<TypedRecord<S>>;
  create<T extends Record<string, unknown> = Record<string, unknown>>(
    typeId: TypeId,
    content: T,
    opts?: CreateRecordOptions,
  ): Promise<StackRecord & { content: T }>;
  /**
   * Typed read: the record at `presentAt: 'latest'`, checked to be exactly
   * the handle's Type, else it throws. An enum field may hold a value the
   * handle does not list. Live records only — a tombstone reads as `null`,
   * and there is no `includeDeleted`.
   * See docs/spec/data-model.md § Type handles.
   */
  get<S extends ReadonlyTypeSchema>(
    handle: TypeHandle<S>,
    id: RecordId,
  ): Promise<TypedRecord<S> | null>;
  get(id: RecordId, opts?: GetRecordOptions): Promise<StackRecord | null>;
  /** Typed read of the handle's whole family — see the typed `get()`. */
  query<S extends ReadonlyTypeSchema>(
    handle: TypeHandle<S>,
    query?: TypedQuery,
  ): Promise<{ records: TypedRecord<S>[]; cursor: string | null }>;
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
   * Apply a change set — any of `contentPatch`, `parentId`, `permissions`,
   * `associations` and `unlisted` — as one atomic write, versioned only when
   * it names `contentPatch`. Keys are read for presence; under ScopedStack
   * one refused key refuses the call. See docs/spec/data-model.md § Mutations.
   */
  mutate<S extends ReadonlyTypeSchema>(
    handle: TypeHandle<S>,
    id: RecordId,
    changes: TypedChangeSet<S>,
    opts?: IfVersionOptions,
  ): Promise<TypedRecord<S>>;
  mutate(id: RecordId, changes: RecordChangeSet, opts?: IfVersionOptions): Promise<StackRecord>;
  /** mutate() with `contentPatch` alone — the common case, named for it. */
  patchContent<S extends ReadonlyTypeSchema>(
    handle: TypeHandle<S>,
    id: RecordId,
    patch: PatchOf<S>,
    opts?: IfVersionOptions,
  ): Promise<TypedRecord<S>>;
  patchContent(
    id: RecordId,
    patch: Record<string, unknown | null>,
    opts?: IfVersionOptions,
  ): Promise<StackRecord>;
  /**
   * Add associations in one atomic write and one journal entry. Never bumps
   * `version`/`updatedAt` and takes no `ifVersion` — a set-add composes
   * regardless of write order. See docs/spec/data-model.md § Mutations and
   * docs/spec/versioning.md § Version history.
   */
  associate(id: RecordId, associations: DataAssociation[]): Promise<StackRecord>;
  /** Remove associations, matched by identity — see associate(). */
  dissociate(id: RecordId, associations: DataAssociation[]): Promise<StackRecord>;
  /**
   * Apply a list of adds and removes to a record's data associations as one
   * atomic write — the cover swap. associate() and dissociate() are this with
   * one half each; `mutate({ associations })` is the only whole-set write.
   * `repoint` is not a request: an add naming an attachment the record
   * already holds re-points it. See docs/spec/data-model.md § Mutations.
   */
  amendAssociations(id: RecordId, changes: AssociationEdit[]): Promise<StackRecord>;
  /**
   * Extend who reaches a record — the record-level mirror of the type-level
   * `grantType()`, and the amending spelling of the `permissions` key, which
   * replaces the whole set. `write` never implies `read`: grant both,
   * `grantAccess(id, [read, write])`. No-bump, like associate().
   * See docs/spec/access-control.md § Write implies read.
   */
  grantAccess(id: RecordId, permissions: AuthorityAssociation[]): Promise<StackRecord>;
  /** Withdraw elements of who reaches a record — see grantAccess(). */
  revokeAccess(id: RecordId, permissions: AuthorityAssociation[]): Promise<StackRecord>;
  /**
   * amendAssociations() for permissions: adds and removes in one atomic
   * write, so a downgrade (remove `write`, keep `read`) is one change.
   * See docs/spec/access-control.md § Record-level permissions.
   */
  amendAccess(id: RecordId, changes: AssociationEdit[]): Promise<StackRecord>;
  delete(id: RecordId, opts?: DeleteRecordOptions): Promise<DeleteResult>;
  /**
   * delete(), plus the record it acted on — read and destroyed as one
   * atomic operation, so a caller that needs the record for its own
   * response (e.g. a server building a purge's body) never opens a
   * gap between reading it and destroying it. See Stack.deleteAndReturn().
   */
  deleteAndReturn(id: RecordId, opts?: DeleteRecordOptions): Promise<DeleteAndReturnResult>;
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
  /**
   * Typed subscription: delivers only changes to records of exactly the
   * handle's Type, each `record` typed as its content. See
   * docs/spec/data-model.md § Type handles.
   */
  subscribe<S extends ReadonlyTypeSchema>(
    handle: TypeHandle<S>,
    handler: (change: TypedChange<S>) => void,
    opts?: TypedSubscribeOptions,
  ): Promise<Unsubscribe>;
  subscribe(handler: (change: RecordChange) => void, opts?: SubscribeOptions): Promise<Unsubscribe>;
}
