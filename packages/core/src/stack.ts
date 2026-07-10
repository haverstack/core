/**
 * Stack — Core Stack Class
 * -------------------------------------------------------
 * The Stack class is the primary interface for apps. It sits
 * on top of a StackAdapter and adds:
 *
 *  - ID generation
 *  - Type definition and schema hashing
 *  - Content validation on write
 *  - Migration registry and auto-migration on read
 *  - Version snapshotting on update
 *  - Soft and hard delete
 *
 * Apps should never talk to a StackAdapter directly.
 */

import { generateId, isValidIdFormat, idTimestamp } from './id.js';
import { hashSchema, isCompatible, parseTypeId } from './schema.js';
import { validateContent } from './validate.js';
import { checkAccess } from './access.js';
import { SYSTEM_TYPES } from './types.js';
import type { ValidationError } from './validate.js';
import type {
  StackRecord,
  StackType,
  TypeSchema,
  TypeId,
  StackAdapter,
  StackQuery,
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
} from './types.js';

// -------------------------------------------------------
// Supporting types
// -------------------------------------------------------

export type CreateRecordOptions = {
  /**
   * Client-minted record ID. Must be 12 lowercase Crockford base-32
   * characters and may not use the reserved `_` prefix. Omit to let the
   * library generate one. See Stack.create() and ScopedStack.create()
   * for the validation each applies.
   */
  id?: string;
  parentId?: string;
  entityId?: string;
  appId?: string;
  permissions?: Permission[];
  associations?: Association[];
};

export type StackOptions = {
  /**
   * Clock-skew tolerance (ms) for the timestamp-prefix plausibility check
   * ScopedStack.create() runs on a grantee-supplied `id` — a grantee is an
   * untrusted actor who could otherwise mint an ID that forges its sort
   * position. Default: 24 hours. Pass null to disable the check entirely.
   * Unscoped Stack.create() never runs this check (full-trust context).
   */
  idTimestampSkewMs?: number | null;
};

export type GetRecordOptions = {
  /** If false, return the raw stored record without auto-migrating. Default: true */
  migrate?: boolean;
};

export type DeleteRecordOptions = {
  /** If true, permanently remove the record and all its history. Default: false */
  hard?: boolean;
};

export type DefineTypeOptions = {
  migratesFrom?: TypeId;
};

export class StackValidationError extends Error {
  constructor(public readonly errors: ValidationError[]) {
    super(
      `Content validation failed:\n` + errors.map((e) => `  ${e.path}: ${e.message}`).join('\n'),
    );
    this.name = 'StackValidationError';
  }
}

export class StackMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StackMigrationError';
  }
}

/** Thrown by ScopedStack when a requester lacks permission for the operation. */
export class StackPermissionError extends Error {
  constructor(message = 'Permission denied') {
    super(message);
    this.name = 'StackPermissionError';
  }
}

/** Thrown when a record (or specific version) does not exist. */
export class StackNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StackNotFoundError';
  }
}

/** Thrown when an operation cannot proceed due to a constraint violation (e.g. deleting an attachment that is still referenced). */
export class StackConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StackConflictError';
  }
}

// -------------------------------------------------------
// Record ID validation
// -------------------------------------------------------

const RESERVED_ID_PREFIX = '_';
const DEFAULT_ID_TIMESTAMP_SKEW_MS = 24 * 60 * 60 * 1000;

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
  update(id: string, content: Record<string, unknown | null>): Promise<StackRecord>;
  associate(id: string, association: Association): Promise<void>;
  dissociate(id: string, association: Association): Promise<void>;
  setPermissions(id: string, permissions: Permission[]): Promise<void>;
  delete(id: string, opts?: DeleteRecordOptions): Promise<void>;
  undelete(id: string): Promise<StackRecord>;
  getVersions(id: string): Promise<RecordVersion[]>;
  getVersion(id: string, version: number): Promise<RecordVersion | null>;
  restoreVersion(id: string, version: number): Promise<StackRecord>;
  getAttachment(fileId: string): Promise<Uint8Array>;
  putAttachmentBytes(data: Uint8Array): Promise<string>;
  putAttachment(data: Uint8Array, mimeType: string, filename?: string): Promise<string>;
  deleteAttachment(fileId: string): Promise<void>;
}

// -------------------------------------------------------
// Stack class
// -------------------------------------------------------

export class Stack implements StackClient {
  private readonly migrations = new Map<TypeId, Migration>();

  private constructor(
    private readonly adapter: StackAdapter,
    private readonly idTimestampSkewMsValue: number | null,
  ) {}

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
    return stack;
  }

  get ownerEntityId(): string {
    return this.adapter.ownerEntityId;
  }

  get timezone(): string {
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
  asEntity(entityId: string | null): ScopedStack {
    return new ScopedStack(this, entityId, this.idTimestampSkewMsValue);
  }

  // -------------------------------------------------------
  // Types
  // -------------------------------------------------------

  /**
   * Define and persist a new Type. Computes the schemaHash automatically.
   * Should be called at app startup before creating any records of this type.
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

    const schemaHash = await hashSchema(schema);

    const type: StackType = {
      id,
      baseId: parsed.baseId,
      version: parsed.version,
      name,
      schema,
      schemaHash,
      createdAt: new Date(),
      ...(opts.migratesFrom && { migratesFrom: opts.migratesFrom }),
    };

    await this.adapter.saveType(type);
    return type;
  }

  async getType(id: TypeId): Promise<StackType | null> {
    return this.adapter.getType(id);
  }

  async listTypes(): Promise<StackType[]> {
    return this.adapter.listTypes();
  }

  /**
   * Check whether a record's type is compatible with a required schema.
   * Useful for duck-typed consumption across types.
   */
  async typeIsCompatible(typeId: TypeId, requiredSchema: TypeSchema): Promise<boolean> {
    const type = await this.adapter.getType(typeId);
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
   * committing the results to disk immediately.
   *
   * Normally migration is lazy — records are migrated in memory on read
   * and written back only when next updated. Call migrateAll() when you
   * want to commit all pending migrations in one deliberate pass, for
   * example before a deployment or after a major schema change.
   *
   * Previous content is preserved in version history before each write.
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

      let cursor: string | undefined;
      do {
        const result: QueryResult = await this.adapter.queryRecords({
          filter: { typeId, includeDeleted: true },
          limit: 100,
          cursor,
        });

        for (const record of result.records) {
          await this.saveVersion(record);
          const migratedContent = migrateFn(record.content);
          await this.adapter.updateRecord(record.id, {
            typeId: latestId,
            content: migratedContent,
            updatedAt: new Date(),
            version: record.version + 1,
          });
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
    const type = await this.adapter.getType(typeId);
    if (!type) {
      throw new Error(`Unknown type: "${typeId}". Call defineType() first.`);
    }

    const errors = validateContent(content, type.schema);
    if (errors.length > 0) {
      throw new StackValidationError(errors);
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
   * Get a record by ID.
   *
   * If the record is on an older type version and a migration path is
   * registered, the content is migrated in memory and returned at the
   * latest type version — but nothing is written to disk. Migration is
   * only persisted when the record is next updated via update().
   *
   * Pass { migrate: false } to get the raw stored record without migration.
   */
  async get(id: string, opts: GetRecordOptions = {}): Promise<StackRecord | null> {
    const record = await this.adapter.getRecord(id);
    if (!record) return null;

    const shouldMigrate = opts.migrate !== false;
    if (!shouldMigrate) return record;

    const latestId = this.latestTypeId(record.typeId);
    if (latestId === record.typeId) return record;

    const migrateFn = this.resolveMigrationPath(record.typeId, latestId);
    if (!migrateFn) {
      console.warn(
        `[Stack] No migration path from "${record.typeId}" to "${latestId}" for record "${id}". ` +
          `Returning raw record. Register migrations with stack.registerMigration().`,
      );
      return record;
    }

    return {
      ...record,
      typeId: latestId,
      content: migrateFn(record.content),
    };
  }

  /**
   * Update a record's content. Accepts a partial content object — only the
   * fields provided are changed. Omitted fields retain their current values.
   *
   * To remove an optional field, set it explicitly to null:
   *   stack.update(id, { title: null })  // removes 'title' from content
   *
   * If the record is on an older type version, its content is migrated
   * in memory first, then the patch is applied. The updated record is
   * written at the latest type version — this is when lazy migration
   * is committed to disk.
   *
   * Validates the merged result against the type's schema. Saves the
   * previous state to version history before updating.
   *
   * For association or permission changes, use associate(), dissociate(),
   * and setPermissions() instead.
   */
  async update(id: string, content: Record<string, unknown | null>): Promise<StackRecord> {
    const existing = await this.adapter.getRecord(id);
    if (!existing) {
      throw new StackNotFoundError(`Record not found: "${id}"`);
    }

    // Resolve the latest type version and migrate existing content
    // in memory before applying the patch. This is when lazy migration
    // from get() gets committed to disk.
    const latestTypeId = this.latestTypeId(existing.typeId);
    const migrateFn = this.resolveMigrationPath(existing.typeId, latestTypeId);
    const existingContent = migrateFn ? migrateFn(existing.content) : existing.content;

    const type = await this.adapter.getType(latestTypeId);
    if (!type) {
      throw new Error(`Unknown type: "${latestTypeId}"`);
    }

    // Shallow merge: start with (migrated) existing content, apply changes.
    // null values mean "delete this field" (RFC 7396 / JSON Merge Patch).
    const merged: Record<string, unknown> = { ...existingContent };
    for (const [key, value] of Object.entries(content)) {
      if (value === null) {
        delete merged[key];
      } else {
        merged[key] = value;
      }
    }

    const errors = validateContent(merged, type.schema);
    if (errors.length > 0) {
      throw new StackValidationError(errors);
    }

    // Snapshot the raw stored state before overwriting
    await this.saveVersion(existing);

    return this.adapter.updateRecord(id, {
      typeId: latestTypeId,
      content: merged,
      updatedAt: new Date(),
      version: existing.version + 1,
    });
  }

  /**
   * Add an association to a record. Snapshots the record's prior state and
   * bumps version, same as update() — associations are covered by the same
   * versioning rule as content.
   * If the association already exists (same kind, label, and payload), this is a no-op.
   */
  async associate(id: string, association: Association): Promise<void> {
    const existing = await this.adapter.getRecord(id);
    if (!existing) {
      throw new StackNotFoundError(`Record not found: "${id}"`);
    }
    if ((existing.associations ?? []).some((a) => associationEqual(a, association))) return;

    await this.saveVersion(existing);
    await this.adapter.associate(id, association);
    await this.adapter.updateRecord(id, { version: existing.version + 1, updatedAt: new Date() });
  }

  /**
   * Remove an association from a record. Snapshots and bumps version, same
   * as associate(). Matched by kind, label, and payload. No-op if not found.
   */
  async dissociate(id: string, association: Association): Promise<void> {
    const existing = await this.adapter.getRecord(id);
    if (!existing) {
      throw new StackNotFoundError(`Record not found: "${id}"`);
    }
    if (!(existing.associations ?? []).some((a) => associationEqual(a, association))) return;

    await this.saveVersion(existing);
    await this.adapter.dissociate(id, association);
    await this.adapter.updateRecord(id, { version: existing.version + 1, updatedAt: new Date() });
  }

  /**
   * Replace all permissions on a record. Snapshots and bumps version, same
   * as associate(). Pass an empty array to make the record private (the
   * default). No-op if the new set is deep-equal to the current one.
   */
  async setPermissions(id: string, permissions: Permission[]): Promise<void> {
    const existing = await this.adapter.getRecord(id);
    if (!existing) {
      throw new StackNotFoundError(`Record not found: "${id}"`);
    }
    if (permissionsEqual(existing.permissions ?? [], permissions)) return;

    await this.saveVersion(existing);
    await this.adapter.updateRecord(id, {
      permissions,
      version: existing.version + 1,
      updatedAt: new Date(),
    });
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
   */
  async delete(id: string, opts: DeleteRecordOptions = {}): Promise<void> {
    if (opts.hard) {
      return this.adapter.deleteRecord(id, opts);
    }

    const existing = await this.adapter.getRecord(id);
    if (!existing) {
      throw new StackNotFoundError(`Record not found: "${id}"`);
    }
    if (existing.deletedAt) return;

    await this.saveVersion(existing);
    await this.adapter.deleteRecord(id, opts);
    await this.adapter.updateRecord(id, { version: existing.version + 1, updatedAt: new Date() });
  }

  /**
   * Reverse a soft delete. Idempotent — undeleting a record that isn't
   * deleted returns it unchanged. Hard-deleted records are gone, so this
   * throws StackNotFoundError for them just like any other missing record.
   * Snapshots and bumps version, same as delete().
   */
  async undelete(id: string): Promise<StackRecord> {
    const existing = await this.adapter.getRecord(id);
    if (!existing) {
      throw new StackNotFoundError(`Record not found: "${id}"`);
    }
    if (!existing.deletedAt) return existing;

    await this.saveVersion(existing);
    await this.adapter.undeleteRecord(id);
    return this.adapter.updateRecord(id, { version: existing.version + 1, updatedAt: new Date() });
  }

  /**
   * Query records. See StackQuery for filter, sort, and pagination options.
   */
  async query(query: StackQuery = {}): Promise<QueryResult> {
    const limit = query.limit !== undefined ? Math.min(query.limit, MAX_QUERY_LIMIT) : undefined;
    return this.adapter.queryRecords(limit !== undefined ? { ...query, limit } : query);
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
   * with the old content. Never rewrites history.
   *
   * Restores associations too, when the target snapshot has them. Never
   * restores permissions — those are owner/creator territory (see
   * setPermissions()), and silently reverting an ACL as a side effect of a
   * content rollback would be a surprise nobody wants. Permissions in a
   * snapshot are for audit and deliberate owner action, not automatic restore.
   */
  async restoreVersion(id: string, version: number): Promise<StackRecord> {
    const existing = await this.adapter.getRecord(id);
    if (!existing) {
      throw new StackNotFoundError(`Record not found: "${id}"`);
    }

    const target = await this.adapter.getVersion(id, version);
    if (!target) {
      throw new StackNotFoundError(`Version ${version} not found for record "${id}"`);
    }

    // Snapshot current state before restoring
    await this.saveVersion(existing);

    return this.adapter.updateRecord(id, {
      content: target.content,
      updatedAt: new Date(),
      version: existing.version + 1,
      ...(target.associations !== undefined && { associations: target.associations }),
    });
  }

  // -------------------------------------------------------
  // Attachments
  // -------------------------------------------------------

  /**
   * Store raw bytes and return the content-addressed file ID.
   * Does not create an _attachment@1 record — use putAttachment() or
   * ScopedStack.putAttachment() for the full upload flow.
   */
  async putAttachmentBytes(data: Uint8Array): Promise<string> {
    return this.adapter.putAttachment(data);
  }

  /**
   * Store bytes and create an _attachment@1 metadata record (owner-attributed,
   * no entityId). Use ScopedStack.putAttachment() when the uploader is a
   * specific entity rather than the stack owner.
   */
  async putAttachment(data: Uint8Array, mimeType: string, filename?: string): Promise<string> {
    const fileId = await this.putAttachmentBytes(data);
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
    const refResult = await this.query({ filter: { attachmentFileId: fileId }, limit: 1 });
    if (refResult.records.length > 0) {
      throw new StackConflictError('Attachment is still referenced by one or more records');
    }

    const metaResult = await this.query({
      filter: {
        typeId: `${SYSTEM_TYPES.ATTACHMENT}@1`,
        ...(this.features.contentFieldQuery && { content: { fileId } }),
      },
    });
    const metaRecords = this.features.contentFieldQuery
      ? metaResult.records
      : metaResult.records.filter((r) => (r.content as AttachmentContent).fileId === fileId);

    if (!metaRecords.length) {
      try {
        await this.adapter.getAttachment(fileId);
      } catch {
        throw new StackNotFoundError(`Attachment not found: "${fileId}"`);
      }
    }

    for (const record of metaRecords) {
      await this.delete(record.id, { hard: true });
    }

    await this.adapter.deleteAttachment(fileId);
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
   * The _grant@1 type is defined automatically on first use.
   */
  async grant(
    entityId: string | null,
    grants: Array<{ actions: GrantAction[]; typeId: TypeId }>,
  ): Promise<StackRecord[]> {
    const records: StackRecord[] = [];
    for (const g of grants) {
      records.push(
        await this.create(
          `${SYSTEM_TYPES.GRANT}@1`,
          { typeId: g.typeId, actions: g.actions },
          entityId ? { entityId } : {},
        ),
      );
    }
    return records;
  }

  // -------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------

  private async seedSystemTypes(): Promise<void> {
    await this.defineType(`${SYSTEM_TYPES.CONFIG}@1`, 'Config', {
      entityId: { kind: 'string', required: true },
      timezone: { kind: 'string', required: true },
    });
    await this.defineType(`${SYSTEM_TYPES.ENTITY}@1`, 'Entity', {
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
    });
    await this.defineType(`${SYSTEM_TYPES.ATTACHMENT}@1`, 'Attachment', {
      fileId: { kind: 'string', required: true },
      mimeType: { kind: 'string', required: true },
      size: { kind: 'number', required: true },
      filename: { kind: 'string' },
    });
  }

  private async saveVersion(record: StackRecord): Promise<void> {
    const version: RecordVersion = {
      version: record.version,
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
    return a.groupId === b.groupId && a.read === b.read && a.write === b.write;
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
    private readonly requesterEntityId: string | null,
    private readonly idTimestampSkewMs: number | null,
  ) {}

  get features(): StackFeatures {
    return this.stack.features;
  }

  private resolveRecord = (id: string): Promise<StackRecord | null> =>
    this.stack.get(id, { migrate: false });

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
   * of the given actions for the given type. For -own actions, additionally
   * requires that `record.entityId` matches the requester (authorship check).
   * Anonymous requesters always return false.
   */
  private async hasGrant(
    typeId: TypeId,
    actions: GrantAction[],
    record?: StackRecord,
    prefetchedGrants?: StackRecord[],
  ): Promise<boolean> {
    if (!this.requesterEntityId) return false;

    let grantRecords: StackRecord[];
    if (prefetchedGrants !== undefined) {
      grantRecords = prefetchedGrants;
    } else {
      const result = await this.stack.query({
        filter: {
          typeId: `${SYSTEM_TYPES.GRANT}@1`,
          ...(this.stack.features.contentFieldQuery && { content: { typeId } }),
        },
      });
      grantRecords = result.records;
    }

    return grantRecords.some((r) => {
      const c = r.content as GrantContent;
      if (c.typeId !== typeId) return false;
      if (r.entityId && r.entityId !== this.requesterEntityId) return false;
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

  /** Fetch a record the requester can update (via permissions or an update grant), or throw. */
  private async requireUpdatable(id: string): Promise<StackRecord> {
    const record = await this.stack.get(id, { migrate: false });
    if (!record) throw new StackNotFoundError(`Record not found: "${id}"`);
    const allowed =
      (await this.checkWrite(record)) ||
      (await this.hasGrant(record.typeId, ['update-own', 'update-any'], record));
    if (!allowed) throw new StackPermissionError();
    return record;
  }

  /** Fetch a record the requester can delete (via permissions or a delete grant), or throw. */
  private async requireDeletable(id: string): Promise<StackRecord> {
    const record = await this.stack.get(id, { migrate: false });
    if (!record) throw new StackNotFoundError(`Record not found: "${id}"`);
    const allowed =
      (await this.checkWrite(record)) ||
      (await this.hasGrant(record.typeId, ['delete-own', 'delete-any'], record));
    if (!allowed) throw new StackPermissionError();
    return record;
  }

  /**
   * Create a new record on behalf of the authenticated requester.
   * Requires either an entity-specific _grant or a default _grant for
   * the target type. Anonymous requesters (null entityId) are always denied.
   * The created record's entityId is always set to the requester.
   *
   * A client-supplied `opts.id` gets the same format validation as
   * Stack.create() plus a timestamp-skew check — the requester here is an
   * untrusted actor who could otherwise mint an ID that forges its sort
   * position. See StackOptions.idTimestampSkewMs.
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
    if (opts.id !== undefined) {
      validateRecordId(opts.id);
      validateIdTimestampSkew(opts.id, this.idTimestampSkewMs);
    }
    return this.stack.create(typeId, content, { ...opts, entityId: requester });
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
   * grants don't trigger a separate _grant@1 query per record.
   */
  async query(query: StackQuery = {}): Promise<QueryResult> {
    const limit = Math.min(query.limit ?? DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT);
    const records: StackRecord[] = [];
    const maxFetched = limit * 10;
    let totalFetched = 0;

    const prefetchedGrants = this.requesterEntityId
      ? (await this.stack.query({ filter: { typeId: `${SYSTEM_TYPES.GRANT}@1` } })).records
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

  async update(id: string, content: Record<string, unknown | null>): Promise<StackRecord> {
    await this.requireUpdatable(id);
    return this.stack.update(id, content);
  }

  async associate(id: string, association: Association): Promise<void> {
    await this.requireUpdatable(id);
    return this.stack.associate(id, association);
  }

  async dissociate(id: string, association: Association): Promise<void> {
    await this.requireUpdatable(id);
    return this.stack.dissociate(id, association);
  }

  async setPermissions(id: string, permissions: Permission[]): Promise<void> {
    const record = await this.stack.get(id, { migrate: false });
    if (!record) throw new StackNotFoundError(`Record not found: "${id}"`);

    const isOwner = this.requesterEntityId === this.stack.ownerEntityId;
    const isCreator = this.requesterEntityId === record.entityId;
    if (!isOwner && !isCreator) throw new StackPermissionError();

    return this.stack.setPermissions(id, permissions);
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
  async undelete(id: string): Promise<StackRecord> {
    await this.requireDeletable(id);
    return this.stack.undelete(id);
  }

  async getVersions(id: string): Promise<RecordVersion[]> {
    const existing = await this.stack.get(id, { migrate: false });
    if (!existing) throw new StackNotFoundError(`Record not found: "${id}"`);
    if (!(await this.canRead(existing))) throw new StackPermissionError();
    return this.stack.getVersions(id);
  }

  async getVersion(id: string, version: number): Promise<RecordVersion | null> {
    const existing = await this.stack.get(id, { migrate: false });
    if (!existing) throw new StackNotFoundError(`Record not found: "${id}"`);
    if (!(await this.canRead(existing))) throw new StackPermissionError();
    return this.stack.getVersion(id, version);
  }

  async restoreVersion(id: string, version: number): Promise<StackRecord> {
    await this.requireUpdatable(id);
    return this.stack.restoreVersion(id, version);
  }

  /**
   * Store raw bytes only — no _attachment@1 record. Gated identically to
   * putAttachment(): a bytes upload is only meaningful as a precursor to
   * metadata creation, so the two share one authorization check.
   * Requires a `create` grant on `_attachment@1`. Anonymous requesters are
   * always denied.
   */
  async putAttachmentBytes(data: Uint8Array): Promise<string> {
    const requester = this.requesterEntityId;
    if (!requester) {
      throw new StackPermissionError('Anonymous requesters cannot upload attachments');
    }
    if (!(await this.checkCreateGrant(`${SYSTEM_TYPES.ATTACHMENT}@1`))) {
      throw new StackPermissionError(`No create grant for type "${SYSTEM_TYPES.ATTACHMENT}@1"`);
    }
    return this.stack.putAttachmentBytes(data);
  }

  /**
   * Store bytes and create an _attachment@1 metadata record owned by the
   * requester. Requires a `create` grant on `_attachment@1`.
   * Anonymous requesters are always denied.
   */
  async putAttachment(data: Uint8Array, mimeType: string, filename?: string): Promise<string> {
    const fileId = await this.putAttachmentBytes(data);
    // putAttachmentBytes() above throws if requesterEntityId is null.
    const requester = this.requesterEntityId as string;
    await this.stack.create(
      `${SYSTEM_TYPES.ATTACHMENT}@1`,
      {
        fileId,
        mimeType,
        size: data.byteLength,
        ...(filename && { filename }),
      } satisfies AttachmentContent,
      { entityId: requester },
    );
    return fileId;
  }

  /**
   * Download attachment bytes. Accessible if the requester is the owner,
   * can read any record referencing the file, or uploaded the file themselves
   * and it hasn't been associated with a record yet.
   */
  async getAttachment(fileId: string): Promise<Uint8Array> {
    if (this.requesterEntityId === this.stack.ownerEntityId) {
      return this.stack.getAttachment(fileId);
    }

    // Accessible if the requester can read any record that references this file
    const refResult = await this.query({ filter: { attachmentFileId: fileId }, limit: 1 });
    if (refResult.records.length > 0) {
      return this.stack.getAttachment(fileId);
    }

    // Accessible if the requester uploaded it and it hasn't been associated yet
    if (this.requesterEntityId) {
      const uploadResult = await this.stack.query({
        filter: {
          typeId: `${SYSTEM_TYPES.ATTACHMENT}@1`,
          entityId: this.requesterEntityId,
          ...(this.stack.features.contentFieldQuery && { content: { fileId } }),
        },
        limit: 1,
      });
      const hasUpload = this.stack.features.contentFieldQuery
        ? uploadResult.records.length > 0
        : uploadResult.records.some((r) => (r.content as AttachmentContent).fileId === fileId);
      if (hasUpload) return this.stack.getAttachment(fileId);
    }

    throw new StackPermissionError();
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
}
