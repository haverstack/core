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
 *  - Soft and hard delete
 *
 * Apps should never talk to a StackAdapter directly.
 */

import { generateId, isValidIdFormat, idTimestamp } from './id.js';
import { hashSchema, isCompatible, parseTypeId, baseIdOf, diffSchemas } from './schema.js';
import type { SchemaDriftViolation } from './schema.js';
import { validateContent } from './validate.js';
import { applyMergePatch } from './merge.js';
import { checkAccess, groupRoleFromAssociations } from './access.js';
import { SYSTEM_TYPES } from './types.js';
import type { ValidationError } from './validate.js';
import type {
  StackRecord,
  StackType,
  TypeSchema,
  TypeId,
  StackAdapter,
  StackQuery,
  RecordFilter,
  QueryResult,
  Association,
  Permission,
  Migration,
  MigrationFn,
  RecordVersion,
  StackFeatures,
  GrantAction,
  GrantContent,
  AttachmentContent,
  ConfigContent,
  EntityId,
  EntityContent,
} from './types.js';

// -------------------------------------------------------
// Supporting types
// -------------------------------------------------------

/** Sentinel: filter.baseId resolved to zero matching types. */
const EMPTY_FAMILY = Symbol('empty-family');

export type CreateRecordOptions = {
  /**
   * Client-minted record ID. Must be 12 lowercase Crockford base-32
   * characters and may not use the reserved `_` prefix. Omit to let the
   * library generate one. See Stack.create() and ScopedStack.create()
   * for the validation each applies.
   */
  id?: string;
  parentId?: string;
  entityId?: EntityId;
  appId?: string;
  permissions?: Permission[];
  associations?: Association[];
};

export type StackOptions = {
  /**
   * Ensures the owner's own `_entity` profile record exists, creating it
   * (`did: ownerEntityId`, plus `name`/`handle`) if this is the first
   * Stack.create() call against a freshly initialized adapter. No-ops if a
   * record with this DID already exists, so it's safe to pass on every
   * open, not just the first one — this is what closes the gap where
   * nothing used to create the owner's `_entity` record at all. See
   * docs/spec.md § Identity.
   */
  ownerProfile?: { name: string; handle?: string };
  /**
   * Clock-skew tolerance (ms) for the timestamp-prefix plausibility check
   * ScopedStack.create() runs on a grantee-supplied `id` — a grantee is an
   * untrusted actor who could otherwise mint an ID that forges its sort
   * position. Default: 24 hours. Pass null to disable the check entirely.
   * Unscoped Stack.create() never runs this check (full-trust context).
   */
  idTimestampSkewMs?: number | null;
};

export type CollectAttachmentGarbageOptions = {
  /**
   * How recent an unreferenced file must be to survive collection, covering
   * the legitimate upload-then-associate window. Default: 24 hours (see
   * DEFAULT_GC_GRACE_MS). Pass 0 to collect anything unreferenced right now.
   */
  graceMs?: number;
  /** Compute what would be deleted without deleting anything. Default: false. */
  dryRun?: boolean;
};

export type CollectAttachmentGarbageResult = {
  deleted: string[];
  reclaimedBytes: number;
};

export type GetRecordOptions = {
  /**
   * Records are returned exactly as stored by default ("stored"). Pass
   * "latest" to apply the registered migration chain in memory before
   * returning — never written back. Throws StackMigrationError if the
   * record has no registered path to the latest version.
   */
  presentAt?: 'stored' | 'latest';
};

/**
 * Opt-in optimistic-concurrency precondition, accepted by every mutation
 * that bumps a record's version (update, delete, undelete, associate,
 * dissociate, setPermissions, restoreVersion). When set, the mutation
 * only applies if the record's current version equals `ifVersion`;
 * otherwise it throws StackVersionConflictError, with the record's actual
 * current version, and nothing is changed. Omit to keep today's
 * last-writer-wins behavior — apps that don't care don't pay.
 */
export type IfVersionOptions = {
  ifVersion?: number;
};

export type DeleteRecordOptions = IfVersionOptions & {
  /** If true, permanently remove the record and all its history. Default: false */
  hard?: boolean;
};

export type DefineTypeOptions = {
  migratesFrom?: TypeId;
};

export class StackValidationError extends Error {
  static readonly code = 'validation' as const;
  constructor(public readonly errors: ValidationError[]) {
    super(
      `Content validation failed:\n` + errors.map((e) => `  ${e.path}: ${e.message}`).join('\n'),
    );
    this.name = 'StackValidationError';
  }
}

export class StackMigrationError extends Error {
  static readonly code = 'migration' as const;
  constructor(message: string) {
    super(message);
    this.name = 'StackMigrationError';
  }
}

/** Thrown by ScopedStack when a requester lacks permission for the operation. */
export class StackPermissionError extends Error {
  static readonly code = 'permission' as const;
  constructor(message = 'Permission denied') {
    super(message);
    this.name = 'StackPermissionError';
  }
}

/** Thrown when a record (or specific version) does not exist. */
export class StackNotFoundError extends Error {
  static readonly code = 'not_found' as const;
  constructor(message: string) {
    super(message);
    this.name = 'StackNotFoundError';
  }
}

/** Thrown when an operation cannot proceed due to a constraint violation (e.g. deleting an attachment that is still referenced). */
export class StackConflictError extends Error {
  static readonly code = 'conflict' as const;
  constructor(message: string) {
    super(message);
    this.name = 'StackConflictError';
  }
}

/**
 * Thrown when an opt-in `ifVersion` precondition doesn't match a record's
 * current version — the one conflict type a caller can mechanically
 * recover from: re-fetch, look at `actualVersion`, decide whether to
 * retry. Deliberately not a StackConflictError subtype: the two have
 * different recovery stories (fix your input vs. retry after re-reading)
 * and, on the wire, different HTTP statuses (409 vs. 412) — sharing a
 * base class would either force one status per subtype or blur the
 * status↔code mapping for status-only error reconstruction.
 */
export class StackVersionConflictError extends Error {
  static readonly code = 'version_conflict' as const;
  constructor(
    message: string,
    readonly recordId: string,
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(message);
    this.name = 'StackVersionConflictError';
  }
}

/**
 * Thrown when a request is structurally malformed — not a content-validation
 * failure, but input the adapter/server can't even interpret (e.g. an
 * undecodable pagination cursor). Distinct from StackValidationError, which
 * means the request was well-formed but content failed schema validation.
 */
export class StackQueryError extends Error {
  static readonly code = 'bad_request' as const;
  constructor(message: string) {
    super(message);
    this.name = 'StackQueryError';
  }
}

/**
 * Thrown by defineType() when redefining an existing typeId with a schema
 * change that isn't a legal in-place evolution (see diffSchemas() in
 * schema.ts) — same typeId, a shape change beyond "new optional fields
 * added." The remedy is always the same: register a new version instead of
 * redefining this one in place.
 */
export class StackSchemaDriftError extends Error {
  static readonly code = 'schema_drift' as const;
  constructor(
    public readonly typeId: TypeId,
    public readonly violations: SchemaDriftViolation[],
  ) {
    super(
      `Schema drift detected for type "${typeId}": the stored schema and the new definition ` +
        `differ beyond additive evolution (new optional fields only). Bump the version instead ` +
        `of redefining "${typeId}" in place — e.g. defineType(\`${baseIdOf(typeId)}@${(parseTypeId(typeId)?.version ?? 0) + 1}\`, ...) plus registerMigration().\n` +
        violations.map((v) => `  ${v.path || '(root)'}: ${v.message}`).join('\n'),
    );
    this.name = 'StackSchemaDriftError';
  }
}

// -------------------------------------------------------
// Record ID validation
// -------------------------------------------------------

const RESERVED_ID_PREFIX = '_';
const DEFAULT_ID_TIMESTAMP_SKEW_MS = 24 * 60 * 60 * 1000;

/**
 * Default grace period for Stack.collectAttachmentGarbage(): how recent an
 * unreferenced file's newest _attachment@1 metadata record (or, for bare
 * bytes with none, the blob's own modifiedAt) must be to still protect it
 * from collection — covering the legitimate upload-then-associate window.
 * Same value and rationale as DEFAULT_ID_TIMESTAMP_SKEW_MS: a generous
 * tolerance at personal-stack scale.
 */
const DEFAULT_GC_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Format and reserved-prefix checks — full-trust context (Stack.create()).
 * Checked before the format check: the Crockford charset already excludes
 * "_", so a reserved-looking id (e.g. "_config") would otherwise just fail
 * as a generic format error instead of a specific, actionable one.
 */
function validateRecordId(id: string): void {
  if (id.startsWith(RESERVED_ID_PREFIX)) {
    throw new StackValidationError([
      { path: 'id', message: `ID "${id}" uses the reserved "${RESERVED_ID_PREFIX}" prefix.` },
    ]);
  }
  if (!isValidIdFormat(id)) {
    throw new StackValidationError([
      {
        path: 'id',
        message: `Invalid ID "${id}": expected 12 lowercase Crockford base-32 characters.`,
      },
    ]);
  }
}

/**
 * Timestamp-prefix plausibility check for grantee-minted IDs
 * (ScopedStack.create()) — a grantee is untrusted and could otherwise mint
 * an ID that forges its sort position. Pass null to disable.
 */
function validateIdTimestampSkew(id: string, toleranceMs: number | null): void {
  if (toleranceMs === null) return;
  const skew = Math.abs(Date.now() - idTimestamp(id));
  if (skew > toleranceMs) {
    throw new StackValidationError([
      {
        path: 'id',
        message: `ID "${id}" timestamp is outside the allowed clock-skew tolerance (${toleranceMs}ms).`,
      },
    ]);
  }
}

// -------------------------------------------------------
// StackClient interface
// -------------------------------------------------------

/**
 * The app-facing record API, implemented by both Stack and ScopedStack.
 * Accept this type in plugin or extension code to remain adapter-agnostic
 * and work equally well with a full Stack or a permission-scoped view.
 */
export interface StackClient {
  readonly features: StackFeatures;
  create<T extends Record<string, unknown> = Record<string, unknown>>(
    typeId: TypeId,
    content: T,
    opts?: CreateRecordOptions,
  ): Promise<StackRecord & { content: T }>;
  get(id: string, opts?: GetRecordOptions): Promise<StackRecord | null>;
  query(query?: StackQuery): Promise<QueryResult>;
  update(
    id: string,
    content: Record<string, unknown | null>,
    opts?: IfVersionOptions,
  ): Promise<StackRecord>;
  associate(id: string, association: Association, opts?: IfVersionOptions): Promise<void>;
  dissociate(id: string, association: Association, opts?: IfVersionOptions): Promise<void>;
  setPermissions(id: string, permissions: Permission[], opts?: IfVersionOptions): Promise<void>;
  delete(id: string, opts?: DeleteRecordOptions): Promise<void>;
  undelete(id: string, opts?: IfVersionOptions): Promise<StackRecord>;
  getVersions(id: string): Promise<RecordVersion[]>;
  getVersion(id: string, version: number): Promise<RecordVersion | null>;
  restoreVersion(id: string, version: number, opts?: IfVersionOptions): Promise<StackRecord>;
  getAttachment(fileId: string): Promise<Uint8Array>;
  putAttachment(data: Uint8Array, mimeType: string, filename?: string): Promise<string>;
  deleteAttachment(fileId: string): Promise<void>;
  collectAttachmentGarbage(
    opts?: CollectAttachmentGarbageOptions,
  ): Promise<CollectAttachmentGarbageResult>;
}

// -------------------------------------------------------
// Query helpers
// -------------------------------------------------------

/**
 * query() always paginates: an absent `limit` returns one adapter-default
 * page, never the complete result set. This walks `cursor` to exhaustion
 * for the handful of internal call sites that need every match — grant
 * checks, attachment-metadata cleanup, uploader-access checks — where
 * silently stopping at page one would misfire past the page boundary
 * (deny an existing grant, leave orphaned metadata, false-deny an
 * uploader). Not a public API: callers that can tolerate normal paging
 * should call query() directly.
 *
 * Throws StackQueryError rather than silently truncating if more than
 * `max` records are found without the cursor terminating — a runaway
 * scan is a bug to surface, not paper over.
 */
async function queryAllPages(
  run: (query: StackQuery) => Promise<QueryResult>,
  query: StackQuery,
  max = QUERY_ALL_MAX,
): Promise<StackRecord[]> {
  const records: StackRecord[] = [];
  let cursor = query.cursor;
  do {
    const page = await run({ ...query, cursor });
    records.push(...page.records);
    if (records.length > max) {
      throw new StackQueryError(
        `queryAllPages: exceeded max of ${max} records without exhausting the cursor`,
      );
    }
    cursor = page.cursor ?? undefined;
  } while (cursor);
  return records;
}

/** Safety cap for queryAllPages() — generous for personal-stack scale. */
const QUERY_ALL_MAX = 10_000;

// -------------------------------------------------------
// Stack class
// -------------------------------------------------------

export class Stack implements StackClient {
  private readonly migrations = new Map<TypeId, Migration>();
  /**
   * Highest version this Stack instance has itself defineType()'d, per
   * baseId — i.e. what *this app process* currently understands, as
   * distinct from whatever versions happen to exist in shared storage.
   * Used to detect the stale-writer case in presentAtLatest().
   */
  private readonly maxDefinedVersion = new Map<string, number>();
  /**
   * In-memory cache of Types this instance has fetched or defined, keyed by
   * versioned id. A Type's schema is immutable once defined — schemaHash
   * only changes via a version bump, which is a different id and thus a
   * different cache entry — so entries are never invalidated, only added
   * (by getTypeCached() on first fetch, and by defineType() on write).
   * listTypes() also refreshes it wholesale. This is what removes the
   * GET /types/:id round trip that create()/update()/restoreVersion() would
   * otherwise pay on every write for a value that cannot change.
   */
  private readonly typeCache = new Map<TypeId, StackType>();

  private constructor(
    private readonly adapter: StackAdapter,
    private readonly idTimestampSkewMsValue: number | null,
  ) {}

  private async getTypeCached(id: TypeId): Promise<StackType | null> {
    const cached = this.typeCache.get(id);
    if (cached) return cached;
    const type = await this.adapter.getType(id);
    if (type) this.typeCache.set(id, type);
    return type;
  }

  /**
   * Create a Stack instance. Reads ownerEntityId and timezone from the adapter.
   */
  static async create(adapter: StackAdapter, opts: StackOptions = {}): Promise<Stack> {
    if (!adapter.ownerEntityId) {
      throw new Error(
        'Stack misconfiguration: adapter has no ownerEntityId. ' +
          'Initialise the adapter with an entityId before calling Stack.create().',
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
   * Idempotent bootstrap for StackOptions.ownerProfile: creates the owner's
   * `_entity` record if none exists yet for their DID. Queries by typeId
   * only (a universally-supported native filter) and matches `content.did`
   * in memory, rather than relying on RecordFilter.content — which is
   * capability-gated and not every adapter implements. `_entity` records
   * are stack-local petname cards, not a global directory, so the result
   * set here stays small by design (see docs/spec.md § Identity).
   */
  private async ensureOwnerEntity(profile: { name: string; handle?: string }): Promise<void> {
    const entityTypeId = `${SYSTEM_TYPES.ENTITY}@1`;
    const { records } = await this.adapter.queryRecords({ filter: { typeId: entityTypeId } });
    const exists = records.some((r) => (r.content as EntityContent).did === this.ownerEntityId);
    if (exists) return;

    await this.create<EntityContent>(entityTypeId, {
      did: this.ownerEntityId,
      name: profile.name,
      ...(profile.handle && { handle: profile.handle }),
    });
  }

  get ownerEntityId(): EntityId {
    return this.adapter.ownerEntityId;
  }

  get timezone(): string | undefined {
    return this.adapter.timezone;
  }

  get features(): StackFeatures {
    return this.adapter.capabilities;
  }

  /**
   * Get a permission-scoped view of this Stack, as if the request came from
   * the given entity. Pass null for an anonymous/unauthenticated requester.
   * Reads and writes are checked against each Record's `permissions`; the
   * owner always has full access.
   *
   * Plain Stack methods are unscoped and skip permission checks entirely —
   * correct for single-entity embedded use, where there's no requester
   * distinct from the app itself. Use asEntity() when one Stack instance
   * serves requests from multiple, possibly untrusted, entities (e.g. a
   * multi-tenant API server).
   */
  asEntity(entityId: EntityId | null): ScopedStack {
    return new ScopedStack(this, entityId, this.idTimestampSkewMsValue, this.adapter);
  }

  // -------------------------------------------------------
  // Types
  // -------------------------------------------------------

  /**
   * Define and persist a Type. Computes the schemaHash automatically.
   * Should be called at app startup before creating any records of this type.
   *
   * Redefining an existing typeId is checked against the stored schema
   * (#68), instead of silently replacing it (the exact corruption
   * schemaHash exists to catch, previously undetected since nothing ever
   * compared it):
   *
   * - Identical schema and name — fully idempotent no-op, `createdAt`
   *   untouched. This is what makes calling defineType() for every system
   *   type on every `Stack.create()` (seedSystemTypes()) cheap instead of
   *   six unconditional rewrites per open.
   * - Identical schema, different name — name is display metadata, not
   *   schema, so this always persists; `createdAt` is preserved from the
   *   stored type either way.
   * - Different schema — legal only if the change is a pure additive
   *   evolution (diffSchemas(): new *optional* fields only, nothing
   *   removed/retyped/re-required). Otherwise throws StackSchemaDriftError
   *   naming each violation; the remedy is a new version
   *   (`defineType('...@n+1', ...)` + `registerMigration()`), never an
   *   in-place rewrite.
   */
  async defineType(
    id: TypeId,
    name: string,
    schema: TypeSchema,
    opts: DefineTypeOptions = {},
  ): Promise<StackType> {
    const parsed = parseTypeId(id);
    if (!parsed) {
      throw new Error(
        `Invalid TypeId format: "${id}". Expected "namespace/name@version", e.g. "com.example.myapp/note@1".`,
      );
    }

    // This instance now knows this version exists, independent of whether
    // the adapter write below turns out to be a no-op — presentAtLatest()'s
    // stale-writer detection depends on every defineType() call registering
    // here, including the idempotent-no-op path.
    const priorMax = this.maxDefinedVersion.get(parsed.baseId) ?? 0;
    if (parsed.version > priorMax) this.maxDefinedVersion.set(parsed.baseId, parsed.version);

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
      ...(opts.migratesFrom && { migratesFrom: opts.migratesFrom }),
    };

    await this.adapter.saveType(type);
    this.typeCache.set(id, type);
    return type;
  }

  async getType(id: TypeId): Promise<StackType | null> {
    return this.getTypeCached(id);
  }

  /** Refreshes typeCache wholesale — the explicit way to see a rename made by another writer. */
  async listTypes(): Promise<StackType[]> {
    const types = await this.adapter.listTypes();
    for (const type of types) this.typeCache.set(type.id, type);
    return types;
  }

  /**
   * Check whether a record's type is compatible with a required schema.
   * Useful for duck-typed consumption across types.
   */
  async typeIsCompatible(typeId: TypeId, requiredSchema: TypeSchema): Promise<boolean> {
    const type = await this.getTypeCached(typeId);
    if (!type) return false;
    return isCompatible(type.schema, requiredSchema);
  }

  // -------------------------------------------------------
  // Migration registry
  // -------------------------------------------------------

  /**
   * Register a migration function between two adjacent Type versions.
   * Call at app startup after defineType(). The library composes
   * adjacent migrations into chains automatically.
   *
   * Migrations run in-memory — they do not write to the adapter unless
   * you call migrateAll() explicitly.
   */
  registerMigration(migration: Migration): void {
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
   * Eagerly migrate all records of a type family to the latest version,
   * committing the results to disk immediately. This is the *only* way a
   * record's disk state changes version — the library never migrates as a
   * side effect of a read or an unrelated content edit. Call it at app
   * startup after registerMigration(), or after a schema change.
   *
   * Sweeps soft-deleted records unconditionally (includeDeleted: true is
   * not a caller option in either direction) so a record can't come back
   * from undelete() stale merely because it was deleted during a migration
   * window.
   *
   * Each record's migrated content is validated against the target type's
   * schema before it's written; a validation failure aborts the batch
   * immediately (a buggy migration function is a bug, not something to
   * paper over by skipping the offending records) — anything already
   * committed earlier in the pass stays committed. Previous content is
   * preserved in version history before each write.
   */
  async migrateAll(baseTypeId: string): Promise<{ migrated: number }> {
    const types = await this.adapter.listTypes();
    const familyTypeIds = types.filter((t) => t.baseId === baseTypeId).map((t) => t.id);

    if (familyTypeIds.length === 0) {
      throw new StackMigrationError(
        `migrateAll: no registered types found for baseTypeId "${baseTypeId}"`,
      );
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
          filter: { typeId, includeDeleted: true },
          limit: 100,
          cursor,
        });

        for (const record of result.records) {
          const migratedContent = migrateFn(record.content);
          const errors = validateContent(migratedContent, latestType.schema);
          if (errors.length > 0) {
            throw new StackValidationError(errors);
          }

          await this.saveVersion(record);
          await this.adapter.commitMigration(record.id, latestId, migratedContent);
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
   */
  async create<T extends Record<string, unknown> = Record<string, unknown>>(
    typeId: TypeId,
    content: T,
    opts: CreateRecordOptions = {},
  ): Promise<StackRecord & { content: T }> {
    const type = await this.getTypeCached(typeId);
    if (!type) {
      throw new Error(`Unknown type: "${typeId}". Call defineType() first.`);
    }

    const errors = validateContent(content, type.schema);
    if (errors.length > 0) {
      throw new StackValidationError(errors);
    }

    if (typeId === `${SYSTEM_TYPES.ATTACHMENT}@1`) {
      await this.checkAttachmentMimeTypeOnCreate(content as unknown as AttachmentContent);
    }

    if (opts.id !== undefined) {
      validateRecordId(opts.id);
      if (await this.adapter.getRecord(opts.id)) {
        throw new StackConflictError(`Record already exists: "${opts.id}"`);
      }
    }

    const now = new Date();
    const record: StackRecord = {
      id: opts.id ?? generateId(),
      typeId,
      createdAt: now,
      updatedAt: now,
      content,
      version: 1,
      ...(opts.parentId && { parentId: opts.parentId }),
      ...(opts.entityId && { entityId: opts.entityId }),
      ...(opts.appId && { appId: opts.appId }),
      ...(opts.permissions?.length && { permissions: opts.permissions }),
      ...(opts.associations?.length && { associations: opts.associations }),
    };

    return this.adapter.createRecord(record) as Promise<StackRecord & { content: T }>;
  }

  /**
   * Apply the registered migration chain to a record in memory, for the
   * presentAt: 'latest' opt-in on get() and query(). Never writes back —
   * only migrateAll() commits a migration to disk.
   *
   * If there's no forward migration path from the record's stored version,
   * that's only unambiguous when this app instance has never defineType()'d
   * a different version of the family — otherwise the record's version
   * disagrees with what this app understands (older with a registration
   * gap, or newer than anything this app has ever defined — the
   * stale-writer case) and presentAt: 'latest' can't honor the request.
   * Throws StackMigrationError rather than silently returning the raw
   * record with a console.warn.
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
   * Get a record by ID, exactly as stored (its own typeId and content —
   * no implicit migration).
   *
   * Pass { presentAt: 'latest' } to apply the registered migration chain
   * in memory instead; nothing is written to disk. Committing a migration
   * to disk is exclusively migrateAll()'s job.
   */
  async get(id: string, opts: GetRecordOptions = {}): Promise<StackRecord | null> {
    const record = await this.adapter.getRecord(id);
    if (!record) return null;
    return opts.presentAt === 'latest' ? this.presentAtLatest(record) : record;
  }

  /**
   * Update a record's content. Accepts a partial content object — only the
   * fields provided are changed. Omitted fields retain their current values.
   *
   * To remove an optional field, set it explicitly to null:
   *   stack.update(id, { title: null })  // removes 'title' from content
   *
   * Validates the merged result against the record's *current* stored
   * type's schema — update() never changes a record's typeId as a side
   * effect. Migrating disk state is migrateAll()'s job exclusively, so an
   * unrelated content edit never folds an invisible schema rewrite into
   * the same version-history entry.
   *
   * Saves the previous state to version history before updating.
   *
   * For association or permission changes, use associate(), dissociate(),
   * and setPermissions() instead.
   */
  async update(
    id: string,
    content: Record<string, unknown | null>,
    opts: IfVersionOptions = {},
  ): Promise<StackRecord> {
    const existing = await this.adapter.getRecord(id);
    if (!existing) {
      throw new StackNotFoundError(`Record not found: "${id}"`);
    }
    this.checkIfVersion(existing, opts.ifVersion);

    const type = await this.getTypeCached(existing.typeId);
    if (!type) {
      throw new Error(`Unknown type: "${existing.typeId}"`);
    }

    // Merge (RFC 7396 / JSON Merge Patch): null values delete a field.
    const merged = applyMergePatch(existing.content, content);

    const errors = validateContent(merged, type.schema);
    if (errors.length > 0) {
      throw new StackValidationError(errors);
    }

    if (existing.typeId === `${SYSTEM_TYPES.ATTACHMENT}@1`) {
      this.checkAttachmentImmutableFields(
        content,
        existing.content as AttachmentContent,
        merged as AttachmentContent,
      );
    }

    if (id === SYSTEM_TYPES.CONFIG) {
      this.checkConfigEntityIdUnchanged(
        (existing.content as ConfigContent).entityId,
        (merged as ConfigContent).entityId,
      );
    }

    // Snapshot the raw stored state before overwriting
    await this.saveVersion(existing);

    return this.adapter.patchContent(id, content, { expectedVersion: opts.ifVersion });
  }

  /**
   * Add an association to a record. Snapshots the record's prior state and
   * bumps version, same as update() — associations are covered by the same
   * versioning rule as content.
   * If the association already exists (same kind, label, and payload), this is a no-op.
   */
  async associate(
    id: string,
    association: Association,
    opts: IfVersionOptions = {},
  ): Promise<void> {
    const existing = await this.adapter.getRecord(id);
    if (!existing) {
      throw new StackNotFoundError(`Record not found: "${id}"`);
    }
    this.checkIfVersion(existing, opts.ifVersion);
    if ((existing.associations ?? []).some((a) => associationEqual(a, association))) return;

    await this.saveVersion(existing);
    await this.adapter.associate(id, association, { expectedVersion: opts.ifVersion });
  }

  /**
   * Remove an association from a record. Snapshots and bumps version, same
   * as associate(). Matched by kind, label, and payload. No-op if not found.
   */
  async dissociate(
    id: string,
    association: Association,
    opts: IfVersionOptions = {},
  ): Promise<void> {
    const existing = await this.adapter.getRecord(id);
    if (!existing) {
      throw new StackNotFoundError(`Record not found: "${id}"`);
    }
    this.checkIfVersion(existing, opts.ifVersion);
    if (!(existing.associations ?? []).some((a) => associationEqual(a, association))) return;

    await this.saveVersion(existing);
    await this.adapter.dissociate(id, association, { expectedVersion: opts.ifVersion });
  }

  /**
   * Replace all permissions on a record. Snapshots and bumps version, same
   * as associate(). Pass an empty array to make the record private (the
   * default). No-op if the new set is deep-equal to the current one.
   */
  async setPermissions(
    id: string,
    permissions: Permission[],
    opts: IfVersionOptions = {},
  ): Promise<void> {
    const existing = await this.adapter.getRecord(id);
    if (!existing) {
      throw new StackNotFoundError(`Record not found: "${id}"`);
    }
    this.checkIfVersion(existing, opts.ifVersion);
    if (permissionsEqual(existing.permissions ?? [], permissions)) return;

    await this.saveVersion(existing);
    await this.adapter.setPermissions(id, permissions, { expectedVersion: opts.ifVersion });
  }

  /**
   * Soft-delete a record (default) or hard-delete it permanently.
   * Soft-deleted records are excluded from queries unless includeDeleted is set.
   * Hard-deleted records and all their version history are permanently removed.
   *
   * Soft delete snapshots the record's prior state and bumps version, same
   * as update(); it's a no-op if the record is already deleted. Hard delete
   * destroys the record (and its version history) outright — there's
   * nothing to snapshot.
   *
   * `_config` can never be deleted, soft or hard (#67): it's the stack's
   * identity record, read at open and consulted by every permission check.
   * A soft-deleted `_config` is unreadable through normal paths; a
   * hard-deleted one bricks the stack outright (nothing to reopen against).
   */
  async delete(id: string, opts: DeleteRecordOptions = {}): Promise<void> {
    if (id === SYSTEM_TYPES.CONFIG) {
      throw new StackConflictError(
        "Cannot delete the _config record: it holds the stack's identity and is required for every permission check.",
      );
    }
    if (opts.hard) {
      return this.adapter.deleteRecord(id, { hard: true, expectedVersion: opts.ifVersion });
    }

    const existing = await this.adapter.getRecord(id);
    if (!existing) {
      throw new StackNotFoundError(`Record not found: "${id}"`);
    }
    this.checkIfVersion(existing, opts.ifVersion);
    if (existing.deletedAt) return;

    await this.saveVersion(existing);
    await this.adapter.deleteRecord(id, { expectedVersion: opts.ifVersion });
  }

  /**
   * Reverse a soft delete. Idempotent — undeleting a record that isn't
   * deleted returns it unchanged. Hard-deleted records are gone, so this
   * throws StackNotFoundError for them just like any other missing record.
   * Snapshots and bumps version, same as delete().
   */
  async undelete(id: string, opts: IfVersionOptions = {}): Promise<StackRecord> {
    const existing = await this.adapter.getRecord(id);
    if (!existing) {
      throw new StackNotFoundError(`Record not found: "${id}"`);
    }
    this.checkIfVersion(existing, opts.ifVersion);
    if (!existing.deletedAt) return existing;

    await this.saveVersion(existing);
    return this.adapter.undeleteRecord(id, { expectedVersion: opts.ifVersion });
  }

  /**
   * Query records. See StackQuery for filter, sort, and pagination options.
   *
   * filter.baseId matches every version of a type family, resolved against
   * registered Types (not string-parsed from typeId) — this is what fixes
   * `query({ filter: { baseId } })` missing not-yet-migrated older-version
   * records. Records are returned exactly as stored by default; pass
   * presentAt: 'latest' to migrate each result in memory (see get()).
   */
  async query(query: StackQuery = {}): Promise<QueryResult> {
    const { presentAt, filter, limit: rawLimit, ...rest } = query;
    const limit = rawLimit !== undefined ? Math.min(rawLimit, MAX_QUERY_LIMIT) : undefined;

    const resolvedFilter = await this.resolveBaseIdFilter(filter);
    if (resolvedFilter === EMPTY_FAMILY) {
      return { records: [], cursor: null, total: 0 };
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
   * Resolve filter.baseId into a concrete typeId set via listTypes(), so
   * adapters — which only know about typeId — never need their own baseId
   * concept. Intersects with filter.typeId when both are given. Returns
   * EMPTY_FAMILY as a sentinel when the resolved set is empty (unknown
   * baseId, or a typeId/baseId combination with no overlap), so the caller
   * can short-circuit without a wasted adapter round trip.
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

  async getVersions(id: string): Promise<RecordVersion[]> {
    return this.adapter.getVersions(id);
  }

  async getVersion(id: string, version: number): Promise<RecordVersion | null> {
    return this.adapter.getVersion(id, version);
  }

  /**
   * Restore a record to a previous version by creating a new version
   * with the old content and typeId. Never rewrites history.
   *
   * Validates the snapshot's content against the *snapshot's own* stored
   * type — not the record's current type, which may have since migrated.
   * A snapshot taken before a migration is `@1`-shaped; validating it
   * against a current `@2` schema would wrongly reject a perfectly valid
   * restore. Restoring an old-version snapshot therefore leaves the record
   * stale at that old typeId, same as undelete() — legal, and healed by
   * the owning app's next migrateAll() sweep. This never forward-migrates:
   * migration functions are app code, and restore shouldn't behave
   * differently locally than a server-side restore endpoint could.
   *
   * Restores associations too, when the target snapshot has them. Never
   * restores permissions — those are owner/creator territory (see
   * setPermissions()), and silently reverting an ACL as a side effect of a
   * content rollback would be a surprise nobody wants. Permissions in a
   * snapshot are for audit and deliberate owner action, not automatic restore.
   */
  async restoreVersion(
    id: string,
    version: number,
    opts: IfVersionOptions = {},
  ): Promise<StackRecord> {
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
      throw new Error(`Unknown type: "${target.typeId}"`);
    }

    const errors = validateContent(target.content, type.schema);
    if (errors.length > 0) {
      throw new StackValidationError(errors);
    }

    if (id === SYSTEM_TYPES.CONFIG) {
      this.checkConfigEntityIdUnchanged(
        (existing.content as ConfigContent).entityId,
        (target.content as ConfigContent).entityId,
      );
    }

    // Snapshot current state before restoring
    await this.saveVersion(existing);

    return this.adapter.restoreVersion(id, version, { expectedVersion: opts.ifVersion });
  }

  // -------------------------------------------------------
  // Attachments
  // -------------------------------------------------------

  /**
   * `_attachment@1` invariant (#65): mimeType is a property of the fileId,
   * not the uploader's perspective — unlike filename, which is. Dedup means
   * a second upload of identical bytes doesn't create a second file, it
   * attaches a second execution claim to the first uploader's bytes; the
   * first metadata record created for a given fileId fixes the type that
   * gets served, so a later upload declaring a different mimeType is
   * rejected rather than silently coexisting for the server to arbitrarily
   * pick between. Cursor-walked (#50): a single unpaginated page could miss
   * the fileId's earlier records and wrongly treat a conflicting upload as
   * the first.
   */
  private async checkAttachmentMimeTypeOnCreate(content: AttachmentContent): Promise<void> {
    const { fileId, mimeType } = content;
    if (typeof fileId !== 'string') return; // schema validation already rejected this

    const metadataTypeId = `${SYSTEM_TYPES.ATTACHMENT}@1`;
    const results = await queryAllPages((q) => this.query(q), {
      filter: {
        typeId: metadataTypeId,
        includeDeleted: true,
        ...(this.features.contentFieldQuery && { content: { fileId } }),
      },
    });
    const existing = this.features.contentFieldQuery
      ? results
      : results.filter((r) => (r.content as AttachmentContent).fileId === fileId);
    if (existing.length === 0) return;

    const first = existing.reduce((a, b) => (a.createdAt <= b.createdAt ? a : b));
    const establishedMimeType = (first.content as AttachmentContent).mimeType;
    if (mimeType !== establishedMimeType) {
      // Anti-oracle (#106): the established mimeType is deliberately not
      // interpolated into the message. Naming it would confirm the fileId's
      // existing content type to a caller who only guessed the fileId,
      // reintroducing the exact confirmation-oracle #51's anti-oracle rule
      // exists to prevent.
      throw new StackValidationError([
        {
          path: 'mimeType',
          message: 'mimeType conflicts with the mimeType already established for this fileId',
        },
      ]);
    }
  }

  /**
   * `_attachment@1` invariant (#65): filename is the only mutable field
   * once a metadata record exists. fileId and size describe the bytes
   * themselves, so any change is rejected. mimeType's value was already
   * pinned to the fileId's established type at create time (above) — even a
   * same-value rewrite is refused, since first-recorded-wins leaves nothing
   * legitimate for a later mimeType edit to do. The correction flow for a
   * wrongly-declared type is delete + re-upload: identical bytes hash to
   * the same fileId, and the fresh first record establishes the fix.
   */
  private checkAttachmentImmutableFields(
    patch: Record<string, unknown | null>,
    existing: AttachmentContent,
    merged: AttachmentContent,
  ): void {
    const errors: ValidationError[] = [];
    if (Object.prototype.hasOwnProperty.call(patch, 'mimeType')) {
      errors.push({
        path: 'mimeType',
        message: 'mimeType is immutable after creation; delete and re-upload to change it',
      });
    }
    if (
      Object.prototype.hasOwnProperty.call(patch, 'fileId') &&
      merged.fileId !== existing.fileId
    ) {
      errors.push({ path: 'fileId', message: 'fileId is immutable' });
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'size') && merged.size !== existing.size) {
      errors.push({ path: 'size', message: 'size is immutable' });
    }
    if (errors.length > 0) {
      throw new StackValidationError(errors);
    }
  }

  /**
   * `_config.entityId` defines stack ownership — read once at open and
   * consulted by every permission check thereafter (#67). Neither update()
   * nor restoreVersion() may change it: a write that silently re-anchors
   * ownership would desync every already-running owner check from the next
   * reopen onward. This is a conflict with stack integrity, not a schema
   * violation (the new value is a perfectly valid string) — hence
   * StackConflictError, matching delete()'s guard on the same record.
   * Ownership transfer, if it ever exists, is a deliberate future API with
   * key-custody semantics (#49), not a field write.
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
   * Store bytes and create an _attachment@1 metadata record (owner-attributed,
   * no entityId). Use ScopedStack.putAttachment() when the uploader is a
   * specific entity rather than the stack owner.
   *
   * When the adapter implements the optional putAttachmentWithMetadata()
   * capability (the API adapter, via one POST /attachments request the
   * server fulfills atomically — #106), the whole operation is delegated to
   * it and the separate create() call below is skipped — not for
   * efficiency, but because a second, independent record-creation call
   * would be indistinguishable, server-side, from a non-owner who never
   * uploaded anything and only guessed the fileId. On that path the
   * returned record is trusted as backend-authoritative: client-side schema
   * validation and the mimeType-conflict check don't run here — the server
   * runs both (a client-side conflict check against remote state would be
   * both racy and itself a mini-oracle). Adapters without the capability
   * (all local storage) fall back to the create() call that was always
   * here.
   */
  async putAttachment(data: Uint8Array, mimeType: string, filename?: string): Promise<string> {
    if (this.adapter.putAttachmentWithMetadata) {
      const record = await this.adapter.putAttachmentWithMetadata(data, mimeType, filename);
      return (record.content as AttachmentContent).fileId;
    }
    const fileId = await this.adapter.putAttachment(data);
    await this.create(`${SYSTEM_TYPES.ATTACHMENT}@1`, {
      fileId,
      mimeType,
      size: data.byteLength,
      ...(filename && { filename }),
    } satisfies AttachmentContent);
    return fileId;
  }

  async getAttachment(fileId: string): Promise<Uint8Array> {
    return this.adapter.getAttachment(fileId);
  }

  /**
   * Delete an attachment's bytes and its _attachment@1 metadata record(s).
   * Throws StackConflictError if any record in the stack still references the file.
   * Throws StackNotFoundError if neither metadata records nor bytes exist.
   */
  async deleteAttachment(fileId: string): Promise<void> {
    const metadataTypeId = `${SYSTEM_TYPES.ATTACHMENT}@1`;
    const deletedRecordIds = this.adapter.deleteUnreferencedAttachmentRecords
      ? await this.adapter.deleteUnreferencedAttachmentRecords(fileId, metadataTypeId)
      : await this.deleteUnreferencedAttachmentRecordsFallback(fileId, metadataTypeId);

    if (!deletedRecordIds.length) {
      try {
        await this.adapter.getAttachment(fileId);
      } catch {
        throw new StackNotFoundError(`Attachment not found: "${fileId}"`);
      }
    }

    await this.adapter.deleteAttachment(fileId);
  }

  /**
   * Non-atomic fallback for adapters that don't implement
   * deleteUnreferencedAttachmentRecords(): a concurrent associate() can
   * race between the reference check below and the deletes it guards.
   */
  private async deleteUnreferencedAttachmentRecordsFallback(
    fileId: string,
    metadataTypeId: string,
  ): Promise<string[]> {
    // includeDeleted: a soft-deleted record is recoverable via undelete()
    // (#59/#60), so it still counts as a reference — otherwise deleting the
    // file now leaves that record's reference dangling the moment it's
    // undeleted. Matches the atomic adapter path (record-logic.ts), which
    // never filters on deleted_at at all.
    const refResult = await this.query({
      filter: { attachmentFileId: fileId, includeDeleted: true },
      limit: 1,
    });
    if (refResult.records.length > 0) {
      throw new StackConflictError('Attachment is still referenced by one or more records');
    }

    // Cursor-walked: on adapters without contentFieldQuery, every
    // _attachment@1 record must be scanned in memory below, and a single
    // default page would leave metadata beyond page one un-deleted —
    // exactly the orphan this method exists to prevent. includeDeleted here
    // too, so a soft-deleted metadata record for this fileId is cleaned up
    // rather than left behind pointing at bytes that no longer exist.
    const metaResults = await queryAllPages((q) => this.query(q), {
      filter: {
        typeId: metadataTypeId,
        includeDeleted: true,
        ...(this.features.contentFieldQuery && { content: { fileId } }),
      },
    });
    const metaRecords = this.features.contentFieldQuery
      ? metaResults
      : metaResults.filter((r) => (r.content as AttachmentContent).fileId === fileId);

    for (const record of metaRecords) {
      await this.delete(record.id, { hard: true });
    }

    return metaRecords.map((r) => r.id);
  }

  /**
   * Sweep for attachment bytes no longer reachable from any record — live
   * or soft-deleted — and delete them (bytes + _attachment@1 metadata).
   * "Reachable" is exactly what deleteAttachment()'s own reference check
   * means: an `attachment` Association or a `file-ref` content field (#63)
   * on a record in any state, since a soft-deleted record is recoverable
   * via undelete() and must find its attachments intact (#59/#60).
   *
   * _attachment@1 metadata records never themselves count as references
   * (else nothing would ever be garbage), but a file's newest metadata
   * record — or, for bare bytes with no metadata at all, the blob's own
   * modifiedAt — must be older than `graceMs` to be collected. This covers
   * the legitimate upload-then-associate window.
   *
   * Bare-bytes orphans (bytes with zero metadata records, left by a
   * putAttachment() that stored bytes but crashed before creating the
   * metadata record) are only discoverable via StackBlobAdapter.listFiles()
   * — optional, so this sweep simply can't find that orphan class on an
   * adapter that doesn't implement it.
   *
   * Deletion goes through deleteAttachment() itself, so its usual conflict
   * check runs once more per file at delete time; a file that turns out to
   * be referenced or already gone by then is skipped, not treated as a
   * sweep failure.
   */
  async collectAttachmentGarbage(
    opts: CollectAttachmentGarbageOptions = {},
  ): Promise<CollectAttachmentGarbageResult> {
    const graceMs = opts.graceMs ?? DEFAULT_GC_GRACE_MS;
    const dryRun = opts.dryRun ?? false;
    const now = Date.now();

    const metadataTypeId = `${SYSTEM_TYPES.ATTACHMENT}@1`;
    const metaRecords = await queryAllPages((q) => this.query(q), {
      filter: { typeId: metadataTypeId, includeDeleted: true },
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
    // discoverable if the blob adapter implements listFiles().
    const blobByFile = new Map<string, { modifiedAt: number; size: number }>();
    if (this.adapter.listFiles) {
      for (const file of await this.adapter.listFiles()) {
        blobByFile.set(file.fileId, { modifiedAt: file.modifiedAt.getTime(), size: file.size });
      }
    }

    const candidateFileIds = new Set([...metaByFile.keys(), ...blobByFile.keys()]);

    const deleted: string[] = [];
    let reclaimedBytes = 0;

    for (const fileId of candidateFileIds) {
      const refResult = await this.query({
        filter: { attachmentFileId: fileId, includeDeleted: true },
        limit: 1,
      });
      if (refResult.records.length > 0) continue;

      const meta = metaByFile.get(fileId);
      const blob = blobByFile.get(fileId);
      const newestAt = meta?.newestAt ?? blob?.modifiedAt;
      if (newestAt !== undefined && now - newestAt < graceMs) continue;

      const size = meta?.size ?? blob?.size ?? 0;

      if (dryRun) {
        deleted.push(fileId);
        reclaimedBytes += size;
        continue;
      }

      try {
        await this.deleteAttachment(fileId);
      } catch (err) {
        // Raced with a new reference, or another sweep/call already removed
        // it — not a sweep failure, just move on to the next candidate.
        if (err instanceof StackConflictError || err instanceof StackNotFoundError) continue;
        throw err;
      }
      deleted.push(fileId);
      reclaimedBytes += size;
    }

    return { deleted, reclaimedBytes };
  }

  // -------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------

  /**
   * Flush any pending writes to the underlying storage.
   * For adapters that write immediately (SQLite, JSON), this is a no-op.
   * For the API adapter, this commits the offline write queue to the server.
   * Safe to call at any time — always resolves, never rejects on its own.
   */
  async flush(): Promise<void> {
    await this.adapter.flush?.();
  }

  /**
   * Release any resources held by the adapter (connections, file handles, timers).
   * Call this when the stack is no longer needed — especially important for the
   * API adapter, which holds an open connection and retry timers.
   * Safe to call even if the adapter has no resources to release.
   */
  async close(): Promise<void> {
    await this.adapter.close?.();
  }

  // -------------------------------------------------------
  // Grants
  // -------------------------------------------------------

  /**
   * Create _grant records that allow entities to call ScopedStack.create()
   * for specific record types. Pass null as entityId for a default grant
   * that applies to any authenticated entity.
   *
   * The grantee lives in `GrantContent.granteeEntityId`, not `record.entityId`
   * — `entityId` means "author" everywhere else, and the owner (who calls
   * grant()) authored this record, never the entity it names (#57).
   *
   * The _grant@1 type is defined automatically on first use.
   */
  async grant(
    entityId: EntityId | null,
    grants: Array<{ actions: GrantAction[]; typeId: TypeId }>,
  ): Promise<StackRecord[]> {
    const records: StackRecord[] = [];
    for (const g of grants) {
      records.push(
        await this.create(`${SYSTEM_TYPES.GRANT}@1`, {
          typeId: g.typeId,
          actions: g.actions,
          ...(entityId && { granteeEntityId: entityId }),
        }),
      );
    }
    return records;
  }

  /**
   * List _grant records. Omit `entityId` for every grant regardless of
   * grantee. Pass `null` for only default grants (no `granteeEntityId` —
   * apply to any authenticated entity). Pass a specific entityId for the
   * grants that currently apply to that entity: ones naming them, plus
   * every default grant — the same resolution ScopedStack's hasGrant()
   * uses internally.
   */
  async listGrants(entityId?: EntityId | null): Promise<StackRecord[]> {
    const all = await queryAllPages((q) => this.query(q), {
      filter: { typeId: `${SYSTEM_TYPES.GRANT}@1` },
    });
    if (entityId === undefined) return all;
    return all.filter((r) => {
      const granteeEntityId = (r.content as GrantContent).granteeEntityId;
      return entityId === null
        ? !granteeEntityId
        : !granteeEntityId || granteeEntityId === entityId;
    });
  }

  /**
   * The inverse of grant(): soft-deletes _grant records exactly matching
   * `entityId` (null for default grants) and each `{ typeId, actions }`
   * pair — matched by typeId baseId and action set, the same granularity
   * grant() writes at. A soft delete like any other mutation: the owner can
   * undelete a revocation the same as any other write (#59/#61).
   */
  async revoke(
    entityId: EntityId | null,
    grants: Array<{ actions: GrantAction[]; typeId: TypeId }>,
  ): Promise<void> {
    const all = await queryAllPages((q) => this.query(q), {
      filter: { typeId: `${SYSTEM_TYPES.GRANT}@1` },
    });
    for (const g of grants) {
      const familyId = baseIdOf(g.typeId);
      const actionSet = new Set(g.actions);
      const matches = all.filter((r) => {
        const c = r.content as GrantContent;
        if (baseIdOf(c.typeId) !== familyId) return false;
        if ((c.granteeEntityId ?? null) !== entityId) return false;
        return c.actions.length === actionSet.size && c.actions.every((a) => actionSet.has(a));
      });
      for (const match of matches) {
        await this.delete(match.id);
      }
    }
  }

  // -------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------

  private async seedSystemTypes(): Promise<void> {
    await this.defineType(`${SYSTEM_TYPES.CONFIG}@1`, 'Config', {
      entityId: { kind: 'string', required: true },
      // Optional passthrough app metadata — see ConfigContent.timezone (#69).
      timezone: { kind: 'string' },
    });
    await this.defineType(`${SYSTEM_TYPES.ENTITY}@1`, 'Entity', {
      did: { kind: 'string', required: true },
      name: { kind: 'string', required: true },
      handle: { kind: 'string' },
    });
    await this.defineType(`${SYSTEM_TYPES.APP}@1`, 'App', {
      name: { kind: 'string', required: true },
      version: { kind: 'string' },
    });
    await this.defineType(`${SYSTEM_TYPES.GROUP}@1`, 'Group', {
      name: { kind: 'string', required: true },
      handle: { kind: 'string' },
      stackUrl: { kind: 'string' },
    });
    await this.defineType(`${SYSTEM_TYPES.GRANT}@1`, 'Grant', {
      typeId: { kind: 'string', required: true },
      actions: { kind: 'array', items: { kind: 'string' }, required: true },
      granteeEntityId: { kind: 'string' },
    });
    await this.defineType(`${SYSTEM_TYPES.ATTACHMENT}@1`, 'Attachment', {
      fileId: { kind: 'string', required: true },
      mimeType: { kind: 'string', required: true },
      size: { kind: 'number', required: true },
      filename: { kind: 'string' },
    });
  }

  /**
   * Fast-fail check for the opt-in ifVersion precondition, using the
   * record already fetched for this operation. The adapter re-checks
   * atomically at write time (the actual source of truth for concurrent
   * writers — see StackRecordAdapter's ExpectedVersionOptions); this is
   * just an early exit that skips validation/snapshotting work when the
   * mismatch is already visible.
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

  private async saveVersion(record: StackRecord): Promise<void> {
    const version: RecordVersion = {
      version: record.version,
      typeId: record.typeId,
      content: record.content,
      updatedAt: record.updatedAt,
      ...(record.entityId && { entityId: record.entityId }),
      ...(record.associations && { associations: record.associations }),
      ...(record.permissions && { permissions: record.permissions }),
    };
    await this.adapter.saveVersion(record.id, version);
  }
}

// -------------------------------------------------------
// Equality helpers
// -------------------------------------------------------

/**
 * Matches the SQLite adapter's association primary key (kind, label,
 * file_id, related_id) — mimeType is not part of an attachment
 * association's identity.
 */
function associationEqual(a: Association, b: Association): boolean {
  if (a.kind !== b.kind || a.label !== b.label) return false;
  if (a.kind === 'attachment' && b.kind === 'attachment') return a.fileId === b.fileId;
  if (a.kind === 'relationship' && b.kind === 'relationship') return a.recordId === b.recordId;
  return true;
}

function permissionEqual(a: Permission, b: Permission): boolean {
  if (a.access !== b.access) return false;
  if (a.access === 'public') return true;
  if (a.access === 'entity' && b.access === 'entity') {
    return a.entityId === b.entityId && a.read === b.read && a.write === b.write;
  }
  if (a.access === 'group' && b.access === 'group') {
    return (
      a.groupId === b.groupId && a.role === b.role && a.read === b.read && a.write === b.write
    );
  }
  return false;
}

function permissionsEqual(a: Permission[], b: Permission[]): boolean {
  return a.length === b.length && a.every((p, i) => permissionEqual(p, b[i]));
}

// -------------------------------------------------------
// ScopedStack
// -------------------------------------------------------

/** Default page size used to fill a permission-filtered query result. */
const DEFAULT_QUERY_LIMIT = 50;
const MAX_QUERY_LIMIT = 1000;

/**
 * Ensures `creator` carries an `admin` relationship association, adding one
 * if it's not already present. Used to bootstrap a `_group` record's first
 * admin at create time.
 */
function stampGroupAdmin(associations: Association[] | undefined, creator: string): Association[] {
  const list = associations ?? [];
  const alreadyAdmin = list.some(
    (a) => a.kind === 'relationship' && a.label === 'admin' && a.recordId === creator,
  );
  if (alreadyAdmin) return list;
  return [...list, { kind: 'relationship', label: 'admin', recordId: creator }];
}

/**
 * A permission-enforcing view of a Stack for a single requester. Obtained
 * via `stack.asEntity(entityId)` — see there for when to use it.
 *
 * Read methods return null for a Record that doesn't exist, and throw
 * StackPermissionError for one that exists but isn't readable by the requester.
 * Write methods throw StackNotFoundError for a missing Record and
 * StackPermissionError for one that exists but isn't writable. This lets
 * callers distinguish "not found" from "forbidden".
 */
export class ScopedStack implements StackClient {
  constructor(
    private readonly stack: Stack,
    private readonly requesterEntityId: EntityId | null,
    private readonly idTimestampSkewMs: number | null,
    // The bytes-storage primitive for putAttachment()'s upload step. Held
    // directly (passed by Stack.asEntity()) because Stack's adapter is
    // private and the bytes-only upload is no longer part of Stack's
    // public API (#106 follow-up): the record ScopedStack creates carries
    // the requester's entityId, which the adapter-level atomic capability
    // has no parameter for, so this class always composes bytes + its own
    // create() rather than delegating to putAttachmentWithMetadata().
    private readonly adapter: StackAdapter,
  ) {}

  get features(): StackFeatures {
    return this.stack.features;
  }

  private resolveRecord = (id: string): Promise<StackRecord | null> => this.stack.get(id);

  private checkRead(record: StackRecord): Promise<boolean> {
    return checkAccess(
      record,
      this.requesterEntityId,
      this.stack.ownerEntityId,
      'read',
      this.resolveRecord,
    );
  }

  private checkWrite(record: StackRecord): Promise<boolean> {
    return checkAccess(
      record,
      this.requesterEntityId,
      this.stack.ownerEntityId,
      'write',
      this.resolveRecord,
    );
  }

  /**
   * Check whether the requester holds a _grant record covering at least one
   * of the given actions for the given type's family. Grants target
   * baseId, not the exact versioned typeId — a grant on "comment@1" covers
   * "comment@2" too, so a version bump never silently orphans an existing
   * grant. For -own actions, additionally requires that `record.entityId`
   * matches the requester (authorship check). Anonymous requesters always
   * return false.
   */
  private async hasGrant(
    typeId: TypeId,
    actions: GrantAction[],
    record?: StackRecord,
    prefetchedGrants?: StackRecord[],
  ): Promise<boolean> {
    if (!this.requesterEntityId) return false;

    const familyId = baseIdOf(typeId);

    let grantRecords: StackRecord[];
    if (prefetchedGrants !== undefined) {
      grantRecords = prefetchedGrants;
    } else {
      // No content-field prefilter here: matching is by baseId, which a
      // stored grant may express as either a bare baseId or a versioned
      // typeId, so an exact-match content filter would wrongly exclude
      // grants for other versions of the family. Cursor-walked: a single
      // default page would silently miss grants past page one.
      grantRecords = await queryAllPages((q) => this.stack.query(q), {
        filter: { typeId: `${SYSTEM_TYPES.GRANT}@1` },
      });
    }

    return grantRecords.some((r) => {
      const c = r.content as GrantContent;
      if (baseIdOf(c.typeId) !== familyId) return false;
      if (c.granteeEntityId && c.granteeEntityId !== this.requesterEntityId) return false;
      return actions.some((action) => {
        if (!(c.actions as string[]).includes(action)) return false;
        if (action.endsWith('-own')) return record?.entityId === this.requesterEntityId;
        return true;
      });
    });
  }

  private async canRead(record: StackRecord, prefetchedGrants?: StackRecord[]): Promise<boolean> {
    return (
      (await this.checkRead(record)) ||
      (await this.hasGrant(record.typeId, ['read-own', 'read-any'], record, prefetchedGrants))
    );
  }

  private async checkCreateGrant(typeId: TypeId): Promise<boolean> {
    if (this.requesterEntityId === this.stack.ownerEntityId) return true;
    return this.hasGrant(typeId, ['create']);
  }

  /**
   * `_group` records are managed, not merely written: the owner or a
   * requester holding an `admin` roster association may mutate them.
   * Ordinary write permissions/grants don't apply — membership rosters live
   * on the very record they'd otherwise let a write-holder rewrite, so the
   * generic write bit would let anyone who can write the record add or
   * remove members (see #58).
   */
  private isGroupManager(record: StackRecord): boolean {
    if (this.requesterEntityId === this.stack.ownerEntityId) return true;
    if (!this.requesterEntityId) return false;
    return groupRoleFromAssociations(record.associations, this.requesterEntityId) === 'admin';
  }

  /** Fetch a record the requester can update (via permissions or an update grant), or throw. */
  private async requireUpdatable(id: string): Promise<StackRecord> {
    const record = await this.stack.get(id);
    if (!record) throw new StackNotFoundError(`Record not found: "${id}"`);
    if (baseIdOf(record.typeId) === SYSTEM_TYPES.GROUP) {
      if (!this.isGroupManager(record)) throw new StackPermissionError();
      return record;
    }
    const allowed =
      (await this.checkWrite(record)) ||
      (await this.hasGrant(record.typeId, ['update-own', 'update-any'], record));
    if (!allowed) throw new StackPermissionError();
    return record;
  }

  /** Fetch a record the requester can delete (via permissions or a delete grant), or throw. */
  private async requireDeletable(id: string): Promise<StackRecord> {
    const record = await this.stack.get(id);
    if (!record) throw new StackNotFoundError(`Record not found: "${id}"`);
    if (baseIdOf(record.typeId) === SYSTEM_TYPES.GROUP) {
      if (!this.isGroupManager(record)) throw new StackPermissionError();
      return record;
    }
    const allowed =
      (await this.checkWrite(record)) ||
      (await this.hasGrant(record.typeId, ['delete-own', 'delete-any'], record));
    if (!allowed) throw new StackPermissionError();
    return record;
  }

  /**
   * Whether the requester may create a reference to `recordId` (as a
   * `parentId` or a `relationship` association target). Missing and
   * unreadable both return false — indistinguishable, so this can't be used
   * to probe for a record's existence (#51).
   */
  private async canReadReferent(recordId: string): Promise<boolean> {
    const record = await this.stack.get(recordId);
    if (!record) return false;
    return this.canRead(record);
  }

  /**
   * Whether the requester can already read some record referencing `fileId`
   * — the "possession via a readable referencing record" clause shared by
   * canAccessFile() and the non-owner _attachment@1 create() carve-out
   * (#106, residual decision 1). Deliberately excludes the uploader clause:
   * using "I hold a metadata record for F" to justify creating *another*
   * metadata record for F would let one successful guess bootstrap
   * unlimited further ones — the exact circularity #106 closes.
   */
  private async hasReadableReference(fileId: string): Promise<boolean> {
    const refResult = await this.query({ filter: { attachmentFileId: fileId }, limit: 1 });
    return refResult.records.length > 0;
  }

  /**
   * Whether the requester may create a reference (`attachment` association
   * or file-ref content field) to `fileId` — the dual of getAttachment()'s
   * access rule: reference creation requires exactly what reference
   * possession would grant. A nonexistent fileId and an existing-but-
   * inaccessible one are indistinguishable here (both false), so this can't
   * become a confirmation oracle for guessed content hashes (#51).
   */
  private async canAccessFile(fileId: string): Promise<boolean> {
    if (this.requesterEntityId === this.stack.ownerEntityId) return true;

    if (await this.hasReadableReference(fileId)) return true;

    if (!this.requesterEntityId) return false;

    return this.stack.features.contentFieldQuery
      ? (
          await this.stack.query({
            filter: {
              typeId: `${SYSTEM_TYPES.ATTACHMENT}@1`,
              entityId: this.requesterEntityId,
              content: { fileId },
            },
            limit: 1,
          })
        ).records.length > 0
      : (
          await queryAllPages((q) => this.stack.query(q), {
            filter: { typeId: `${SYSTEM_TYPES.ATTACHMENT}@1`, entityId: this.requesterEntityId },
          })
        ).some((r) => (r.content as AttachmentContent).fileId === fileId);
  }

  /** Names of the type's top-level file-ref fields — the content-reference half of attachmentFileId matching (#63). */
  private async fileRefFieldNames(typeId: TypeId): Promise<string[]> {
    const type = await this.stack.getType(typeId);
    if (!type) return [];
    return Object.entries(type.schema)
      .filter(([, def]) => def.kind === 'file-ref')
      .map(([field]) => field);
  }

  /**
   * Gates file-ref content fields on file access, mirroring the attachment-
   * association gate below — #63 made a file-ref field convey attachment
   * access exactly like an `attachment` association does, so it needs the
   * same reference-creation check (#51). Only fields actually present in
   * `content` are checked: on update() that's a merge patch, so untouched
   * fields carry no new reference.
   */
  private async requireFileRefAccess(
    typeId: TypeId,
    content: Record<string, unknown | null>,
  ): Promise<void> {
    for (const field of await this.fileRefFieldNames(typeId)) {
      const value = content[field];
      if (typeof value !== 'string') continue;
      if (!(await this.canAccessFile(value))) throw new StackPermissionError();
    }
  }

  /**
   * Gates a single association's reference-creation check per #51: an
   * `attachment` association requires file access, a `relationship`
   * association requires read access to its target, a `tag` carries no
   * reference and is unchecked.
   *
   * `_group` roster associations are exempt from the relationship check —
   * their `recordId` is an entity ID, not a readable record, and roster
   * mutation is already gated by isGroupManager() (#58), which is strictly
   * tighter than "can read the target".
   */
  private async requireAssociationAccess(typeId: TypeId, association: Association): Promise<void> {
    if (association.kind === 'attachment') {
      if (!(await this.canAccessFile(association.fileId))) throw new StackPermissionError();
    } else if (association.kind === 'relationship' && baseIdOf(typeId) !== SYSTEM_TYPES.GROUP) {
      if (!(await this.canReadReferent(association.recordId))) throw new StackPermissionError();
    }
  }

  /**
   * Create a new record on behalf of the authenticated requester.
   * Requires either an entity-specific _grant or a default _grant for
   * the target type. Anonymous requesters (null entityId) are always denied.
   * The created record's entityId is set to the requester — unless the
   * requester *is* the owner, in which case entityId is omitted, matching
   * the spec's "owner-created records carry no entityId" invariant (#69).
   * Without this, the owner writing through asEntity(ownerEntityId) would
   * produce a differently-shaped record than Stack.create() for the exact
   * same author.
   *
   * A client-supplied `opts.id` gets the same format validation as
   * Stack.create() plus a timestamp-skew check — the requester here is an
   * untrusted actor who could otherwise mint an ID that forges its sort
   * position. See StackOptions.idTimestampSkewMs.
   *
   * `_group` records additionally get the creator stamped as their first
   * `admin` roster association, so a group is never management-orphaned —
   * without this, nobody could ever pass isGroupManager() to add themselves.
   *
   * `parentId`, `associations`, and file-ref content fields are all
   * reference-creating options a caller could otherwise use to piggyback on
   * a bare `create` grant: a `parentId` or `relationship` association
   * requires read access to the target, and an `attachment` association or
   * file-ref field requires file access — the same checks associate()
   * applies post-create (#51). `permissions` and `appId` are deliberately
   * left unchecked here: `permissions` is create-time-consistent with
   * setPermissions() (owner/creator territory already), and `appId` is
   * self-reported, untrusted metadata everywhere, not a permission input.
   *
   * `_attachment@1` (matched by baseId, like `_group`) is refused outright
   * for non-owners, with one carve-out (#106): a readable record already
   * referencing `content.fileId` may get a second metadata record (e.g. a
   * second filename) without re-uploading. Otherwise, a bare `create` grant
   * — held by every uploader — would let a requester name an arbitrary
   * guessed fileId and, via canAccessFile()'s uploader clause, turn that
   * guess into a read: creating an access-conveying record without ever
   * proving possession of the bytes. `putAttachment()` is the only
   * non-owner path left: it derives fileId from bytes it just hashed, so
   * possession is proven by construction rather than asserted by the
   * caller. The carve-out deliberately excludes the uploader clause of
   * canAccessFile() — using an existing metadata record to justify creating
   * another would let one successful guess bootstrap unlimited further
   * ones, the same circularity this guard exists to close.
   */
  async create<T extends Record<string, unknown> = Record<string, unknown>>(
    typeId: TypeId,
    content: T,
    opts: CreateRecordOptions = {},
  ): Promise<StackRecord & { content: T }> {
    const requester = this.requesterEntityId;
    if (!requester) throw new StackPermissionError('Anonymous requesters cannot create records');
    if (!(await this.checkCreateGrant(typeId))) {
      throw new StackPermissionError(`No create grant for type "${typeId}"`);
    }
    const isOwner = requester === this.stack.ownerEntityId;
    if (!isOwner && baseIdOf(typeId) === SYSTEM_TYPES.ATTACHMENT) {
      const fileId = (content as Record<string, unknown>).fileId;
      if (typeof fileId !== 'string' || !(await this.hasReadableReference(fileId))) {
        throw new StackPermissionError();
      }
    }
    if (opts.id !== undefined) {
      validateRecordId(opts.id);
      validateIdTimestampSkew(opts.id, this.idTimestampSkewMs);
    }
    if (opts.parentId !== undefined && !(await this.canReadReferent(opts.parentId))) {
      throw new StackPermissionError();
    }
    for (const assoc of opts.associations ?? []) {
      await this.requireAssociationAccess(typeId, assoc);
    }
    await this.requireFileRefAccess(typeId, content);
    const createOpts =
      baseIdOf(typeId) === SYSTEM_TYPES.GROUP
        ? { ...opts, associations: stampGroupAdmin(opts.associations, requester) }
        : opts;
    return this.stack.create(typeId, content, {
      ...createOpts,
      entityId: isOwner ? undefined : requester,
    });
  }

  async get(id: string, opts: GetRecordOptions = {}): Promise<StackRecord | null> {
    const record = await this.stack.get(id, opts);
    if (!record) return null;
    if (!(await this.canRead(record))) throw new StackPermissionError();
    return record;
  }

  /**
   * Query records, filtered to only those the requester can read.
   *
   * Pagination is filtered-then-refilled: each adapter page is fetched in
   * full and entirely evaluated before deciding whether to fetch another,
   * so the returned page may overshoot `limit` slightly, but never skips a
   * record that shared a page with the one that crossed the threshold (the
   * adapter's cursor can't address a position mid-page).
   *
   * `total` is always null — see the QueryResult.total doc comment.
   *
   * Grant records are pre-fetched once before the pagination loop so read
   * grants don't trigger a separate _grant@1 query per record. The
   * prefetch itself cursor-walks every _grant@1 record — a single default
   * page would silently miss grants past page one, denying access that
   * should exist with no error (see queryAllPages()).
   */
  async query(query: StackQuery = {}): Promise<QueryResult> {
    const limit = Math.min(query.limit ?? DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT);
    const records: StackRecord[] = [];
    const maxFetched = limit * 10;
    let totalFetched = 0;

    const prefetchedGrants = this.requesterEntityId
      ? await queryAllPages((q) => this.stack.query(q), {
          filter: { typeId: `${SYSTEM_TYPES.GRANT}@1` },
        })
      : undefined;

    let page: QueryResult = { records: [], cursor: query.cursor ?? null, total: null };
    do {
      page = await this.stack.query({ ...query, cursor: page.cursor ?? undefined });
      totalFetched += page.records.length;
      for (const record of page.records) {
        if (await this.canRead(record, prefetchedGrants)) records.push(record);
      }
    } while (records.length < limit && page.cursor && totalFetched < maxFetched);

    return { records, cursor: page.cursor, total: null };
  }

  async update(
    id: string,
    content: Record<string, unknown | null>,
    opts: IfVersionOptions = {},
  ): Promise<StackRecord> {
    const record = await this.requireUpdatable(id);
    await this.requireFileRefAccess(record.typeId, content);
    return this.stack.update(id, content, opts);
  }

  async associate(
    id: string,
    association: Association,
    opts: IfVersionOptions = {},
  ): Promise<void> {
    const record = await this.requireUpdatable(id);
    await this.requireAssociationAccess(record.typeId, association);
    return this.stack.associate(id, association, opts);
  }

  async dissociate(
    id: string,
    association: Association,
    opts: IfVersionOptions = {},
  ): Promise<void> {
    await this.requireUpdatable(id);
    return this.stack.dissociate(id, association, opts);
  }

  async setPermissions(
    id: string,
    permissions: Permission[],
    opts: IfVersionOptions = {},
  ): Promise<void> {
    const record = await this.stack.get(id);
    if (!record) throw new StackNotFoundError(`Record not found: "${id}"`);

    if (baseIdOf(record.typeId) === SYSTEM_TYPES.GROUP) {
      // Group management, not authorship: a creator later demoted from the
      // admin roster shouldn't retain a side door to reassign who can read
      // or write the group record. Same gate as update/associate/delete.
      if (!this.isGroupManager(record)) throw new StackPermissionError();
    } else {
      const isOwner = this.requesterEntityId === this.stack.ownerEntityId;
      const isCreator = this.requesterEntityId === record.entityId;
      if (!isOwner && !isCreator) throw new StackPermissionError();
    }

    return this.stack.setPermissions(id, permissions, opts);
  }

  /**
   * Hard delete is owner-only: it is irreversible and destroys version
   * history, so neither the write bit nor delete-own/delete-any grants
   * reach it. Non-owners are always limited to soft delete.
   */
  async delete(id: string, opts: DeleteRecordOptions = {}): Promise<void> {
    await this.requireDeletable(id);
    if (opts.hard && this.requesterEntityId !== this.stack.ownerEntityId) {
      throw new StackPermissionError('Hard delete is owner-only');
    }
    return this.stack.delete(id, opts);
  }

  /**
   * Reverse a soft delete. Gated the same as delete() — undelete is the
   * inverse of soft delete, so granting one direction without the other
   * would be backwards. Idempotent, per Stack.undelete().
   */
  async undelete(id: string, opts: IfVersionOptions = {}): Promise<StackRecord> {
    await this.requireDeletable(id);
    return this.stack.undelete(id, opts);
  }

  async getVersions(id: string): Promise<RecordVersion[]> {
    const existing = await this.stack.get(id);
    if (!existing) throw new StackNotFoundError(`Record not found: "${id}"`);
    if (!(await this.canRead(existing))) throw new StackPermissionError();
    return this.stack.getVersions(id);
  }

  async getVersion(id: string, version: number): Promise<RecordVersion | null> {
    const existing = await this.stack.get(id);
    if (!existing) throw new StackNotFoundError(`Record not found: "${id}"`);
    if (!(await this.canRead(existing))) throw new StackPermissionError();
    return this.stack.getVersion(id, version);
  }

  async restoreVersion(
    id: string,
    version: number,
    opts: IfVersionOptions = {},
  ): Promise<StackRecord> {
    await this.requireUpdatable(id);
    return this.stack.restoreVersion(id, version, opts);
  }

  /**
   * Store bytes and create an _attachment@1 metadata record. Requires a
   * `create` grant on `_attachment@1`. Anonymous requesters are always
   * denied. The record's entityId is set to the requester — unless the
   * requester is the owner, in which case entityId is omitted, matching the
   * normalization create() applies (#69, #106 E1): without it, the owner
   * uploading through asEntity(ownerEntityId) would produce a differently-
   * shaped record than Stack.putAttachment() for the exact same author.
   */
  async putAttachment(data: Uint8Array, mimeType: string, filename?: string): Promise<string> {
    const requester = this.requesterEntityId;
    if (!requester) {
      throw new StackPermissionError('Anonymous requesters cannot upload attachments');
    }
    if (!(await this.checkCreateGrant(`${SYSTEM_TYPES.ATTACHMENT}@1`))) {
      throw new StackPermissionError(`No create grant for type "${SYSTEM_TYPES.ATTACHMENT}@1"`);
    }
    const fileId = await this.adapter.putAttachment(data);
    const isOwner = requester === this.stack.ownerEntityId;
    await this.stack.create(
      `${SYSTEM_TYPES.ATTACHMENT}@1`,
      {
        fileId,
        mimeType,
        size: data.byteLength,
        ...(filename && { filename }),
      } satisfies AttachmentContent,
      { entityId: isOwner ? undefined : requester },
    );
    return fileId;
  }

  /**
   * Download attachment bytes. Accessible if the requester is the owner,
   * can read any record referencing the file, or uploaded the file themselves
   * and it hasn't been associated with a record yet. Shares its predicate
   * with the reference-creation gate (canAccessFile, #51) — reference
   * creation requires exactly what reference possession grants.
   */
  async getAttachment(fileId: string): Promise<Uint8Array> {
    if (!(await this.canAccessFile(fileId))) throw new StackPermissionError();
    return this.stack.getAttachment(fileId);
  }

  /**
   * Delete an attachment. Only the stack owner may delete attachments.
   * Delegates to Stack.deleteAttachment(), which enforces the "not referenced" check.
   */
  async deleteAttachment(fileId: string): Promise<void> {
    if (this.requesterEntityId !== this.stack.ownerEntityId) {
      throw new StackPermissionError('Only the stack owner can delete attachments');
    }
    return this.stack.deleteAttachment(fileId);
  }

  /**
   * Sweep for unreferenced attachment bytes and delete them. Only the stack
   * owner may run this. Delegates to Stack.collectAttachmentGarbage().
   */
  async collectAttachmentGarbage(
    opts?: CollectAttachmentGarbageOptions,
  ): Promise<CollectAttachmentGarbageResult> {
    if (this.requesterEntityId !== this.stack.ownerEntityId) {
      throw new StackPermissionError('Only the stack owner can collect attachment garbage');
    }
    return this.stack.collectAttachmentGarbage(opts);
  }
}
