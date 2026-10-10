/**
 * Stack — Core Stack Class
 * -------------------------------------------------------
 * The Stack class is the primary interface for apps. It sits
 * on top of a StackAdapter and adds:
 *
 *  - ID generation, and validation of every caller-supplied field
 *  - Type definition, schema hashing and drift detection
 *  - Content validation on write, and the integrity rules in integrity.ts
 *  - Migrations: the registry, commitMigration() and owner-driven migrateAll()
 *  - Version snapshots, the change journal, soft delete and purge
 *  - Association and permission edits, and the change feed
 *  - Attachments, type-level grants and app installs, whose bodies live
 *    beside this file
 *  - asEntity()/asActor(), the scoped views that enforce access control
 *
 * Apps should never talk to a StackAdapter directly.
 */

import { generateId, generateIdForTimestamp } from '../id.js';
import {
  hashSchema,
  isCompatible,
  parseTypeId,
  baseIdOf,
  diffSchemas,
  fileRefFields,
  lineageProblem,
} from '../schema.js';
import {
  dropAbsentFields,
  validateContent,
  validateContentKeys,
  validatePatchValues,
  validateReservedKeys,
  validateSchemaFieldNames,
  validateSchemaReservedNames,
  validateSchemaShape,
} from '../validate.js';
import { applyMergePatch } from '../merge.js';
import { compareRecordedAttachments } from '../attachment-records.js';
import { stampGroupAdmin, validatePermissions } from '../access.js';
import { ChangeEmitter, RelayDelivery, PendingChange, assertSinceUsable } from './changes.js';
import { SYSTEM_TYPES } from '../types/index.js';
import type { ValidationError } from '../validate.js';
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
  AssociationEdit,
  AuthorityAssociation,
  DataAssociation,
  RecordVersion,
  StackCapabilities,
  IfVersionOptions,
  GrantContent,
  TypeGrant,
  PutAttachmentOptions,
  AttachmentContent,
  FileId,
  ConfigContent,
  EntityId,
  EntityContent,
  AppId,
  InstallContent,
  RecordId,
  Actor,
  ActorOptions,
  ChangeActor,
  RecordChange,
  RecordChangeSet,
  SubscribeOptions,
  Unsubscribe,
  JournalQuery,
  VersionsQuery,
  RecordJournalEntry,
} from '../types/index.js';

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
  ARGUMENTS_INVALID,
  SCHEMA_INVALID,
} from '../errors.js';
import {
  assertQueryCapabilities,
  assertSortCapability,
  assertValidAssociationFilters,
  assertValidBaseIdFilter,
  assertValidJournalQuery,
  assertValidVersionsQuery,
  assertValidSort,
  normalizeSort,
  filtersContent,
  assertFamilyId,
} from '../query-validation.js';
import {
  assertAssociationEdits,
  assertAssociationList,
  assertAuthorityAssociations,
  assertDataAssociations,
  validateAssociations,
} from '../associations/validation.js';
import { applyAssociationEdits, associationDelta, editsOf } from '../associations/identity.js';
import { validateGrantee, validateGrantBaseId } from '../grants.js';
import type { GrantQuery } from '../grants.js';
import { bindingFieldsOf } from './identity-bindings.js';
import { validateInstall } from '../install.js';
import type { AppManifest, InstallPlan } from '../install.js';
import { assertAttachmentSize, assertContentSize } from './limits.js';
import {
  validateRecordId,
  validateClockField,
  validateIdTimestampSkew,
  DEFAULT_ID_TIMESTAMP_SKEW_MS,
} from './record-id.js';
import { queryAllPages, lookupEntityByDid, MAX_QUERY_LIMIT } from './reads.js';
import {
  assertNonEmptyChangeSet,
  bumpsVersion,
  changeSetOps,
  effectiveChanges,
  takesIfVersion,
} from '../record-changes.js';
import { ScopedStack, scopeToken } from '../scoped-stack/scoped-stack.js';
import { MigrationRegistry } from './migrations.js';
import * as apps from './install-app.js';
import * as typeGrants from './type-grants.js';
import * as attachments from './attachments.js';
import {
  assertAttachmentImmutable,
  assertGroupAdminRemains,
  assertNoParentCycle,
  assertParentExists,
  checkAttachmentAssociationPointers,
  checkAttachmentMimeTypeOnCreate,
  checkBindingImmutable,
  checkBindingsOnCreate,
  checkBindingsOnMigrate,
  checkBindingsOnUpdate,
  checkConfigEntityIdUnchanged,
} from './integrity.js';
import { systemTypeDefinitions } from './system-types.js';
import type {
  BackdatableCreateRecordOptions,
  CollectAttachmentGarbageOptions,
  CollectAttachmentGarbageResult,
  DefineTypeOptions,
  DeleteAndReturnResult,
  DeleteRecordOptions,
  DeleteResult,
  GetRecordOptions,
  MigrateAllOptions,
  StackClient,
  StackOptions,
} from './client.js';
import {
  isTypeHandle,
  typedCreate,
  typedGet,
  typedMutate,
  typedQuery,
  typedSubscribe,
} from '../type-handle.js';
import { checkFamily, checkStoredVersion, WRITE_EXPECTATION } from './write-expectation.js';
import type { ExpectationOptions } from './write-expectation.js';
import type {
  ContentOf,
  PatchOf,
  ReadonlyTypeSchema,
  TypedChange,
  TypedChangeSet,
  TypedQuery,
  TypedSubscribeOptions,
  TypedRecord,
  TypeHandle,
} from '../type-handle.js';

// -------------------------------------------------------
// Supporting definitions
// -------------------------------------------------------

/**
 * An Actor in the one form `Stack` stores: a `principalId` equal to the
 * subject is dropped, so "acted as itself" has a single spelling, and an
 * empty id is refused rather than stored as a name for nobody.
 * See docs/spec/data-model.md § Actor.
 */
function normalizeActor(actor: Actor | undefined): Actor | undefined {
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
 * One refusal for every problem a call carries, content and arguments alike,
 * so a caller fixes them in one round trip. Content is itself an argument,
 * so a mixed set reads "Invalid arguments"; content alone keeps its header.
 */
function throwValidation(
  contentErrors: ValidationError[],
  argumentErrors: ValidationError[],
): void {
  if (argumentErrors.length > 0) {
    throw new StackValidationError([...argumentErrors, ...contentErrors], ARGUMENTS_INVALID);
  }
  if (contentErrors.length > 0) throw new StackValidationError(contentErrors);
}

/**
 * Every problem `content` has as a record of `typeId`: its schema, plus the
 * rules the `_grant` and `_install` families hold their content to on top
 * of one. Owed by every write that sets content, whatever shape it takes.
 */
function typedContentErrors(
  typeId: TypeId,
  content: Record<string, unknown>,
  schema: TypeSchema,
): ValidationError[] {
  return [
    ...validateContent(content, schema),
    ...validateGrantee(typeId, content),
    ...validateGrantBaseId(typeId, content),
    ...validateInstall(typeId, content),
  ];
}

// -------------------------------------------------------
// Stack class
// -------------------------------------------------------

export class Stack implements StackClient {
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
    private readonly migrations: MigrationRegistry,
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
        'Invalid adapter: adapter has no ownerEntityId. ' +
          'Initialize the adapter with an ownerEntityId before calling Stack.open().',
      );
    }
    const stack = new Stack(
      adapter,
      opts.idTimestampSkewMs === undefined ? DEFAULT_ID_TIMESTAMP_SKEW_MS : opts.idTimestampSkewMs,
      new MigrationRegistry(opts.migrations ?? []),
    );
    for (const type of systemTypeDefinitions()) await stack.defineType(type);
    if (opts.ownerProfile) {
      await stack.ensureOwnerEntity(opts.ownerProfile);
    }
    return stack;
  }

  /**
   * Idempotent bootstrap for StackOptions.ownerProfile. Its probe sees every
   * card the binding rules do, deleted and migrated ones included, or it
   * would mint one they then refuse and the stack would not reopen.
   * See docs/spec/identity.md § Entity.
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
   * TokenSession as StackTokenStore.lookupToken() returns it, which is what
   * a server should pass at its request boundary.
   * See docs/spec/access-control.md § Delegation: principal and subject.
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
  async defineType({
    id,
    name,
    schema: declared,
    migratesFrom,
  }: DefineTypeOptions): Promise<StackType> {
    this.assertOpen();
    // Only read below; the readonly view exists so a handle's literal fits.
    const schema = declared as TypeSchema;
    const parsed = parseTypeId(id);
    if (!parsed) {
      throw new StackBadRequestError(
        `Invalid TypeId format: "${id}". Expected "namespace/name@version", e.g. "com.example.myapp/note@1".`,
      );
    }

    // Even on the idempotent-no-op path below — see noteDefined().
    this.migrations.noteDefined(parsed.baseId, parsed.version);

    // Shape first: the name checks and hashSchema() below both read the
    // schema as a well-formed one, and a schema off the wire is parsed
    // JSON that no compiler has seen.
    const shapeErrors = validateSchemaShape(schema);
    if (shapeErrors.length > 0) {
      throw new StackValidationError(shapeErrors, SCHEMA_INVALID);
    }

    const nameErrors = [
      ...validateSchemaReservedNames(schema),
      ...validateSchemaFieldNames(schema),
    ];
    if (nameErrors.length > 0) {
      throw new StackValidationError(nameErrors, SCHEMA_INVALID);
    }

    const lineage = lineageProblem(id, migratesFrom);
    if (lineage) throw new StackBadRequestError(lineage);

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

  /**
   * Migrate every record of a family, deleted ones included, to the latest
   * version, aborting on the first that fails validation. `sweep: 'listed'`
   * is for a contained app that cannot see unlisted or deleted content.
   * See docs/spec/data-model.md § Type migrations.
   */
  async migrateAll(
    baseId: BaseId,
    opts: MigrateAllOptions = {},
  ): Promise<{ migrated: number; skipped: number }> {
    this.assertOpen();
    assertFamilyId(baseId, 'migrateAll');
    const familyTypeIds = await this.familyTypeIds([baseId]);

    if (familyTypeIds.length === 0) {
      throw new StackMigrationError(`migrateAll: no registered types found for baseId "${baseId}"`);
    }

    const listedOnly = opts.sweep === 'listed';
    let migrated = 0;
    let skipped = 0;

    for (const typeId of familyTypeIds) {
      const latestId = this.migrations.latest(typeId);
      if (typeId === latestId) continue;

      const migrateFn = this.migrations.path(typeId, latestId);
      if (!migrateFn) continue;

      const latestType = await this.getTypeCached(latestId);
      if (!latestType) {
        throw new StackMigrationError(`migrateAll: target type "${latestId}" is not defined.`);
      }

      let cursor: string | undefined;
      do {
        const result: QueryResult = await this.adapter.queryRecords({
          filter: { typeId, includeDeleted: true, includeUnlisted: !listedOnly },
          limit: 100,
          cursor,
        });

        for (const record of result.records) {
          if (listedOnly && record.deletedAt) {
            skipped++;
            continue;
          }
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

    return { migrated, skipped };
  }

  // -------------------------------------------------------
  // Records
  // -------------------------------------------------------

  /**
   * Create a record, validated against its type's schema. The one site that
   * stamps a `_group`'s author as its first `admin`, for scoped creates too.
   * Backdating is accepted unconditionally here; ScopedStack decides who may.
   * See docs/spec/data-model.md § Backdating on import.
   */
  async create<S extends ReadonlyTypeSchema>(
    handle: TypeHandle<S>,
    content: ContentOf<S>,
    opts?: BackdatableCreateRecordOptions,
  ): Promise<TypedRecord<S>>;
  async create<T extends Record<string, unknown> = Record<string, unknown>>(
    typeId: TypeId,
    content: T,
    opts?: BackdatableCreateRecordOptions,
  ): Promise<StackRecord & { content: T }>;
  async create(
    typeIdOrHandle: TypeId | TypeHandle,
    input: Record<string, unknown>,
    opts: BackdatableCreateRecordOptions = {},
  ): Promise<StackRecord> {
    if (isTypeHandle(typeIdOrHandle))
      return typedCreate(this, typeIdOrHandle, input as never, opts);
    const typeId = typeIdOrHandle;
    this.assertOpen();
    const type = await this.getTypeCached(typeId);
    if (!type) {
      throw new StackBadRequestError(`Unknown type: "${typeId}". Call defineType() first.`);
    }
    const content = dropAbsentFields(input, type.schema);

    // Copied, never aliased: an import loop reusing one Date would otherwise
    // retro-edit every record it had written. `instanceof`, so a non-Date
    // off the wire reaches validateClockField() below rather than throwing
    // here; the fallback never reaches storage.
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

    const argumentErrors = [
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
      argumentErrors.push({ path: 'updatedAt', message: 'updatedAt cannot precede createdAt.' });
    }
    const contentErrors = [
      ...validateReservedKeys(content),
      ...validateContentKeys(content),
      ...typedContentErrors(typeId, content, type.schema),
    ];
    throwValidation(contentErrors, argumentErrors);

    assertContentSize(content, this.capabilities.limits.contentBytes, 'Content');

    if (typeId === `${SYSTEM_TYPES.ATTACHMENT}@1`) {
      await checkAttachmentMimeTypeOnCreate(this, content as unknown as AttachmentContent);
    }

    await checkAttachmentAssociationPointers(this.readRecord, opts.associations);

    await checkBindingsOnCreate(this, typeId, content as Record<string, unknown>);

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
      if (opts.parentId !== undefined)
        await assertNoParentCycle(this.readRecord, opts.id, opts.parentId);
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
    if (opts.parentId !== undefined) await assertParentExists(this.readRecord, id, opts.parentId);

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
    return created;
  }

  /**
   * Get a record by ID, exactly as stored — no implicit migration. Pass
   * { presentAt: 'latest' } to migrate in memory; only migrateAll()
   * commits migrations to disk. A soft-deleted record answers `null` unless
   * { includeDeleted: true } is passed.
   */
  async get<S extends ReadonlyTypeSchema>(
    handle: TypeHandle<S>,
    id: RecordId,
  ): Promise<TypedRecord<S> | null>;
  async get(id: RecordId, opts?: GetRecordOptions): Promise<StackRecord | null>;
  async get(
    idOrHandle: RecordId | TypeHandle,
    idOrOpts: RecordId | GetRecordOptions = {},
  ): Promise<StackRecord | null> {
    if (isTypeHandle(idOrHandle)) return typedGet(this, idOrHandle, idOrOpts as RecordId);
    const id = idOrHandle;
    const opts = idOrOpts as GetRecordOptions;
    this.assertOpen();
    const record = await this.adapter.getRecord(id);
    if (!record) return null;
    if (record.deletedAt && !opts.includeDeleted) return null;
    return opts.presentAt === 'latest' ? this.migrations.presentAtLatest(record) : record;
  }

  /**
   * Apply a change set as one atomic write — see StackClient.mutate(). A
   * set the record already satisfies writes nothing, and content is checked
   * against the record's current stored type.
   * See docs/spec/data-model.md § Mutations.
   */
  async mutate<S extends ReadonlyTypeSchema>(
    handle: TypeHandle<S>,
    id: RecordId,
    changes: TypedChangeSet<S>,
    opts?: IfVersionOptions & ActorOptions,
  ): Promise<TypedRecord<S>>;
  async mutate(
    id: RecordId,
    changes: RecordChangeSet,
    opts?: IfVersionOptions & ActorOptions,
  ): Promise<StackRecord>;
  async mutate(
    first: RecordId | TypeHandle,
    second: RecordId | RecordChangeSet | TypedChangeSet<ReadonlyTypeSchema>,
    third?: (IfVersionOptions & ActorOptions) | RecordChangeSet,
    fourth: IfVersionOptions & ActorOptions = {},
  ): Promise<StackRecord> {
    if (isTypeHandle(first)) {
      return typedMutate(
        this,
        first,
        second as RecordId,
        third as TypedChangeSet<ReadonlyTypeSchema>,
        fourth,
      );
    }
    const id = first;
    const changes = second as RecordChangeSet;
    const opts = (third ?? {}) as IfVersionOptions & ActorOptions & ExpectationOptions;
    this.assertOpen();
    assertNonEmptyChangeSet(changes);

    const existing = await this.requireRecord(id);
    checkFamily(existing, opts);
    this.refuseIfDeleted(existing);

    // Checked before validation, so a caller that lost the race learns its
    // version is stale rather than that its patch is bad, and before the
    // no-op short-circuit below, so a precondition is never satisfied by a
    // write that turned out to move nothing.
    if (takesIfVersion(changes)) this.checkIfVersion(existing, opts.ifVersion);
    checkStoredVersion(existing, opts, changes.contentPatch !== undefined);

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

    // From the same before/after changeSetOps compared, so `ops` and the
    // journal cannot disagree; ACL and data edits travel as one list.
    // See docs/spec/events.md § The event shape.
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
  async patchContent<S extends ReadonlyTypeSchema>(
    handle: TypeHandle<S>,
    id: RecordId,
    patch: PatchOf<S>,
    opts?: IfVersionOptions & ActorOptions,
  ): Promise<TypedRecord<S>>;
  async patchContent(
    id: RecordId,
    patch: Record<string, unknown | null>,
    opts?: IfVersionOptions & ActorOptions,
  ): Promise<StackRecord>;
  async patchContent(
    first: RecordId | TypeHandle,
    second: RecordId | Record<string, unknown | null>,
    third?: Record<string, unknown | null> | (IfVersionOptions & ActorOptions),
    fourth?: IfVersionOptions & ActorOptions,
  ): Promise<StackRecord> {
    if (isTypeHandle(first)) {
      return this.mutate(first, second as RecordId, { contentPatch: third as never }, fourth);
    }
    return this.mutate(first, { contentPatch: second as Record<string, unknown | null> }, third);
  }

  /**
   * Every check a change set owes, all before anything is written. Returns
   * the merged content for a content patch, which the caller compares to
   * decide whether content moved. A parent is checked only when it changes.
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

    const argumentErrors = [
      ...(permissions
        ? [...validateAssociations(permissions, 'permissions'), ...validatePermissions(permissions)]
        : []),
      ...(associations ? validateAssociations(associations) : []),
    ];
    const patchErrors = contentPatch
      ? [
          ...validateReservedKeys(contentPatch),
          ...validatePatchValues(contentPatch),
          ...validateContentKeys(contentPatch),
        ]
      : [];
    throwValidation(patchErrors, argumentErrors);

    await checkAttachmentAssociationPointers(this.readRecord, associations, existing.associations);

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

      const contentErrors = typedContentErrors(existing.typeId, merged, type.schema);
      if (contentErrors.length > 0) throw new StackValidationError(contentErrors);

      if (existing.typeId === `${SYSTEM_TYPES.ATTACHMENT}@1`) {
        // Presence decides mimeType and value decides the rest: re-sending
        // the mimeType a record already holds is refused outright, while a
        // client round-tripping fileId or size unchanged has claimed nothing.
        assertAttachmentImmutable(
          (field) =>
            Object.prototype.hasOwnProperty.call(contentPatch, field) &&
            (field === 'mimeType' ||
              (merged as AttachmentContent)[field] !==
                (existing.content as AttachmentContent)[field]),
        );
      }

      await checkBindingsOnUpdate(
        this,
        existing.typeId,
        id,
        contentPatch,
        existing.content,
        merged,
      );

      if (id === SYSTEM_TYPES.CONFIG) {
        checkConfigEntityIdUnchanged(
          (existing.content as ConfigContent).entityId,
          (merged as ConfigContent).entityId,
        );
      }
    }

    if (associations !== undefined) {
      assertGroupAdminRemains(existing, associations);
    }

    if (parentId !== undefined && parentId !== null && parentId !== (existing.parentId ?? null)) {
      await assertParentExists(this.readRecord, id, parentId);
      await assertNoParentCycle(this.readRecord, id, parentId);
    }

    return merged;
  }

  /**
   * Add associations to a record, without a version bump. One matching an
   * existing association's identity but a different `attachmentRecordId`
   * re-points it in place. See docs/spec/attachments.md § Naming the upload
   * a reference came from.
   */
  async associate(
    id: RecordId,
    associations: DataAssociation[],
    opts: ActorOptions & ExpectationOptions = {},
  ): Promise<StackRecord> {
    assertAssociationList(associations, 'associate()', 'associations', 'data');
    return this.amendAssociations(id, editsOf('add', associations), opts, 'associate()');
  }

  /**
   * Remove associations from a record — see associate(). Matched by kind,
   * label and payload; an element not found is a no-op. The emitted event
   * names each association by identity only, since an attachment's
   * `attachmentRecordId` describes nothing current once it is gone; the
   * journal is where it survives.
   */
  async dissociate(
    id: RecordId,
    associations: DataAssociation[],
    opts: ActorOptions & ExpectationOptions = {},
  ): Promise<StackRecord> {
    assertAssociationList(associations, 'dissociate()', 'associations', 'data');
    return this.amendAssociations(id, editsOf('remove', associations), opts, 'dissociate()');
  }

  /**
   * The atomic form of associate() and dissociate(): one list of adds and
   * removes, one adapter write, one journal entry. The journal records each
   * element in full — a remove with its annotation, a re-point with what it
   * overwrote — so the entry is as undoable as a single-element one.
   * See docs/spec/data-model.md § Mutations.
   */
  async amendAssociations(
    id: RecordId,
    changes: AssociationEdit[],
    opts: ActorOptions & ExpectationOptions = {},
    surface = 'amendAssociations()',
  ): Promise<StackRecord> {
    this.assertOpen();
    assertAssociationEdits(changes, surface, 'data');
    const existing = await this.requireRecord(id);
    checkFamily(existing, opts);
    this.refuseIfDeleted(existing);
    const current = existing.associations ?? [];
    const next = applyAssociationEdits(current, changes) as DataAssociation[];
    const delta = associationDelta(current, next);
    if (delta.length === 0) return existing;
    // Only a roster can lose its last admin, and only the post-state says so.
    assertGroupAdminRemains(existing, next);
    await checkAttachmentAssociationPointers(
      this.readRecord,
      changes.flatMap((c) => (c.op === 'add' ? [c.association] : [])),
      current,
    );

    const change = new PendingChange(
      [
        ...(delta.some((c) => c.op !== 'remove') ? (['associate'] as const) : []),
        ...(delta.some((c) => c.op === 'remove') ? (['dissociate'] as const) : []),
      ],
      { actor: normalizeActor(opts.actor), associations: delta },
    );
    const updated = await this.adapter.amendAssociations(id, changes, { journal: change.journal });
    this.announce(change, updated);
    return updated;
  }

  /**
   * Extend who reaches a record. The spelling that survives two admins
   * sharing a record at once: a `permissions` key write replaces the whole
   * set, so the later of two concurrent ones drops what the earlier
   * granted. No-bump, like associate(); an element the record already
   * carries is a no-op. `write` never implies `read` — name both.
   */
  async grantAccess(
    id: RecordId,
    permissions: AuthorityAssociation[],
    opts: ActorOptions & ExpectationOptions = {},
  ): Promise<StackRecord> {
    assertAssociationList(permissions, 'grantAccess()', 'permissions', 'authority');
    return this.amendAccess(id, editsOf('add', permissions), opts, 'grantAccess()');
  }

  /**
   * Withdraw elements of who reaches a record — see grantAccess() for why
   * this is a verb rather than a key write. An element the record does not
   * carry is a no-op. Returns the record as it now stands.
   */
  async revokeAccess(
    id: RecordId,
    permissions: AuthorityAssociation[],
    opts: ActorOptions & ExpectationOptions = {},
  ): Promise<StackRecord> {
    assertAssociationList(permissions, 'revokeAccess()', 'permissions', 'authority');
    return this.amendAccess(id, editsOf('remove', permissions), opts, 'revokeAccess()');
  }

  /**
   * The atomic form of grantAccess() and revokeAccess(). The
   * write-implies-read invariant is asked once, of the set the whole list
   * produces. See docs/spec/access-control.md § Write implies read.
   */
  async amendAccess(
    id: RecordId,
    changes: AssociationEdit[],
    opts: ActorOptions & ExpectationOptions = {},
    surface = 'amendAccess()',
  ): Promise<StackRecord> {
    this.assertOpen();
    assertAssociationEdits(changes, surface, 'authority');
    const existing = await this.requireRecord(id);
    checkFamily(existing, opts);
    this.refuseIfDeleted(existing);
    const current = existing.permissions ?? [];
    const next = applyAssociationEdits(current, changes) as AuthorityAssociation[];
    const delta = associationDelta(current, next);
    if (delta.length === 0) return existing;
    this.assertPermissionSet(next);

    const change = new PendingChange('reshare', {
      actor: normalizeActor(opts.actor),
      associations: delta,
    });
    const updated = await this.adapter.amendAssociations(id, changes, { journal: change.journal });
    this.announce(change, updated);
    return updated;
  }

  /**
   * Hold a permission set to the cross-element invariant — see
   * validatePermissions() in access.ts for why it reads the post-state.
   */
  private assertPermissionSet(next: AuthorityAssociation[]): void {
    const errors = validatePermissions(next);
    if (errors.length > 0) throw new StackValidationError(errors, ARGUMENTS_INVALID);
  }

  /**
   * A soft-deleted record has no current state to edit, so the verbs that
   * edit one refuse it; undelete() and commitMigration() do not call this.
   * Asked after the record is found and, under ScopedStack, after the
   * authority decision. See docs/spec/versioning.md § Mutations are refused,
   * not applied to a tombstone.
   */
  private refuseIfDeleted(record: StackRecord): void {
    if (record.deletedAt) {
      throw new StackConflictError(
        `Record "${record.id}" is soft-deleted; undelete it before mutating it.`,
      );
    }
  }

  /**
   * A by-id read straight from the adapter, for the integrity checks a write
   * runs once it is under way: they read past the open-check, as the write
   * they belong to was admitted before any close() began.
   */
  private readonly readRecord = (id: RecordId): Promise<StackRecord | null> =>
    this.adapter.getRecord(id);

  /** The record, or the not-found refusal every mutating verb owes. */
  private async requireRecord(id: string): Promise<StackRecord> {
    const record = await this.adapter.getRecord(id);
    if (!record) throw new StackNotFoundError(`Record not found: "${id}"`);
    return record;
  }

  /**
   * Soft-delete a record, or purge it with its history. A purge reports
   * the files the record referenced, deleting none of them. Use
   * deleteAndReturn() when the record is needed too. See
   * docs/spec/versioning.md § Deletion and docs/spec/attachments.md § A
   * purge strands the bytes it referenced.
   */
  async delete(
    id: RecordId,
    opts: DeleteRecordOptions & ActorOptions & ExpectationOptions = {},
  ): Promise<DeleteResult> {
    const { referencedFileIds } = await this.deleteAndReturn(id, opts);
    return { referencedFileIds };
  }

  /**
   * delete(), plus the record it acted on — before destruction for a purge,
   * the tombstone for a soft delete — captured inside the same write, so no
   * concurrent write can land unseen between a read and the delete.
   */
  async deleteAndReturn(
    id: RecordId,
    opts: DeleteRecordOptions & ActorOptions & ExpectationOptions = {},
  ): Promise<DeleteAndReturnResult> {
    this.assertOpen();
    if (id === SYSTEM_TYPES.CONFIG) {
      throw new StackConflictError(
        "Cannot delete the _config record: it holds the stack's identity and is required for every permission check.",
      );
    }
    if (opts.purge) {
      // A purge otherwise reads nothing first, so an expectation costs it
      // one read, and the purge is pinned to that read: a write in between
      // is a conflict, never a purge of a record that was not checked.
      let ifVersion = opts.ifVersion;
      if (opts[WRITE_EXPECTATION]) {
        const current = await this.adapter.getRecord(id);
        if (!current) return { record: null, referencedFileIds: [] };
        checkFamily(current, opts);
        ifVersion ??= current.version;
      }
      // The adapter hands back what it destroyed, captured inside the same
      // write: a read here instead would race the delete, and afterwards
      // there is nothing left to read. Null means there was no record, so
      // nothing was purged and nothing is announced.
      const change = new PendingChange('purge', { actor: normalizeActor(opts.actor) });
      const purged = await this.adapter.deleteRecord(id, {
        purge: true,
        ifVersion,
        journal: change.journal,
      });
      if (!purged) return { record: null, referencedFileIds: [] };
      this.announce(change, purged);
      return { record: purged, referencedFileIds: await this.referencedFileIds(purged) };
    }

    const existing = await this.requireRecord(id);
    checkFamily(existing, opts);
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
   * purging a metadata record reports nothing — see systemTypeDefinitions().
   */
  private async referencedFileIds(record: StackRecord): Promise<FileId[]> {
    const fromAssociations = (record.associations ?? []).flatMap((a) =>
      a.kind === 'attachment' ? [a.fileId] : [],
    );
    const type = await this.getType(record.typeId);
    const content = record.content as Record<string, unknown>;
    const fromContent = fileRefFields(type?.schema ?? {}).flatMap((field) =>
      typeof content[field] === 'string' ? [content[field]] : [],
    );
    return [...new Set([...fromAssociations, ...fromContent])];
  }

  /**
   * Reverse a soft delete. Idempotent — undeleting a record that isn't
   * deleted returns it unchanged. Purged records are gone, so this
   * throws StackNotFoundError for them just like any other missing record.
   * Snapshots and bumps version, same as delete().
   */
  async undelete(
    id: RecordId,
    opts: IfVersionOptions & ActorOptions & ExpectationOptions = {},
  ): Promise<StackRecord> {
    this.assertOpen();
    const existing = await this.requireRecord(id);
    checkFamily(existing, opts);
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
  async query<S extends ReadonlyTypeSchema>(
    handle: TypeHandle<S>,
    query?: TypedQuery,
  ): Promise<{ records: TypedRecord<S>[]; cursor: string | null }>;
  async query(query?: StackQuery): Promise<QueryResult>;
  async query(
    first: TypeHandle | StackQuery = {},
    typedQueryArg?: TypedQuery,
  ): Promise<QueryResult> {
    if (isTypeHandle(first)) return typedQuery(this, first, typedQueryArg);
    const query = first;
    this.assertOpen();
    const { presentAt, filter, limit: rawLimit, ...rest } = query;
    assertQueryCapabilities(filter, this.adapter.capabilities);
    assertValidSort(query.sort);
    assertSortCapability(query.sort, this.adapter.capabilities);
    assertValidAssociationFilters(filter);
    assertValidBaseIdFilter(filter);
    const limit = rawLimit !== undefined ? Math.min(rawLimit, MAX_QUERY_LIMIT) : undefined;

    const resolvedFilter = await this.resolveBaseIdFilter(filter);
    if (resolvedFilter === EMPTY_FAMILY) {
      return { records: [], cursor: null };
    }

    const result = await this.adapter.queryRecords({
      ...rest,
      ...(query.sort && { sort: normalizeSort(query.sort) }),
      ...(resolvedFilter !== undefined && { filter: resolvedFilter }),
      ...(limit !== undefined && { limit }),
    });

    if (presentAt !== 'latest') return result;
    return { ...result, records: result.records.map((r) => this.migrations.presentAtLatest(r)) };
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
    const familyTypeIds = await this.familyTypeIds(requestedBaseIds);

    const resolvedTypeIds =
      typeId === undefined
        ? familyTypeIds
        : familyTypeIds.filter((id) =>
            Array.isArray(typeId) ? typeId.includes(id) : typeId === id,
          );

    if (resolvedTypeIds.length === 0) return EMPTY_FAMILY;
    return { ...rest, typeId: resolvedTypeIds };
  }

  /**
   * Every registered version of the named families, as concrete typeIds —
   * resolved here because an adapter has no baseId concept of its own.
   */
  private async familyTypeIds(baseIds: readonly string[]): Promise<TypeId[]> {
    const types = await this.adapter.listTypes();
    return types.filter((t) => baseIds.includes(t.baseId)).map((t) => t.id);
  }

  // -------------------------------------------------------
  // Versions
  // -------------------------------------------------------

  async getVersions(id: RecordId, query: VersionsQuery = {}): Promise<RecordVersion[]> {
    this.assertOpen();
    assertValidVersionsQuery(query);
    return this.adapter.getVersions(id, query);
  }

  /**
   * A record's change journal, oldest first, ungated. A missing or purged
   * record is StackNotFoundError, since a destroyed log and an empty one
   * are not the same answer. See docs/spec/journal.md § Reading it.
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
    opts: IfVersionOptions & ActorOptions & ExpectationOptions = {},
  ): Promise<StackRecord> {
    this.assertOpen();
    const existing = await this.requireRecord(id);
    // A snapshot is validated against its own stored Type, never the
    // record's current one, so only the family is held to the expectation.
    checkFamily(existing, opts);
    this.refuseIfDeleted(existing);
    this.checkIfVersion(existing, opts.ifVersion);

    const target = await this.adapter.getVersion(id, version);
    if (!target) {
      throw new StackNotFoundError(`Version ${version} not found for record "${id}"`);
    }

    const type = await this.getTypeCached(target.typeId);
    if (!type) {
      throw new StackBadRequestError(`Unknown type: "${target.typeId}"`);
    }

    const errors = typedContentErrors(target.typeId, target.content, type.schema);
    if (errors.length > 0) {
      throw new StackValidationError(errors);
    }

    if (id === SYSTEM_TYPES.CONFIG) {
      checkConfigEntityIdUnchanged(
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
      checkBindingImmutable(
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
   * Commit a per-record migration with caller-supplied content. Create-shaped
   * at the destination and update-shaped over the record, so it owes both
   * sets of integrity checks. See docs/spec/data-model.md § Type migrations.
   */
  async commitMigration(
    id: RecordId,
    toTypeId: TypeId,
    content: Record<string, unknown>,
    opts: IfVersionOptions & ActorOptions = {},
  ): Promise<StackRecord> {
    this.assertOpen();
    const existing = await this.requireRecord(id);
    this.checkIfVersion(existing, opts.ifVersion);
    return this.commitMigrationChecked(existing, toTypeId, content, opts);
  }

  /**
   * The checked migration write behind commitMigration() and migrateAll(),
   * taking the record in hand so a batch pass needs no re-read. A Migration
   * function is held to the same checks as a request body: app code is no
   * trust boundary here.
   */
  private async commitMigrationChecked(
    existing: StackRecord,
    toTypeId: TypeId,
    input: Record<string, unknown>,
    opts: IfVersionOptions & ActorOptions = {},
  ): Promise<StackRecord> {
    const id = existing.id;

    const type = await this.getTypeCached(toTypeId);
    if (!type) {
      throw new StackBadRequestError(`Unknown type: "${toTypeId}". Call defineType() first.`);
    }
    const content = dropAbsentFields(input, type.schema);

    const errors = [
      ...validateReservedKeys(content),
      ...validateContentKeys(content),
      ...typedContentErrors(toTypeId, content, type.schema),
    ];
    if (errors.length > 0) {
      throw new StackValidationError(errors);
    }

    assertContentSize(content, this.capabilities.limits.contentBytes, 'Content');

    const fromFamily = baseIdOf(existing.typeId);
    const toFamily = baseIdOf(toTypeId);
    const existingContent = existing.content as Record<string, unknown>;

    // Only create() stamps a group's first `admin`, so a record migrated
    // *into* `_group` would have an empty roster. Version-to-version within
    // the family keeps its roster. See docs/spec/data-model.md § Type migrations.
    if (toFamily === SYSTEM_TYPES.GROUP && fromFamily !== SYSTEM_TYPES.GROUP) {
      throw new StackConflictError(
        'Cannot migrate a record into _group: a group’s admin roster is stamped at creation. ' +
          'Create the group instead.',
      );
    }

    if (fromFamily === SYSTEM_TYPES.ATTACHMENT) {
      // Value-wise throughout: a migration re-sends all three required
      // fields, so presence would refuse every migration of the family.
      assertAttachmentImmutable(
        (field) =>
          (content as unknown as AttachmentContent)[field] !==
          (existingContent as unknown as AttachmentContent)[field],
      );
    } else if (toFamily === SYSTEM_TYPES.ATTACHMENT) {
      // A record arriving from outside the family stakes a fresh claim on
      // its fileId, exactly as create() does — so it owes create()'s check.
      await checkAttachmentMimeTypeOnCreate(this, content as unknown as AttachmentContent);
    }

    await checkBindingsOnMigrate(this, existing.typeId, toTypeId, id, existingContent, content);

    if (id === SYSTEM_TYPES.CONFIG) {
      checkConfigEntityIdUnchanged(
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

  // -------------------------------------------------------
  // Attachments
  // -------------------------------------------------------

  /**
   * Store bytes and create their `_attachment@1` metadata record, returning
   * it: `content.fileId` addresses the bytes, `id` the metadata. Uses the
   * adapter's atomic putAttachmentWithMetadata() where there is one.
   * See docs/spec/wire-format.md § Attachments.
   */
  async putAttachment(
    data: Uint8Array,
    opts: PutAttachmentOptions,
  ): Promise<StackRecord & { content: AttachmentContent }> {
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
      attachments.uploadContent(fileId, data, opts),
      { appId: opts.appId },
    );
  }

  async getAttachment(fileId: FileId): Promise<Uint8Array> {
    this.assertOpen();
    return this.adapter.getBlob(fileId);
  }

  /**
   * Every `_attachment` record describing `fileId`, earliest-recorded first.
   * Not on StackClient: it presents an access decision already made, which
   * a scoped version would only check a second, different way. See
   * docs/spec/attachments.md § Finding a `fileId`'s metadata records.
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
      .sort(compareRecordedAttachments) as (StackRecord & {
      content: AttachmentContent;
    })[];
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
        await this.familyTypeIds([SYSTEM_TYPES.ATTACHMENT]),
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
      deletedRecords = await attachments.deleteUnreferencedAttachmentRecordsFallback(
        this,
        fileId,
        opts,
      );
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
   * Sweep for attachment bytes unreachable from any record — live or
   * soft-deleted — and delete bytes + metadata. Deletion goes through
   * deleteAttachment(), so a file re-referenced by sweep time is skipped,
   * not a failure. See docs/spec/attachments.md § Garbage collection.
   */
  async collectAttachmentGarbage(
    opts: CollectAttachmentGarbageOptions & ActorOptions = {},
  ): Promise<CollectAttachmentGarbageResult> {
    this.assertOpen();
    return attachments.collectAttachmentGarbage(
      this,
      this.adapter.listBlobs?.bind(this.adapter),
      opts,
    );
  }

  // -------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------

  /**
   * Observe every change made through this Stack, unfiltered. Async so a
   * remote stack resolves once its feed is live, making subscribe-then-query
   * gap-free. See docs/spec/events.md § Subscribing.
   */
  async subscribe<S extends ReadonlyTypeSchema>(
    handle: TypeHandle<S>,
    handler: (change: TypedChange<S>) => void,
    opts?: TypedSubscribeOptions,
  ): Promise<Unsubscribe>;
  async subscribe(
    handler: (change: RecordChange) => void,
    opts?: SubscribeOptions,
  ): Promise<Unsubscribe>;
  async subscribe(
    first: TypeHandle | ((change: RecordChange) => void),
    second?: ((change: TypedChange<ReadonlyTypeSchema>) => void) | SubscribeOptions,
    third?: TypedSubscribeOptions,
  ): Promise<Unsubscribe> {
    if (isTypeHandle(first)) {
      return typedSubscribe(
        this,
        first,
        second as (change: TypedChange<ReadonlyTypeSchema>) => void,
        third,
      );
    }
    const handler = first;
    const opts = (second ?? {}) as SubscribeOptions;
    this.assertOpen();
    assertSinceUsable(opts.since, this.relaysChanges);
    assertValidBaseIdFilter(opts.filter);
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
   * Ask the adapter to relay changes made elsewhere, if it can. One relay
   * per subscription, carrying its filter to the far end, which holds the
   * records that filter needs. See docs/spec/events.md § Where events come
   * from.
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
   * Create a `_grant` authorizing `grantee` to take `actions` on `baseId`'s
   * family. An app's `-own` is read as the bare verb when it acts for
   * someone, so grant it the types it needs, not the narrowest-looking
   * suffix. See docs/spec/access-control.md § Type-level grants.
   */
  async grantType(
    baseId: BaseId,
    grant: TypeGrant,
  ): Promise<StackRecord & { content: GrantContent }> {
    this.assertOpen();
    return typeGrants.grantType(this, baseId, grant);
  }

  /**
   * List `_grant` records: all of them, or those `grantType()` would have
   * written for the same grantee. The `entity` arm instead lists what
   * currently applies to that entity, so it is not a preview of what
   * `revokeType()` would withdraw. See docs/spec/access-control.md § Listing
   * and revoking.
   */
  async listTypeGrants(query?: GrantQuery): Promise<(StackRecord & { content: GrantContent })[]> {
    this.assertOpen();
    return typeGrants.listTypeGrants(this, query);
  }

  /**
   * The inverse of grantType(): soft-deletes the matching `_grant` records,
   * grantee and actions matched exactly, and returns them. Matching nothing
   * is not an error, so re-running a revocation stays safe.
   * See docs/spec/access-control.md § Listing and revoking.
   */
  async revokeType(
    baseId: BaseId,
    grant: TypeGrant,
  ): Promise<(StackRecord & { content: GrantContent })[]> {
    this.assertOpen();
    return typeGrants.revokeType(this, baseId, grant);
  }

  // -------------------------------------------------------
  // App installs
  // -------------------------------------------------------

  /**
   * What applying `manifest` for the key `did` would change, for the owner
   * to review before installApp(). Writes nothing. Refuses outright what no
   * approval could make valid: a type outside the app's own namespace and
   * the commons, a request the grant rules refuse, or a `did` already
   * registered to a different app. See docs/spec/apps.md § Plan, then apply.
   */
  async planInstall(submitted: AppManifest, opts: { did: EntityId }): Promise<InstallPlan> {
    this.assertOpen();
    return apps.planInstall(this, submitted, opts);
  }

  /**
   * Apply an approved plan: types, the key's `_app` card, the `_install`
   * Record and every linked key's grants. A plan the stack has moved on
   * from is a StackConflictError, so what lands is what was approved.
   * See docs/spec/apps.md § Plan, then apply.
   */
  async installApp(plan: InstallPlan): Promise<StackRecord & { content: InstallContent }> {
    this.assertOpen();
    return apps.installApp(this, plan);
  }

  /**
   * Withdraw every grant an install produced and soft-delete it. The app's
   * records and `_app` cards stay: the data is the owner's, and the cards
   * are what its records' attribution resolves through. Returns the
   * install's tombstone. See docs/spec/apps.md § Uninstalling.
   */
  async uninstallApp(appId: AppId): Promise<StackRecord & { content: InstallContent }> {
    this.assertOpen();
    return apps.uninstallApp(this, appId);
  }

  // -------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------

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
   * The options every version-bumping adapter write carries — precondition,
   * prior-state snapshot and actor — taken together so a new verb cannot
   * omit one. See docs/spec/versioning.md § Version history.
   */
  private writeOptions(existing: StackRecord, opts: IfVersionOptions & ActorOptions) {
    return {
      ifVersion: opts.ifVersion,
      snapshot: this.buildVersionSnapshot(existing),
      actor: normalizeActor(opts.actor),
    };
  }

  /**
   * A record's prior state for the version it is about to leave: `content`
   * and the `typeId` it is read under, which only a snapshot keeps. The
   * journal keeps everything else. See docs/spec/versioning.md § Version
   * history.
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
