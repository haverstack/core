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

import {
  generateId,
  generateIdForTimestamp,
  isValidIdFormat,
  idTimestamp,
  MAX_ID_TIMESTAMP,
} from './id.js';
import {
  hashSchema,
  isCompatible,
  parseTypeId,
  baseIdOf,
  diffSchemas,
  isWellFormedTypeId,
} from './schema.js';
import type { SchemaDriftViolation } from './schema.js';
import { validateContent, validateReservedKeys } from './validate.js';
import { applyMergePatch } from './merge.js';
import { checkAccess, groupRoleFromAssociations, validatePermissions } from './access.js';
import type { GroupRole } from './access.js';
import { firstRecordedAttachment } from './attachment-download.js';
import {
  ChangeEmitter,
  RelayDelivery,
  Subscription,
  buildEmission,
  matchesFilter,
  passesUnlistedBoundary,
} from './changes.js';
import type { EmittedChange } from './changes.js';
import { SYSTEM_TYPES, GRANT_ACTIONS } from './types.js';
import type { ValidationError } from './validate.js';
import type {
  StackRecord,
  StackType,
  TypeSchema,
  TypeId,
  StackAdapter,
  StackQuery,
  QuerySort,
  RecordFilter,
  QueryResult,
  Association,
  RelationshipTarget,
  RelationshipTargetPattern,
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
  AppId,
  AppContent,
  RecordId,
  TokenSession,
  ActorOptions,
  ChangeActor,
  ChangeOp,
  RecordChange,
  SubscribeOptions,
  Unsubscribe,
} from './types.js';

// -------------------------------------------------------
// Supporting types
// -------------------------------------------------------

/** Sentinel: filter.baseId resolved to zero matching types. */
const EMPTY_FAMILY = Symbol('empty-family');

/**
 * Valid GrantAction values, for runtime validation in Stack.grant().
 * Built from GRANT_ACTIONS (types.ts), the source of truth GrantAction is
 * itself derived from — so this can't drift from the type.
 */
const GRANT_ACTION_SET: ReadonlySet<GrantAction> = new Set(GRANT_ACTIONS);

/**
 * The read actions that make a mutate action coherent, scope for scope: a
 * `-any` verb needs read over the same reach it can mutate, a `-own` verb
 * needs read over its author's own. A grant carrying neither conveys the
 * verb to nobody. `create` has no companion — writing a Record you then
 * cannot read is the drop-box, and it discloses nothing.
 * See docs/spec/access-control.md § Write implies read.
 */
const READ_COMPANIONS: ReadonlyMap<GrantAction, readonly GrantAction[]> = new Map([
  ['update-own', ['read-own', 'read-any']],
  ['delete-own', ['read-own', 'read-any']],
  ['update-any', ['read-any']],
  ['delete-any', ['read-any']],
]);

/**
 * Whether one grant's action list conveys `action`. The companion has to
 * sit in the same `_grant` Record, not merely somewhere in the grantee's
 * set: a grant is revoked whole, so a rule satisfied across two records
 * would let revoking the read one leave a mutate-without-read grant
 * standing — the configuration this rule exists to refuse, arrived at
 * without anyone writing it.
 */
function grantConveys(actions: readonly string[], action: GrantAction): boolean {
  if (!actions.includes(action)) return false;
  const companions = READ_COMPANIONS.get(action);
  return !companions || companions.some((c) => actions.includes(c));
}

/**
 * Who a grant() / revoke() / listGrants() call targets: a specific entity
 * (DID), a `_group` Record's roster (by ID), or `null` for the default
 * grant / default-only listing. See docs/spec/access-control.md § Type-level
 * grants.
 */
export type GrantTarget = EntityId | { groupId: RecordId } | null;

/** Direct (non-roster) match between a stored _grant's content and a GrantTarget. */
function matchesGrantTarget(content: GrantContent, target: GrantTarget): boolean {
  if (target !== null && typeof target === 'object') {
    // Guarded so an absent groupId can't match the absent granteeGroupId on
    // every entity-targeted and default grant — `undefined === undefined`
    // would otherwise sweep them all into a revoke aimed at one group.
    if (!target.groupId) return false;
    return content.granteeGroupId === target.groupId;
  }
  if (target === null) {
    return !content.granteeEntityId && !content.granteeGroupId;
  }
  return content.granteeEntityId === target;
}

/**
 * Reject a grant target that names nobody. An empty groupId or entityId is
 * falsy, so a stored record carrying one reads as a *default* grant — every
 * authenticated entity — instead of the target the caller meant. `null` is
 * the only way to say "default".
 */
function validateGrantTarget(target: GrantTarget): void {
  if (target === null) return;
  if (typeof target === 'string') {
    if (target.length === 0) {
      throw new StackQueryError(
        'A grant target entityId cannot be empty. Pass null for a default grant.',
      );
    }
    return;
  }
  if (typeof target.groupId !== 'string' || target.groupId.length === 0) {
    throw new StackQueryError('A group grant target requires a non-empty groupId.');
  }
  // Not a format check: granteeGroupId is a reference to an existing
  // Record, like parentId or an association's recordId, and none of those
  // are parsed either. One that resolves to nothing simply denies.
}

/**
 * Whether a stored _grant covers `grantee`: a direct DID match, roster
 * membership when `allowGroup`, or a default when `allowDefault`. Presence
 * decides the tier, never truthiness — an empty grantee field names nobody.
 * Module-level so the access checks and listGrants() cannot drift apart.
 * See docs/spec/access-control.md § Type-level grants.
 */
async function grantCoversGrantee(
  c: GrantContent,
  grantee: EntityId,
  opts: {
    allowDefault: boolean;
    allowGroup: boolean;
    groupRoles: Map<string, GroupRole | null>;
    resolveRecord: (id: RecordId) => Promise<StackRecord | null>;
  },
): Promise<boolean> {
  const namesEntity = c.granteeEntityId !== undefined;
  const namesGroup = c.granteeGroupId !== undefined;
  if (!namesEntity && !namesGroup) return opts.allowDefault;
  if (namesEntity && c.granteeEntityId !== grantee) return false;
  if (namesGroup) {
    if (!opts.allowGroup) return false;
    if (!c.granteeGroupId) return false;
    const role = await resolveGroupRoleMemoized(
      c.granteeGroupId,
      grantee,
      opts.groupRoles,
      opts.resolveRecord,
    );
    if (role === null) return false;
  }
  return true;
}

/**
 * An entity's role on a `_group` roster, memoized in the caller's
 * `groupRoles` map. That map is built per operation and threaded alongside
 * `prefetchedGrants`, so no resolved role outlives the operation that
 * resolved it — removal from a group must never go stale.
 * See docs/spec/access-control.md § Type-level grants.
 */
async function resolveGroupRoleMemoized(
  groupId: RecordId,
  entityId: EntityId,
  groupRoles: Map<string, GroupRole | null>,
  resolveRecord: (id: RecordId) => Promise<StackRecord | null>,
): Promise<GroupRole | null> {
  const key = `${groupId}:${entityId}`;
  const cached = groupRoles.get(key);
  if (cached !== undefined) return cached;
  const group = await resolveRecord(groupId);
  // Only a real `_group` Record carries a roster. Without the family check
  // any Record's relationship associations would serve as one, and a group
  // migrated out of the family would keep resolving after it had stopped
  // being a group.
  const role =
    group && baseIdOf(group.typeId) === SYSTEM_TYPES.GROUP
      ? groupRoleFromAssociations(group.associations, entityId)
      : null;
  groupRoles.set(key, role);
  return role;
}

/**
 * System type families grant() refuses to target: a grant on any of them
 * would let the grantee mint their own grants, touch stack config, or
 * register an app card claiming a DID that isn't theirs — the last of
 * which is what verified app attribution rests on. See
 * docs/spec/access-control.md § Type-level grants.
 */
const UNGRANTABLE_SYSTEM_TYPES: ReadonlySet<string> = new Set([
  SYSTEM_TYPES.GRANT,
  SYSTEM_TYPES.CONFIG,
  SYSTEM_TYPES.APP,
]);

/**
 * Content fields that are lookup keys rather than display values: a card
 * claims one, and something later resolves through it. Every one of them is
 * immutable once set. See docs/spec/identity.md § DID bindings.
 */
const BINDING_FIELDS: ReadonlyMap<string, readonly ('did' | 'appId')[]> = new Map([
  [SYSTEM_TYPES.APP, ['did', 'appId'] as const],
  [SYSTEM_TYPES.ENTITY, ['did'] as const],
]);

/**
 * The subset that is additionally unique per stack: the fields something
 * resolves *by*. A Record's `principalId` finds its card by `_app.did` and
 * its `entityId` by `_entity.did`, so a second card claiming either leaves
 * that lookup without a single answer — and ambiguity is all an
 * impersonating card needs.
 *
 * `_app.appId` is deliberately absent. Nothing resolves a card by it — the
 * cross-check reaches the card by `did` and only compares `appId` — so
 * uniqueness would buy no disambiguation, while forbidding the second card
 * key rotation is supposed to produce: `appId` is required, so a
 * replacement card for the same software necessarily repeats it. Moving one
 * card onto another's `appId` is what immutability already refuses.
 * See docs/spec/identity.md § DID bindings.
 */
const UNIQUE_BINDING_FIELDS: ReadonlyMap<string, readonly ('did' | 'appId')[]> = new Map([
  [SYSTEM_TYPES.APP, ['did'] as const],
  [SYSTEM_TYPES.ENTITY, ['did'] as const],
]);

const bindingFieldsOf = (family: string): readonly ('did' | 'appId')[] =>
  BINDING_FIELDS.get(family) ?? [];

const uniqueBindingFieldsOf = (family: string): readonly ('did' | 'appId')[] =>
  UNIQUE_BINDING_FIELDS.get(family) ?? [];

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
  /** Reverse-DNS identifier of the writing software — see AppId. */
  appId?: AppId;
  /**
   * The authenticated principal, when it isn't the author. ScopedStack sets
   * this from its own principal; callers of plain Stack supply it only when
   * reconstructing a delegated write. See StackRecord.principalId.
   */
  principalId?: EntityId;
  permissions?: Permission[];
  associations?: Association[];
  /**
   * Create the record already unlisted, so the create event itself is
   * withheld from the feed — there is no window where the record exists
   * and is listed before setUnlisted() catches up. See
   * docs/spec/access-control.md § Unlisted records.
   */
  unlisted?: boolean;
};

/**
 * CreateRecordOptions extended with createdAt/updatedAt, for backdating a
 * record's clock fields on import (e.g. migrating an existing archive with
 * its original dates). Accepted unconditionally by unscoped Stack.create().
 * ScopedStack.create() accepts the same two fields, but only from the
 * stack owner acting alone (undelegated, authenticated as themselves) — a
 * grantee, or a delegated app acting for the owner, is refused, since
 * either could otherwise forge a sort position the same way a raw `id`
 * could. A server built on ScopedStack inherits this automatically: an
 * owner-authenticated `POST /records` may carry both fields; anyone else's
 * request has them ignored, as before. See docs/spec/data-model.md §
 * Record IDs and docs/spec/wire-format.md § Records.
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

export type ScopedStackOptions = {
  /**
   * The entity a delegated app acts for. Omit when the principal acts as
   * itself — the case for an app riding its user's identity, which needs
   * no delegation. See docs/spec/identity.md § App.
   */
  onBehalfOf?: EntityId;
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
  deleted: string[];
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

/**
 * Opt-in optimistic-concurrency precondition, accepted by every mutation
 * that bumps a record's version. On mismatch the mutation throws
 * StackVersionConflictError and changes nothing; omit to keep
 * last-writer-wins. See docs/spec/versioning.md § Optimistic concurrency (`ifVersion`).
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

/**
 * The wire-protocol discriminator vocabulary, one code per Stack-domain
 * error class. Lives here rather than in @haverstack/wire-types because the
 * classes that carry these codes are defined here; wire-types re-exports it
 * as WireErrorCode. See docs/spec/wire-format.md § Wire error body.
 */
export type StackErrorCode =
  | 'bad_request'
  | 'permission'
  | 'not_found'
  | 'conflict'
  | 'version_conflict'
  | 'validation'
  | 'migration'
  | 'schema_drift'
  | 'payload_too_large'
  | 'timeout';

/**
 * Root of the Stack error taxonomy. A single `instanceof StackError` answers
 * "is this a Stack-domain error or a bug?" — the question a server's error
 * middleware asks before serializing a wire body, and one a nine-arm
 * instanceof ladder answers only by exhaustion. Every subclass carries its
 * discriminator as an instance `code`, so serialization is a lookup rather
 * than a chain of class tests.
 *
 * Membership implies a wire mapping: every code has an entry in
 * WIRE_ERROR_STATUS. Errors with no wire representation (IdGenerationError,
 * InvalidDidError) deliberately stay outside this hierarchy.
 *
 * Subclassing adds no hierarchy beyond this root — notably
 * StackVersionConflictError is a sibling of StackConflictError, not a
 * subtype. See docs/spec/wire-format.md § Error responses.
 */
export abstract class StackError extends Error {
  abstract readonly code: StackErrorCode;
}

export class StackValidationError extends StackError {
  static readonly code = 'validation' as const;
  override readonly code = StackValidationError.code;
  constructor(public readonly errors: ValidationError[]) {
    super(
      `Content validation failed:\n` + errors.map((e) => `  ${e.path}: ${e.message}`).join('\n'),
    );
    this.name = 'StackValidationError';
  }
}

export class StackMigrationError extends StackError {
  static readonly code = 'migration' as const;
  override readonly code = StackMigrationError.code;
  constructor(message: string) {
    super(message);
    this.name = 'StackMigrationError';
  }
}

/** Thrown by ScopedStack when a requester lacks permission for the operation. */
export class StackPermissionError extends StackError {
  static readonly code = 'permission' as const;
  override readonly code = StackPermissionError.code;
  constructor(message = 'Permission denied') {
    super(message);
    this.name = 'StackPermissionError';
  }
}

/** Thrown when a record (or specific version) does not exist. */
export class StackNotFoundError extends StackError {
  static readonly code = 'not_found' as const;
  override readonly code = StackNotFoundError.code;
  constructor(message: string) {
    super(message);
    this.name = 'StackNotFoundError';
  }
}

/** Thrown when an operation cannot proceed due to a constraint violation (e.g. deleting an attachment that is still referenced). */
export class StackConflictError extends StackError {
  static readonly code = 'conflict' as const;
  override readonly code = StackConflictError.code;
  constructor(message: string) {
    super(message);
    this.name = 'StackConflictError';
  }
}

/**
 * Thrown when an `ifVersion` precondition doesn't match a record's current
 * version. Deliberately not a StackConflictError subtype — the two have
 * different recovery stories and HTTP statuses (409 vs. 412). See
 * docs/spec/versioning.md § Optimistic concurrency (`ifVersion`).
 */
export class StackVersionConflictError extends StackError {
  static readonly code = 'version_conflict' as const;
  override readonly code = StackVersionConflictError.code;
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
export class StackQueryError extends StackError {
  static readonly code = 'bad_request' as const;
  override readonly code = StackQueryError.code;
  constructor(message: string) {
    super(message);
    this.name = 'StackQueryError';
  }
}

/**
 * Fail loud rather than silently widen: a filter the adapter can't honor
 * would otherwise be dropped, returning an unfiltered superset presented
 * as the filtered result. Shared by Stack.query() and
 * APIAdapter.queryRecords(). See docs/spec/data-model.md
 * § Capability-gated filters.
 */
export function assertQueryCapabilities(
  filter: RecordFilter | undefined,
  capabilities: Pick<StackFeatures, 'fullTextSearch' | 'contentFieldQuery'>,
): void {
  if (filter?.search && !capabilities.fullTextSearch) {
    throw new StackQueryError(
      'Query uses filter.search, but this adapter does not declare the fullTextSearch capability.',
    );
  }
  if (filter?.content && !capabilities.contentFieldQuery) {
    throw new StackQueryError(
      'Query uses filter.content, but this adapter does not declare the contentFieldQuery capability.',
    );
  }
}

/** The only sort fields any adapter maps; anything else is a caller error. */
const VALID_SORT_FIELDS = new Set(['createdAt', 'updatedAt', 'version']);
/** The only two sort directions; see assertValidSort. */
const VALID_SORT_DIRECTIONS = new Set(['asc', 'desc']);

/**
 * Reject a sort whose field or direction is outside the closed set the
 * types promise. `QuerySort` is typed `'asc' | 'desc'`, but a type is not a
 * runtime guard: a server mapping `?direction=` onto a query, or a
 * delegated app calling query(), supplies a raw string. A SQLite record
 * adapter interpolates the direction straight into `ORDER BY`, so an
 * unvalidated value there is a SQL-injection sink reachable from every
 * untrusted caller. Validating in the invariant layer — the same reason
 * emission and _config protection live here — means no adapter can forget
 * it. See docs/spec/data-model.md § Sorting and pagination.
 */
export function assertValidSort(sort: QuerySort | undefined): void {
  if (!sort) return;
  if (sort.field !== undefined && !VALID_SORT_FIELDS.has(sort.field)) {
    throw new StackQueryError(
      `Invalid sort field "${sort.field}": expected one of createdAt, updatedAt, version.`,
    );
  }
  if (sort.direction !== undefined && !VALID_SORT_DIRECTIONS.has(sort.direction)) {
    throw new StackQueryError(
      `Invalid sort direction "${sort.direction}": expected "asc" or "desc".`,
    );
  }
}

/** The identifier spaces a relationship target may name. */
const TARGET_SCOPES = new Set(['record', 'entity', 'external']);

/**
 * Collect what makes a relationship target malformed. Absence is
 * meaningful on `stackUrl` and an external `id` — this stack, and the
 * whole namespace — so every part that names something must be non-empty:
 * an empty string stores and matches as though it were absent.
 * See docs/spec/data-model.md § Relationship targets.
 */
function targetErrors(
  target: RelationshipTarget | RelationshipTargetPattern,
  path: string,
  opts: { externalIdOptional?: boolean } = {},
): ValidationError[] {
  const fail = (message: string): ValidationError[] => [{ path, message }];
  if (!target || typeof target !== 'object')
    return fail('A relationship target must be an object.');
  if (!TARGET_SCOPES.has(target.scope)) {
    return fail(
      `Unknown relationship target scope "${target.scope}": expected "record", "entity" or "external".`,
    );
  }
  if (target.scope === 'record') {
    if (!target.recordId) return fail('A record target requires a non-empty recordId.');
    if (target.stackUrl !== undefined && !target.stackUrl) {
      return fail("A record target's stackUrl must be non-empty; omit it to name this stack.");
    }
    return [];
  }
  if (target.scope === 'entity') {
    return target.entityId ? [] : fail('An entity target requires a non-empty entityId.');
  }
  if (!target.ns) return fail('An external target requires a non-empty ns.');
  if (target.id === undefined) {
    return opts.externalIdOptional ? [] : fail('An external target requires an id.');
  }
  return target.id ? [] : fail("An external target's id must be non-empty when present.");
}

/**
 * Reject a relationship target outside the closed set the types promise.
 * A discriminated union is not a runtime guard — a server mapping a
 * request body onto an association supplies raw JSON — and an
 * unrecognized scope would otherwise be stored under the one arm that
 * names a Record in this stack. See docs/spec/data-model.md
 * § Relationship targets.
 */
function validateAssociation(association: Association, path = 'association'): ValidationError[] {
  if (association?.kind !== 'relationship') return [];
  return targetErrors(association.target, `${path}.target`);
}

/** validateAssociation() over a create's `associations` array. */
function validateAssociations(
  associations: Association[] | undefined,
  path = 'associations',
): ValidationError[] {
  return (associations ?? []).flatMap((a, i) => validateAssociation(a, `${path}[${i}]`));
}

/**
 * Reject a relationship filter that names neither a label nor a target,
 * or whose target is malformed. `RelatedToFilter` promises one half is
 * always present; without the runtime check a filter decoded from a
 * request could arrive empty and match every record carrying any
 * relationship. See docs/spec/data-model.md § Filter.
 */
export function assertValidRelatedTo(relatedTo: RecordFilter['relatedTo']): void {
  if (!relatedTo) return;
  if (relatedTo.label === undefined && relatedTo.target === undefined) {
    throw new StackQueryError(
      'filter.relatedTo must name a label, a target, or both — "any relationship at all" is not a filter.',
    );
  }
  if (relatedTo.target === undefined) return;
  const errors = targetErrors(relatedTo.target, 'filter.relatedTo.target', {
    externalIdOptional: true,
  });
  if (errors.length > 0) throw new StackQueryError(errors[0].message);
}

/**
 * Thrown when an attachment upload exceeds the adapter's declared
 * `maxAttachmentBytes` ceiling — checked client-side before any bytes are
 * sent; a server still enforces 413 authoritatively regardless. See
 * docs/spec/wire-format.md § Attachments.
 */
export class StackPayloadTooLargeError extends StackError {
  static readonly code = 'payload_too_large' as const;
  override readonly code = StackPayloadTooLargeError.code;
  constructor(message: string) {
    super(message);
    this.name = 'StackPayloadTooLargeError';
  }
}

/**
 * Thrown when a server abandons an operation for taking too long — in
 * practice a full-text search, the one query whose cost the sanitizers
 * bound the *grammar* of but not the execution of (see
 * docs/spec/data-model.md § Capability-gated filters).
 *
 * Never produced in-process: both SQLite engines run synchronously, so
 * there is nothing to interrupt from inside the call. It exists so a
 * server that bounds query time has a class to serialize, and so the app
 * catching it can tell "too expensive, narrow it and retry" from
 * StackQueryError's "malformed, don't bother retrying" — the distinction
 * that would be lost if a timeout reused `bad_request`.
 */
export class StackTimeoutError extends StackError {
  static readonly code = 'timeout' as const;
  override readonly code = StackTimeoutError.code;
  constructor(message: string) {
    super(message);
    this.name = 'StackTimeoutError';
  }
}

/** Shared by Stack.putAttachment() and ScopedStack.putAttachment(). */
function assertAttachmentSize(byteLength: number, maxAttachmentBytes: number | null): void {
  if (maxAttachmentBytes !== null && byteLength > maxAttachmentBytes) {
    throw new StackPayloadTooLargeError(
      `Attachment (${byteLength} bytes) exceeds the ${maxAttachmentBytes}-byte limit.`,
    );
  }
}

/**
 * The content half of the same pre-check, on Stack.create() and
 * Stack.update(). Local adapters declare `maxContentBytes: null` and skip
 * the serialization entirely; only a server declares a ceiling, and its
 * own request-size limit stays authoritative — this just spares an app the
 * round trip and gives it a typed failure instead of a 413 it has to
 * interpret. See docs/spec/wire-format.md § Request size limits.
 */
function assertContentSize(
  content: Record<string, unknown>,
  maxContentBytes: number | null,
  what: 'Content' | 'Patch',
): void {
  if (maxContentBytes === null) return;
  const byteLength = new TextEncoder().encode(JSON.stringify(content)).length;
  if (byteLength > maxContentBytes) {
    throw new StackPayloadTooLargeError(
      `${what} (${byteLength} bytes) exceeds the ${maxContentBytes}-byte limit.`,
    );
  }
}

/**
 * Thrown by defineType() when redefining an existing typeId with a schema
 * change beyond additive evolution. The remedy is a new version, never an
 * in-place redefinition. See docs/spec/data-model.md § Schema drift
 * detection.
 */
export class StackSchemaDriftError extends StackError {
  static readonly code = 'schema_drift' as const;
  override readonly code = StackSchemaDriftError.code;
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

/**
 * Thrown when a Stack or ScopedStack is used after close(). Deliberately
 * outside the StackError taxonomy, alongside IdGenerationError and
 * InvalidDidError: a caller holding a closed client is a local programming
 * error with no wire representation — no server ever responds with it.
 * See docs/spec/adapters.md § Lifecycle.
 */
export class StackClosedError extends Error {
  constructor(message = 'This Stack has been closed.') {
    super(message);
    this.name = 'StackClosedError';
  }
}

/**
 * Thrown when a scoped view is asked to observe a stack whose adapter
 * relays a remote feed. Outside the StackError taxonomy for the same
 * reason StackClosedError is: it reports a topology the caller assembled,
 * not a state a request can be in.
 *
 * A relayed frame is scoped by the authority that opened the feed, and a
 * narrower scope cannot re-derive that decision — a purge leaves no record
 * to check `canRead` against. Delivering anyway would break the promise
 * that a subscriber never sees what it may not read; delivering only local
 * writes would silently drop every change made elsewhere, which is the
 * failure that looks fine in testing. So it refuses.
 * See docs/spec/events.md § Permission scoping.
 */
export class StackRelayScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StackRelayScopeError';
  }
}

// -------------------------------------------------------
// Record ID validation
// -------------------------------------------------------

const RESERVED_ID_PREFIX = '_';
const DEFAULT_ID_TIMESTAMP_SKEW_MS = 24 * 60 * 60 * 1000;

/**
 * Default grace period for Stack.collectAttachmentGarbage(), covering the
 * upload-then-associate window. See docs/spec/attachments.md § Garbage
 * collection.
 */
const DEFAULT_GC_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Format and reserved-prefix checks — full-trust context (Stack.create()).
 * Checked before the format check: the Crockford charset already excludes
 * "_", so a reserved-looking id (e.g. "_config") would otherwise just fail
 * as a generic format error instead of a specific, actionable one.
 *
 * Throws StackQueryError, not StackValidationError: a malformed id is
 * structurally bad input the request never gets past — it doesn't reach
 * type-schema validation — the same reasoning that makes an undecodable
 * pagination cursor a StackQueryError rather than a content-validation
 * failure. See StackQueryError's doc comment.
 */
function validateRecordId(id: string): void {
  if (id.startsWith(RESERVED_ID_PREFIX)) {
    throw new StackQueryError(`ID "${id}" uses the reserved "${RESERVED_ID_PREFIX}" prefix.`);
  }
  if (!isValidIdFormat(id)) {
    throw new StackQueryError(
      `Invalid ID "${id}": expected 12 lowercase Crockford base-32 characters.`,
    );
  }
}

/**
 * Validity and range check for the backdating options on unscoped
 * Stack.create(). A Date is only as good as what the caller parsed it
 * from, and the two failure modes both need catching here rather than
 * downstream:
 *
 * - **Invalid Date** (`new Date('13/45/2020')` off a malformed import row)
 *   has a NaN getTime(), and every comparison against NaN is false — so an
 *   unchecked Invalid Date passes the updatedAt/createdAt ordering check
 *   and the id/createdAt skew check by turning them off, mints the
 *   epoch-zero ID `000000000xxx`, and persists a record whose
 *   `createdAt.toISOString()` throws RangeError in serializeRecord() —
 *   making that record, and any wire response containing it,
 *   permanently unreadable.
 * - **Out of encodable range** — before 1970 crockford32Encode() throws a
 *   bare RangeError from deep inside the ID encoder, and past
 *   MAX_ID_TIMESTAMP the derived ID silently grows to 13 characters and
 *   fails isValidIdFormat().
 *
 * Checked at the door for both, as a StackValidationError naming the
 * field. Applies whether or not an `id` is supplied: a clock field outside
 * this range is unrepresentable regardless of where the ID came from.
 */
function validateClockField(value: Date | undefined, path: string): ValidationError[] {
  if (value === undefined) return [];
  // Type-checked callers always pass a Date, but this option is now
  // reachable from the wire: JSON has no Date, so a server that forwards a
  // parsed `POST /records` body hands us the ISO *string* it deserialized.
  // Without this the very next line is `"2020-…".getTime()` — an unhandled
  // TypeError, a 500 where the caller should have got a 400 naming the
  // field.
  if (!(value instanceof Date)) {
    return [{ path, message: `${path} must be a Date.` }];
  }
  const ms = value.getTime();
  if (Number.isNaN(ms)) {
    return [{ path, message: `${path} is not a valid Date.` }];
  }
  if (ms < 0 || ms > MAX_ID_TIMESTAMP) {
    return [
      {
        path,
        message:
          `${path} is outside the representable range ` +
          `(1970-01-01T00:00:00.000Z…${new Date(MAX_ID_TIMESTAMP).toISOString()}).`,
      },
    ];
  }
  return [];
}

/**
 * Timestamp-prefix plausibility check, shared by callers that compare an
 * ID's embedded millisecond against a different reference each:
 * ScopedStack.create() against the current time for any non-backdated
 * create (a grantee is untrusted and could otherwise mint an ID that
 * forges its sort position, and this is the one check standing between a
 * delegated or grantee caller and doing so), and Stack.create() — reached
 * directly when unscoped, or via ScopedStack.create() when the requester
 * is the owner acting alone with an explicit `createdAt` — against that
 * `createdAt` instead (the two must agree, not silently diverge — see
 * docs/spec/data-model.md § Record IDs). Pass null to disable.
 */
function validateIdTimestampSkew(
  id: string,
  toleranceMs: number | null,
  referenceMs: number,
  referenceLabel: string,
): void {
  if (toleranceMs === null) return;
  const skew = Math.abs(referenceMs - idTimestamp(id));
  if (skew > toleranceMs) {
    throw new StackValidationError([
      {
        path: 'id',
        message: `ID "${id}" timestamp disagrees with ${referenceLabel} by more than the allowed clock-skew tolerance (${toleranceMs}ms).`,
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
  setUnlisted(id: string, unlisted: boolean, opts?: IfVersionOptions): Promise<void>;
  delete(id: string, opts?: DeleteRecordOptions): Promise<void>;
  undelete(id: string, opts?: IfVersionOptions): Promise<StackRecord>;
  getVersions(id: string): Promise<RecordVersion[]>;
  getVersion(id: string, version: number): Promise<RecordVersion | null>;
  restoreVersion(id: string, version: number, opts?: IfVersionOptions): Promise<StackRecord>;
  /**
   * Commit a per-record migration: change `typeId` and `content` together,
   * validated against `toTypeId`'s schema. The only way a record's typeId
   * changes after creation — see docs/spec/wire-format.md § Migration
   * commit. Takes `ifVersion` like every other mutation that bumps a
   * record's version (see docs/spec/versioning.md § Optimistic
   * concurrency); over the wire that is `If-Match`.
   */
  commitMigration(
    id: string,
    toTypeId: TypeId,
    content: Record<string, unknown>,
    opts?: IfVersionOptions,
  ): Promise<StackRecord>;
  getAttachment(fileId: string): Promise<Uint8Array>;
  putAttachment(
    data: Uint8Array,
    mimeType: string,
    filename?: string,
    appId?: AppId,
  ): Promise<StackRecord & { content: AttachmentContent }>;
  deleteAttachment(fileId: string): Promise<void>;
  collectAttachmentGarbage(
    opts?: CollectAttachmentGarbageOptions,
  ): Promise<CollectAttachmentGarbageResult>;
  subscribe(handler: (change: RecordChange) => void, opts?: SubscribeOptions): Promise<Unsubscribe>;
}

// -------------------------------------------------------
// Query helpers
// -------------------------------------------------------

/**
 * Walks `cursor` to exhaustion for the internal call sites that need every
 * match (grant checks, attachment cleanup) — query() itself always
 * paginates. Throws StackQueryError past `max` rather than silently
 * truncating a runaway scan. Not a public API.
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

/**
 * Cursor-walks `run(query)` looking for the first record matching
 * `predicate`, short-circuiting on a match. Same bounded-scan discipline
 * as queryAllPages(): a match past page one is still found, and a
 * non-terminating scan throws StackQueryError.
 */
async function findFirstMatch(
  run: (query: StackQuery) => Promise<QueryResult>,
  query: StackQuery,
  predicate: (record: StackRecord) => boolean | Promise<boolean>,
  max = QUERY_ALL_MAX,
): Promise<StackRecord | undefined> {
  let cursor = query.cursor;
  let totalFetched = 0;
  do {
    const page = await run({ ...query, cursor });
    totalFetched += page.records.length;
    if (totalFetched > max) {
      throw new StackQueryError(
        `findFirstMatch: exceeded max of ${max} records without exhausting the cursor`,
      );
    }
    for (const record of page.records) {
      if (await predicate(record)) return record;
    }
    cursor = page.cursor ?? undefined;
  } while (cursor);
  return undefined;
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
   * `await stack.update(...)` guarantees subscribers have been notified —
   * and nothing about work they deferred. A handler cannot fail the write:
   * there is nothing left to fail. See docs/spec/events.md § Handlers.
   */
  private emitChange(
    op: ChangeOp,
    record: StackRecord,
    opts: { actor?: ChangeActor; at?: Date } = {},
  ): void {
    this.changes.emit(buildEmission(op, record, opts));
  }

  /**
   * The requester behind a hard delete, which stamps nothing on a record
   * that no longer exists. Owner-acting-alone is the only way to reach the
   * verb, so there is never a principal to name beside the subject.
   */
  private static purgeActor(opts: ActorOptions): ChangeActor | undefined {
    return opts.updatedBy ? { entityId: opts.updatedBy } : undefined;
  }

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
   * Idempotent bootstrap for StackOptions.ownerProfile. Filters by family
   * only (contentFieldQuery is capability-gated) and matches `content.did`
   * in memory, cursor-walking so an owner card past page one isn't missed
   * and duplicated. The probe must be blind to nothing the binding rules
   * see, or it mints a card they then refuse and the stack won't open with
   * `ownerProfile`: soft-deleted cards still reserve their `did`, and a card
   * migrated to a later version still holds one.
   * See docs/spec/identity.md § DID bindings.
   */
  private async ensureOwnerEntity(profile: { name: string; handle?: string }): Promise<void> {
    const entityTypeId = `${SYSTEM_TYPES.ENTITY}@1`;
    const existing = await findFirstMatch(
      (q) => this.query(q),
      { filter: { baseId: SYSTEM_TYPES.ENTITY, includeDeleted: true, includeUnlisted: true } },
      (r) => (r.content as EntityContent).did === this.ownerEntityId,
    );
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

  get timezone(): string | undefined {
    return this.adapter.timezone;
  }

  get features(): StackFeatures {
    return this.adapter.capabilities;
  }

  /**
   * Get a permission-scoped view of this Stack, as if requests came from
   * the given principal (null = anonymous). Plain Stack methods are
   * unscoped; use asEntity() when one Stack serves multiple, possibly
   * untrusted, entities.
   *
   * `onBehalfOf` names the subject a delegated app acts for: authority is
   * then the intersection of both parties' grants, while authorship and
   * `-own` resolve against the subject. See
   * docs/spec/access-control.md § Enforcement: Stack.asEntity().
   */
  asEntity(entityId: EntityId | null, opts: ScopedStackOptions = {}): ScopedStack {
    this.assertOpen();
    if (opts.onBehalfOf && !entityId) {
      throw new StackPermissionError('An anonymous principal cannot act on behalf of an entity');
    }
    return new ScopedStack(
      this,
      entityId,
      opts.onBehalfOf ?? entityId,
      this.idTimestampSkewMsValue,
      this.adapter,
      this.changes,
    );
  }

  /**
   * Scope to an authenticated session — what StackTokenStore.lookupToken()
   * returns. Equivalent to asEntity(principalId, { onBehalfOf: subjectId }),
   * and what a server should reach for at its request boundary.
   *
   * Both identities are DIDs, so passing them positionally leaves nothing
   * to catch a swap, and a swapped pair is undetectable in the undelegated
   * case where they are equal — it would surface only once delegation is in
   * use, as authority no longer fenced by the app's grants and every write
   * attributed to the app rather than the person. Taking the pair whole
   * removes the order to get wrong. See
   * docs/spec/access-control.md § Delegation: principal and subject.
   */
  forSession(session: TokenSession): ScopedStack {
    return this.asEntity(session.principalId, { onBehalfOf: session.subjectId });
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
  async defineType(
    id: TypeId,
    name: string,
    schema: TypeSchema,
    opts: DefineTypeOptions = {},
  ): Promise<StackType> {
    this.assertOpen();
    const parsed = parseTypeId(id);
    if (!parsed) {
      throw new Error(
        `Invalid TypeId format: "${id}". Expected "namespace/name@version", e.g. "com.example.myapp/note@1".`,
      );
    }

    // Register this version even on the idempotent-no-op path —
    // presentAtLatest()'s stale-writer detection depends on it.
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
  async migrateAll(baseTypeId: string): Promise<{ migrated: number }> {
    this.assertOpen();
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
      throw new Error(`Unknown type: "${typeId}". Call defineType() first.`);
    }

    // updatedAt defaults to createdAt, not to the actual current time, so a
    // plain import doesn't fabricate a fake edit.
    //
    // Copied, never aliased: the caller keeps its own reference to any Date
    // it passed, and an import loop that reuses one Date across rows
    // (`d.setTime(...)` per record — the obvious way to write one) would
    // otherwise retro-edit every record it had already written, with no
    // version bump and no change event. createdAt drives updatedAt and
    // unlistedAt below, so one copy taken here covers all three.
    // `instanceof Date`, not `!== undefined`: this runs before the error
    // block below, so a non-Date reaching here off the wire would throw a
    // raw TypeError out of .getTime() before validateClockField() could
    // report it. Falling back keeps this line total; the error it recorded
    // still throws below, so the fallback value is never actually stored.
    const createdAt =
      opts.createdAt instanceof Date ? new Date(opts.createdAt.getTime()) : new Date();
    const updatedAt =
      opts.updatedAt instanceof Date ? new Date(opts.updatedAt.getTime()) : createdAt;

    const errors = [
      ...validateReservedKeys(content),
      ...validateContent(content, type.schema),
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

    assertContentSize(content, this.features.maxContentBytes, 'Content');

    if (typeId === `${SYSTEM_TYPES.ATTACHMENT}@1`) {
      await this.checkAttachmentMimeTypeOnCreate(content as unknown as AttachmentContent);
    }

    await this.checkBindingsOnCreate(typeId, content as Record<string, unknown>);

    if (opts.id !== undefined) {
      validateRecordId(opts.id);
      // Only when both are explicit: an `id` alone (no createdAt) stays a
      // pure position choice, exactly as before this option existed.
      if (opts.createdAt !== undefined) {
        validateIdTimestampSkew(
          opts.id,
          this.idTimestampSkewMsValue,
          opts.createdAt.getTime(),
          'createdAt',
        );
      }
    }

    const associations =
      baseIdOf(typeId) === SYSTEM_TYPES.GROUP
        ? stampGroupAdmin(opts.associations, opts.entityId ?? this.ownerEntityId)
        : opts.associations;

    // createdAt (hoisted above, alongside its validation) drives the ID
    // when the caller doesn't supply one, so the two agree by construction
    // rather than by coincidence — the same relationship an explicit `id`
    // is checked against above.
    // An explicit createdAt mints via generateIdForTimestamp(), which never
    // clamps to "now" — generateId()'s monotonic floor would otherwise
    // silently pull a deliberately historical id forward once this process
    // has minted any live id past it. The no-createdAt path keeps
    // generateId(), unaffected and still monotonic-safe.
    const id =
      opts.id ??
      (opts.createdAt !== undefined
        ? generateIdForTimestamp(createdAt.getTime())
        : generateId(createdAt.getTime()));
    const record: StackRecord = {
      id,
      typeId,
      createdAt,
      updatedAt,
      content,
      version: 1,
      ...(opts.parentId && { parentId: opts.parentId }),
      ...(opts.entityId && { entityId: opts.entityId }),
      ...(opts.appId && { appId: opts.appId }),
      ...(opts.principalId && { principalId: opts.principalId }),
      // A create's actor is its author, so these are derived rather than
      // taken: stamping them here keeps "absent means an unscoped write"
      // true of version 1 as it is of every later version.
      ...(opts.entityId && { updatedBy: opts.entityId }),
      ...(opts.principalId && { updatedVia: opts.principalId }),
      ...(opts.permissions?.length && { permissions: opts.permissions }),
      ...(associations?.length && { associations }),
      ...(opts.unlisted && { unlistedAt: createdAt }),
    };

    const created = await this.adapter.createRecord(record);
    this.emitChange('create', created);
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
  async get(id: string, opts: GetRecordOptions = {}): Promise<StackRecord | null> {
    this.assertOpen();
    const record = await this.adapter.getRecord(id);
    if (!record) return null;
    return opts.presentAt === 'latest' ? this.presentAtLatest(record) : record;
  }

  /**
   * Update a record's content via JSON Merge Patch: omitted fields are
   * kept, null removes a field. Validates the merged result against the
   * record's *current* stored type and never changes typeId (see
   * docs/spec/data-model.md § Type migrations); snapshots the prior state
   * to version history. Associations and permissions have their own methods.
   */
  async update(
    id: string,
    content: Record<string, unknown | null>,
    opts: IfVersionOptions & ActorOptions = {},
  ): Promise<StackRecord> {
    this.assertOpen();
    const existing = await this.adapter.getRecord(id);
    if (!existing) {
      throw new StackNotFoundError(`Record not found: "${id}"`);
    }
    this.checkIfVersion(existing, opts.ifVersion);

    const type = await this.getTypeCached(existing.typeId);
    if (!type) {
      throw new Error(`Unknown type: "${existing.typeId}"`);
    }

    // Checked on the raw patch, before the merge: a reserved key in a
    // patch is lost by applyMergePatch rather than stored, so a check on
    // the merged result would never see it. See validateReservedKeys().
    const patchErrors = validateReservedKeys(content);
    if (patchErrors.length > 0) {
      throw new StackValidationError(patchErrors);
    }

    // The patch is what travels, so the patch is what's measured — a small
    // patch against a large record is not an oversized request.
    assertContentSize(content, this.features.maxContentBytes, 'Patch');

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

    await this.checkBindingsOnUpdate(
      existing.typeId,
      id,
      content,
      existing.content,
      merged as Record<string, unknown>,
    );

    if (id === SYSTEM_TYPES.CONFIG) {
      this.checkConfigEntityIdUnchanged(
        (existing.content as ConfigContent).entityId,
        (merged as ConfigContent).entityId,
      );
    }

    const updated = await this.adapter.patchContent(id, content, {
      expectedVersion: opts.ifVersion,
      snapshot: this.buildVersionSnapshot(existing),
      updatedBy: opts.updatedBy,
      updatedVia: opts.updatedVia,
    });
    this.emitChange('update', updated);
    return updated;
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
    opts: IfVersionOptions & ActorOptions = {},
  ): Promise<void> {
    this.assertOpen();
    const errors = validateAssociation(association);
    if (errors.length > 0) throw new StackValidationError(errors);
    const existing = await this.adapter.getRecord(id);
    if (!existing) {
      throw new StackNotFoundError(`Record not found: "${id}"`);
    }
    this.checkIfVersion(existing, opts.ifVersion);
    if ((existing.associations ?? []).some((a) => associationEqual(a, association))) return;

    const updated = await this.adapter.associate(id, association, {
      expectedVersion: opts.ifVersion,
      snapshot: this.buildVersionSnapshot(existing),
      updatedBy: opts.updatedBy,
      updatedVia: opts.updatedVia,
    });
    this.emitChange('associate', updated);
  }

  /**
   * Remove an association from a record. Snapshots and bumps version, same
   * as associate(). Matched by kind, label, and payload. No-op if not found.
   */
  async dissociate(
    id: string,
    association: Association,
    opts: IfVersionOptions & ActorOptions = {},
  ): Promise<void> {
    this.assertOpen();
    const errors = validateAssociation(association);
    if (errors.length > 0) throw new StackValidationError(errors);
    const existing = await this.adapter.getRecord(id);
    if (!existing) {
      throw new StackNotFoundError(`Record not found: "${id}"`);
    }
    this.checkIfVersion(existing, opts.ifVersion);
    if (!(existing.associations ?? []).some((a) => associationEqual(a, association))) return;

    const updated = await this.adapter.dissociate(id, association, {
      expectedVersion: opts.ifVersion,
      snapshot: this.buildVersionSnapshot(existing),
      updatedBy: opts.updatedBy,
      updatedVia: opts.updatedVia,
    });
    this.emitChange('dissociate', updated);
  }

  /**
   * Replace all permissions on a record. Snapshots and bumps version, same
   * as associate(). Pass an empty array to make the record private (the
   * default). No-op if the new set is deep-equal to the current one.
   */
  async setPermissions(
    id: string,
    permissions: Permission[],
    opts: IfVersionOptions & ActorOptions = {},
  ): Promise<void> {
    this.assertOpen();
    const errors = validatePermissions(permissions);
    if (errors.length > 0) {
      throw new StackValidationError(errors);
    }
    const existing = await this.adapter.getRecord(id);
    if (!existing) {
      throw new StackNotFoundError(`Record not found: "${id}"`);
    }
    this.checkIfVersion(existing, opts.ifVersion);
    if (permissionsEqual(existing.permissions ?? [], permissions)) return;

    const updated = await this.adapter.setPermissions(id, permissions, {
      expectedVersion: opts.ifVersion,
      snapshot: this.buildVersionSnapshot(existing),
      updatedBy: opts.updatedBy,
      updatedVia: opts.updatedVia,
    });
    this.emitChange('permissions', updated);
  }

  /**
   * Withhold a record from enumeration, or restore it. Orthogonal to
   * setPermissions(): it says nothing about who may read the record, only
   * whether `query()` and the change feed enumerate it by default. No-op if
   * already in the requested state. See docs/spec/access-control.md §
   * Unlisted records.
   *
   * The op passed to emitChange() carries the transition direction —
   * `unlist` (kind `deleted`, so subscribers already holding the record are
   * told to drop it) or `list` (kind `changed`, an upsert like `undelete`,
   * for the record's publish moment).
   */
  async setUnlisted(
    id: string,
    unlisted: boolean,
    opts: IfVersionOptions & ActorOptions = {},
  ): Promise<void> {
    this.assertOpen();
    const existing = await this.adapter.getRecord(id);
    if (!existing) {
      throw new StackNotFoundError(`Record not found: "${id}"`);
    }
    this.checkIfVersion(existing, opts.ifVersion);
    if (Boolean(existing.unlistedAt) === unlisted) return;

    const updated = await this.adapter.setUnlisted(id, unlisted, {
      expectedVersion: opts.ifVersion,
      snapshot: this.buildVersionSnapshot(existing),
      updatedBy: opts.updatedBy,
      updatedVia: opts.updatedVia,
    });
    this.emitChange(unlisted ? 'unlist' : 'list', updated);
  }

  /**
   * Soft-delete a record (default) or hard-delete it permanently, removing
   * the record and its version history. Soft delete snapshots and bumps
   * version; a no-op if already deleted. `_config` is never deletable
   * (docs/spec.md § The `_config` record). See docs/spec/versioning.md
   * § Deletion.
   */
  async delete(id: string, opts: DeleteRecordOptions & ActorOptions = {}): Promise<void> {
    this.assertOpen();
    if (id === SYSTEM_TYPES.CONFIG) {
      throw new StackConflictError(
        "Cannot delete the _config record: it holds the stack's identity and is required for every permission check.",
      );
    }
    if (opts.hard) {
      // The adapter hands back what it destroyed, captured inside the same
      // write: a read here instead would race the delete, and afterwards
      // there is nothing left to read. Null means there was no record, so
      // nothing was purged and nothing is announced.
      const purged = await this.adapter.deleteRecord(id, {
        hard: true,
        expectedVersion: opts.ifVersion,
      });
      if (purged) this.emitChange('hard-delete', purged, { actor: Stack.purgeActor(opts) });
      return;
    }

    const existing = await this.adapter.getRecord(id);
    if (!existing) {
      throw new StackNotFoundError(`Record not found: "${id}"`);
    }
    this.checkIfVersion(existing, opts.ifVersion);
    if (existing.deletedAt) return;

    const deleted = await this.adapter.deleteRecord(id, {
      expectedVersion: opts.ifVersion,
      snapshot: this.buildVersionSnapshot(existing),
      updatedBy: opts.updatedBy,
      updatedVia: opts.updatedVia,
    });
    if (deleted) this.emitChange('delete', deleted);
  }

  /**
   * Reverse a soft delete. Idempotent — undeleting a record that isn't
   * deleted returns it unchanged. Hard-deleted records are gone, so this
   * throws StackNotFoundError for them just like any other missing record.
   * Snapshots and bumps version, same as delete().
   */
  async undelete(id: string, opts: IfVersionOptions & ActorOptions = {}): Promise<StackRecord> {
    this.assertOpen();
    const existing = await this.adapter.getRecord(id);
    if (!existing) {
      throw new StackNotFoundError(`Record not found: "${id}"`);
    }
    this.checkIfVersion(existing, opts.ifVersion);
    if (!existing.deletedAt) return existing;

    const undeleted = await this.adapter.undeleteRecord(id, {
      expectedVersion: opts.ifVersion,
      snapshot: this.buildVersionSnapshot(existing),
      updatedBy: opts.updatedBy,
      updatedVia: opts.updatedVia,
    });
    this.emitChange('undelete', undeleted);
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
    assertValidRelatedTo(filter?.relatedTo);
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

  async getVersions(id: string): Promise<RecordVersion[]> {
    this.assertOpen();
    return this.adapter.getVersions(id);
  }

  async getVersion(id: string, version: number): Promise<RecordVersion | null> {
    this.assertOpen();
    return this.adapter.getVersion(id, version);
  }

  /**
   * Restore a record to a previous version by creating a new version —
   * never rewrites history. The snapshot is validated against its own
   * stored typeId (not the record's current type), restores associations,
   * and never restores permissions. See docs/spec/versioning.md § Restore
   * semantics.
   */
  async restoreVersion(
    id: string,
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

    // Restoring is a write like any other, so it owes the same immutability
    // check update() pays — a snapshot taken before a card claimed its DID
    // would otherwise move the binding by rolling content back. Uniqueness
    // needs no separate check here: a restore can only put back a value this
    // same card already held, which immutability already refuses to change.
    for (const field of bindingFieldsOf(baseIdOf(target.typeId))) {
      this.checkBindingImmutable(
        baseIdOf(target.typeId),
        field,
        (existing.content as Record<string, unknown>)[field],
        (target.content as Record<string, unknown>)[field],
      );
    }

    const restored = await this.adapter.restoreVersion(id, version, {
      expectedVersion: opts.ifVersion,
      snapshot: this.buildVersionSnapshot(existing),
      updatedBy: opts.updatedBy,
      updatedVia: opts.updatedVia,
    });
    this.emitChange('restore', restored);
    return restored;
  }

  /**
   * Commit a per-record migration: replace `content` and `typeId` together
   * in one step, validated against `toTypeId`'s schema exactly as
   * create()/update() validate against a type's schema. The single-record
   * counterpart to migrateAll() — content here is supplied by the caller
   * (computed client-side by the type's owning app, per
   * docs/spec/wire-format.md § Migration commit) rather than a registered
   * Migration function. Snapshots the prior state to version history, same
   * as update()/restoreVersion(), and takes the same optional `ifVersion`
   * precondition every version-bumping mutation takes — checked atomically
   * at the adapter, not here (see docs/spec/versioning.md § Optimistic
   * concurrency).
   *
   * Because `content` is a full replacement written under a new `typeId`,
   * this is create-shaped at the destination *and* update-shaped over the
   * record as it stands, so it owes both sets of integrity checks — the
   * binding rules, the attachment rules, and `_config`'s. Missing either
   * half would make migrate a second, unguarded write path to the same
   * state create()/update() refuse to reach.
   */
  async commitMigration(
    id: string,
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
      throw new Error(`Unknown type: "${toTypeId}". Call defineType() first.`);
    }

    const errors = [...validateReservedKeys(content), ...validateContent(content, type.schema)];
    if (errors.length > 0) {
      throw new StackValidationError(errors);
    }

    assertContentSize(content, this.features.maxContentBytes, 'Content');

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
      this.checkAttachmentImmutableOnMigrate(
        existingContent as unknown as AttachmentContent,
        content as unknown as AttachmentContent,
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

    const migrated = await this.adapter.commitMigration(id, toTypeId, content, {
      expectedVersion: opts.ifVersion,
      snapshot: this.buildVersionSnapshot(existing),
      updatedBy: opts.updatedBy,
      updatedVia: opts.updatedVia,
    });
    this.emitChange('migrate', migrated);
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
   * new claim — update() is a merge, so an untouched binding is the one the
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
   * Bindings across a migration. `content` is a full replacement rather
   * than a patch, so there is no "field absent from the patch" case to
   * exempt: every binding field either keeps its value, moves to a new
   * one, or is shed by omission — and immutability refuses the last two
   * whichever family they happen in. Asked across the union of the two
   * families' binding fields, so a card can neither shed its DID by
   * migrating out of `_entity`/`_app` nor pick one up on the way in.
   *
   * Uniqueness is asked only of the destination family, which is where the
   * record's claim lives once the write lands, and excludes the record
   * itself — re-sending the value it already holds claims nothing.
   * See docs/spec/identity.md § DID bindings.
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
   * A unique binding field is what a lookup resolves *by* — a record's
   * `principalId` by `_app.did`, its `entityId` by `_entity.did`. Two cards
   * claiming one value would leave that lookup without a single answer, and
   * ambiguity is all an impersonating card needs. Enforced here rather than
   * by schema, since uniqueness is a property of the set, not of the value.
   * Called by the paths that can introduce a binding: create and update.
   *
   * Short-circuits on the first clash rather than materialising the family,
   * so a stack whose `_entity` family is larger than a single scan settles
   * the common case — the value is already taken — without walking the rest.
   *
   * Read-then-write, so two creates racing on one value can both pass.
   * Closing that properly means a unique index over a JSON field, which
   * each adapter would enforce separately — a decision about where
   * uniqueness lives, not a local fix.
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
          ...(this.features.contentFieldQuery && { content: { [field]: value } }),
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
   * later upload is rejected. Cursor-walked so earlier records past page
   * one are seen. See docs/spec/attachments.md § The `_attachment` record
   * type.
   *
   * Best-effort by construction — check-then-create with no storage-level
   * uniqueness behind it, so two racing first uploads can both land on a
   * concurrent server. What survives that race is the *resolution*: which
   * record establishes the type is firstRecordedAttachment()'s total
   * order, the same one a server serving Content-Type applies, so both
   * sides name the same winner however many records exist.
   */
  private async checkAttachmentMimeTypeOnCreate(content: AttachmentContent): Promise<void> {
    const { fileId, mimeType } = content;
    if (typeof fileId !== 'string') return; // schema validation already rejected this

    const metadataTypeId = `${SYSTEM_TYPES.ATTACHMENT}@1`;
    const results = await queryAllPages((q) => this.query(q), {
      filter: {
        typeId: metadataTypeId,
        includeDeleted: true,
        includeUnlisted: true,
        ...(this.features.contentFieldQuery && { content: { fileId } }),
      },
    });
    const existing = this.features.contentFieldQuery
      ? results
      : results.filter((r) => (r.content as AttachmentContent).fileId === fileId);
    if (existing.length === 0) return;

    const first = firstRecordedAttachment(existing)!;
    const establishedMimeType = (first.content as AttachmentContent).mimeType;
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
   * filename is the only mutable field on an _attachment@1 record; fileId,
   * size, and mimeType are immutable (even a same-value mimeType rewrite
   * is refused). The correction flow is delete + re-upload. See
   * docs/spec/attachments.md § The `_attachment` record type.
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
   * The same immutability checkAttachmentImmutableFields() enforces, asked
   * value-wise instead of presence-wise: a migration replaces content
   * wholesale, so it necessarily re-sends `mimeType`, `fileId` and `size`
   * (all required) and a presence check would refuse every migration. Only
   * an actual change is a violation.
   *
   * Repointing `fileId` is the one that matters most: an `_attachment@1`
   * record naming a fileId is what canAccessFile()'s uploader clause reads,
   * so moving an existing record onto another file's hash is a route to
   * bytes the record's author never uploaded.
   */
  private checkAttachmentImmutableOnMigrate(
    existing: AttachmentContent,
    next: AttachmentContent,
  ): void {
    const errors: ValidationError[] = [];
    if (next.mimeType !== existing.mimeType) {
      errors.push({
        path: 'mimeType',
        message: 'mimeType is immutable after creation; delete and re-upload to change it',
      });
    }
    if (next.fileId !== existing.fileId) {
      errors.push({ path: 'fileId', message: 'fileId is immutable' });
    }
    if (next.size !== existing.size) {
      errors.push({ path: 'size', message: 'size is immutable' });
    }
    if (errors.length > 0) {
      throw new StackValidationError(errors);
    }
  }

  /**
   * `_config.entityId` defines stack ownership; neither update() nor
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
   * attributed, no entityId), returning that record — `content.fileId`
   * addresses the bytes, `id` addresses the metadata. Delegates to the
   * adapter's atomic putAttachmentWithMetadata() when implemented, trusting
   * the returned record as backend-authoritative; otherwise falls back to
   * bytes-then-create(). See docs/spec/wire-format.md § Attachments.
   */
  async putAttachment(
    data: Uint8Array,
    mimeType: string,
    filename?: string,
    appId?: AppId,
  ): Promise<StackRecord & { content: AttachmentContent }> {
    this.assertOpen();
    assertAttachmentSize(data.byteLength, this.features.maxAttachmentBytes);
    if (this.adapter.putAttachmentWithMetadata) {
      // The metadata record is written inside the adapter, so create()
      // never sees it and this is the only place it can be announced.
      const record = await this.adapter.putAttachmentWithMetadata(data, mimeType, filename, appId);
      this.emitChange('create', record);
      return record as StackRecord & { content: AttachmentContent };
    }
    const fileId = await this.adapter.putAttachment(data);
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

  async getAttachment(fileId: string): Promise<Uint8Array> {
    this.assertOpen();
    return this.adapter.getAttachment(fileId);
  }

  /**
   * Delete an attachment's bytes and its _attachment@1 metadata record(s).
   * Throws StackConflictError if any record in the stack still references the file.
   * Throws StackNotFoundError if neither metadata records nor bytes exist.
   */
  async deleteAttachment(fileId: string, opts: ActorOptions = {}): Promise<void> {
    this.assertOpen();
    const metadataTypeId = `${SYSTEM_TYPES.ATTACHMENT}@1`;
    let deletedRecords: StackRecord[];
    if (this.adapter.deleteUnreferencedAttachmentRecords) {
      // Purged inside the adapter's own transaction, so these never reach
      // delete() and are announced here instead — from the records it
      // hands back, which are the last copies that will ever exist.
      deletedRecords = await this.adapter.deleteUnreferencedAttachmentRecords(
        fileId,
        metadataTypeId,
      );
      const at = new Date();
      for (const record of deletedRecords) {
        this.emitChange('hard-delete', record, { actor: Stack.purgeActor(opts), at });
      }
    } else {
      deletedRecords = await this.deleteUnreferencedAttachmentRecordsFallback(
        fileId,
        metadataTypeId,
        opts,
      );
    }

    if (!deletedRecords.length) {
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
    opts: ActorOptions = {},
  ): Promise<StackRecord[]> {
    // A soft-deleted or unlisted record still counts as a reference — it
    // must find its attachments intact on undelete or relisting. See
    // docs/spec/attachments.md § Deleting attachments.
    const refResult = await this.query({
      filter: { attachmentFileId: fileId, includeDeleted: true, includeUnlisted: true },
      limit: 1,
    });
    if (refResult.records.length > 0) {
      throw new StackConflictError('Attachment is still referenced by one or more records');
    }

    // Cursor-walk with includeDeleted/includeUnlisted: metadata past page
    // one, soft-deleted, or unlisted must be cleaned up too — not left
    // pointing at deleted bytes.
    const metaResults = await queryAllPages((q) => this.query(q), {
      filter: {
        typeId: metadataTypeId,
        includeDeleted: true,
        includeUnlisted: true,
        ...(this.features.contentFieldQuery && { content: { fileId } }),
      },
    });
    const metaRecords = this.features.contentFieldQuery
      ? metaResults
      : metaResults.filter((r) => (r.content as AttachmentContent).fileId === fileId);

    for (const record of metaRecords) {
      await this.delete(record.id, { hard: true, ...opts });
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

    const metadataTypeId = `${SYSTEM_TYPES.ATTACHMENT}@1`;
    const metaRecords = await queryAllPages((q) => this.query(q), {
      filter: { typeId: metadataTypeId, includeDeleted: true, includeUnlisted: true },
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
        filter: { attachmentFileId: fileId, includeDeleted: true, includeUnlisted: true },
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
        await this.deleteAttachment(fileId, { updatedBy: opts.updatedBy });
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
   * Flush pending writes to the underlying storage. A no-op for adapters
   * that commit on every call (SQLite, the API adapter); meaningful for
   * ones that buffer, and for checkpointing a stack that stays open —
   * close() covers the teardown case on its own.
   */
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
   * so it can answer `entityId` and `parentId`, which the envelope
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

  /**
   * Whether changes reach this stack from elsewhere. Public only so
   * ScopedStack can refuse a scope it cannot honor; not an app-facing API.
   */
  get relaysChanges(): boolean {
    return typeof this.adapter.subscribeChanges === 'function';
  }

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

  /**
   * Throws once close() has run. Public only so ScopedStack can gate the
   * one path it takes to the adapter directly; not an app-facing API.
   */
  assertOpen(): void {
    if (this.closed) throw new StackClosedError();
  }

  // -------------------------------------------------------
  // Grants
  // -------------------------------------------------------

  /**
   * Create _grant records authorizing entities to act on records of
   * specific types; null target writes a default grant (any authenticated
   * entity); `{ groupId }` targets a `_group` Record's roster instead of a
   * single entity.
   *
   * Granting an **app** a `-own` action does not contain it the way the
   * suffix suggests: when that app acts for someone, `-own` is read as the
   * bare verb and the subject decides which records are in reach, so in a
   * personal stack — where nearly every record is owner-authored — a
   * delegated `read-own` is close to `read-any`. Grant an app the types it
   * needs, not the suffix that looks narrowest. See
   * docs/spec/access-control.md § Delegation: principal and subject.
   *
   * The grantee lives in content.granteeEntityId / content.granteeGroupId,
   * not record.entityId. See docs/spec/access-control.md § Type-level
   * grants.
   */
  async grant(
    target: GrantTarget,
    grants: Array<{ actions: GrantAction[]; typeId: TypeId }>,
  ): Promise<StackRecord[]> {
    this.assertOpen();
    validateGrantTarget(target);
    this.checkGrantsValid(grants);
    const records: StackRecord[] = [];
    for (const g of grants) {
      records.push(
        await this.create(`${SYSTEM_TYPES.GRANT}@1`, {
          typeId: g.typeId,
          actions: g.actions,
          ...(typeof target === 'string' && { granteeEntityId: target }),
          ...(target !== null && typeof target === 'object' && { granteeGroupId: target.groupId }),
        }),
      );
    }
    return records;
  }

  /**
   * List _grant records. Omit `target` for all grants; pass null for only
   * default grants; pass `{ groupId }` for grants naming that exact group;
   * pass a specific entityId for the grants that currently apply to that
   * entity (ones naming them, ones naming a group they belong to, plus
   * every default grant) — the same resolution hasGrant() uses.
   */
  async listGrants(target?: GrantTarget): Promise<StackRecord[]> {
    this.assertOpen();
    if (target !== undefined) validateGrantTarget(target);
    const all = await queryAllPages((q) => this.query(q), {
      filter: { typeId: `${SYSTEM_TYPES.GRANT}@1` },
    });
    if (target === undefined) return all;
    if (target === null || typeof target === 'object') {
      return all.filter((r) => matchesGrantTarget(r.content as GrantContent, target));
    }

    // target is an EntityId: resolve group rosters, since a grant naming a
    // group the entity belongs to also currently applies to them. Shares
    // grantCoversGrantee() with the access checks, so a listing can't
    // disagree with them about who a grant covers.
    const groupRoles = new Map<string, GroupRole | null>();
    const result: StackRecord[] = [];
    for (const r of all) {
      const covers = await grantCoversGrantee(r.content as GrantContent, target, {
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
   * The inverse of grant(): soft-deletes _grant records matching `target`
   * (null for default grants) and each `{ typeId, actions }` pair, at the
   * same granularity grant() writes. A soft delete like any other — the
   * owner can undelete a revocation.
   */
  async revoke(
    target: GrantTarget,
    grants: Array<{ actions: GrantAction[]; typeId: TypeId }>,
  ): Promise<void> {
    this.assertOpen();
    validateGrantTarget(target);
    const all = await queryAllPages((q) => this.query(q), {
      filter: { typeId: `${SYSTEM_TYPES.GRANT}@1` },
    });
    for (const g of grants) {
      const familyId = baseIdOf(g.typeId);
      const actionSet = new Set(g.actions);
      const matches = all.filter((r) => {
        const c = r.content as GrantContent;
        if (baseIdOf(c.typeId) !== familyId) return false;
        if (!matchesGrantTarget(c, target)) return false;
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

  /**
   * Validates the whole grant batch before any record is created, so a bad
   * entry fails clean rather than leaving a partial set written. Actions
   * must be known GrantAction values, typeIds must be well-formed, and the
   * _grant/_config families are refused — see docs/spec/access-control.md
   * § Type-level grants.
   */
  private checkGrantsValid(grants: Array<{ actions: GrantAction[]; typeId: TypeId }>): void {
    const errors: ValidationError[] = [];
    grants.forEach((g, i) => {
      g.actions.forEach((action, j) => {
        if (!GRANT_ACTION_SET.has(action)) {
          errors.push({
            path: `grants[${i}].actions[${j}]`,
            message: `Unknown grant action "${action}"`,
          });
        }
      });

      if (!isWellFormedTypeId(g.typeId)) {
        errors.push({
          path: `grants[${i}].typeId`,
          message: `"${g.typeId}" is not a well-formed baseId or versioned TypeId (expected "baseId" or "baseId@version")`,
        });
        return;
      }

      if (UNGRANTABLE_SYSTEM_TYPES.has(baseIdOf(g.typeId))) {
        const refused = [...UNGRANTABLE_SYSTEM_TYPES].join(', ');
        errors.push({
          path: `grants[${i}].typeId`,
          message: `Cannot grant on "${baseIdOf(g.typeId)}": grants on ${refused} are refused to prevent privilege escalation`,
        });
      }

      g.actions.forEach((action, j) => {
        if (grantConveys(g.actions, action)) return;
        const companions = READ_COMPANIONS.get(action);
        if (!companions) return;
        errors.push({
          path: `grants[${i}].actions[${j}]`,
          message: `"${action}" requires ${companions.map((c) => `"${c}"`).join(' or ')} in the same grant: a mutate verb reaches the record and its history, so it conveys nothing without read`,
        });
      });
    });
    if (errors.length > 0) {
      throw new StackValidationError(errors);
    }
  }

  private async seedSystemTypes(): Promise<void> {
    await this.defineType(`${SYSTEM_TYPES.CONFIG}@1`, 'Config', {
      entityId: { kind: 'string', required: true },
      // Optional passthrough app metadata — see ConfigContent.timezone.
      timezone: { kind: 'string' },
    });
    await this.defineType(`${SYSTEM_TYPES.ENTITY}@1`, 'Entity', {
      did: { kind: 'string', required: true },
      name: { kind: 'string', required: true },
      handle: { kind: 'string' },
    });
    await this.defineType(`${SYSTEM_TYPES.APP}@1`, 'App', {
      appId: { kind: 'string', required: true },
      name: { kind: 'string', required: true },
      version: { kind: 'string' },
      did: { kind: 'string' },
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
      granteeGroupId: { kind: 'string' },
    });
    await this.defineType(`${SYSTEM_TYPES.ATTACHMENT}@1`, 'Attachment', {
      fileId: { kind: 'string', required: true },
      mimeType: { kind: 'string', required: true },
      size: { kind: 'number', required: true },
      filename: { kind: 'string' },
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
   * Snapshot of a record's prior state, passed with the mutating adapter
   * call so snapshot and mutation land in one atomic write. `associations`
   * is always present ([] when empty) so restore can distinguish "cleared"
   * from a snapshot that omits the key entirely ("leave as-is"). See
   * docs/spec/versioning.md § Version history.
   */
  private buildVersionSnapshot(record: StackRecord): RecordVersion {
    return {
      version: record.version,
      typeId: record.typeId,
      content: record.content,
      updatedAt: record.updatedAt,
      ...(record.entityId && { entityId: record.entityId }),
      ...(record.updatedBy && { updatedBy: record.updatedBy }),
      ...(record.updatedVia && { updatedVia: record.updatedVia }),
      associations: record.associations ?? [],
      ...(record.permissions && { permissions: record.permissions }),
    };
  }
}

// -------------------------------------------------------
// Equality helpers
// -------------------------------------------------------

/**
 * Matches the SQLite adapter's association primary key (kind, label,
 * file_id, related_scope, related_id, related_ns, related_stack).
 */
function associationEqual(a: Association, b: Association): boolean {
  if (a.kind !== b.kind || a.label !== b.label) return false;
  if (a.kind === 'attachment' && b.kind === 'attachment') return a.fileId === b.fileId;
  if (a.kind === 'relationship' && b.kind === 'relationship') {
    return targetEqual(a.target, b.target);
  }
  return true;
}

/** Structural equality per target arm — what dissociate() matches on. */
export function targetEqual(a: RelationshipTarget, b: RelationshipTarget): boolean {
  if (a.scope !== b.scope) return false;
  if (a.scope === 'record' && b.scope === 'record') {
    return a.recordId === b.recordId && (a.stackUrl ?? '') === (b.stackUrl ?? '');
  }
  if (a.scope === 'entity' && b.scope === 'entity') return a.entityId === b.entityId;
  if (a.scope === 'external' && b.scope === 'external') return a.ns === b.ns && a.id === b.id;
  return false;
}

function permissionEqual(a: Permission, b: Permission): boolean {
  if (a.access !== b.access) return false;
  if (a.access === 'public') return true;
  if (a.access === 'entity' && b.access === 'entity') {
    return a.entityId === b.entityId && a.read === b.read && a.write === b.write;
  }
  if (a.access === 'group' && b.access === 'group') {
    return a.groupId === b.groupId && a.role === b.role && a.read === b.read && a.write === b.write;
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
function stampGroupAdmin(
  associations: Association[] | undefined,
  creator: EntityId,
): Association[] {
  const list = associations ?? [];
  const alreadyAdmin = list.some(
    (a) =>
      a.kind === 'relationship' &&
      a.label === 'admin' &&
      a.target.scope === 'entity' &&
      a.target.entityId === creator,
  );
  if (alreadyAdmin) return list;
  return [
    ...list,
    { kind: 'relationship', label: 'admin', target: { scope: 'entity', entityId: creator } },
  ];
}

/**
 * Drops a snapshot's `permissions` — owner-only audit data, never served
 * to a non-owner history reader. `entityId` (change attribution) stays.
 * See docs/spec/versioning.md § History access.
 */
function stripVersionPermissions(version: RecordVersion): RecordVersion {
  if (version.permissions === undefined) return version;
  const { permissions: _permissions, ...rest } = version;
  return rest;
}

/**
 * A permission-enforcing view of a Stack for a single (principal, subject)
 * pair, obtained via `stack.asEntity(entityId)`. A record the request
 * cannot read answers exactly as a missing one does — null on reads,
 * StackNotFoundError on the verbs that name one — so only a requester who
 * could have read it is told a refusal was about access.
 * See docs/spec/access-control.md § Errors and information exposure.
 *
 * Two identities, one rule: **the principal governs authority, the subject
 * governs attribution.** Grant lookup and the privilege-bearing gates that
 * no grant reaches (setPermissions, group management, hard delete, widening
 * access at create time) key on `principalEntityId`; authorship, `-own`
 * matching, record-level permission resolution, and "files I uploaded"
 * lookups key on `subjectEntityId`.
 *
 * Unconditional owner access follows that same split rather than one
 * identity: it answers *what data is reachable* for the subject (an owner
 * subject resolves past every permission check) and *who may exercise a
 * privileged verb* for the principal (an owner app is not bounded by
 * grants). Under delegation both halves apply, and a mistake on the
 * authority side is an escalation rather than a preference.
 */
/**
 * The authority lookups canRead needs, held for the life of one
 * subscription. A subscription is long-lived where a query is not, so the
 * cache is only safe because every write that can change canRead's answer
 * arrives as an event that drops it — see ScopedSubscription.
 */
class FeedAuthorityCache {
  private grantRecords: StackRecord[] | null = null;
  /**
   * Bumped by every invalidation, so a load that was already in flight can
   * tell that its result is stale before seating it.
   */
  private generation = 0;
  /** Roster roles, memoized per group, as ScopedStack.query() does per query. */
  roles = new Map<string, GroupRole | null>();

  /** Every `_grant` record, refilled through `load` after an invalidation. */
  async grants(load: () => Promise<StackRecord[]>): Promise<StackRecord[]> {
    if (this.grantRecords !== null) return this.grantRecords;
    const generation = this.generation;
    const loaded = await load();
    // An invalidation during the load already dropped the set these
    // replace, so seating them would outlive the write that expired them
    // and no later event would drop them again. The event being decided
    // precedes that write, so it is still decided on what was loaded.
    if (this.generation === generation) this.grantRecords = loaded;
    return loaded;
  }

  invalidateFor(typeFamily: string): void {
    if (typeFamily === SYSTEM_TYPES.GRANT) {
      this.grantRecords = null;
      this.generation++;
    }
    if (typeFamily === SYSTEM_TYPES.GROUP) this.roles = new Map();
  }
}

/**
 * A ScopedStack's delivery: canRead per event, with the grant and roster
 * lookups it needs cached for the life of the subscription and dropped the
 * moment anything that feeds them changes.
 *
 * Two properties do the work, and neither is optional:
 *
 * **Deliveries are serialized.** The permission decision is asynchronous,
 * so without a queue two changes to one record could resolve out of order
 * and be delivered newest-first — breaking the one ordering guarantee the
 * feed makes. Every emission is appended to a chain instead.
 *
 * **The filter fails closed.** A permission check that throws drops the
 * event and reports the error; it never delivers on the assumption that a
 * failed check would have passed.
 *
 * See docs/spec/events.md § Permission scoping.
 */
class ScopedSubscription extends Subscription {
  private readonly cache = new FeedAuthorityCache();
  /** Tail of the delivery chain — see the class comment. */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly canRead: (record: StackRecord, cache: FeedAuthorityCache) => Promise<boolean>,
    handler: (change: RecordChange) => void,
    opts: SubscribeOptions,
  ) {
    super(handler, opts);
  }

  accept(emission: EmittedChange): void {
    // Invalidation reads every emission, including the ones this
    // subscriber may not see: a revocation the subscriber cannot read is
    // exactly the one that must still expire its cache.
    this.invalidateFor(emission);
    if (!matchesFilter(emission, this.opts.filter)) return;
    this.queue = this.queue.then(() => this.filterAndDeliver(emission));
  }

  /**
   * A cached grant set outlives the write that revokes it unless something
   * drops it. Both writes that can change canRead's answer — a `_grant`
   * record, or a `_group` roster — arrive here as ordinary events, which
   * is what makes the cache safe to hold at all. A future authority change
   * that did not emit would silently strand it.
   */
  private invalidateFor(emission: EmittedChange): void {
    this.cache.invalidateFor(baseIdOf(emission.change.typeId));
  }

  private async filterAndDeliver(emission: EmittedChange): Promise<void> {
    if (this.isClosed) return;
    if (!passesUnlistedBoundary(emission, this.opts.includeUnlisted)) return;
    try {
      if (!(await this.canRead(emission.record, this.cache))) return;
    } catch (err) {
      // Fail closed: an undecided permission question is not a yes.
      this.reportError(err);
      return;
    }
    this.deliver(emission);
  }
}

export class ScopedStack implements StackClient {
  constructor(
    private readonly stack: Stack,
    private readonly principalEntityId: EntityId | null,
    private readonly subjectEntityId: EntityId | null,
    private readonly idTimestampSkewMs: number | null,
    // Bytes-storage primitive for putAttachment(). Held directly because
    // ScopedStack always composes bytes + its own create() — the record
    // must carry the subject's entityId and the principal behind it,
    // neither of which the adapter-level atomic capability takes.
    private readonly adapter: StackAdapter,
    // The stack's own stream, filtered by subscribe(). Held here rather
    // than reached through a method on Stack so the unfiltered stream
    // stays inside this module.
    private readonly changes: ChangeEmitter,
  ) {}

  get features(): StackFeatures {
    return this.stack.features;
  }

  private resolveRecord = (id: string): Promise<StackRecord | null> => this.stack.get(id);

  /** Whether a delegated app is acting for someone other than itself. */
  private get delegated(): boolean {
    return this.subjectEntityId !== this.principalEntityId;
  }

  /**
   * Who this request is, for stamping onto whatever it mutates. Attribution
   * follows record-level authorship: the subject is the actor, and the
   * principal is named beside it only when the two differ.
   * See docs/spec/data-model.md § Authorship and attribution.
   */
  private get actor(): ActorOptions {
    // Both keys are always present, so spreading this last overrides
    // anything a caller passed: a scoped requester names itself by making
    // the request, never by describing itself in the options.
    return {
      updatedBy: this.subjectEntityId ?? undefined,
      updatedVia: this.delegated ? (this.principalEntityId ?? undefined) : undefined,
    };
  }

  /**
   * Whether unconditional owner authority applies — the owner acting as
   * itself. The verbs that rest on it are irreversible or disclose the
   * sharing graph, so delegation never carries one to a subject, whichever
   * side the owner is on. See
   * docs/spec/access-control.md § Delegation: principal and subject.
   */
  private get ownerActingAlone(): boolean {
    return !this.delegated && this.principalEntityId === this.stack.ownerEntityId;
  }

  private checkRead(record: StackRecord): Promise<boolean> {
    return checkAccess(
      record,
      this.subjectEntityId,
      this.stack.ownerEntityId,
      'read',
      this.resolveRecord,
    );
  }

  private checkWrite(record: StackRecord): Promise<boolean> {
    return checkAccess(
      record,
      this.subjectEntityId,
      this.stack.ownerEntityId,
      'write',
      this.resolveRecord,
    );
  }

  /**
   * Whether `grantee` holds a _grant covering one of `actions` for the
   * type's family (grants match by baseId, so a version bump never orphans
   * one). -own actions additionally require record.entityId === grantee,
   * unless `matchOwn` is false — on the principal side of a delegated
   * request the suffix is read as the bare verb, since which records are
   * reachable is the subject's business. `allowDefault` decides whether a
   * grant naming nobody counts. Anonymous grantees always return false.
   *
   * Reached only through subjectAllows()/principalAllows(), which fix those
   * two flags per side of the intersection. Call one of those instead.
   * See docs/spec/access-control.md § Type-level grants.
   */
  private async hasGrant(
    typeId: TypeId,
    actions: GrantAction[],
    opts: {
      grantee: EntityId | null;
      record?: StackRecord;
      prefetchedGrants?: StackRecord[];
      groupRoles?: Map<string, GroupRole | null>;
      matchOwn?: boolean;
      allowDefault?: boolean;
      allowGroup?: boolean;
    },
  ): Promise<boolean> {
    const {
      grantee,
      record,
      prefetchedGrants,
      matchOwn = true,
      allowDefault = true,
      allowGroup = true,
    } = opts;
    if (!grantee) return false;
    // Absent when the caller has no operation-scoped map to share — one
    // call's worth of memoization, which is still every grant record in
    // this loop naming the same group.
    const groupRoles = opts.groupRoles ?? new Map<string, GroupRole | null>();

    const familyId = baseIdOf(typeId);

    // grant() refuses to write these, but a _grant record is an ordinary
    // Record: an unscoped Stack, an import, or a server mapping a request
    // body onto Stack can mint one anyway. Refusing at the point of use is
    // what makes the rule hold regardless of how the record got there.
    if (UNGRANTABLE_SYSTEM_TYPES.has(familyId)) return false;

    let grantRecords: StackRecord[];
    if (prefetchedGrants !== undefined) {
      grantRecords = prefetchedGrants;
    } else {
      // No content-field prefilter: a stored grant's typeId may be a bare
      // baseId or versioned, so exact matching would wrongly exclude family
      // versions. Cursor-walked to see grants past page one.
      grantRecords = await queryAllPages((q) => this.stack.query(q), {
        filter: { typeId: `${SYSTEM_TYPES.GRANT}@1` },
      });
    }

    for (const r of grantRecords) {
      const c = r.content as GrantContent;
      if (baseIdOf(c.typeId) !== familyId) continue;
      const covers = await grantCoversGrantee(c, grantee, {
        allowDefault,
        allowGroup,
        groupRoles,
        resolveRecord: this.resolveRecord,
      });
      if (!covers) continue;
      const matches = actions.some((action) => {
        if (!grantConveys(c.actions as string[], action)) return false;
        if (matchOwn && action.endsWith('-own')) return record?.entityId === grantee;
        return true;
      });
      if (matches) return true;
    }
    return false;
  }

  /**
   * The principal half of a delegated request's authority: does the app
   * hold any grant permitting these verbs on this type at all. Bounds what
   * the subject's own authority can reach through it, so a powerful app
   * can never lend its reach to a weaker subject — nor the reverse.
   * Vacuously true when there's no delegation, where the principal and
   * subject checks would be the same question asked twice.
   *
   * Default grants don't count here. "Any authenticated entity" is about
   * people who turn up, not software the owner installed — an app reaches
   * only the types named to it, which is the whole of what containment
   * promises.
   *
   * Group-targeted grants don't count here either, one step removed: a
   * roster is editable by any of the group's admins, so authority reaching
   * a principal through one would let someone other than the owner name an
   * app to a type. See docs/spec/access-control.md § Type-level grants.
   */
  private principalAllows(
    typeId: TypeId,
    actions: GrantAction[],
    prefetchedGrants?: StackRecord[],
  ): Promise<boolean> {
    if (!this.delegated) return Promise.resolve(true);
    if (this.principalEntityId === this.stack.ownerEntityId) return Promise.resolve(true);
    return this.hasGrant(typeId, actions, {
      grantee: this.principalEntityId,
      prefetchedGrants,
      matchOwn: false,
      allowDefault: false,
      allowGroup: false,
    });
  }

  /**
   * The subject half: which records are reachable, answered with `-own`
   * matching and default grants both in force — the ordinary reading of a
   * grant, since the subject is the entity a grant is written about.
   *
   * Paired with principalAllows() so that the two halves of the
   * intersection are the only callers of hasGrant(): its flags differ per
   * side and mean nothing on their own, so no call site sets them by hand.
   */
  private subjectAllows(
    typeId: TypeId,
    actions: GrantAction[],
    opts: {
      record?: StackRecord;
      prefetchedGrants?: StackRecord[];
      groupRoles?: Map<string, GroupRole | null>;
    } = {},
  ): Promise<boolean> {
    return this.hasGrant(typeId, actions, {
      grantee: this.subjectEntityId,
      record: opts.record,
      prefetchedGrants: opts.prefetchedGrants,
      groupRoles: opts.groupRoles,
    });
  }

  /**
   * How to refuse a record this request addressed by ID. A requester who
   * can read the record is told it exists and the verb was refused;
   * everyone else is told what a missing ID is told, so no one learns an ID
   * is live who could not have learned it by reading. `message` therefore
   * only ever reaches someone holding the record already.
   * See docs/spec/access-control.md § Errors and information exposure.
   */
  private async denialFor(record: StackRecord, message?: string): Promise<StackError> {
    // Prefetched here rather than threaded down from the gate: a write
    // carried by a record-level permission settles without reading a grant
    // at all, and that path must not pay for this one. Both halves of
    // canRead share the one scan.
    const grants =
      this.principalEntityId || this.subjectEntityId
        ? await queryAllPages((q) => this.stack.query(q), {
            filter: { typeId: `${SYSTEM_TYPES.GRANT}@1` },
          })
        : undefined;
    if (await this.canRead(record, grants)) return new StackPermissionError(message);
    return new StackNotFoundError(`Record not found: "${record.id}"`);
  }

  private async canRead(
    record: StackRecord,
    prefetchedGrants?: StackRecord[],
    groupRoles?: Map<string, GroupRole | null>,
  ): Promise<boolean> {
    const reachable =
      (await this.checkRead(record)) ||
      (await this.subjectAllows(record.typeId, ['read-own', 'read-any'], {
        record,
        prefetchedGrants,
        groupRoles,
      }));
    if (!reachable) return false;
    return this.principalAllows(record.typeId, ['read-own', 'read-any'], prefetchedGrants);
  }

  private async checkCreateGrant(typeId: TypeId): Promise<boolean> {
    if (this.ownerActingAlone) return true;
    const reachable =
      this.subjectEntityId === this.stack.ownerEntityId ||
      (await this.subjectAllows(typeId, ['create']));
    if (!reachable) return false;
    return this.principalAllows(typeId, ['create']);
  }

  /**
   * `_group` records are managed, not merely written: only the owner or an
   * `admin` roster holder may mutate them — ordinary write permissions and
   * grants don't apply. Asked of both identities under delegation, like
   * setPermissions(). See docs/spec/identity.md § Group.
   */
  private isGroupManager(record: StackRecord): boolean {
    if (!this.managesGroup(this.principalEntityId, record)) return false;
    return !this.delegated || this.managesGroup(this.subjectEntityId, record);
  }

  /** Whether one identity, on its own, manages `record` — see isGroupManager(). */
  private managesGroup(entityId: EntityId | null, record: StackRecord): boolean {
    if (!entityId) return false;
    if (entityId === this.stack.ownerEntityId) return true;
    return groupRoleFromAssociations(record.associations, entityId) === 'admin';
  }

  /**
   * Fetch a record the subject can reach and the principal holds `update` on
   * (via permissions or an update grant), or throw. `mutating: false` marks
   * the history readers, which borrow this gate without changing anything —
   * the one way through it a `_grant` Record stays open to.
   */
  private async requireUpdatable(
    id: string,
    opts: { mutating?: boolean } = {},
  ): Promise<StackRecord> {
    const record = await this.stack.get(id);
    if (!record) throw new StackNotFoundError(`Record not found: "${id}"`);
    if (opts.mutating ?? true) await this.requireOwnerForGrantRecord(record);
    if (baseIdOf(record.typeId) === SYSTEM_TYPES.GROUP) {
      if (!this.isGroupManager(record)) throw await this.denialFor(record);
      return record;
    }
    const allowed =
      ((await this.checkWrite(record)) ||
        (await this.subjectAllows(record.typeId, ['update-own', 'update-any'], { record }))) &&
      (await this.principalAllows(record.typeId, ['update-own', 'update-any']));
    if (!allowed) throw await this.denialFor(record);
    return record;
  }

  /**
   * Fetch a record the subject can reach and the principal holds `delete` on
   * (via permissions or a delete grant), or throw.
   */
  private async requireDeletable(id: string): Promise<StackRecord> {
    const record = await this.stack.get(id);
    if (!record) throw new StackNotFoundError(`Record not found: "${id}"`);
    await this.requireOwnerForGrantRecord(record);
    if (baseIdOf(record.typeId) === SYSTEM_TYPES.GROUP) {
      if (!this.isGroupManager(record)) throw await this.denialFor(record);
      return record;
    }
    const allowed =
      ((await this.checkWrite(record)) ||
        (await this.subjectAllows(record.typeId, ['delete-own', 'delete-any'], { record }))) &&
      (await this.principalAllows(record.typeId, ['delete-own', 'delete-any']));
    if (!allowed) throw await this.denialFor(record);
    return record;
  }

  /**
   * Whether this request may reference `recordId` (as a parentId or
   * relationship target). Missing and unreadable both return false —
   * indistinguishable, so this can't probe for a record's existence.
   */
  private async canReadReferent(recordId: string): Promise<boolean> {
    const record = await this.stack.get(recordId);
    if (!record) return false;
    return this.canRead(record);
  }

  /**
   * Whether this request can read some record referencing `fileId` —
   * shared by canAccessFile() and the non-owner _attachment@1 create()
   * carve-out, which deliberately excludes the uploader clause. Walks
   * every referencing record, short-circuiting on the first readable one.
   * See docs/spec/attachments.md § Creating `_attachment@1` records directly.
   */
  private async hasReadableReference(fileId: string): Promise<boolean> {
    const prefetchedGrants = this.subjectEntityId
      ? await queryAllPages((q) => this.stack.query(q), {
          filter: { typeId: `${SYSTEM_TYPES.GRANT}@1` },
        })
      : undefined;
    const groupRoles = new Map<string, GroupRole | null>();

    const match = await findFirstMatch(
      (q) => this.stack.query(q),
      { filter: { attachmentFileId: fileId } },
      (record) => this.canRead(record, prefetchedGrants, groupRoles),
    );
    return match !== undefined;
  }

  /**
   * Whether this request may reference or download `fileId` — the dual of
   * getAttachment()'s access rule. Nonexistent and inaccessible are
   * indistinguishable (both false), so no confirmation oracle for guessed
   * hashes. See docs/spec/access-control.md § Reference-creation gating.
   */
  private async canAccessFile(fileId: string): Promise<boolean> {
    if (this.ownerActingAlone) return true;

    // Reaching a file through a record this request can read is already
    // fully intersected — canRead() applied the principal's mask against
    // that record's own type, which is the type the reference lives on.
    if (await this.hasReadableReference(fileId)) return true;

    if (!this.subjectEntityId) return false;

    // The remaining paths are authorship facts about the subject, so they
    // decide *which* files match — they are not themselves a grant, and the
    // principal still needs one of its own on the attachment type.
    if (!(await this.principalAllows(`${SYSTEM_TYPES.ATTACHMENT}@1`, ['read-own', 'read-any']))) {
      return false;
    }

    if (this.subjectEntityId === this.stack.ownerEntityId) return true;

    return this.stack.features.contentFieldQuery
      ? (
          await this.stack.query({
            filter: {
              typeId: `${SYSTEM_TYPES.ATTACHMENT}@1`,
              entityId: this.subjectEntityId,
              content: { fileId },
            },
            limit: 1,
          })
        ).records.length > 0
      : (
          await queryAllPages((q) => this.stack.query(q), {
            filter: { typeId: `${SYSTEM_TYPES.ATTACHMENT}@1`, entityId: this.subjectEntityId },
          })
        ).some((r) => (r.content as AttachmentContent).fileId === fileId);
  }

  /** Names of the type's top-level file-ref fields — the content-reference half of attachmentFileId matching. */
  private async fileRefFieldNames(typeId: TypeId): Promise<string[]> {
    const type = await this.stack.getType(typeId);
    if (!type) return [];
    return Object.entries(type.schema)
      .filter(([, def]) => def.kind === 'file-ref')
      .map(([field]) => field);
  }

  /**
   * Gates file-ref content fields on file access, mirroring the
   * attachment-association gate — a file-ref field conveys attachment
   * access exactly like an `attachment` association. Only fields present
   * in `content` are checked (update() is a merge patch; untouched fields
   * carry no new reference).
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
   * Reference-creation gate for one association: `attachment` requires
   * file access, and a `relationship` naming a record in this stack
   * requires read access to it. `tag` is unchecked, and `_group` roster
   * associations are gated by the stricter isGroupManager() instead.
   *
   * The other target arms are ungated because the gate's purpose —
   * refusing a reference that would convey access to, or confirm the
   * existence of, an unreadable record — has nothing to bite on: core
   * never resolves them, so no access flows through one.
   * See docs/spec/access-control.md § Reference-creation gating.
   */
  private async requireAssociationAccess(typeId: TypeId, association: Association): Promise<void> {
    if (association.kind === 'attachment') {
      if (!(await this.canAccessFile(association.fileId))) throw new StackPermissionError();
    } else if (association.kind === 'relationship' && baseIdOf(typeId) !== SYSTEM_TYPES.GROUP) {
      const { target } = association;
      // `stackUrl` is tested for a value, not for presence: absent and
      // empty are one target — storage, targetEqual() and the filter all
      // read them as this stack — so a check on presence alone would
      // leave one spelling of a local Record ungated.
      if (target.scope !== 'record' || target.stackUrl) return;
      if (!(await this.canReadReferent(target.recordId))) throw new StackPermissionError();
    }
  }

  /**
   * Create a record on behalf of the subject: create grant required,
   * anonymous denied, entityId set to the subject, client IDs skew-checked,
   * reference-creating options gated, and non-owner `_attachment@1`
   * creation refused save one carve-out. A scoped create always stamps
   * authorship — an absent entityId means an unscoped `Stack` wrote it.
   * `createdAt`/`updatedAt` are refused to everyone but the owner acting
   * alone — see the guard below and docs/spec/data-model.md § Record IDs.
   * See also docs/spec/access-control.md and docs/spec/attachments.md.
   */
  async create<T extends Record<string, unknown> = Record<string, unknown>>(
    typeId: TypeId,
    content: T,
    opts: BackdatableCreateRecordOptions = {},
  ): Promise<StackRecord & { content: T }> {
    const principal = this.principalEntityId;
    if (!principal) throw new StackPermissionError('Anonymous requesters cannot create records');
    // createdAt/updatedAt let a caller backdate a record's clock fields —
    // and, without `id` also supplied, its sort position too. Refused to
    // everyone but the owner acting alone (undelegated, authenticated as
    // themselves): a grantee is exactly the untrusted actor the `id`
    // skew check below already exists to stop from forging a sort
    // position, and a delegated app acting for the owner inherits none of
    // the owner's extra trust — same reasoning as mayGrantAccess() below.
    // Refused rather than silently dropped, so an app never believes it
    // published something it didn't. This is also the enforcement a
    // server built on ScopedStack inherits for `POST /records`: an
    // owner-authenticated request may carry both fields, anyone else's
    // has them ignored.
    if (('createdAt' in opts || 'updatedAt' in opts) && !this.ownerActingAlone) {
      throw new StackPermissionError(
        'createdAt/updatedAt can only be set by the stack owner acting alone; a grantee or delegated create always stamps the current time.',
      );
    }
    if (!(await this.checkCreateGrant(typeId))) {
      throw new StackPermissionError(`No create grant for type "${typeId}"`);
    }
    // The exemption is the owner's own, so delegation doesn't carry it: an
    // owner principal acting for someone else would otherwise let that
    // subject name any fileId and reach the bytes through the uploader
    // clause, which matches on the subject this create stamps.
    if (!this.ownerActingAlone && baseIdOf(typeId) === SYSTEM_TYPES.ATTACHMENT) {
      const fileId = (content as Record<string, unknown>).fileId;
      if (typeof fileId !== 'string' || !(await this.hasReadableReference(fileId))) {
        throw new StackPermissionError();
      }
    }
    if (opts.permissions?.length && !this.mayGrantAccess()) {
      throw new StackPermissionError(
        'A delegated principal cannot set permissions, at create time or after',
      );
    }
    if (opts.unlisted && !this.mayGrantAccess()) {
      throw new StackPermissionError(
        'A delegated principal cannot create an unlisted record, at create time or after',
      );
    }
    this.requireOwnerForOwnerDid(typeId, (content as Record<string, unknown>).did);
    await this.requireAppIdMatchesPrincipal(opts.appId);
    if (opts.id !== undefined) {
      validateRecordId(opts.id);
      // Skipped when createdAt is also supplied: only the owner reaches
      // here with that combination (checked above), and Stack.create()
      // below checks the id against createdAt instead of "now" — the
      // check here exists for a live grantee write, and a backdated
      // owner create is deliberately not one. See
      // docs/spec/data-model.md § Record IDs.
      if (opts.createdAt === undefined) {
        validateIdTimestampSkew(opts.id, this.idTimestampSkewMs, Date.now(), 'the current time');
      }
    }
    if (opts.parentId !== undefined && !(await this.canReadReferent(opts.parentId))) {
      throw new StackPermissionError();
    }
    for (const assoc of opts.associations ?? []) {
      await this.requireAssociationAccess(typeId, assoc);
    }
    await this.requireFileRefAccess(typeId, content);
    return this.stack.create(typeId, content, {
      ...opts,
      entityId: this.subjectEntityId ?? undefined,
      principalId: this.delegated ? principal : undefined,
    });
  }

  /**
   * Whether this request may decide who else reaches a record — the rule
   * setPermissions() enforces, asked at create time too so the reach it
   * withholds can't be taken one step earlier while authoring. A delegated
   * app is denied it: widening access is the one thing containment most
   * needs to hold. Refused rather than silently ignored, so an app never
   * believes it published something it didn't. Not `ownerActingAlone`:
   * the record is the subject's own, so an owner principal grants it no
   * reach the subject lacks.
   * See docs/spec/access-control.md § Delegation: principal and subject.
   */
  private mayGrantAccess(): boolean {
    return !this.delegated || this.principalEntityId === this.stack.ownerEntityId;
  }

  /**
   * Whether one identity, on its own, may decide who else reaches `record`
   * — the owner-or-creator rule setPermissions() enforces, asked of one
   * side at a time. See
   * docs/spec/access-control.md § Delegation: principal and subject.
   */
  private mayReshare(entityId: EntityId | null, record: StackRecord): boolean {
    if (!entityId) return false;
    return entityId === this.stack.ownerEntityId || entityId === record.entityId;
  }

  /**
   * A record this request may read, or null. Never throws
   * StackPermissionError: an unreadable record answers exactly as a missing
   * one does, so a caller learns only what it may read.
   * See docs/spec/access-control.md § Errors and information exposure.
   */
  async get(id: string, opts: GetRecordOptions = {}): Promise<StackRecord | null> {
    const record = await this.stack.get(id, opts);
    if (!record) return null;
    return (await this.canRead(record)) ? record : null;
  }

  /**
   * Query records, filtered to those this request can read. Pages are
   * filtered then refilled, so a page may slightly overshoot `limit` but
   * never skips a record. `total` is always null (see QueryResult.total).
   * Grants are prefetched once, cursor-walked to exhaustion.
   */
  async query(query: StackQuery = {}): Promise<QueryResult> {
    assertValidSort(query.sort);
    assertValidRelatedTo(query.filter?.relatedTo);
    if (query.filter?.includeUnlisted && !this.ownerActingAlone) {
      throw new StackPermissionError('includeUnlisted is owner-only');
    }
    const limit = Math.min(query.limit ?? DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT);
    const records: StackRecord[] = [];
    const maxFetched = limit * 10;
    let totalFetched = 0;

    const prefetchedGrants = this.principalEntityId
      ? await queryAllPages((q) => this.stack.query(q), {
          filter: { typeId: `${SYSTEM_TYPES.GRANT}@1` },
        })
      : undefined;
    // Scoped to this query, like prefetchedGrants beside it: every
    // candidate Record shares one roster resolution per group, and nothing
    // is carried into the next operation.
    const groupRoles = new Map<string, GroupRole | null>();

    let page: QueryResult = { records: [], cursor: query.cursor ?? null, total: null };
    do {
      page = await this.stack.query({ ...query, cursor: page.cursor ?? undefined });
      totalFetched += page.records.length;
      for (const record of page.records) {
        if (await this.canRead(record, prefetchedGrants, groupRoles)) records.push(record);
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
    // Value-wise, not presence-wise: a client that reads a card, edits its
    // `name` and sends the whole content object back is not setting the
    // binding it round-trips, and `name` is writable by record-level
    // permission. Same predicate restoreVersion() applies to a snapshot.
    this.requireOwnerForAppIdentity(
      record.typeId,
      (field) =>
        field in content && content[field] !== (record.content as Record<string, unknown>)[field],
    );
    // Likewise value-wise: re-sending the DID a card already holds claims
    // nothing, and immutability refuses changing it regardless.
    if ('did' in content && content.did !== (record.content as Record<string, unknown>).did) {
      this.requireOwnerForOwnerDid(record.typeId, content.did);
    }
    await this.requireFileRefAccess(record.typeId, content);
    return this.stack.update(id, content, { ...opts, ...this.actor });
  }

  /**
   * Naming the software behind a key is the trust decision the `_app`
   * registry exists to record, so both halves of that binding — `did` and
   * `appId` — belong to the owner alone. Same reasoning that makes `_app`
   * ungrantable, applied to the fields a lookup reads. Registering a card
   * is already owner-only; without this, record-level `write` shared on a
   * card would be a second way in: a card carrying no DID yet could be
   * pointed at a write-holder's own key while keeping the name the owner
   * gave it, or relabelled to claim another app's `appId`. `name` and
   * `version` stay writable — they are display, not lookup.
   *
   * Owner *acting alone*, in both directions: a delegated app never holds
   * it, and an owner principal doesn't lend it to a subject holding
   * record-level `write` on a card — which would reopen the same route
   * from the other side.
   *
   * `_entity` deliberately does not get this rule: naming people is what a
   * contacts app does, so its cards stay writable by grant. Uniqueness and
   * immutability still bind them. See docs/spec/identity.md § DID bindings.
   */
  private requireOwnerForAppIdentity(
    typeId: TypeId,
    touches: (field: 'did' | 'appId') => boolean,
  ): void {
    if (baseIdOf(typeId) !== SYSTEM_TYPES.APP) return;
    if (!bindingFieldsOf(SYSTEM_TYPES.APP).some(touches)) return;
    if (!this.ownerActingAlone) {
      throw new StackPermissionError('Only the stack owner may set an _app record’s did or appId');
    }
  }

  /**
   * A self-reported `appId` must agree with the `_app` card naming the
   * principal's DID, where the owner registered one. `principalId` is
   * verified, so letting the pair disagree would leave a verified principal
   * claiming a name the owner gave different software — the cross-check the
   * registry exists for, refused at the write instead of left to each reader.
   * A principal with no card keeps `appId` as the bare self-report it is for
   * every undelegated writer.
   * See docs/spec/identity.md § Attribution and what can be trusted.
   */
  private async requireAppIdMatchesPrincipal(appId: AppId | undefined): Promise<void> {
    if (appId === undefined || !this.delegated) return;
    const card = await findFirstMatch(
      (q) => this.stack.query(q),
      {
        filter: {
          baseId: SYSTEM_TYPES.APP,
          includeDeleted: true,
          includeUnlisted: true,
          ...(this.stack.features.contentFieldQuery && {
            content: { did: this.principalEntityId },
          }),
        },
      },
      (r) => (r.content as AppContent).did === this.principalEntityId,
    );
    if (card && (card.content as AppContent).appId !== appId) {
      throw new StackPermissionError(
        `appId "${appId}" is not the appId registered for this principal`,
      );
    }
  }

  /**
   * The owner's own DID is the one `_entity` binding a grantee may not claim.
   * `ownerProfile` adopts whichever card holds it, so a card minted by
   * someone else becomes the stack's own profile, and uniqueness then makes
   * that permanent. Every other DID stays open to a contacts app, which is
   * the reach `_entity` is grantable for.
   * See docs/spec/identity.md § DID bindings.
   */
  private requireOwnerForOwnerDid(typeId: TypeId, did: unknown): void {
    if (baseIdOf(typeId) !== SYSTEM_TYPES.ENTITY) return;
    if (did !== this.stack.ownerEntityId) return;
    if (!this.ownerActingAlone) {
      throw new StackPermissionError('Only the stack owner may claim the owner’s own did');
    }
  }

  /**
   * A `_grant` Record *is* authority, so rewriting one is the escalation
   * UNGRANTABLE_SYSTEM_TYPES refuses at evaluation, reached by editing an
   * existing grant rather than minting a fresh one. `grant()` and `revoke()`
   * live on `Stack`, never `StackClient`, so no scoped write is lost. Writes
   * only: reading a grant Record and its history stays on the ordinary gate.
   * See docs/spec/access-control.md § Type-level grants.
   */
  private async requireOwnerForGrantRecord(record: StackRecord): Promise<void> {
    if (baseIdOf(record.typeId) !== SYSTEM_TYPES.GRANT) return;
    if (this.ownerActingAlone) return;
    throw await this.denialFor(record, 'Only the stack owner may write a _grant record');
  }

  async associate(
    id: string,
    association: Association,
    opts: IfVersionOptions = {},
  ): Promise<void> {
    const record = await this.requireUpdatable(id);
    await this.requireAssociationAccess(record.typeId, association);
    return this.stack.associate(id, association, { ...opts, ...this.actor });
  }

  async dissociate(
    id: string,
    association: Association,
    opts: IfVersionOptions = {},
  ): Promise<void> {
    await this.requireUpdatable(id);
    return this.stack.dissociate(id, association, { ...opts, ...this.actor });
  }

  async setPermissions(
    id: string,
    permissions: Permission[],
    opts: IfVersionOptions = {},
  ): Promise<void> {
    const record = await this.stack.get(id);
    if (!record) throw new StackNotFoundError(`Record not found: "${id}"`);
    await this.requireOwnerForGrantRecord(record);

    if (baseIdOf(record.typeId) === SYSTEM_TYPES.GROUP) {
      // Group management, not authorship: a creator later demoted from the
      // admin roster shouldn't retain a side door to reassign who can read
      // or write the group record. Same gate as update/associate/delete.
      if (!this.isGroupManager(record)) throw await this.denialFor(record);
    } else {
      // Intersected like every other authority here: the principal must
      // hold the verb, and the subject must be able to reach this record —
      // without which an owner principal would carry its subject to records
      // the subject cannot touch. create() withholds the same reach via
      // mayGrantAccess().
      if (!this.mayReshare(this.principalEntityId, record)) throw await this.denialFor(record);
      if (this.delegated && !this.mayReshare(this.subjectEntityId, record)) {
        throw await this.denialFor(record);
      }
    }

    return this.stack.setPermissions(id, permissions, { ...opts, ...this.actor });
  }

  /**
   * Withhold a record from enumeration, or restore it — gated exactly like
   * setPermissions(), since both decide who or what can discover the
   * record rather than merely read it once found. See
   * docs/spec/access-control.md § Unlisted records.
   */
  async setUnlisted(id: string, unlisted: boolean, opts: IfVersionOptions = {}): Promise<void> {
    const record = await this.stack.get(id);
    if (!record) throw new StackNotFoundError(`Record not found: "${id}"`);
    await this.requireOwnerForGrantRecord(record);

    if (baseIdOf(record.typeId) === SYSTEM_TYPES.GROUP) {
      if (!this.isGroupManager(record)) throw await this.denialFor(record);
    } else {
      if (!this.mayReshare(this.principalEntityId, record)) throw await this.denialFor(record);
      if (this.delegated && !this.mayReshare(this.subjectEntityId, record)) {
        throw await this.denialFor(record);
      }
    }

    return this.stack.setUnlisted(id, unlisted, { ...opts, ...this.actor });
  }

  /**
   * Hard delete is owner-only: it is irreversible and destroys version
   * history, so neither the write bit nor delete-own/delete-any grants
   * reach it, and delegation doesn't carry it either. Everyone else is
   * limited to soft delete.
   */
  async delete(id: string, opts: DeleteRecordOptions = {}): Promise<void> {
    await this.requireDeletable(id);
    if (opts.hard && !this.ownerActingAlone) {
      throw new StackPermissionError('Hard delete is owner-only');
    }
    return this.stack.delete(id, { ...opts, ...this.actor });
  }

  /**
   * Reverse a soft delete. Gated the same as delete() — undelete is the
   * inverse of soft delete, so granting one direction without the other
   * would be backwards. Idempotent, per Stack.undelete().
   */
  async undelete(id: string, opts: IfVersionOptions = {}): Promise<StackRecord> {
    await this.requireDeletable(id);
    return this.stack.undelete(id, { ...opts, ...this.actor });
  }

  /**
   * History is the mutation/recovery surface, not a read surface — gated
   * like update(), with snapshot `permissions` stripped for everyone but
   * the owner acting alone — a snapshot's permissions are the stack's
   * sharing graph, which delegation is not a route to. Reading history
   * changes nothing, so it is the one path the `_grant` write fence leaves
   * alone: seeing how a Record you can already read got that way is not
   * the escalation that fence exists to stop, and losing it would leave a
   * write-holder unable to audit the Record they hold.
   * See docs/spec/versioning.md § History access.
   */
  async getVersions(id: string): Promise<RecordVersion[]> {
    await this.requireUpdatable(id, { mutating: false });
    const versions = await this.stack.getVersions(id);
    return this.ownerActingAlone ? versions : versions.map(stripVersionPermissions);
  }

  /** See getVersions() — same mutate-surface gate, same permissions stripping. */
  async getVersion(id: string, version: number): Promise<RecordVersion | null> {
    await this.requireUpdatable(id, { mutating: false });
    const target = await this.stack.getVersion(id, version);
    if (!target) return null;
    return this.ownerActingAlone ? target : stripVersionPermissions(target);
  }

  /**
   * Re-runs the reference-creation checks against the snapshot, so a
   * restore can't re-convey access to a file or record the subject can no
   * longer reach today. Only the owner acting alone is exempt: under
   * delegation the checks resolve against the subject, which is whose reach
   * the restore would widen. See docs/spec/versioning.md § Restore semantics.
   */
  async restoreVersion(
    id: string,
    version: number,
    opts: IfVersionOptions = {},
  ): Promise<StackRecord> {
    const record = await this.requireUpdatable(id);
    if (!this.ownerActingAlone) {
      const target = await this.stack.getVersion(id, version);
      if (target) {
        // A rollback that would move a card's binding is the same trust
        // decision update() reserves to the owner, reached by another route.
        this.requireOwnerForAppIdentity(
          record.typeId,
          (field) =>
            (target.content as Record<string, unknown>)[field] !==
            (record.content as Record<string, unknown>)[field],
        );
        await this.requireFileRefAccess(target.typeId, target.content);
        for (const association of target.associations ?? []) {
          await this.requireAssociationAccess(target.typeId, association);
        }
      }
    }
    return this.stack.restoreVersion(id, version, { ...opts, ...this.actor });
  }

  /**
   * Commit a per-record migration — **the owner acting alone, only**.
   *
   * Migration is owner-driven by design: `migrateAll()`, the bulk path,
   * lives on `Stack` and is deliberately absent from `StackClient`, the
   * same way `grant()`/`revoke()` are. This is its per-record counterpart
   * and carries the same restriction, rather than inventing a grant model
   * that the bulk path deliberately doesn't have.
   *
   * The restriction is what makes the verb safe to expose at all. Migrate
   * replaces `content` and `typeId` wholesale, so a grant-based version
   * would have to re-derive every gate `create()` applies at the
   * destination *and* every gate `update()` applies over the existing
   * content, and would reopen each one it missed. The sharpest is the
   * non-owner `_attachment@1` refusal create() carries: without it, a
   * requester holding a create grant on `_attachment@1` and write access
   * to any record they authored could migrate that record into the family
   * naming any `fileId`, then read the bytes through canAccessFile()'s
   * uploader clause — the exact escalation that carve-out exists to refuse
   * (see docs/spec/attachments.md § Creating `_attachment@1` records
   * directly). Ordinary write access to a record is not consent to move it
   * between families.
   *
   * A server implementing `POST /records/:id/migrate` therefore serves it
   * to the stack owner and answers 403 otherwise. See
   * docs/spec/data-model.md § Type migrations.
   */
  async commitMigration(
    id: string,
    toTypeId: TypeId,
    content: Record<string, unknown>,
    opts: IfVersionOptions = {},
  ): Promise<StackRecord> {
    if (!this.ownerActingAlone) {
      throw new StackPermissionError('Only the stack owner may commit a migration');
    }
    return this.stack.commitMigration(id, toTypeId, content, { ...opts, ...this.actor });
  }

  /**
   * Store bytes and create an _attachment@1 metadata record (create grant
   * on `_attachment@1` required; anonymous denied), returning that record.
   * Authorship and principal are stamped exactly as create() does.
   */
  async putAttachment(
    data: Uint8Array,
    mimeType: string,
    filename?: string,
    appId?: AppId,
  ): Promise<StackRecord & { content: AttachmentContent }> {
    // The one ScopedStack path that reaches the adapter without going
    // through Stack first — without this, a closed stack would still write
    // bytes before the delegated create() refused.
    this.stack.assertOpen();
    const principal = this.principalEntityId;
    if (!principal) {
      throw new StackPermissionError('Anonymous requesters cannot upload attachments');
    }
    if (!(await this.checkCreateGrant(`${SYSTEM_TYPES.ATTACHMENT}@1`))) {
      throw new StackPermissionError(`No create grant for type "${SYSTEM_TYPES.ATTACHMENT}@1"`);
    }
    await this.requireAppIdMatchesPrincipal(appId);
    assertAttachmentSize(data.byteLength, this.features.maxAttachmentBytes);
    const fileId = await this.adapter.putAttachment(data);
    return this.stack.create<AttachmentContent>(
      `${SYSTEM_TYPES.ATTACHMENT}@1`,
      {
        fileId,
        mimeType,
        size: data.byteLength,
        ...(filename && { filename }),
      },
      {
        entityId: this.subjectEntityId ?? undefined,
        principalId: this.delegated ? principal : undefined,
        appId,
      },
    );
  }

  /**
   * Download attachment bytes. Accessible to the owner, a reader of any
   * referencing record, or the uploader pre-association — the same
   * predicate as the reference-creation gate (canAccessFile).
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
    if (!this.ownerActingAlone) {
      throw new StackPermissionError('Only the stack owner can delete attachments');
    }
    return this.stack.deleteAttachment(fileId, this.actor);
  }

  /**
   * Sweep for unreferenced attachment bytes and delete them. Only the stack
   * owner may run this. Delegates to Stack.collectAttachmentGarbage().
   */
  async collectAttachmentGarbage(
    opts?: CollectAttachmentGarbageOptions,
  ): Promise<CollectAttachmentGarbageResult> {
    if (!this.ownerActingAlone) {
      throw new StackPermissionError('Only the stack owner can collect attachment garbage');
    }
    return this.stack.collectAttachmentGarbage({ ...opts, ...this.actor });
  }

  /**
   * Observe the changes this request may read. The predicate is canRead
   * applied per event — the same one get() and query() answer with, so a
   * feed can't disagree with them about what this session sees.
   *
   * A record the subscriber cannot read produces no event at all, rather
   * than an empty or redacted one: the existence of a change is itself a
   * disclosure, the same reasoning that keeps query()'s `total` null.
   * See docs/spec/events.md § Permission scoping.
   */
  async subscribe(
    handler: (change: RecordChange) => void,
    opts: SubscribeOptions = {},
  ): Promise<Unsubscribe> {
    this.stack.assertOpen();
    if (this.stack.relaysChanges) {
      throw new StackRelayScopeError(
        'This stack relays changes from elsewhere, and a scoped view cannot narrow that feed: ' +
          'a relayed frame was already scoped by the session that opened it, and a purge leaves ' +
          'no record to re-check. Subscribe with a session-scoped stack instead.',
      );
    }
    if (opts.includeUnlisted && !this.ownerActingAlone) {
      throw new StackPermissionError('includeUnlisted is owner-only');
    }
    return this.changes.add(
      new ScopedSubscription((record, cache) => this.canReadCached(record, cache), handler, opts),
    );
  }

  /**
   * canRead for one event, through the subscription's own cache. Grants
   * are prefetched once and refilled after an invalidation rather than
   * re-queried per event, which would be a `_grant` scan for every change
   * the stack makes.
   */
  private async canReadCached(record: StackRecord, cache: FeedAuthorityCache): Promise<boolean> {
    const grants = this.principalEntityId
      ? await cache.grants(() =>
          queryAllPages((q) => this.stack.query(q), {
            filter: { typeId: `${SYSTEM_TYPES.GRANT}@1` },
          }),
        )
      : undefined;
    return this.canRead(record, grants, cache.roles);
  }
}
