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

import { generateId } from './id.js';
import { hashSchema, isCompatible, parseTypeId } from './schema.js';
import { validateContent } from './validate.js';
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
  AdapterCapabilities,
} from './types.js';

// -------------------------------------------------------
// Supporting types
// -------------------------------------------------------

export type CreateRecordOptions = {
  parentId?: string;
  entityId?: string;
  appId?: string;
  permissions?: Permission[];
  associations?: Association[];
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

// -------------------------------------------------------
// Stack class
// -------------------------------------------------------

export class Stack {
  private readonly migrations = new Map<TypeId, Migration>();

  private constructor(
    private readonly adapter: StackAdapter,
    readonly ownerEntityId: string | null,
    readonly timezone: string,
  ) {}

  /**
   * Create a Stack instance. Reads ownerEntityId and timezone from the
   * adapter's config — the adapter is the single source of truth for
   * stack-level configuration.
   */
  static async create(adapter: StackAdapter): Promise<Stack> {
    const entityId = await adapter.getConfig('entity_id');
    const timezone = (await adapter.getConfig('timezone')) ?? 'UTC';
    return new Stack(adapter, entityId, timezone);
  }

  get capabilities(): AdapterCapabilities {
    return this.adapter.capabilities;
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

    while (current !== toId) {
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
    while (this.migrations.has(current)) {
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
          filter: { typeId },
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

    const now = new Date();
    const record: StackRecord = {
      id: generateId(),
      typeId,
      createdAt: now,
      updatedAt: now,
      content,
      version: 1,
      ...(opts.parentId && { parentId: opts.parentId }),
      ...(opts.entityId
        ? { entityId: opts.entityId }
        : this.ownerEntityId && { entityId: this.ownerEntityId }),
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
      throw new Error(`Record not found: "${id}"`);
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
   * Add an association to a record.
   * If the association already exists (same kind, label, and payload), this is a no-op.
   */
  async associate(id: string, association: Association): Promise<void> {
    return this.adapter.associate(id, association);
  }

  /**
   * Remove an association from a record.
   * Matched by kind, label, and payload. No-op if not found.
   */
  async dissociate(id: string, association: Association): Promise<void> {
    return this.adapter.dissociate(id, association);
  }

  /**
   * Replace all permissions on a record.
   * Pass an empty array to make the record private (the default).
   */
  async setPermissions(id: string, permissions: Permission[]): Promise<void> {
    const existing = await this.adapter.getRecord(id);
    if (!existing) {
      throw new Error(`Record not found: "${id}"`);
    }
    await this.adapter.updateRecord(id, { permissions });
  }

  /**
   * Soft-delete a record (default) or hard-delete it permanently.
   * Soft-deleted records are excluded from queries unless includeDeleted is set.
   * Hard-deleted records and all their version history are permanently removed.
   */
  async delete(id: string, opts: DeleteRecordOptions = {}): Promise<void> {
    return this.adapter.deleteRecord(id, opts);
  }

  /**
   * Query records. See StackQuery for filter, sort, and pagination options.
   */
  async query(query: StackQuery = {}): Promise<QueryResult> {
    return this.adapter.queryRecords(query);
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
   */
  async restoreVersion(id: string, version: number): Promise<StackRecord> {
    const existing = await this.adapter.getRecord(id);
    if (!existing) {
      throw new Error(`Record not found: "${id}"`);
    }

    const target = await this.adapter.getVersion(id, version);
    if (!target) {
      throw new Error(`Version ${version} not found for record "${id}"`);
    }

    // Snapshot current state before restoring
    await this.saveVersion(existing);

    return this.adapter.updateRecord(id, {
      content: target.content,
      updatedAt: new Date(),
      version: existing.version + 1,
    });
  }

  // -------------------------------------------------------
  // Attachments
  // -------------------------------------------------------

  async putAttachment(data: Uint8Array, mimeType: string): Promise<string> {
    return this.adapter.putAttachment(data, mimeType);
  }

  async getAttachment(fileId: string): Promise<Uint8Array> {
    return this.adapter.getAttachment(fileId);
  }

  // -------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------

  async flush(): Promise<void> {
    await this.adapter.flush?.();
  }

  async close(): Promise<void> {
    await this.adapter.close?.();
  }

  // -------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------

  private async saveVersion(record: StackRecord): Promise<void> {
    const version: RecordVersion = {
      version: record.version,
      content: record.content,
      updatedAt: record.updatedAt,
      ...(record.entityId && { entityId: record.entityId }),
    };
    await this.adapter.saveVersion(record.id, version);
  }
}
