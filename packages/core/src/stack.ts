/**
 * Stack — Core Stack Class
 * -------------------------------------------------------
 * The Stack class is the primary interface for apps. It sits
 * on top of a StackAdapter and adds:
 *
 *  - ID generation
 *  - Type definition and schema hashing
 *  - Content validation on write
 *  - Migration registry and explicit, owner-driven migrateAll()
 *  - Version snapshotting on update
 *  - Soft delete and purge
 *
 * Apps should never talk to a StackAdapter directly.
 */

import { generateId, generateIdForTimestamp } from './id.js';
import {
  hashSchema,
  isCompatible,
  parseTypeId,
  baseIdOf,
  diffSchemas,
  isWellFormedTypeId,
} from './schema.js';
import {
  validateContent,
  validateContentKeys,
  validatePatchValues,
  validateReservedKeys,
  validateSchemaFieldNames,
  validateSchemaReservedNames,
  validateSchemaShape,
} from './validate.js';
import { applyMergePatch } from './merge.js';
import { hasGroupAdmin, isGroupAdminAssociation, validatePermissions } from './access.js';
import { compareRecordedAttachments } from './attachment-download.js';
import { ChangeEmitter, RelayDelivery, PendingChange, assertSinceUsable } from './changes.js';
import { SYSTEM_TYPES } from './types.js';
import type { ValidationError } from './validate.js';
import type {
  StackRecord,
  StackType,
  TypeSchema,
  TypeId,
  BaseId,
  StackAdapter,
  StackQuery,
  RecordFilter,
  QueryResult,
  Association,
  AuthorityAssociation,
  DataAssociation,
  Migration,
  MigrationFn,
  RecordVersion,
  StackCapabilities,
  IfVersionOptions,
  GrantAction,
  GrantContent,
  TypeGrant,
  PutAttachmentOptions,
  GroupRole,
  AttachmentContent,
  FileId,
  ConfigContent,
  EntityId,
  EntityContent,
  AppId,
  RecordId,
  Actor,
  ActorOptions,
  ChangeActor,
  RecordChange,
  RecordChangeSet,
  SubscribeOptions,
  Unsubscribe,
  JournalQuery,
  RecordJournalEntry,
} from './types.js';

import {
  UseAfterCloseError,
  InvalidAdapterError,
  StackConflictError,
  StackMigrationError,
  StackNotFoundError,
  StackBadRequestError,
  StackSchemaDriftError,
  StackValidationError,
  StackVersionConflictError,
} from './errors.js';
import {
  assertQueryCapabilities,
  assertSortCapability,
  assertValidAssociationFilters,
  assertValidJournalQuery,
  assertValidSort,
  assertAuthorityAssociations,
  assertDataAssociations,
  filtersContent,
  validateAssociation,
  validateAssociations,
} from './query-validation.js';
import {
  GRANT_ACTION_SET,
  READ_COMPANIONS,
  grantConveys,
  grantReach,
  matchesGrantTarget,
  validateGrantTarget,
  validateGrantee,
  grantCoversGrantee,
  UNGRANTABLE_SYSTEM_TYPES,
  loadGrantRecords,
} from './grants.js';
import type { GrantQuery } from './grants.js';
import { bindingFieldsOf, uniqueBindingFieldsOf } from './identity-bindings.js';
import { assertAttachmentSize, assertContentSize } from './limits.js';
import {
  validateParentId,
  validateRecordId,
  validateClockField,
  validateIdTimestampSkew,
  DEFAULT_ID_TIMESTAMP_SKEW_MS,
} from './record-id.js';
import {
  queryAllPages,
  findFirstMatch,
  lookupEntityByDid,
  MAX_QUERY_LIMIT,
} from './stack-reads.js';
import {
  associationDelta,
  associationEqual,
  associationIdentical,
  assertNonEmptyChangeSet,
  changeSetOps,
  bumpsVersion,
  takesIfVersion,
  effectiveChanges,
  stampGroupAdmin,
  isGroupRecord,
} from './record-changes.js';
import { ScopedStack, scopeToken } from './scoped-stack.js';

// -------------------------------------------------------
// Supporting types
// -------------------------------------------------------

/**
 * Default grace period for Stack.collectAttachmentGarbage(), covering the
 * upload-then-associate window. See docs/spec/attachments.md § Garbage
 * collection.
 */
const DEFAULT_GC_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * How far a change set's `parentId` will walk a proposed ancestor chain before refusing
 * the move. Bounds the reads one call can cost; a hierarchy deeper than
 * this is beyond what `parentId` is for. See docs/spec/data-model.md
 * § Reparenting.
 */
const MAX_PARENT_DEPTH = 64;

/**
 * An Actor in the one form `Stack` stores: a `principalId` equal to the
 * subject is dropped, so "acted as itself" has a single spelling, and an
 * empty id is refused rather than stored as a name for nobody.
 * See docs/spec/data-model.md § Actor.
 */
export function normalizeActor(actor: Actor | undefined): Actor | undefined {
  if (!actor) return undefined;
  for (const field of ['subjectId', 'principalId'] as const) {
    if (actor[field] === '') {
      throw new StackBadRequestError(`Invalid ${field}: the empty string is not an id.`);
    }
  }
  const { subjectId, principalId } = actor;
  return principalId === undefined || principalId === subjectId
    ? { subjectId }
    : { subjectId, principalId };
}

/** Sentinel: filter.baseId resolved to zero matching types. */
const EMPTY_FAMILY = Symbol('empty-family');

/**
 * The `_attachment@1` fields a write may not move, each with the message it
 * is refused by. Ordered as reported. See docs/spec/attachments.md § The
 * `_attachment` record type.
 */
const ATTACHMENT_IMMUTABLE_FIELDS = [
  ['mimeType', 'mimeType is immutable after creation; delete and re-upload to change it'],
  ['fileId', 'fileId is immutable'],
  ['size', 'size is immutable'],
] as const;

type AttachmentImmutableField = (typeof ATTACHMENT_IMMUTABLE_FIELDS)[number][0];

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
 * CreateRecordOptions extended with createdAt/updatedAt, for backdating a
 * record's clock fields on import. Unscoped Stack.create() accepts them
 * unconditionally; ScopedStack.create() only from the stack owner acting
 * alone, since a grantee or a delegated app could otherwise forge a sort
 * position the same way a raw `id` could.
 * See docs/spec/data-model.md § Record IDs.
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
   * Clock-skew tolerance (ms) for two timestamp-prefix checks: the one
   * ScopedStack.create() runs on a non-backdated create's client-supplied
   * `id` against the current time, and the one Stack.create() runs between
   * an explicit `id` and an explicit `createdAt` when both are supplied —
   * reached directly when unscoped, or via ScopedStack.create() when the
   * requester is the owner acting alone. Default: 24 hours; null disables
   * both. See docs/spec/data-model.md § Record IDs.
   */
  idTimestampSkewMs?: number | null;
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

/** The argument to Stack.defineType(). */
export type DefineTypeOptions = {
  id: TypeId;
  name: string;
  schema: TypeSchema;
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
   * Apply a change set: any combination of content patch, `parentId`,
   * `permissions`, `associations` and `unlisted`, in one atomic write —
   * producing one version where it names `contentPatch`, and none where it
   * doesn't. Keys are read for presence, so `unlisted: false`
   * and `parentId: null` are changes; a change set naming no key at all is
   * a StackBadRequestError. Under ScopedStack each key carries its own gate and
   * one refused key refuses the call.
   * See docs/spec/data-model.md § Mutations.
   */
  mutate(id: RecordId, changes: RecordChangeSet, opts?: IfVersionOptions): Promise<StackRecord>;
  /** mutate() with `contentPatch` alone — the common case, named for it. */
  patchContent(
    id: RecordId,
    patch: Record<string, unknown | null>,
    opts?: IfVersionOptions,
  ): Promise<StackRecord>;
  /**
   * Add an association. Never bumps `version`/`updatedAt` and takes no
   * `ifVersion` — a set-add composes regardless of write order.
   * See docs/spec/versioning.md § Version history.
   */
  associate(id: RecordId, association: DataAssociation): Promise<StackRecord>;
  /** Remove an association. Never bumps `version`/`updatedAt` — see associate(). */
  dissociate(id: RecordId, association: DataAssociation): Promise<StackRecord>;
  /**
   * Extend who reaches a record by one element — the record-level mirror of
   * the type-level `grantType()`, and the amending spelling of the
   * `permissions` key, which replaces the whole set. No-bump, like
   * associate(). See docs/spec/access-control.md § Record-level permissions.
   */
  grantAccess(id: RecordId, permission: AuthorityAssociation): Promise<StackRecord>;
  /** Withdraw one element of who reaches a record — see grantAccess(). */
  revokeAccess(id: RecordId, permission: AuthorityAssociation): Promise<StackRecord>;
  delete(id: RecordId, opts?: DeleteRecordOptions): Promise<DeleteResult>;
  /**
   * delete(), plus the record it acted on — read and destroyed as one
   * atomic operation, so a caller that needs the record for its own
   * response (e.g. a server building a purge's body) never opens a
   * gap between reading it and destroying it. See Stack.deleteAndReturn().
   */
  deleteAndReturn(id: RecordId, opts?: DeleteRecordOptions): Promise<DeleteAndReturnResult>;
  undelete(id: RecordId, opts?: IfVersionOptions): Promise<StackRecord>;
  getVersions(id: RecordId): Promise<RecordVersion[]>;
  getVersion(id: RecordId, version: number): Promise<RecordVersion | null>;
  restoreVersion(id: RecordId, version: number, opts?: IfVersionOptions): Promise<StackRecord>;
  /**
   * A record's change journal, oldest first. On the mutate surface, on the
   * same footing as getVersions() — a plain reader is refused.
   *
   * Required of every adapter rather than optional, which is why it sits
   * here beside the rest: an empty log has to mean "nothing changed"
   * unconditionally, so an adapter with nothing to read refuses and names
   * why instead. See docs/spec/journal.md § Reading it.
   */
  getJournal(id: RecordId, query?: JournalQuery): Promise<RecordJournalEntry[]>;
  /**
   * Commit a per-record migration: change `typeId` and `content` together,
   * validated against `toTypeId`'s schema. The only way a record's typeId
   * changes after creation — see docs/spec/wire-format.md § Migration
   * commit. Takes `ifVersion` like every other mutation that bumps a
   * record's version (see docs/spec/versioning.md § Optimistic
   * concurrency); over the wire that is `If-Match`.
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

// -------------------------------------------------------
// Stack class
// -------------------------------------------------------

export class Stack implements StackClient {
  private readonly migrations = new Map<TypeId, Migration>();
  /**
   * Highest version this instance has defineType()'d, per baseId — what
   * this app process understands, as distinct from what exists in shared
   * storage. Used to detect the stale-writer case in presentAtLatest().
   */
  private readonly maxDefinedVersion = new Map<string, number>();
  /**
   * Types this instance has fetched or defined, keyed by versioned id. A
   * Type's schema is immutable once defined, so entries are never
   * invalidated, only added; listTypes() refreshes wholesale. See
   * docs/spec/data-model.md § Type cache.
   */
  private readonly typeCache = new Map<TypeId, StackType>();

  /** Set by close(). See docs/spec/adapters.md § Lifecycle. */
  private closed = false;

  /**
   * Every change made through this Stack. `ScopedStack` filters this same
   * stream rather than opening its own, so no scoped view can observe a
   * change the stack did not emit. See docs/spec/events.md.
   */
  private readonly changes = new ChangeEmitter();

  private constructor(
    private readonly adapter: StackAdapter,
    private readonly idTimestampSkewMsValue: number | null,
  ) {}

  /**
   * Announce a mutation that has already been persisted. Called after the
   * adapter write resolves and before the mutating method settles, so
   * `await stack.mutate(...)` guarantees subscribers have been notified —
   * and nothing about work they deferred. A handler cannot fail the write:
   * there is nothing left to fail. See docs/spec/events.md § Handlers.
   */
  private announce(change: PendingChange, record: StackRecord, at?: Date): void {
    this.changes.emit(change.emission(record, at));
  }

  /**
   * The actor for a `create` journal entry, read off the record as just
   * built. Create is the one journaled write that stamps the requester
   * onto the row itself, so the record in hand is authoritative — and it
   * carries `appId`, which ActorOptions has no field for.
   */
  private static createActor(record: StackRecord): ChangeActor | undefined {
    if (!record.updatedBy) return undefined;
    return { ...record.updatedBy, ...(record.appId !== undefined && { appId: record.appId }) };
  }

  private async getTypeCached(id: TypeId): Promise<StackType | null> {
    const cached = this.typeCache.get(id);
    if (cached) return cached;
    const type = await this.adapter.getType(id);
    if (type) this.typeCache.set(id, type);
    return type;
  }

  /**
   * Open a Stack over an adapter. Reads ownerEntityId and timezone from the adapter.
   */
  static async open(adapter: StackAdapter, opts: StackOptions = {}): Promise<Stack> {
    if (!adapter.ownerEntityId) {
      throw new InvalidAdapterError(
        'Stack misconfiguration: adapter has no ownerEntityId. ' +
          'Initialise the adapter with an entityId before calling Stack.open().',
      );
    }
    const stack = new Stack(
      adapter,
      opts.idTimestampSkewMs === undefined ? DEFAULT_ID_TIMESTAMP_SKEW_MS : opts.idTimestampSkewMs,
    );
    await stack.seedSystemTypes();
    if (opts.ownerProfile) {
      await stack.ensureOwnerEntity(opts.ownerProfile);
    }
    return stack;
  }

  /**
   * Idempotent bootstrap for StackOptions.ownerProfile. Filters by family
   * only (content filtering is capability-gated) and matches `content.did`
   * in memory, cursor-walking so an owner card past page one isn't missed
   * and duplicated. The probe must be blind to nothing the binding rules
   * see, or it mints a card they then refuse and the stack won't open with
   * `ownerProfile`: soft-deleted cards still reserve their `did`, and a card
   * migrated to a later version still holds one.
   * See docs/spec/identity.md § DID bindings.
   */
  private async ensureOwnerEntity(profile: { name: string; handle?: string }): Promise<void> {
    const entityTypeId = `${SYSTEM_TYPES.ENTITY}@1`;
    const existing = await this.getEntityByDid(this.ownerEntityId);
    if (existing) return;

    await this.create<EntityContent>(entityTypeId, {
      did: this.ownerEntityId,
      name: profile.name,
      ...(profile.handle && { handle: profile.handle }),
    });
  }

  get ownerEntityId(): EntityId {
    return this.adapter.ownerEntityId;
  }

  async getEntityByDid(did: EntityId): Promise<StackRecord | null> {
    return lookupEntityByDid((q) => this.query(q), did, filtersContent(this.capabilities), true);
  }

  async getOwnerEntity(): Promise<StackRecord | null> {
    return this.getEntityByDid(this.ownerEntityId);
  }

  get timezone(): string | undefined {
    return this.adapter.timezone;
  }

  get capabilities(): StackCapabilities {
    return this.adapter.capabilities;
  }

  /**
   * Get a permission-scoped view of this Stack, as if requests came from
   * the given entity acting as itself (null = anonymous). Plain Stack
   * methods are unscoped; use asEntity() when one Stack serves multiple,
   * possibly untrusted, entities. See
   * docs/spec/access-control.md § Enforcement: Stack.asEntity().
   */
  asEntity(entityId: EntityId | null): ScopedStack {
    return entityId === null ? this.scope(null, null) : this.asActor({ subjectId: entityId });
  }

  /**
   * Scope to an Actor — a delegated app acting for its user, or a
   * TokenSession exactly as StackTokenStore.lookupToken() returns it, which
   * is what a server should reach for at its request boundary. Authority is
   * the intersection of both parties' grants, while authorship and `-own`
   * resolve against the subject. Taking the pair whole leaves no order to
   * swap. See docs/spec/access-control.md § Delegation: principal and subject.
   */
  asActor(actor: Actor): ScopedStack {
    const { subjectId, principalId = subjectId } = normalizeActor(actor)!;
    return this.scope(principalId, subjectId);
  }

  private scope(principalId: EntityId | null, subjectId: EntityId | null): ScopedStack {
    this.assertOpen();
    return new ScopedStack(scopeToken, {
      stack: this,
      principalId,
      subjectId,
      idTimestampSkewMs: this.idTimestampSkewMsValue,
      adapter: this.adapter,
      changes: this.changes,
      assertOpen: () => this.assertOpen(),
      relaysChanges: this.relaysChanges,
    });
  }

  // -------------------------------------------------------
  // Types
  // -------------------------------------------------------

  /**
   * Define and persist a Type; call at app startup before creating records
   * of the type. Redefining an existing typeId is checked against the
   * stored schema: identical is a no-op, a name-only change persists, and
   * anything beyond additive evolution throws StackSchemaDriftError. See
   * docs/spec/data-model.md § Schema drift detection.
   */
  async defineType({ id, name, schema, migratesFrom }: DefineTypeOptions): Promise<StackType> {
    this.assertOpen();
    const parsed = parseTypeId(id);
    if (!parsed) {
      throw new StackBadRequestError(
        `Invalid TypeId format: "${id}". Expected "namespace/name@version", e.g. "com.example.myapp/note@1".`,
      );
    }

    // Register this version even on the idempotent-no-op path —
    // presentAtLatest()'s stale-writer detection depends on it.
    const priorMax = this.maxDefinedVersion.get(parsed.baseId) ?? 0;
    if (parsed.version > priorMax) this.maxDefinedVersion.set(parsed.baseId, parsed.version);

    // Shape first: the name checks and hashSchema() below both read the
    // schema as a well-formed one, and a schema off the wire is parsed
    // JSON that no compiler has seen.
    const shapeErrors = validateSchemaShape(schema);
    if (shapeErrors.length > 0) {
      throw new StackValidationError(shapeErrors);
    }

    const nameErrors = [
      ...validateSchemaReservedNames(schema),
      ...validateSchemaFieldNames(schema),
    ];
    if (nameErrors.length > 0) {
      throw new StackValidationError(nameErrors);
    }

    const schemaHash = await hashSchema(schema);
    const existing = await this.getTypeCached(id);

    if (existing) {
      if (existing.schemaHash === schemaHash) {
        if (existing.name === name) return existing;
        // else: name-only change — falls through to the write below,
        // schema/hash/createdAt all carried over unchanged.
      } else {
        const violations = diffSchemas(existing.schema, schema);
        if (violations.length > 0) {
          throw new StackSchemaDriftError(id, violations);
        }
      }
    }

    const type: StackType = {
      id,
      baseId: parsed.baseId,
      version: parsed.version,
      name,
      schema,
      schemaHash,
      createdAt: existing?.createdAt ?? new Date(),
      ...(migratesFrom && { migratesFrom }),
    };

    await this.adapter.saveType(type);
    this.typeCache.set(id, type);
    return type;
  }

  async getType(id: TypeId): Promise<StackType | null> {
    this.assertOpen();
    return this.getTypeCached(id);
  }

  /** Refreshes typeCache wholesale — the explicit way to see a rename made by another writer. */
  async listTypes(): Promise<StackType[]> {
    this.assertOpen();
    const types = await this.adapter.listTypes();
    for (const type of types) this.typeCache.set(type.id, type);
    return types;
  }

  /**
   * Check whether a record's type is compatible with a required schema.
   * Useful for duck-typed consumption across types.
   */
  async typeIsCompatible(typeId: TypeId, requiredSchema: TypeSchema): Promise<boolean> {
    this.assertOpen();
    const type = await this.getTypeCached(typeId);
    if (!type) return false;
    return isCompatible(type.schema, requiredSchema);
  }

  // -------------------------------------------------------
  // Migration registry
  // -------------------------------------------------------

  /**
   * Register a migration function between two adjacent Type versions; call
   * at app startup after defineType(). Runs in-memory — nothing is written
   * until migrateAll(). Adjacent migrations are composed into chains
   * automatically.
   */
  registerMigration(migration: Migration): void {
    this.assertOpen();
    if (this.migrations.has(migration.from)) {
      throw new StackMigrationError(`A migration from "${migration.from}" is already registered.`);
    }
    this.migrations.set(migration.from, migration);
  }

  /**
   * Find and compose a migration path from one TypeId to another.
   * Returns null if no path exists.
   */
  private resolveMigrationPath(fromId: TypeId, toId: TypeId): MigrationFn | null {
    if (fromId === toId) return (content) => content;

    const fns: MigrationFn[] = [];
    let current = fromId;
    const visited = new Set<TypeId>();

    while (current !== toId) {
      if (visited.has(current)) {
        throw new StackMigrationError(`Migration cycle detected at "${current}"`);
      }
      visited.add(current);
      const migration = this.migrations.get(current);
      if (!migration) return null;
      fns.push(migration.migrate);
      current = migration.to;
    }

    return (content) => fns.reduce((c, fn) => fn(c), content);
  }

  /**
   * Find the latest registered version of a type family.
   * Follows the migration chain from the given typeId to the end.
   */
  private latestTypeId(fromId: TypeId): TypeId {
    let current = fromId;
    const visited = new Set<TypeId>();
    while (this.migrations.has(current)) {
      if (visited.has(current)) {
        throw new StackMigrationError(`Migration cycle detected at "${current}"`);
      }
      visited.add(current);
      current = this.migrations.get(current)!.to;
    }
    return current;
  }

  /**
   * Eagerly migrate all records of a type family to the latest version —
   * the only way disk state changes version. Sweeps soft-deleted records
   * too, validates each result before writing, and aborts on the first
   * validation failure. See docs/spec/data-model.md § Type migrations.
   */
  async migrateAll(baseId: BaseId): Promise<{ migrated: number }> {
    this.assertOpen();
    const types = await this.adapter.listTypes();
    const familyTypeIds = types.filter((t) => t.baseId === baseId).map((t) => t.id);

    if (familyTypeIds.length === 0) {
      throw new StackMigrationError(`migrateAll: no registered types found for baseId "${baseId}"`);
    }

    let migrated = 0;

    for (const typeId of familyTypeIds) {
      const latestId = this.latestTypeId(typeId);
      if (typeId === latestId) continue;

      const migrateFn = this.resolveMigrationPath(typeId, latestId);
      if (!migrateFn) continue;

      const latestType = await this.getTypeCached(latestId);
      if (!latestType) {
        throw new StackMigrationError(`migrateAll: target type "${latestId}" is not defined.`);
      }

      let cursor: string | undefined;
      do {
        const result: QueryResult = await this.adapter.queryRecords({
          filter: { typeId, includeDeleted: true, includeUnlisted: true },
          limit: 100,
          cursor,
        });

        for (const record of result.records) {
          // Same checked path commitMigration() takes — a migration
          // function is no more entitled to move a DID binding or repoint
          // an attachment than a request body is. No ifVersion: a batch
          // pass doesn't know each record's version going in.
          await this.commitMigrationChecked(record, latestId, migrateFn(record.content));
          migrated++;
        }

        cursor = result.cursor ?? undefined;
      } while (cursor);
    }

    return { migrated };
  }

  // -------------------------------------------------------
  // Records
  // -------------------------------------------------------

  /**
   * Create a new record. Validates content against the type's schema.
   * `_group` records get their author stamped as the first `admin` roster
   * association here — the single stamping site for both Stack.create()
   * and ScopedStack.create(). `opts.createdAt`/`updatedAt` let a caller
   * backdate an imported record's clock fields — unconditionally here;
   * ScopedStack.create() forwards to this same method, but only reaches
   * this far with them when the requester is the stack owner acting alone
   * — see BackdatableCreateRecordOptions and docs/spec/data-model.md §
   * Record IDs.
   */
  async create<T extends Record<string, unknown> = Record<string, unknown>>(
    typeId: TypeId,
    content: T,
    opts: BackdatableCreateRecordOptions = {},
  ): Promise<StackRecord & { content: T }> {
    this.assertOpen();
    const type = await this.getTypeCached(typeId);
    if (!type) {
      throw new StackBadRequestError(`Unknown type: "${typeId}". Call defineType() first.`);
    }

    // Copied, never aliased: an import loop that reuses one Date across rows
    // (`d.setTime(...)` per record) would otherwise retro-edit every record
    // it had already written, with no version bump and no change event.
    // `instanceof Date`, not `!== undefined`, because this runs ahead of the
    // error block below and .getTime() on a non-Date off the wire would
    // throw before validateClockField() could report it; the fallback value
    // never reaches storage, since that recorded error still throws.
    const createdAt =
      opts.createdAt instanceof Date ? new Date(opts.createdAt.getTime()) : new Date();
    const updatedAt =
      opts.updatedAt instanceof Date ? new Date(opts.updatedAt.getTime()) : createdAt;

    // Ahead of every other check on these two lists: a caller that named
    // the wrong surface asked for something this layer does not offer, and
    // reporting its grantee as a malformed relationship target would
    // describe the mistake as the wrong kind of problem.
    assertDataAssociations(opts.associations ?? [], 'associations');
    assertAuthorityAssociations(opts.permissions ?? [], 'permissions');

    const errors = [
      ...validateReservedKeys(content),
      ...validateContentKeys(content),
      ...validateContent(content, type.schema),
      ...validateGrantee(typeId, content),
      ...validateAssociations(opts.permissions, 'permissions'),
      ...validatePermissions(opts.permissions),
      ...validateAssociations(opts.associations),
      ...validateClockField(opts.createdAt, 'createdAt'),
      ...validateClockField(opts.updatedAt, 'updatedAt'),
    ];
    // Compared against the *effective* createdAt, so an updatedAt supplied
    // on its own is caught too: defaulted-createdAt is now, which a
    // backdated updatedAt alone would still precede.
    if (opts.updatedAt !== undefined && updatedAt.getTime() < createdAt.getTime()) {
      errors.push({ path: 'updatedAt', message: 'updatedAt cannot precede createdAt.' });
    }
    if (errors.length > 0) {
      throw new StackValidationError(errors);
    }

    assertContentSize(content, this.capabilities.limits.contentBytes, 'Content');

    if (typeId === `${SYSTEM_TYPES.ATTACHMENT}@1`) {
      await this.checkAttachmentMimeTypeOnCreate(content as unknown as AttachmentContent);
    }

    await this.checkAttachmentAssociationPointers(opts.associations);

    await this.checkBindingsOnCreate(typeId, content as Record<string, unknown>);

    if (opts.id !== undefined) {
      validateRecordId(opts.id);
      // Only when both are explicit: an `id` alone is a pure position
      // choice, with no second timestamp to agree with.
      if (opts.createdAt !== undefined) {
        validateIdTimestampSkew(
          opts.id,
          this.idTimestampSkewMsValue,
          opts.createdAt.getTime(),
          'createdAt',
        );
      }
      // A generated id names nothing, so a create under a parent cannot
      // close a loop. A caller-supplied one can: existing records may
      // already point at it, and the chain above the parent can lead back
      // to it — so the walk is asked only for that combination.
      // See docs/spec/data-model.md § Reparenting.
      if (opts.parentId !== undefined) await this.assertNoParentCycle(opts.id, opts.parentId);
    }

    const createdBy = normalizeActor(opts.createdBy);
    const associations =
      baseIdOf(typeId) === SYSTEM_TYPES.GROUP
        ? stampGroupAdmin(opts.associations, createdBy?.subjectId ?? this.ownerEntityId)
        : opts.associations;

    // createdAt drives the id, so the two agree by construction rather than
    // by coincidence. An explicit one mints via generateIdForTimestamp(),
    // which never clamps to "now": generateId()'s monotonic floor would
    // otherwise pull a deliberately historical id forward once this process
    // has minted any live id past it.
    const id =
      opts.id ??
      (opts.createdAt !== undefined
        ? generateIdForTimestamp(createdAt.getTime())
        : generateId(createdAt.getTime()));

    // An id field a caller supplies is a value or it is absent — never the
    // empty string, which names nobody. Refused rather than dropped, so the
    // caller is never silently ignored.
    if (opts.appId === '') {
      throw new StackBadRequestError('Invalid appId: the empty string is not an id.');
    }

    // Every create naming a parent owes the reference check, whether or not
    // it supplied an id: a destination a caller names has to exist.
    if (opts.parentId !== undefined) await this.assertParentExists(id, opts.parentId);

    const record: StackRecord = {
      id,
      typeId,
      createdAt,
      updatedAt,
      content,
      version: 1,
      // Presence, not truthiness: '' is refused above, so absence is the
      // only thing a falsy value could mean here.
      ...(opts.parentId !== undefined && { parentId: opts.parentId }),
      ...(opts.appId !== undefined && { appId: opts.appId }),
      // A create's actor is its author, so `updatedBy` is derived rather
      // than taken: stamping it here keeps "absent means an unscoped write"
      // true of version 1 as it is of every later version.
      ...(createdBy && { createdBy, updatedBy: createdBy }),
      ...(opts.permissions?.length && { permissions: opts.permissions }),
      ...(associations?.length && { associations }),
      ...(opts.unlisted && { unlistedAt: createdAt }),
    };

    const change = new PendingChange('create', { actor: Stack.createActor(record) });
    const created = await this.adapter.createRecord(record, { journal: change.journal });
    this.announce(change, created);
    return created as StackRecord & { content: T };
  }

  /**
   * Apply the registered migration chain in memory, for presentAt:
   * 'latest'. Never writes back. Throws StackMigrationError when the
   * record's version can't be reconciled with what this instance has
   * registered — the stale-writer case. See docs/spec/data-model.md
   * § Type migrations.
   */
  private presentAtLatest(record: StackRecord): StackRecord {
    const latestId = this.latestTypeId(record.typeId);

    if (latestId !== record.typeId) {
      // latestTypeId() found this by walking the same migration graph
      // resolveMigrationPath() walks, from the same starting point, so a
      // path is always resolvable here.
      const migrateFn = this.resolveMigrationPath(record.typeId, latestId)!;
      return { ...record, typeId: latestId, content: migrateFn(record.content) };
    }

    const parsed = parseTypeId(record.typeId);
    const knownMax = parsed ? this.maxDefinedVersion.get(parsed.baseId) : undefined;
    if (parsed && knownMax !== undefined && parsed.version !== knownMax) {
      const direction =
        parsed.version > knownMax
          ? `the record is newer than this app instance understands — update the app, or register the missing migrations`
          : `no registered migration bridges the gap — call stack.registerMigration()`;
      throw new StackMigrationError(
        `Record "${record.id}" is at "${record.typeId}", but this app instance has defined ` +
          `up to "${parsed.baseId}@${knownMax}": ${direction}. Omit presentAt: "latest" to ` +
          `read the record as stored.`,
      );
    }

    return record;
  }

  /**
   * Get a record by ID, exactly as stored — no implicit migration. Pass
   * { presentAt: 'latest' } to migrate in memory; only migrateAll()
   * commits migrations to disk.
   */
  async get(id: RecordId, opts: GetRecordOptions = {}): Promise<StackRecord | null> {
    this.assertOpen();
    const record = await this.adapter.getRecord(id);
    if (!record) return null;
    return opts.presentAt === 'latest' ? this.presentAtLatest(record) : record;
  }

  /**
   * Apply a change set as one atomic write — see the StackClient
   * declaration above for what it accepts. Atomicity is what it is for: a
   * publish is one act, so nothing it names may half-land.
   *
   * Every key present is checked against the record as it stands, and a set
   * already satisfied in all of them writes nothing. Content is validated
   * against the record's *current* stored type; `typeId` never changes here.
   * See docs/spec/data-model.md § Mutations.
   */
  async mutate(
    id: RecordId,
    changes: RecordChangeSet,
    opts: IfVersionOptions & ActorOptions = {},
  ): Promise<StackRecord> {
    this.assertOpen();
    assertNonEmptyChangeSet(changes);

    const existing = await this.adapter.getRecord(id);
    if (!existing) {
      throw new StackNotFoundError(`Record not found: "${id}"`);
    }

    // Checked before validation, so a caller that lost the race learns its
    // version is stale rather than that its patch is bad, and before the
    // no-op short-circuit below, so a precondition is never satisfied by a
    // write that turned out to move nothing.
    if (takesIfVersion(changes)) this.checkIfVersion(existing, opts.ifVersion);

    const merged = await this.validateChangeSet(id, existing, changes);

    const ops = changeSetOps(existing, changes, merged);
    // Nothing moved, so there is nothing to version. Decided here rather
    // than in the adapter: "did this change anything" is a question about
    // the record's meaning, and an adapter is never handed a write that
    // writes nothing.
    if (ops.length === 0) return existing;

    // A change set naming only aspects the journal already keeps in full
    // doesn't bump — the same rule associate()/dissociate() follow
    // unconditionally. Its actor travels as an explicit opt rather than a
    // record stamp, since a non-bumping write never touches `updatedBy`.
    // See docs/spec/versioning.md § Version history.
    const bumps = bumpsVersion(ops);

    // Computed against the same before/after changeSetOps compared, so
    // whether associate/dissociate/reshare appear in `ops` and what
    // the journal lists can never disagree. Both halves of the partition
    // produce the same tagged edits and travel as one list: the journal's
    // argument is prior state, and an ACL element's is no different from a
    // tag's. See docs/spec/events.md § The event shape.
    const assocDelta = [
      ...(changes.associations
        ? associationDelta(existing.associations ?? [], changes.associations)
        : []),
      ...(changes.permissions
        ? associationDelta(existing.permissions ?? [], changes.permissions)
        : []),
    ];

    const previousParentId = existing.parentId ?? null;
    const change = new PendingChange(ops, {
      actor: normalizeActor(opts.actor),
      ...(ops.includes('reparent') && { previousParentId }),
      ...(assocDelta.length && { associations: assocDelta }),
    });
    const updated = await this.adapter.mutateRecord(id, effectiveChanges(changes, ops), {
      ...(bumps ? this.writeOptions(existing, opts) : { actor: normalizeActor(opts.actor) }),
      bumpsVersion: bumps,
      journal: change.journal,
    });
    this.announce(change, updated);
    return updated;
  }

  /**
   * mutate() with `contentPatch` alone. The common case by a wide margin,
   * and named for what it does rather than for a symmetry with create()
   * that a patch does not have.
   */
  async patchContent(
    id: RecordId,
    patch: Record<string, unknown | null>,
    opts: IfVersionOptions & ActorOptions = {},
  ): Promise<StackRecord> {
    return this.mutate(id, { contentPatch: patch }, opts);
  }

  /**
   * Every check a change set owes before anything is written, in one pass:
   * one refused key refuses the call, so none of them may run after a
   * partial write. Returns the merged content when the set carries a
   * content patch, since the caller needs it to decide whether content
   * actually moved.
   *
   * Parent existence and acyclicity are asked only when the destination
   * differs from where the record already sits — a move to where it
   * already is names no new edge, and would otherwise cost a read apiece.
   */
  private async validateChangeSet(
    id: string,
    existing: StackRecord,
    changes: RecordChangeSet,
  ): Promise<Record<string, unknown> | undefined> {
    const { contentPatch, permissions, associations, parentId } = changes;

    // Each key replaces only within its own domain. Asked before the
    // shape checks below so a misrouted element is reported as the wrong
    // surface rather than as a malformed value of the right one, and
    // asked here rather than in `ScopedStack` so an unscoped `Stack`, an
    // import and a server mapping a request body are all held to it.
    if (associations) assertDataAssociations(associations, 'associations');
    if (permissions) assertAuthorityAssociations(permissions, 'permissions');

    const errors = [
      ...(contentPatch
        ? [
            ...validateReservedKeys(contentPatch),
            ...validatePatchValues(contentPatch),
            ...validateContentKeys(contentPatch),
          ]
        : []),
      ...(permissions
        ? [...validateAssociations(permissions, 'permissions'), ...validatePermissions(permissions)]
        : []),
      ...(associations ? validateAssociations(associations) : []),
    ];
    if (errors.length > 0) throw new StackValidationError(errors);

    await this.checkAttachmentAssociationPointers(associations, existing.associations);

    let merged: Record<string, unknown> | undefined;
    if (contentPatch) {
      // The patch is what travels, so the patch is what's measured — a
      // small patch against a large record is not an oversized request.
      assertContentSize(contentPatch, this.capabilities.limits.contentBytes, 'Patch');

      const type = await this.getTypeCached(existing.typeId);
      if (!type) {
        throw new StackBadRequestError(`Unknown type: "${existing.typeId}"`);
      }
      merged = applyMergePatch(existing.content, contentPatch);

      const contentErrors = [
        ...validateContent(merged, type.schema),
        ...validateGrantee(existing.typeId, merged),
      ];
      if (contentErrors.length > 0) throw new StackValidationError(contentErrors);

      if (existing.typeId === `${SYSTEM_TYPES.ATTACHMENT}@1`) {
        // Presence decides mimeType and value decides the rest: re-sending
        // the mimeType a record already holds is refused outright, while a
        // client round-tripping fileId or size unchanged has claimed nothing.
        this.assertAttachmentImmutable(
          (field) =>
            Object.prototype.hasOwnProperty.call(contentPatch, field) &&
            (field === 'mimeType' ||
              (merged as AttachmentContent)[field] !==
                (existing.content as AttachmentContent)[field]),
        );
      }

      await this.checkBindingsOnUpdate(existing.typeId, id, contentPatch, existing.content, merged);

      if (id === SYSTEM_TYPES.CONFIG) {
        this.checkConfigEntityIdUnchanged(
          (existing.content as ConfigContent).entityId,
          (merged as ConfigContent).entityId,
        );
      }
    }

    if (associations !== undefined) {
      this.assertGroupAdminRemains(existing, associations);
    }

    if (parentId !== undefined && parentId !== null && parentId !== (existing.parentId ?? null)) {
      await this.assertParentExists(id, parentId);
      await this.assertNoParentCycle(id, parentId);
    }

    return merged;
  }

  /**
   * Refuse a write that would leave a `_group` Record with no `admin` on its
   * roster. Asked of the roster the write would *produce*, which is the
   * whole of the self-removal question: an admin removing themselves passes
   * while another remains and is refused when they are the last, without
   * either case naming who is going.
   *
   * An integrity constraint on the Record, not a permission question, so it
   * lives here rather than in `ScopedStack` and binds every requester — the
   * stack owner included. See docs/spec/identity.md § Group.
   */
  private assertGroupAdminRemains(record: StackRecord, next: DataAssociation[]): void {
    if (!isGroupRecord(record)) return;
    if (hasGroupAdmin(next)) return;
    throw new StackConflictError(
      `Cannot leave group "${record.id}" without an admin: a _group record's roster keeps at ` +
        'least one `admin` relationship association. Name the incoming admin in the same write.',
    );
  }

  /**
   * Add an association to a record — no-bump and no snapshot, per the
   * StackClient declaration above.
   *
   * An association the record already holds, saying the same thing, is a
   * no-op; one matching an existing association's identity but naming a
   * different `attachmentRecordId` — or none, which clears the one stored —
   * re-points it in place rather than adding a second reference to the same
   * file. What a re-point overwrote is kept only by the journal, on that
   * entry's `repoint`. See docs/spec/journal.md § The entry.
   */
  async associate(
    id: RecordId,
    association: DataAssociation,
    opts: ActorOptions = {},
  ): Promise<StackRecord> {
    this.assertOpen();
    assertDataAssociations([association], 'associate()');
    const errors = validateAssociation(association);
    if (errors.length > 0) throw new StackValidationError(errors);
    const existing = await this.adapter.getRecord(id);
    if (!existing) {
      throw new StackNotFoundError(`Record not found: "${id}"`);
    }
    if ((existing.associations ?? []).some((a) => associationIdentical(a, association))) {
      return existing;
    }
    const replaced = (existing.associations ?? []).find((a) => associationEqual(a, association));
    await this.checkAttachmentAssociationPointers([association]);

    const change = new PendingChange('associate', {
      actor: normalizeActor(opts.actor),
      // A re-point carries what it overwrote: nothing else retains the
      // attachmentRecordId that association held.
      associations: [
        replaced ? { op: 'repoint', association, previous: replaced } : { op: 'add', association },
      ],
    });
    const updated = await this.adapter.associate(id, association, { journal: change.journal });
    this.announce(change, updated);
    return updated;
  }

  /**
   * Remove an association from a record — see associate(). Matched by kind,
   * label and payload; a no-op if not found. The emitted event names the
   * association by identity only, since an attachment's
   * `attachmentRecordId` describes nothing current once it is gone; the
   * journal is where it survives.
   */
  async dissociate(
    id: RecordId,
    association: DataAssociation,
    opts: ActorOptions = {},
  ): Promise<StackRecord> {
    this.assertOpen();
    assertDataAssociations([association], 'dissociate()');
    const errors = validateAssociation(association);
    if (errors.length > 0) throw new StackValidationError(errors);
    const existing = await this.adapter.getRecord(id);
    if (!existing) {
      throw new StackNotFoundError(`Record not found: "${id}"`);
    }
    const matched = (existing.associations ?? []).find((a) => associationEqual(a, association));
    if (!matched) {
      return existing;
    }
    // Removing anything else cannot take the roster to zero, so only an
    // admin entry is worth deriving the post-state for. Derived rather than
    // counted so this path and the change set's reach the invariant through
    // the same helper, asking the same question of the same shape of list.
    if (isGroupAdminAssociation(association)) {
      this.assertGroupAdminRemains(
        existing,
        (existing.associations ?? []).filter((a) => !associationEqual(a, association)),
      );
    }

    const change = new PendingChange('dissociate', {
      actor: normalizeActor(opts.actor),
      // In full, annotation included — what makes a removal as undoable
      // from the log as a re-point is. The frame this becomes still names
      // identity only. See docs/spec/journal.md § The entry.
      associations: [{ op: 'remove', previous: matched }],
    });
    const updated = await this.adapter.dissociate(id, association, { journal: change.journal });
    this.announce(change, updated);
    return updated;
  }

  /**
   * Extend who reaches a record by one element. The spelling that survives
   * two admins sharing a record at once: a `permissions` key write replaces
   * the whole set, so the later of two concurrent ones drops what the
   * earlier granted. No-bump, like associate(); an element the record
   * already carries is a no-op.
   */
  async grantAccess(
    id: RecordId,
    permission: AuthorityAssociation,
    opts: ActorOptions = {},
  ): Promise<StackRecord> {
    this.assertOpen();
    assertAuthorityAssociations([permission], 'grantAccess()');
    const errors = validateAssociation(permission, 'permission');
    if (errors.length > 0) throw new StackValidationError(errors);
    const existing = await this.requireRecord(id);
    const current = existing.permissions ?? [];
    if (current.some((p) => associationEqual(p, permission))) return existing;
    this.assertPermissionSet([...current, permission]);

    const change = new PendingChange('reshare', {
      actor: normalizeActor(opts.actor),
      associations: [{ op: 'add', association: permission }],
    });
    const updated = await this.adapter.associate(id, permission, { journal: change.journal });
    this.announce(change, updated);
    return updated;
  }

  /**
   * Withdraw one element of who reaches a record — see grantAccess() for
   * why this is a verb rather than a key write. An element the record does
   * not carry is a no-op. Returns the record as it now stands.
   */
  async revokeAccess(
    id: RecordId,
    permission: AuthorityAssociation,
    opts: ActorOptions = {},
  ): Promise<StackRecord> {
    this.assertOpen();
    assertAuthorityAssociations([permission], 'revokeAccess()');
    const errors = validateAssociation(permission, 'permission');
    if (errors.length > 0) throw new StackValidationError(errors);
    const existing = await this.requireRecord(id);
    const current = existing.permissions ?? [];
    const matched = current.find((p) => associationEqual(p, permission));
    if (!matched) return existing;
    this.assertPermissionSet(current.filter((p) => !associationEqual(p, permission)));

    const change = new PendingChange('reshare', {
      actor: normalizeActor(opts.actor),
      associations: [{ op: 'remove', previous: matched }],
    });
    const updated = await this.adapter.dissociate(id, permission, { journal: change.journal });
    this.announce(change, updated);
    return updated;
  }

  /**
   * Hold a permission set to the cross-element invariant — see
   * validatePermissions() in access.ts for why it reads the post-state.
   */
  private assertPermissionSet(next: AuthorityAssociation[]): void {
    const errors = validatePermissions(next);
    if (errors.length > 0) throw new StackValidationError(errors);
  }

  /** The record, or the not-found refusal every mutating verb owes. */
  private async requireRecord(id: string): Promise<StackRecord> {
    const record = await this.adapter.getRecord(id);
    if (!record) throw new StackNotFoundError(`Record not found: "${id}"`);
    return record;
  }

  /**
   * The checks a *caller-named* destination owes, before the cycle walk:
   * `parentId` is a real, well-formed record id. Format first, so a
   * malformed one is a 400 naming the problem rather than a read that
   * cannot match. Existence closes the gap between the owner path and a
   * non-owner's, where canReadReferent() already refuses a parent that
   * isn't there.
   *
   * restoreVersion() deliberately does not call this — see its own comment.
   * See docs/spec/data-model.md § Reparenting.
   */
  private async assertParentExists(id: string, parentId: string): Promise<void> {
    validateParentId(parentId);
    if (!(await this.adapter.getRecord(parentId))) {
      throw new StackConflictError(
        `Cannot parent record "${id}" to "${parentId}": no such record. A container has to ` +
          'exist when it is named.',
      );
    }
  }

  /**
   * Refuse an edge that would make a record its own ancestor — asked at
   * every site that adds one. Nothing downstream (a generator deriving a
   * page path, a folder view) is written to survive a cycle.
   *
   * Walks with the unscoped adapter: a walk that skipped the links a
   * requester cannot read would let a cycle be assembled through them and
   * break the invariant for every reader.
   *
   * Read-then-write, so two moves racing on opposite ends of one chain can
   * both pass — the same deferral as checkBindingUnique() above, since
   * closing it would put a graph constraint in the storage contract.
   * Consumers walking `parentId` should carry a visited set rather than
   * trust this alone. See docs/spec/data-model.md § Reparenting.
   */
  private async assertNoParentCycle(id: string, parentId: string): Promise<void> {
    let cursor: string | undefined = parentId;
    for (let depth = 0; cursor !== undefined; depth++) {
      if (cursor === id) {
        throw new StackConflictError(
          `Cannot parent record "${id}" to "${parentId}": it is a descendant of "${id}", ` +
            'and the move would make the record its own ancestor.',
        );
      }
      // The cap bounds work, and guarantees this terminates on a chain that
      // is already cyclic. It does not refuse the move: a chain this long is
      // past what the check can speak to, not evidence of a loop, and
      // refusing it would claim an invariant core does not maintain.
      if (depth >= MAX_PARENT_DEPTH) return;
      cursor = (await this.adapter.getRecord(cursor))?.parentId;
    }
  }

  /**
   * Soft-delete a record (default) or purge it permanently, removing
   * the record and its version history. Soft delete snapshots and bumps
   * version; a no-op if already deleted. `_config` is never deletable
   * (docs/spec.md § The `_config` record). See docs/spec/versioning.md
   * § Deletion.
   *
   * A purge reports the files the record referenced. It deletes none of
   * them — byte lifetime is not the purged record's to decide — but it
   * destroys the only rows naming them, so a caller who means to erase the
   * bytes too has nowhere else to read the argument from afterwards. See
   * docs/spec/attachments.md § A purge strands the bytes it referenced.
   *
   * deleteAndReturn() is this plus the record itself; reach for that
   * instead when the caller needs the record too — building a response
   * body from a separate read beforehand is exactly the race and the extra
   * round trip it exists to remove.
   */
  async delete(id: RecordId, opts: DeleteRecordOptions & ActorOptions = {}): Promise<DeleteResult> {
    const { referencedFileIds } = await this.deleteAndReturn(id, opts);
    return { referencedFileIds };
  }

  /**
   * delete(), reporting the record it acted on alongside the files it
   * stranded: as it stood immediately before destruction for a
   * purge, or as the resulting tombstone for a soft delete. Both are
   * captured inside the same write that destroys or tombstones the record,
   * never a read beforehand — a read-then-delete would leave a window
   * where a concurrent write can land, get destroyed or overwritten by
   * this call, and never appear in the record this returns.
   */
  async deleteAndReturn(
    id: RecordId,
    opts: DeleteRecordOptions & ActorOptions = {},
  ): Promise<DeleteAndReturnResult> {
    this.assertOpen();
    if (id === SYSTEM_TYPES.CONFIG) {
      throw new StackConflictError(
        "Cannot delete the _config record: it holds the stack's identity and is required for every permission check.",
      );
    }
    if (opts.purge) {
      // The adapter hands back what it destroyed, captured inside the same
      // write: a read here instead would race the delete, and afterwards
      // there is nothing left to read. Null means there was no record, so
      // nothing was purged and nothing is announced.
      const change = new PendingChange('purge', { actor: normalizeActor(opts.actor) });
      const purged = await this.adapter.deleteRecord(id, {
        purge: true,
        ifVersion: opts.ifVersion,
        journal: change.journal,
      });
      if (!purged) return { record: null, referencedFileIds: [] };
      this.announce(change, purged);
      return { record: purged, referencedFileIds: await this.referencedFileIds(purged) };
    }

    const existing = await this.adapter.getRecord(id);
    if (!existing) {
      throw new StackNotFoundError(`Record not found: "${id}"`);
    }
    this.checkIfVersion(existing, opts.ifVersion);
    // A tombstone's references stand — undelete() must find its
    // attachments intact — so nothing is stranded and nothing is reported.
    if (existing.deletedAt) return { record: existing, referencedFileIds: [] };

    const change = new PendingChange('delete', { actor: normalizeActor(opts.actor) });
    const deleted = await this.adapter.deleteRecord(id, {
      ...this.writeOptions(existing, opts),
      journal: change.journal,
    });
    if (deleted) this.announce(change, deleted);
    return { record: deleted ?? existing, referencedFileIds: [] };
  }

  /**
   * The files a record references, by the same definition
   * deleteAttachment() and the garbage sweep use: attachment associations
   * and top-level `file-ref` content fields. An `_attachment` record's own
   * `fileId` is a plain string by design and is not one, which is why
   * purging a metadata record reports nothing — see initSystemTypes().
   */
  private async referencedFileIds(record: StackRecord): Promise<FileId[]> {
    const fromAssociations = (record.associations ?? []).flatMap((a) =>
      a.kind === 'attachment' ? [a.fileId] : [],
    );
    const type = await this.getType(record.typeId);
    const content = record.content as Record<string, unknown>;
    const fromContent = Object.entries(type?.schema ?? {}).flatMap(([field, def]) =>
      def.kind === 'file-ref' && typeof content[field] === 'string' ? [content[field]] : [],
    );
    return [...new Set([...fromAssociations, ...fromContent])];
  }

  /**
   * Reverse a soft delete. Idempotent — undeleting a record that isn't
   * deleted returns it unchanged. Purged records are gone, so this
   * throws StackNotFoundError for them just like any other missing record.
   * Snapshots and bumps version, same as delete().
   */
  async undelete(id: RecordId, opts: IfVersionOptions & ActorOptions = {}): Promise<StackRecord> {
    this.assertOpen();
    const existing = await this.adapter.getRecord(id);
    if (!existing) {
      throw new StackNotFoundError(`Record not found: "${id}"`);
    }
    this.checkIfVersion(existing, opts.ifVersion);
    if (!existing.deletedAt) return existing;

    const change = new PendingChange('undelete', { actor: normalizeActor(opts.actor) });
    const undeleted = await this.adapter.undeleteRecord(id, {
      ...this.writeOptions(existing, opts),
      journal: change.journal,
    });
    this.announce(change, undeleted);
    return undeleted;
  }

  /**
   * Query records. filter.baseId matches every version of a type family,
   * resolved against registered Types. Results come back exactly as
   * stored; pass presentAt: 'latest' to migrate in memory. See
   * docs/spec/data-model.md § Queries.
   */
  async query(query: StackQuery = {}): Promise<QueryResult> {
    this.assertOpen();
    const { presentAt, filter, limit: rawLimit, ...rest } = query;
    assertQueryCapabilities(filter, this.adapter.capabilities);
    assertValidSort(query.sort);
    assertSortCapability(query.sort, this.adapter.capabilities);
    assertValidAssociationFilters(filter);
    const limit = rawLimit !== undefined ? Math.min(rawLimit, MAX_QUERY_LIMIT) : undefined;

    const resolvedFilter = await this.resolveBaseIdFilter(filter);
    if (resolvedFilter === EMPTY_FAMILY) {
      return { records: [], cursor: null };
    }

    const result = await this.adapter.queryRecords({
      ...rest,
      ...(resolvedFilter !== undefined && { filter: resolvedFilter }),
      ...(limit !== undefined && { limit }),
    });

    if (presentAt !== 'latest') return result;
    return { ...result, records: result.records.map((r) => this.presentAtLatest(r)) };
  }

  /**
   * Resolve filter.baseId into a concrete typeId set (intersected with
   * filter.typeId when both are given), so adapters never need their own
   * baseId concept. Returns EMPTY_FAMILY when the resolved set is empty so
   * the caller can short-circuit without an adapter round trip.
   */
  private async resolveBaseIdFilter(
    filter: RecordFilter | undefined,
  ): Promise<RecordFilter | undefined | typeof EMPTY_FAMILY> {
    if (filter?.baseId === undefined) return filter;

    const { baseId, typeId, ...rest } = filter;
    const requestedBaseIds = Array.isArray(baseId) ? baseId : [baseId];
    const types = await this.adapter.listTypes();
    const familyTypeIds = types.filter((t) => requestedBaseIds.includes(t.baseId)).map((t) => t.id);

    const resolvedTypeIds =
      typeId === undefined
        ? familyTypeIds
        : familyTypeIds.filter((id) =>
            Array.isArray(typeId) ? typeId.includes(id) : typeId === id,
          );

    if (resolvedTypeIds.length === 0) return EMPTY_FAMILY;
    return { ...rest, typeId: resolvedTypeIds };
  }

  // -------------------------------------------------------
  // Versions
  // -------------------------------------------------------

  async getVersions(id: RecordId): Promise<RecordVersion[]> {
    this.assertOpen();
    return this.adapter.getVersions(id);
  }

  /**
   * A record's change journal, oldest first — what moved, who moved it, and
   * the association deltas nothing else retains. `ScopedStack` applies the
   * mutate-surface gate; this layer is unscoped and trusted by definition.
   *
   * A record that isn't there is StackNotFoundError, a purged one included:
   * a destroyed log and an empty one are not the same answer.
   * See docs/spec/journal.md § Reading it.
   */
  async getJournal(id: RecordId, query: JournalQuery = {}): Promise<RecordJournalEntry[]> {
    this.assertOpen();
    assertValidJournalQuery(query);
    return this.adapter.getJournal(id, query);
  }

  async getVersion(id: RecordId, version: number): Promise<RecordVersion | null> {
    this.assertOpen();
    return this.adapter.getVersion(id, version);
  }

  /**
   * Restore a record to a previous version by creating a new version —
   * never rewrites history. The snapshot is validated against its own
   * stored typeId, and puts back `content` and `typeId` alone: a snapshot
   * carries nothing else. See docs/spec/versioning.md § Restore semantics.
   */
  async restoreVersion(
    id: RecordId,
    version: number,
    opts: IfVersionOptions & ActorOptions = {},
  ): Promise<StackRecord> {
    this.assertOpen();
    const existing = await this.adapter.getRecord(id);
    if (!existing) {
      throw new StackNotFoundError(`Record not found: "${id}"`);
    }
    this.checkIfVersion(existing, opts.ifVersion);

    const target = await this.adapter.getVersion(id, version);
    if (!target) {
      throw new StackNotFoundError(`Version ${version} not found for record "${id}"`);
    }

    const type = await this.getTypeCached(target.typeId);
    if (!type) {
      throw new StackBadRequestError(`Unknown type: "${target.typeId}"`);
    }

    const errors = [
      ...validateContent(target.content, type.schema),
      ...validateGrantee(target.typeId, target.content),
    ];
    if (errors.length > 0) {
      throw new StackValidationError(errors);
    }

    if (id === SYSTEM_TYPES.CONFIG) {
      this.checkConfigEntityIdUnchanged(
        (existing.content as ConfigContent).entityId,
        (target.content as ConfigContent).entityId,
      );
    }

    // Restoring is a write like any other, so it owes the same immutability
    // check a content patch pays: a snapshot taken before a card claimed
    // its DID would otherwise move the binding by rolling content back.
    // Uniqueness needs none — a restore can only put back a value this same
    // card already held.
    for (const field of bindingFieldsOf(baseIdOf(target.typeId))) {
      this.checkBindingImmutable(
        baseIdOf(target.typeId),
        field,
        (existing.content as Record<string, unknown>)[field],
        (target.content as Record<string, unknown>)[field],
      );
    }

    // A restore adds no containment edge and takes none away, so there is
    // no cycle for it to close and nothing for the destination checks to
    // gate. See docs/spec/versioning.md § Restore semantics.
    const change = new PendingChange('restore', {
      actor: normalizeActor(opts.actor),
      previousTypeId: existing.typeId,
    });
    const restored = await this.adapter.restoreVersion(id, version, {
      ...this.writeOptions(existing, opts),
      journal: change.journal,
    });
    this.announce(change, restored);
    return restored;
  }

  /**
   * Commit a per-record migration — the single-record counterpart to
   * migrateAll(), with `content` supplied by the caller rather than by a
   * registered Migration function. See docs/spec/wire-format.md § Migration
   * commit.
   *
   * Because `content` is a full replacement written under a new `typeId`,
   * this is create-shaped at the destination *and* update-shaped over the
   * record as it stands, so it owes both sets of integrity checks. Missing
   * either half would make migrate a second, unguarded write path to a
   * state create()/mutate() refuse to reach.
   */
  async commitMigration(
    id: RecordId,
    toTypeId: TypeId,
    content: Record<string, unknown>,
    opts: IfVersionOptions & ActorOptions = {},
  ): Promise<StackRecord> {
    this.assertOpen();
    const existing = await this.adapter.getRecord(id);
    if (!existing) {
      throw new StackNotFoundError(`Record not found: "${id}"`);
    }
    this.checkIfVersion(existing, opts.ifVersion);
    return this.commitMigrationChecked(existing, toTypeId, content, opts);
  }

  /**
   * The checked migration write, shared by commitMigration() and
   * migrateAll(). Takes the record already in hand rather than an id: a
   * batch pass holds each record from its own query page, and re-fetching
   * per record would cost a read apiece for nothing.
   *
   * Both callers owe the same checks. migrateAll()'s content comes from a
   * registered Migration function rather than a request body, but "app
   * code" is not a trust boundary here — the app calling commitMigration()
   * is the same app that registered the function, and neither may move a
   * DID binding or repoint an attachment. registerMigration() also places
   * no constraint on `from` and `to` sharing a baseId, so a migration path
   * can cross type families; family-crossing is exactly what the checks
   * below care about.
   */
  private async commitMigrationChecked(
    existing: StackRecord,
    toTypeId: TypeId,
    content: Record<string, unknown>,
    opts: IfVersionOptions & ActorOptions = {},
  ): Promise<StackRecord> {
    const id = existing.id;

    const type = await this.getTypeCached(toTypeId);
    if (!type) {
      throw new StackBadRequestError(`Unknown type: "${toTypeId}". Call defineType() first.`);
    }

    const errors = [
      ...validateReservedKeys(content),
      ...validateContentKeys(content),
      ...validateContent(content, type.schema),
      ...validateGrantee(toTypeId, content),
    ];
    if (errors.length > 0) {
      throw new StackValidationError(errors);
    }

    assertContentSize(content, this.capabilities.limits.contentBytes, 'Content');

    const fromFamily = baseIdOf(existing.typeId);
    const toFamily = baseIdOf(toTypeId);
    const existingContent = existing.content as Record<string, unknown>;

    // A `_group` record's `admin` roster entry is stamped by create(), the
    // single site that does it — migrate cannot, since the adapter's
    // commitMigration() writes `typeId` and `content` alone and leaves
    // associations untouched. Minting one here would produce a group with
    // an empty roster, manageable by nobody but the owner, so migrating
    // *into* the family is refused. Version-to-version stays open and
    // carries the existing roster with it.
    if (toFamily === SYSTEM_TYPES.GROUP && fromFamily !== SYSTEM_TYPES.GROUP) {
      throw new StackConflictError(
        'Cannot migrate a record into _group: a group’s admin roster is stamped at creation. ' +
          'Create the group instead.',
      );
    }

    if (fromFamily === SYSTEM_TYPES.ATTACHMENT) {
      // Value-wise throughout: a migration re-sends all three required
      // fields, so presence would refuse every migration of the family.
      this.assertAttachmentImmutable(
        (field) =>
          (content as unknown as AttachmentContent)[field] !==
          (existingContent as unknown as AttachmentContent)[field],
      );
    } else if (toFamily === SYSTEM_TYPES.ATTACHMENT) {
      // A record arriving from outside the family stakes a fresh claim on
      // its fileId, exactly as create() does — so it owes create()'s check.
      await this.checkAttachmentMimeTypeOnCreate(content as unknown as AttachmentContent);
    }

    await this.checkBindingsOnMigrate(existing.typeId, toTypeId, id, existingContent, content);

    if (id === SYSTEM_TYPES.CONFIG) {
      this.checkConfigEntityIdUnchanged(
        (existing.content as ConfigContent).entityId,
        (content as ConfigContent).entityId,
      );
    }

    const change = new PendingChange('migrate', {
      actor: normalizeActor(opts.actor),
      previousTypeId: existing.typeId,
    });
    const migrated = await this.adapter.commitMigration(id, toTypeId, content, {
      ...this.writeOptions(existing, opts),
      journal: change.journal,
    });
    this.announce(change, migrated);
    return migrated;
  }

  /** Uniqueness for every unique binding field a newly created card claims. */
  private async checkBindingsOnCreate(
    typeId: TypeId,
    content: Record<string, unknown>,
  ): Promise<void> {
    const family = baseIdOf(typeId);
    for (const field of uniqueBindingFieldsOf(family)) {
      await this.checkBindingUnique(family, field, content[field]);
    }
  }

  /**
   * Immutability for every binding field a patch touches, then uniqueness
   * for the subset that carries it. Fields absent from the patch carry no
   * new claim — a content patch is a merge, so an untouched binding is the one the
   * card already holds.
   */
  private async checkBindingsOnUpdate(
    typeId: TypeId,
    id: RecordId,
    patch: Record<string, unknown | null>,
    existing: Record<string, unknown>,
    merged: Record<string, unknown>,
  ): Promise<void> {
    const family = baseIdOf(typeId);
    const unique = uniqueBindingFieldsOf(family);
    for (const field of bindingFieldsOf(family)) {
      if (!(field in patch)) continue;
      this.checkBindingImmutable(family, field, existing[field], merged[field]);
      if (unique.includes(field)) {
        await this.checkBindingUnique(family, field, merged[field], id);
      }
    }
  }

  /**
   * Bindings across a migration. `content` is a full replacement, so every
   * binding field either keeps its value, moves to a new one, or is shed by
   * omission — and immutability refuses the last two. Asked across the
   * union of both families' binding fields, so a card can neither shed its
   * DID by migrating out of `_entity`/`_app` nor pick one up on the way in.
   *
   * Uniqueness is asked only of the destination family, excluding the
   * record itself. See docs/spec/identity.md § DID bindings.
   */
  private async checkBindingsOnMigrate(
    fromTypeId: TypeId,
    toTypeId: TypeId,
    id: RecordId,
    existing: Record<string, unknown>,
    content: Record<string, unknown>,
  ): Promise<void> {
    const fromFamily = baseIdOf(fromTypeId);
    const toFamily = baseIdOf(toTypeId);

    const checked = new Set<string>();
    for (const family of fromFamily === toFamily ? [fromFamily] : [fromFamily, toFamily]) {
      for (const field of bindingFieldsOf(family)) {
        if (checked.has(field)) continue;
        checked.add(field);
        this.checkBindingImmutable(family, field, existing[field], content[field]);
      }
    }

    for (const field of uniqueBindingFieldsOf(toFamily)) {
      await this.checkBindingUnique(toFamily, field, content[field], id);
    }
  }

  /**
   * A unique binding field is what a lookup resolves *by* — an Actor's
   * `principalId` by `_app.did`, its `subjectId` by `_entity.did`. Two cards
   * claiming one value would leave that lookup without a single answer, and
   * ambiguity is all an impersonating card needs. Enforced here rather than
   * by schema, since uniqueness is a property of the set, not of the value.
   *
   * Read-then-write, so two creates racing on one value can both pass:
   * closing that means a unique index over a JSON field, which is a
   * decision about where uniqueness lives rather than a local fix.
   * See docs/spec/identity.md § DID bindings.
   */
  private async checkBindingUnique(
    family: string,
    field: 'did' | 'appId',
    value: unknown,
    excludeId?: RecordId,
  ): Promise<void> {
    if (typeof value !== 'string' || value === '') return;

    const clash = await findFirstMatch(
      (q) => this.query(q),
      {
        filter: {
          baseId: family,
          includeDeleted: true,
          includeUnlisted: true,
          ...(filtersContent(this.capabilities) && { content: { [field]: value } }),
        },
      },
      (r) => r.id !== excludeId && (r.content as Record<string, unknown>)[field] === value,
    );
    if (clash) {
      throw new StackConflictError(
        `Another ${family} record already claims the ${field} "${value}"`,
      );
    }
  }

  /**
   * A binding is permanent once made: uniqueness stops a second card
   * claiming a value, but only immutability stops an existing card being
   * moved onto one, which reaches the same impersonation by another route.
   * Adopting a value is therefore a one-way step, and a subject whose key
   * changes gets a new card — matching identity.md's deferral of key
   * rotation, where a new key is a new identity rather than the same one
   * relabelled. See docs/spec/identity.md § DID bindings.
   */
  private checkBindingImmutable(
    family: string,
    field: 'did' | 'appId',
    existing: unknown,
    next: unknown,
  ): void {
    if (typeof existing !== 'string' || existing === '') return;
    if (next === existing) return;
    throw new StackValidationError([
      {
        path: field,
        message: `${field} is immutable once set; register a new ${family} record instead`,
      },
    ]);
  }

  // -------------------------------------------------------
  // Attachments
  // -------------------------------------------------------

  /**
   * mimeType is a property of the fileId, not the uploader's perspective:
   * the first metadata record for a fileId fixes it, and a conflicting
   * later upload is rejected. See docs/spec/attachments.md § The
   * `_attachment` record type.
   *
   * Best-effort by construction — check-then-create with no storage-level
   * uniqueness behind it, so two racing first uploads can both land on a
   * concurrent server. What survives that race is the *resolution*:
   * getAttachmentRecords() returns the candidates in the same total order
   * a server serving Content-Type applies, so both sides name the same
   * winner however many records exist.
   */
  private async checkAttachmentMimeTypeOnCreate(content: AttachmentContent): Promise<void> {
    const { fileId, mimeType } = content;
    if (typeof fileId !== 'string') return; // schema validation already rejected this

    const existing = await this.getAttachmentRecords(fileId);
    if (existing.length === 0) return;

    const establishedMimeType = existing[0].content.mimeType;
    if (mimeType !== establishedMimeType) {
      // Deliberately does not name the established mimeType — that would
      // confirm a guessed fileId's content type. See the anti-oracle rule
      // in docs/spec/attachments.md.
      throw new StackValidationError([
        {
          path: 'mimeType',
          message: 'mimeType conflicts with the mimeType already established for this fileId',
        },
      ]);
    }
  }

  /**
   * An attachment association's `attachmentRecordId` names an `_attachment`
   * record for the same `fileId` — checked here so a reference can't be
   * annotated with an unrelated record's filename.
   *
   * Best-effort, like the mimeType check above: the named record can be
   * deleted afterwards, so every reader of the field falls back rather than
   * trusting it. `stored` is what the record already holds, asked so a
   * change set restating an association is never refused for a pointer the
   * record has carried since before the named record was deleted.
   * See docs/spec/attachments.md § Naming the upload a reference came from.
   */
  private async checkAttachmentAssociationPointers(
    associations: Association[] | undefined,
    stored: Association[] = [],
  ): Promise<void> {
    const pointed = (associations ?? []).flatMap((association) =>
      association.kind === 'attachment' &&
      association.attachmentRecordId !== undefined &&
      !stored.some((a) => associationIdentical(a, association))
        ? [{ fileId: association.fileId, attachmentRecordId: association.attachmentRecordId }]
        : [],
    );
    // One round trip per pointer, taken together: a change set carries a
    // whole association list, and each pointer is an independent read.
    const named = await Promise.all(
      pointed.map(({ attachmentRecordId }) => this.adapter.getRecord(attachmentRecordId)),
    );

    pointed.forEach(({ fileId }, i) => {
      const record = named[i];
      const content = record?.content as AttachmentContent | undefined;
      if (
        record &&
        baseIdOf(record.typeId) === SYSTEM_TYPES.ATTACHMENT &&
        content?.fileId === fileId
      ) {
        return;
      }
      // One message for every way of failing: a missing record and a record
      // for other bytes must not be distinguishable, or this becomes an
      // existence oracle for records the caller cannot read. A write that
      // succeeds does confirm the record it names, but only to a caller who
      // already has file access for those bytes.
      // See the anti-oracle rule in docs/spec/attachments.md.
      throw new StackValidationError([
        {
          path: 'attachmentRecordId',
          message: 'attachmentRecordId must name an `_attachment` record for this fileId',
        },
      ]);
    });
  }

  /**
   * filename is the only mutable field on an `_attachment@1` record; fileId,
   * size and mimeType are immutable, and the correction flow is delete +
   * re-upload. `violates` decides what counts as touching one, because the
   * two write shapes disagree: a patch names only what it changes, while a
   * migration replaces content wholesale and necessarily re-sends all three.
   *
   * Repointing `fileId` is the one that matters most: an `_attachment@1`
   * record naming a fileId is what canAccessFile()'s uploader clause reads,
   * so moving an existing record onto another file's hash is a route to
   * bytes the record's author never uploaded.
   * See docs/spec/attachments.md § The `_attachment` record type.
   */
  private assertAttachmentImmutable(violates: (field: AttachmentImmutableField) => boolean): void {
    const errors = ATTACHMENT_IMMUTABLE_FIELDS.filter(([field]) => violates(field)).map(
      ([path, message]) => ({ path, message }),
    );
    if (errors.length > 0) {
      throw new StackValidationError(errors);
    }
  }

  /**
   * `_config.entityId` defines stack ownership; neither patchContent() nor
   * restoreVersion() may change it. A conflict with stack integrity, not a
   * schema violation — hence StackConflictError. See docs/spec.md § The
   * `_config` record.
   */
  private checkConfigEntityIdUnchanged(existingEntityId: EntityId, newEntityId: EntityId): void {
    if (newEntityId !== existingEntityId) {
      throw new StackConflictError(
        'Cannot change _config.entityId: it defines stack ownership. ' +
          'Ownership transfer is not a supported operation.',
      );
    }
  }

  /**
   * Store bytes and create an _attachment@1 metadata record (owner-
   * attributed, no createdBy), returning that record — `content.fileId`
   * addresses the bytes, `id` addresses the metadata. Delegates to the
   * adapter's atomic putAttachmentWithMetadata() when implemented, trusting
   * the returned record as backend-authoritative; otherwise falls back to
   * bytes-then-create(). See docs/spec/wire-format.md § Attachments.
   */
  async putAttachment(
    data: Uint8Array,
    opts: PutAttachmentOptions,
  ): Promise<StackRecord & { content: AttachmentContent }> {
    const { mimeType, filename, appId } = opts;
    this.assertOpen();
    assertAttachmentSize(data.byteLength, this.capabilities.limits.attachmentBytes);
    if (this.adapter.putAttachmentWithMetadata) {
      // The metadata record is written inside the adapter, so create()
      // never sees it and this is the only place it can be announced.
      const record = await this.adapter.putAttachmentWithMetadata(data, opts);
      // The one emission with no journal half of its own: the far side
      // wrote the record, so it appended the entry in that same write —
      // the same division saveVersion() follows over this adapter. See
      // docs/spec/journal.md § The entry set is the event set.
      this.announce(new PendingChange('create'), record);
      return record as StackRecord & { content: AttachmentContent };
    }
    const fileId = await this.adapter.putBlob(data);
    return this.create<AttachmentContent>(
      `${SYSTEM_TYPES.ATTACHMENT}@1`,
      {
        fileId,
        mimeType,
        size: data.byteLength,
        ...(filename && { filename }),
      },
      { appId },
    );
  }

  async getAttachment(fileId: FileId): Promise<Uint8Array> {
    this.assertOpen();
    return this.adapter.getBlob(fileId);
  }

  /**
   * Every `_attachment` record describing `fileId`, earliest-recorded
   * first — so `records[0]` is the one that establishes the file's
   * mimeType, and firstRecordedAttachment() is only needed by a caller
   * narrowing the set further. See docs/spec/attachments.md § Finding a
   * `fileId`'s metadata records.
   *
   * On `Stack` and not `StackClient`: the lookup answers a presentation
   * question about an access decision already made, so a scoped version
   * would impose a second, different permission check rather than a
   * narrower correct answer.
   */
  async getAttachmentRecords(
    fileId: FileId,
  ): Promise<(StackRecord & { content: AttachmentContent })[]> {
    this.assertOpen();
    const results = await queryAllPages((q) => this.query(q), {
      filter: {
        baseId: SYSTEM_TYPES.ATTACHMENT,
        includeDeleted: true,
        includeUnlisted: true,
        ...(filtersContent(this.capabilities) && { content: { fileId } }),
      },
    });
    return results
      .filter((r) => (r.content as AttachmentContent).fileId === fileId)
      .sort(compareRecordedAttachments) as (StackRecord & { content: AttachmentContent })[];
  }

  /**
   * The `_attachment` family as concrete typeIds. Resolved here rather
   * than in the adapter, which has no baseId concept of its own — see
   * resolveBaseIdFilter().
   */
  private async attachmentTypeIds(): Promise<TypeId[]> {
    const types = await this.adapter.listTypes();
    return types.filter((t) => t.baseId === SYSTEM_TYPES.ATTACHMENT).map((t) => t.id);
  }

  /**
   * Delete an attachment's bytes and every _attachment metadata record for
   * it, family-wide. Throws StackConflictError if any record in the stack
   * still references the file, StackNotFoundError if neither metadata
   * records nor bytes exist.
   */
  async deleteAttachment(fileId: FileId, opts: ActorOptions = {}): Promise<void> {
    this.assertOpen();
    let deletedRecords: StackRecord[];
    if (this.adapter.deleteUnreferencedAttachmentRecords) {
      // Purged inside the adapter's own transaction, so these never reach
      // delete() and are announced here instead — from the records it
      // hands back, which are the last copies that will ever exist.
      deletedRecords = await this.adapter.deleteUnreferencedAttachmentRecords(
        fileId,
        await this.attachmentTypeIds(),
      );
      const at = new Date();
      for (const record of deletedRecords) {
        this.announce(
          new PendingChange('purge', { actor: normalizeActor(opts.actor) }),
          record,
          at,
        );
      }
    } else {
      deletedRecords = await this.deleteUnreferencedAttachmentRecordsFallback(fileId, opts);
    }

    if (!deletedRecords.length) {
      try {
        await this.adapter.getBlob(fileId);
      } catch {
        throw new StackNotFoundError(`Attachment not found: "${fileId}"`);
      }
    }

    await this.adapter.deleteBlob(fileId);
  }

  /**
   * Non-atomic fallback for adapters that don't implement
   * deleteUnreferencedAttachmentRecords(): a concurrent associate() can
   * race between the reference check below and the deletes it guards.
   */
  private async deleteUnreferencedAttachmentRecordsFallback(
    fileId: string,
    opts: ActorOptions = {},
  ): Promise<StackRecord[]> {
    // A soft-deleted or unlisted record still counts as a reference — it
    // must find its attachments intact on undelete or relisting. See
    // docs/spec/attachments.md § Deleting attachments.
    const refResult = await this.query({
      filter: { referencesFileId: fileId, includeDeleted: true, includeUnlisted: true },
      limit: 1,
    });
    if (refResult.records.length > 0) {
      throw new StackConflictError('Attachment is still referenced by one or more records');
    }

    // Soft-deleted, unlisted, and later-version metadata is cleaned up
    // too — none of it may be left pointing at deleted bytes.
    const metaRecords = await this.getAttachmentRecords(fileId);

    for (const record of metaRecords) {
      await this.delete(record.id, { purge: true, ...opts });
    }

    return metaRecords;
  }

  /**
   * Sweep for attachment bytes unreachable from any record — live or
   * soft-deleted — and delete bytes + metadata. Deletion goes through
   * deleteAttachment(), so a file re-referenced by sweep time is skipped,
   * not a failure. See docs/spec/attachments.md § Garbage collection.
   */
  async collectAttachmentGarbage(
    opts: CollectAttachmentGarbageOptions & ActorOptions = {},
  ): Promise<CollectAttachmentGarbageResult> {
    this.assertOpen();
    const graceMs = opts.graceMs ?? DEFAULT_GC_GRACE_MS;
    const dryRun = opts.dryRun ?? false;
    const now = Date.now();

    const metaRecords = await queryAllPages((q) => this.query(q), {
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
    if (this.adapter.listBlobs) {
      for (const file of await this.adapter.listBlobs()) {
        blobByFile.set(file.fileId, { modifiedAt: file.modifiedAt.getTime(), size: file.size });
      }
    }

    const candidateFileIds = new Set([...metaByFile.keys(), ...blobByFile.keys()]);

    const deletedFileIds: FileId[] = [];
    let reclaimedBytes = 0;

    for (const fileId of candidateFileIds) {
      const refResult = await this.query({
        filter: { referencesFileId: fileId, includeDeleted: true, includeUnlisted: true },
        limit: 1,
      });
      if (refResult.records.length > 0) continue;

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
        await this.deleteAttachment(fileId, { actor: opts.actor });
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

  // -------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------

  /**
   * Observe every change made through this Stack. Unscoped, so no
   * permission filter applies — a caller holding a `Stack` already reaches
   * every record by other means; `ScopedStack.subscribe()` is the filtered
   * view. See docs/spec/events.md.
   *
   * Async so that a remote stack can resolve once its feed is live, which
   * makes subscribe-then-query the gap-free startup order everywhere. A
   * local stack is live immediately.
   */
  async subscribe(
    handler: (change: RecordChange) => void,
    opts: SubscribeOptions = {},
  ): Promise<Unsubscribe> {
    this.assertOpen();
    assertSinceUsable(opts.since, this.relaysChanges);
    const unsubscribe = this.changes.subscribe(handler, opts);
    let stopRelay: Unsubscribe | undefined;
    try {
      stopRelay = await this.openRelay(handler, opts);
    } catch (err) {
      // The local half is already registered, and a failed subscribe()
      // must leave nothing behind for the caller to unsubscribe from.
      unsubscribe();
      throw err;
    }
    return () => {
      unsubscribe();
      stopRelay?.();
    };
  }

  /**
   * Ask the adapter to relay changes that originated elsewhere. Absent on
   * every local adapter, where one process owns the storage and there is
   * no third party whose writes could have been missed.
   *
   * The subscription's own filter goes to the relay rather than being
   * applied on the way back: the emitter at the far end holds the record,
   * so it can answer `createdBy` and `parentId`, which the envelope
   * deliberately does not carry. That is also why a relay is opened per
   * subscription rather than shared.
   */
  private async openRelay(
    handler: (change: RecordChange) => void,
    opts: SubscribeOptions,
  ): Promise<Unsubscribe | undefined> {
    if (!this.adapter.subscribeChanges) return undefined;
    const delivery = new RelayDelivery(handler, opts);
    const stop = await this.adapter.subscribeChanges(
      {
        ...(opts.filter !== undefined && { filter: opts.filter }),
        ...(opts.since !== undefined && { since: opts.since }),
        ...(opts.includeRecords !== undefined && { includeRecords: opts.includeRecords }),
        ...(opts.includeUnlisted !== undefined && { includeUnlisted: opts.includeUnlisted }),
        ...(opts.onError !== undefined && { onError: opts.onError }),
        ...(opts.onReset !== undefined && { onReset: opts.onReset }),
      },
      (change) => delivery.deliver(change),
    );
    return () => {
      delivery.close();
      void stop();
    };
  }

  /** Whether changes reach this stack from elsewhere. */
  private get relaysChanges(): boolean {
    return typeof this.adapter.subscribeChanges === 'function';
  }

  /**
   * Flush pending writes to the underlying storage. A no-op for adapters
   * that commit on every call (SQLite, the API adapter); meaningful for
   * ones that buffer, and for checkpointing a stack that stays open —
   * close() covers the teardown case on its own.
   */
  async flush(): Promise<void> {
    this.assertOpen();
    await this.adapter.flush?.();
  }

  /**
   * Flush, then release any resources the adapter holds (connections, file
   * handles, lock files). A failed flush still releases them before it
   * propagates: an unwritable stack must not also leak a lock file.
   * See docs/spec/adapters.md § Lifecycle.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    // Marked closed up front so a failed flush can't leave the stack
    // half-open and invite a second close() onto an already-closed adapter.
    // Flushes through the adapter directly, past the now-tripped guard.
    this.closed = true;
    this.changes.closeAll();
    try {
      await this.adapter.flush?.();
    } finally {
      await this.adapter.close?.();
    }
  }

  /** Throws once close() has run. */
  private assertOpen(): void {
    if (this.closed) throw new UseAfterCloseError();
  }

  // -------------------------------------------------------
  // Grants
  // -------------------------------------------------------

  /**
   * Create a _grant record authorizing `grantee` to take `actions` on
   * records of `typeId`: `{ kind: 'entity' }` for one DID, `{ kind: 'group' }`
   * for a `_group` Record's roster at a role, `{ kind: 'authenticated' }` for
   * any authenticated entity. The type-level mirror of grantAccess() —
   * subject first, grantee inside the element.
   *
   * Granting an **app** a `-own` action does not contain it the way the
   * suffix suggests: when that app acts for someone, `-own` is read as the
   * bare verb and the subject decides which records are in reach, so in a
   * personal stack — where nearly every record is owner-authored — a
   * delegated `read-own` is close to `read-any`. Grant an app the types it
   * needs, not the suffix that looks narrowest. See
   * docs/spec/access-control.md § Delegation: principal and subject.
   *
   * `typeOrBaseId` is a versioned TypeId (`"baseId@version"`) or a bare
   * baseId; either names the whole family. See
   * docs/spec/access-control.md § Type-level grants.
   */
  async grantType(
    typeOrBaseId: TypeId | BaseId,
    grant: TypeGrant,
  ): Promise<StackRecord & { content: GrantContent }> {
    this.assertOpen();
    validateGrantTarget(grant.grantee);
    this.checkGrantValid(typeOrBaseId, grant.actions);
    return this.create<GrantContent>(`${SYSTEM_TYPES.GRANT}@1`, {
      typeId: typeOrBaseId,
      actions: grant.actions,
      grantee: grant.grantee,
    });
  }

  /**
   * List _grant records. Omit `query` for all grants;
   * `{ kind: 'authenticated' }` for only default grants;
   * `{ kind: 'group' }` for grants naming that exact group and role, or
   * `role: 'any'` for every grant naming the group;
   * `{ kind: 'entity' }` for the grants that currently apply to that entity
   * (ones naming them, ones naming a group they belong to at a role they
   * hold, plus every default grant) — the same resolution hasGrant() uses.
   *
   * Every arm but `entity` answers identity — what `grantType()` would have
   * written with the same argument. The `entity` arm answers coverage, so
   * its result is not a preview of what `revokeType()` would withdraw.
   * See docs/spec/access-control.md § Type-level grants.
   */
  async listTypeGrants(query?: GrantQuery): Promise<(StackRecord & { content: GrantContent })[]> {
    this.assertOpen();
    if (query !== undefined) validateGrantTarget(query, true);
    const all = await loadGrantRecords((q) => this.query(q));
    if (query === undefined) return all;
    if (query.kind !== 'entity') {
      return all.filter((r) => matchesGrantTarget(r.content, query));
    }

    // An entity query resolves group rosters, since a grant naming a group
    // the entity belongs to also currently applies to them. Shares
    // grantCoversGrantee() with the access checks, so a listing can't
    // disagree with them about who a grant covers.
    const groupRoles = new Map<string, GroupRole | null>();
    const result: (StackRecord & { content: GrantContent })[] = [];
    for (const r of all) {
      const covers = await grantCoversGrantee(r.content, query.entityId, {
        allowDefault: true,
        allowGroup: true,
        groupRoles,
        resolveRecord: (id) => this.get(id),
      });
      if (covers) result.push(r);
    }
    return result;
  }

  /**
   * The inverse of grantType(): soft-deletes the _grant records on
   * `typeOrBaseId`'s family matching `grant`, at the same granularity
   * grantType() writes — the grantee is matched whole, role included, and
   * the actions exactly. A soft delete like any other — the owner can
   * undelete a revocation.
   *
   * Returns the grants it withdrew, as they stood: an array, where
   * revokeAccess() returns one Record, because one target can match several
   * _grant records. An empty result is not an error — re-running a
   * revocation has to stay safe. See
   * docs/spec/access-control.md § Listing and revoking.
   */
  async revokeType(
    typeOrBaseId: TypeId | BaseId,
    grant: TypeGrant,
  ): Promise<(StackRecord & { content: GrantContent })[]> {
    this.assertOpen();
    validateGrantTarget(grant.grantee);
    const familyId = baseIdOf(typeOrBaseId);
    const actionSet = new Set(grant.actions);
    const all = await loadGrantRecords((q) => this.query(q));
    const matches = all.filter((r) => {
      const c = r.content;
      // Establishes the family and that `actions` is a list, so the exact
      // match below reads a real one. Matched against the stored list
      // rather than the reach, so a grant carrying an action this
      // vocabulary drops is not withdrawn by a target that omits it.
      const reach = grantReach(c);
      if (!reach || reach.familyId !== familyId) return false;
      if (!matchesGrantTarget(c, grant.grantee)) return false;
      return c.actions.length === actionSet.size && c.actions.every((a) => actionSet.has(a));
    });
    for (const match of matches) await this.delete(match.id);
    return matches;
  }

  // -------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------

  /**
   * Actions must be known GrantAction values, typeIds must be well-formed,
   * and the _grant/_config families are refused — see
   * docs/spec/access-control.md § Type-level grants.
   */
  private checkGrantValid(typeId: TypeId, actions: GrantAction[]): void {
    const errors: ValidationError[] = [];
    actions.forEach((action, j) => {
      if (!GRANT_ACTION_SET.has(action)) {
        errors.push({ path: `actions[${j}]`, message: `Unknown grant action "${action}"` });
      }
    });

    if (!isWellFormedTypeId(typeId)) {
      errors.push({
        path: 'typeId',
        message: `"${typeId}" is not a well-formed baseId or versioned TypeId (expected "baseId" or "baseId@version")`,
      });
    } else if (UNGRANTABLE_SYSTEM_TYPES.has(baseIdOf(typeId))) {
      const refused = [...UNGRANTABLE_SYSTEM_TYPES].join(', ');
      errors.push({
        path: 'typeId',
        message: `Cannot grant on "${baseIdOf(typeId)}": grants on ${refused} are refused to prevent privilege escalation`,
      });
    }

    actions.forEach((action, j) => {
      if (grantConveys(actions, action)) return;
      const companions = READ_COMPANIONS.get(action);
      if (!companions) return;
      errors.push({
        path: `actions[${j}]`,
        message: `"${action}" requires ${companions.map((c) => `"${c}"`).join(' or ')} in the same grant: a mutate verb reaches the record and its history, so it conveys nothing without read`,
      });
    });
    if (errors.length > 0) {
      throw new StackValidationError(errors);
    }
  }

  private async seedSystemTypes(): Promise<void> {
    await this.defineType({
      id: `${SYSTEM_TYPES.CONFIG}@1`,
      name: 'Config',
      schema: {
        entityId: { kind: 'string', required: true },
        // Optional passthrough app metadata — see ConfigContent.timezone.
        timezone: { kind: 'string' },
      },
    });
    await this.defineType({
      id: `${SYSTEM_TYPES.ENTITY}@1`,
      name: 'Entity',
      schema: {
        did: { kind: 'string', required: true },
        name: { kind: 'string', required: true },
        handle: { kind: 'string' },
      },
    });
    await this.defineType({
      id: `${SYSTEM_TYPES.APP}@1`,
      name: 'App',
      schema: {
        appId: { kind: 'string', required: true },
        name: { kind: 'string', required: true },
        version: { kind: 'string' },
        did: { kind: 'string' },
      },
    });
    await this.defineType({
      id: `${SYSTEM_TYPES.GROUP}@1`,
      name: 'Group',
      schema: {
        name: { kind: 'string', required: true },
        handle: { kind: 'string' },
        stackUrl: { kind: 'string' },
      },
    });
    await this.defineType({
      id: `${SYSTEM_TYPES.GRANT}@1`,
      name: 'Grant',
      schema: {
        typeId: { kind: 'string', required: true },
        actions: { kind: 'array', items: { kind: 'string' }, required: true },
        // Required, and closed: a Grant's reach is spelled by its `grantee`,
        // so a record arriving without one is refused here rather than read
        // as a grant to every authenticated entity. The arms differ in which
        // fields they carry, which a schema cannot express — evaluation reads
        // the `kind` and confers nothing on one it does not recognize.
        // See docs/spec/access-control.md § Type-level grants.
        grantee: {
          kind: 'object',
          required: true,
          properties: {
            kind: { kind: 'string', required: true },
            entityId: { kind: 'string' },
            groupId: { kind: 'string' },
            role: { kind: 'string' },
          },
        },
      },
    });
    await this.defineType({
      id: `${SYSTEM_TYPES.ATTACHMENT}@1`,
      name: 'Attachment',
      schema: {
        // Deliberately `string`, not `file-ref`: referencesFileId matching
        // (deleteAttachment()/collectAttachmentGarbage()'s reference scan) is
        // schema-driven, so a `file-ref` fileId here would make every
        // metadata record its own file's reference — nothing would ever be
        // deletable or collectible. See docs/spec/attachments.md § Deleting
        // attachments / Garbage collection.
        fileId: { kind: 'string', required: true },
        mimeType: { kind: 'string', required: true },
        size: { kind: 'number', required: true },
        filename: { kind: 'string' },
      },
    });
  }

  /**
   * Fast-fail for the ifVersion precondition using the already-fetched
   * record. The adapter re-checks atomically at write time (the source of
   * truth for concurrent writers) — this just skips validation and
   * snapshotting work when the mismatch is already visible.
   */
  private checkIfVersion(existing: StackRecord, ifVersion: number | undefined): void {
    if (ifVersion === undefined || existing.version === ifVersion) return;
    throw new StackVersionConflictError(
      `Record "${existing.id}" is at version ${existing.version}, expected ${ifVersion}`,
      existing.id,
      ifVersion,
      existing.version,
    );
  }

  /**
   * The options every version-bumping adapter write carries: the `ifVersion`
   * precondition, the prior-state snapshot that has to land in the same
   * atomic write, and who to attribute the change to. Taken together so a
   * new mutating verb cannot quietly omit one — the actor's `principalId`
   * most of all, whose absence reads as an undelegated write.
   * See docs/spec/versioning.md § Version history.
   */
  private writeOptions(existing: StackRecord, opts: IfVersionOptions & ActorOptions) {
    return {
      ifVersion: opts.ifVersion,
      snapshot: this.buildVersionSnapshot(existing),
      actor: normalizeActor(opts.actor),
    };
  }

  /**
   * Snapshot of a record's prior state, passed with the mutating adapter
   * call so snapshot and mutation land in one atomic write. Carries what
   * only a snapshot preserves: `content` and the `typeId` it is read
   * under. Containment, listing and associations — the authority ones
   * among them — are all kept by the journal instead, so no version ever
   * snapshots them and there is nothing for a restore to roll them back
   * to. See docs/spec/versioning.md § Version history.
   */
  private buildVersionSnapshot(record: StackRecord): RecordVersion {
    return {
      version: record.version,
      typeId: record.typeId,
      content: record.content,
      updatedAt: record.updatedAt,
      ...(record.createdBy && { createdBy: record.createdBy }),
      ...(record.updatedBy && { updatedBy: record.updatedBy }),
    };
  }
}
