/**
 * ScopedStack — the permission-enforcing view
 * -------------------------------------------------------
 * A `Stack` answers every question; a `ScopedStack` answers only the ones a
 * particular requester is entitled to. It wraps a Stack rather than an
 * adapter, so every invariant the Stack layer holds is already in force by
 * the time a check here runs, and the gates below only ever narrow.
 *
 * Two identities, one rule: **the principal governs authority, the subject
 * governs attribution.** Both are DIDs and both are often equal, which is
 * what makes them easy to confuse — so the split is stated on every gate
 * that depends on it. Grant lookup and the privilege-bearing gates no grant
 * reaches (resharing, group management, purge, widening access at create
 * time) key on the principal; authorship, `-own` matching, record-level
 * permissions and "files I uploaded" key on the subject. Unconditional
 * owner access splits the same way: an owner subject passes every
 * permission check, an owner principal is not bounded by grants, and under
 * delegation both halves apply. The questions those gates ask are
 * ScopeAuthority's, in authority.ts; this module turns their answers into
 * refusals.
 *
 * Also holds the feed side of the same rule: a subscription's deliveries
 * ask the same read reach a get() does, so a feed can never disagree with
 * a read about what a session sees.
 *
 * See docs/spec/access-control.md and docs/spec/events.md § Permission scoping.
 */

import { baseIdOf } from '../schema.js';
import { validatePatchValues } from '../validate.js';
import { ChangeEmitter, assertSinceUsable } from '../stack/changes.js';
import { SYSTEM_TYPES } from '../types/index.js';
import type {
  ActorOptions,
  AppContent,
  AppId,
  BaseId,
  PutAttachmentOptions,
  Association,
  AssociationEdit,
  AttachmentContent,
  AuthorityAssociation,
  DataAssociation,
  EntityId,
  FileId,
  QueryResult,
  Reach,
  RecordChange,
  RecordId,
  RecordVersion,
  RecordJournalEntry,
  JournalQuery,
  VersionsQuery,
  StackAdapter,
  StackCapabilities,
  IfVersionOptions,
  StackQuery,
  StackRecord,
  SubscribeOptions,
  TypeId,
  Unsubscribe,
} from '../types/index.js';
import {
  StackConflictError,
  StackNotFoundError,
  StackPermissionError,
  StackValidationError,
} from '../errors.js';
import { assertAssociationEdits } from '../associations/validation.js';
import { addsOf, associationEqual } from '../associations/identity.js';
import {
  assertQueryCapabilities,
  assertValidBaseIdFilter,
  splitQuery,
  filtersContent,
} from '../query-validation.js';
import type { SplitQuery } from '../query-validation.js';
import {
  checkFamily,
  storedVersionDiffers,
  WRITE_EXPECTATION,
} from '../stack/write-expectation.js';
import type { ExpectationOptions } from '../stack/write-expectation.js';
import { WRITE_GATE } from '../stack/write-gate.js';
import { assertAttachmentSize } from '../stack/limits.js';
import { validateIdTimestampSkew, validateRecordId } from '../stack/record-id.js';
import { findAppCardByDid, lookupEntityByDid } from '../stack/reads.js';
import { presentDeleted, withoutAuthorityChanges } from '../record-changes.js';
import type { ContentOf, ReadonlyTypeSchema, TypeHandle } from '../type-handle.js';
import { createCollection } from '../collection.js';
import type { Collection } from '../collection.js';
import type { MigrationRegistry } from '../stack/migrations.js';
import { uploadContent } from '../stack/attachments.js';
import {
  assertAssociationSet,
  assertContentPatch,
  assertParentArgument,
  assertUnlistedArgument,
} from '../stack/arguments.js';
// Type-only: a ScopedStack never constructs a Stack, so nothing here
// closes a runtime cycle with stack.ts, which does construct a ScopedStack.
import type { Stack } from '../stack/stack.js';
import { ScopeAuthority } from './authority.js';
import { familyPolicy, ownerFieldRefusal } from './family-policy.js';
import { ScopedSubscription } from './subscription.js';
import type { AuthoritySnapshot, ReachVerb } from './authority-snapshot.js';
import type {
  BackdatableCreateRecordOptions,
  CollectAttachmentGarbageOptions,
  CollectAttachmentGarbageResult,
  DeleteRecordOptions,
  DeleteResult,
  GetRecordOptions,
  StackClient,
} from '../stack/client.js';

/**
 * Held by Stack alone: the index re-exports ScopedStack but not this, so
 * asEntity()/asActor() stay the only way to one, and the actor
 * normalization and open-check they run can't be skipped.
 */
export const scopeToken: unique symbol = Symbol('ScopedStack');

/** Everything a ScopedStack borrows from the Stack that scoped it. */
export type ScopedStackInit = {
  stack: Stack;
  principalId: EntityId | null;
  subjectId: EntityId | null;
  idTimestampSkewMs: number | null;
  /**
   * Bytes-storage primitive for putAttachment(), which composes bytes with
   * its own create() so the record carries the subject and principal as
   * `createdBy` — neither of which the adapter-level atomic capability takes.
   */
  adapter: StackAdapter;
  /** The stack's own unfiltered stream, which subscribe() narrows. */
  changes: ChangeEmitter;
  assertOpen: () => void;
  /** The app's migrations, which collection() migrates records through. */
  migrations: MigrationRegistry;
  /** Stack.query() within a reach over type families — see query(). */
  queryReadable: (split: SplitQuery, reach: Reach<BaseId>) => Promise<QueryResult>;
};

/**
 * A permission-enforcing view of a Stack for one (principal, subject) pair,
 * obtained via `stack.asEntity()` or `stack.asActor()`. A record the request
 * cannot read answers exactly as a missing one does.
 * See docs/spec/disclosure.md § Which refusal a Record answers with.
 */
export class ScopedStack implements StackClient {
  readonly #authority: ScopeAuthority;
  private readonly stack: Stack;
  private readonly idTimestampSkewMs: number | null;
  private readonly adapter: StackAdapter;
  private readonly changes: ChangeEmitter;
  private readonly assertStackOpen: () => void;
  private readonly migrations: MigrationRegistry;
  private readonly queryReadable: ScopedStackInit['queryReadable'];

  /** Not callable from outside the package — see ScopedStackInit. */
  constructor(token: typeof scopeToken, init: ScopedStackInit) {
    if (token !== scopeToken) {
      throw new TypeError('A ScopedStack is obtained through Stack.asEntity() or Stack.asActor()');
    }
    this.stack = init.stack;
    this.#authority = new ScopeAuthority(
      init.stack,
      init.principalId,
      init.subjectId,
      init.queryReadable,
    );
    this.idTimestampSkewMs = init.idTimestampSkewMs;
    this.adapter = init.adapter;
    this.changes = init.changes;
    this.assertStackOpen = init.assertOpen;
    this.migrations = init.migrations;
    this.queryReadable = init.queryReadable;
  }

  collection<S extends ReadonlyTypeSchema>(handle: TypeHandle<S>): Collection<ContentOf<S>> {
    this.assertStackOpen();
    return createCollection(this, this.migrations, handle, () => this.stack.listTypes());
  }

  /**
   * The identity whose authority this view acts with; `null` when
   * anonymous. See docs/spec/access-control.md § Delegation: principal and subject.
   */
  get principalId(): EntityId | null {
    return this.#authority.principalId;
  }

  /**
   * The identity this view acts for and attributes writes to; `null` when
   * anonymous. Equal to `principalId` unless an app is acting for a user.
   */
  get subjectId(): EntityId | null {
    return this.#authority.subjectId;
  }

  get capabilities(): StackCapabilities {
    return this.stack.capabilities;
  }

  private get actor(): ActorOptions {
    // The key is always present, so spreading this last overrides anything
    // a caller passed: a scoped requester names itself by making the
    // request, never by describing itself in the options.
    return { actor: this.#authority.requester };
  }

  /** Refuse a create outside this request's reach — see ScopeAuthority.canCreate(). */
  private async requireCreateGrant(typeId: TypeId, snapshot: AuthoritySnapshot): Promise<void> {
    if (!(await this.#authority.canCreate(typeId, snapshot))) {
      throw new StackPermissionError(`No create grant for type "${typeId}"`);
    }
  }

  /** Refuse anything but the owner acting as itself — see ScopeAuthority.ownerActingAlone. */
  private requireOwnerActingAlone(message: string): void {
    if (!this.#authority.ownerActingAlone) throw new StackPermissionError(message);
  }

  /**
   * Fetch a record the subject can reach and the principal holds `update` on
   * (via permissions or an update grant), or throw. `mutating: false` marks
   * the history readers, which borrow this gate without changing anything —
   * the one way through it a `_grant` Record stays open to.
   */
  private async requireUpdatable(
    id: string,
    opts: { mutating?: boolean; expect?: ExpectationOptions },
    snapshot: AuthoritySnapshot,
  ): Promise<StackRecord> {
    // The `_grant` write fence applies to mutating callers only: reading a
    // grant Record's history is not the escalation that fence exists to stop.
    return this.requireVerb(
      id,
      'update',
      { fenceGrantRecord: opts.mutating ?? true, expect: opts.expect },
      snapshot,
    );
  }

  /**
   * The write gate both requireUpdatable() and requireDeletable() are: the
   * subject can reach the record (record-level permission or a grant) and
   * the principal holds the same verb, intersected — or, for a `_group`, the
   * stricter management rule that no grant reaches.
   * See docs/spec/access-control.md § Delegation: principal and subject.
   */
  private async requireVerb(
    id: string,
    verb: ReachVerb,
    opts: { fenceGrantRecord: boolean; expect?: ExpectationOptions },
    snapshot: AuthoritySnapshot,
  ): Promise<StackRecord> {
    const record = await this.stack.get(id, { includeDeleted: true });
    if (!record) throw new StackNotFoundError(`Record not found: "${id}"`);
    // Ahead of the gate, so another family's record is not found whatever
    // this requester may do to it — the answer a collection's get() gives.
    checkFamily(record, opts.expect);
    await this.gateVerb(record, verb, opts.fenceGrantRecord, snapshot);
    return record;
  }

  /** requireVerb()'s gate, asked of a record already found in its family. */
  private async gateVerb(
    record: StackRecord,
    verb: ReachVerb,
    fenceGrantRecord: boolean,
    snapshot: AuthoritySnapshot,
  ): Promise<void> {
    const { id } = record;
    const { writers } = familyPolicy(record.typeId);
    // The owner-alone fence is on writes only: reading how a grant came to
    // be is not the escalation it exists to stop.
    if (fenceGrantRecord) await this.requireOwnerAloneWriter(record, snapshot);
    if (writers === 'group-managers') {
      if (!this.#authority.isGroupManager(record)) {
        throw await this.#authority.denialFor(
          record,
          `Cannot change group "${id}": only its admins can manage it`,
          snapshot,
        );
      }
      return;
    }
    if (await this.#authority.may(verb, record, snapshot)) return;
    const what = `Cannot ${verb} "${id}" (${record.typeId})`;
    throw await this.#authority.denialFor(
      record,
      (await this.#authority.subjectMay(verb, record, snapshot))
        ? `${what}: the app acting for this entity holds no ${verb} grant`
        : `${what}: requires ${verb}-own or ${verb}-any`,
      snapshot,
    );
  }

  /**
   * Fetch a record the subject can reach and the principal holds `delete` on
   * (via permissions or a delete grant), or throw.
   */
  private requireDeletable(
    id: string,
    expect: ExpectationOptions,
    snapshot: AuthoritySnapshot,
  ): Promise<StackRecord> {
    // No soft-delete refusal: undelete() shares this gate, and a tombstone
    // is exactly what it addresses.
    return this.requireVerb(id, 'delete', { fenceGrantRecord: true, expect }, snapshot);
  }

  /**
   * Gates file-ref content fields on file access, mirroring the
   * attachment-association gate — a file-ref field conveys attachment
   * access exactly like an `attachment` association. Only fields present
   * in `content` are checked (a content patch is a merge patch; untouched fields
   * carry no new reference).
   */
  private async requireFileRefAccess(
    typeId: TypeId,
    content: Record<string, unknown | null>,
    snapshot: AuthoritySnapshot,
  ): Promise<void> {
    for (const field of await this.#authority.fileRefFieldNames(typeId)) {
      const value = content[field];
      if (typeof value !== 'string') continue;
      if (!(await this.#authority.canAccessFile(value, snapshot))) {
        throw new StackPermissionError(
          `Cannot reference file "${value}" in field "${field}": it does not exist or you cannot read it`,
        );
      }
    }
  }

  /**
   * Reference-creation gate for one association: file access for an
   * `attachment`, read access for a `relationship` to a record in this
   * stack. Other targets convey nothing, and a `_group` roster has the
   * stricter management gate. See docs/spec/access-control.md
   * § Reference-creation gating.
   */
  private async requireAssociationAccess(
    typeId: TypeId,
    association: Association,
    snapshot: AuthoritySnapshot,
  ): Promise<void> {
    if (association.kind === 'attachment') {
      if (!(await this.#authority.canAccessFile(association.fileId, snapshot))) {
        throw new StackPermissionError(
          `Cannot reference file "${association.fileId}": it does not exist or you cannot read it`,
        );
      }
    } else if (association.kind === 'relationship' && !familyPolicy(typeId).rosterAssociations) {
      const { target } = association;
      // `stackUrl` is tested for a value, not for presence: absent and
      // empty are one target — storage, targetEqual() and the filter all
      // read them as this stack — so a check on presence alone would
      // leave one spelling of a local Record ungated.
      if (target.kind !== 'record' || target.stackUrl) return;
      if (!(await this.#authority.canReadReferent(target.recordId, snapshot))) {
        throw new StackPermissionError(
          `Cannot reference record "${target.recordId}": it does not exist or you cannot read it`,
        );
      }
    }
  }

  /**
   * Create a record on behalf of the subject, stamped with the requester as
   * `createdBy`. Every option that could widen reach or forge a position is
   * refused rather than dropped, so an app never believes it published
   * something it didn't. See docs/spec/data-model.md § Backdating on import.
   */
  async create<T extends Record<string, unknown> = Record<string, unknown>>(
    typeId: TypeId,
    content: T,
    opts: BackdatableCreateRecordOptions = {},
  ): Promise<StackRecord & { content: T }> {
    const principal = this.#authority.principalId;
    if (!principal) throw new StackPermissionError('Anonymous requesters cannot create records');
    // A grantee is exactly the untrusted actor the `id` skew check below
    // exists to stop from forging a sort position, and a delegated app
    // acting for the owner inherits none of the owner's extra trust — same
    // reasoning as ScopeAuthority.mayGrantAccess(). Asked value-wise, since an
    // `undefined` carries no date and Stack.create() reads it as absent.
    if (
      (opts.createdAt !== undefined || opts.updatedAt !== undefined) &&
      !this.#authority.ownerActingAlone
    ) {
      throw new StackPermissionError(
        'createdAt/updatedAt can only be set by the stack owner acting alone; a grantee or delegated create always stamps the current time.',
      );
    }
    const snapshot = this.#authority.snapshot();
    await this.requireCreateGrant(typeId, snapshot);
    // The exemption is the owner's own, so delegation doesn't carry it: an
    // owner principal acting for someone else would otherwise let that
    // subject name any fileId and reach the bytes through the uploader
    // clause, which matches on the subject this create stamps.
    const namesFile = familyPolicy(typeId).createNamesFile;
    if (!this.#authority.ownerActingAlone && namesFile !== undefined) {
      const fileId = (content as Record<string, unknown>)[namesFile];
      if (
        typeof fileId !== 'string' ||
        !(await this.#authority.hasReadableReference(fileId, snapshot))
      ) {
        throw new StackPermissionError(
          `Cannot reference file "${String(fileId)}": it does not exist or you cannot read it`,
        );
      }
    }
    if (opts.permissions?.length && !this.#authority.mayGrantAccess()) {
      throw new StackPermissionError(
        'A delegated principal cannot set permissions, at create time or after',
      );
    }
    if (opts.unlisted && !this.#authority.mayGrantAccess()) {
      throw new StackPermissionError(
        'A delegated principal cannot create an unlisted record, at create time or after',
      );
    }
    this.requireOwnerFields(typeId, undefined, content);
    await this.requireAppIdMatchesPrincipal(opts.appId);
    if (opts.id !== undefined) {
      validateRecordId(opts.id);
      // A backdated create — the owner's alone, checked above — has its id
      // checked against `createdAt` by Stack.create() instead of against now.
      // See docs/spec/data-model.md § Record IDs.
      if (opts.createdAt === undefined) {
        validateIdTimestampSkew(opts.id, this.idTimestampSkewMs, Date.now(), 'the current time');
      }
    }
    if (
      opts.parentId !== undefined &&
      !(await this.#authority.canReadReferent(opts.parentId, snapshot))
    ) {
      throw new StackPermissionError(
        `Cannot reference record "${opts.parentId}" as parent: it does not exist or you cannot read it`,
      );
    }
    for (const assoc of opts.associations ?? []) {
      await this.requireAssociationAccess(typeId, assoc, snapshot);
    }
    await this.requireFileRefAccess(typeId, content, snapshot);
    return this.stack.create(typeId, content, {
      ...opts,
      createdBy: this.#authority.requester,
    });
  }

  /**
   * A record this request may read, or null. Never throws
   * StackPermissionError: an unreadable record answers exactly as a missing
   * one does, so a caller learns only what it may read.
   * See docs/spec/disclosure.md § Which refusal a Record answers with.
   */
  async get(id: RecordId, opts: GetRecordOptions = {}): Promise<StackRecord | null> {
    const record = await this.stack.get(id, opts);
    if (!record) return null;
    if (!(await this.#authority.canRead(record, this.#authority.snapshot()))) return null;
    return presentDeleted(record);
  }

  /**
   * Runs through this.query(), so the read reach still applies — this
   * answers a question the caller asks on its own behalf. includeUnlisted
   * is passed only when the request is the owner acting alone, per
   * docs/spec/identity.md § DID bindings.
   */
  async getEntityByDid(did: EntityId): Promise<StackRecord | null> {
    return lookupEntityByDid(
      (q) => this.query(q),
      did,
      filtersContent(this.stack.capabilities),
      this.#authority.ownerActingAlone,
    );
  }

  async getOwnerEntity(): Promise<StackRecord | null> {
    return this.getEntityByDid(this.stack.ownerEntityId);
  }

  /**
   * Query records, among those this request can read: the adapter matches
   * the request's read reach as one more condition of the query, so a page,
   * its cursor and whether one comes back are decided among readable
   * Records alone. See docs/spec/disclosure.md § What a query reveals.
   */
  async query(query: StackQuery = {}): Promise<QueryResult> {
    const split = splitQuery(query);
    assertQueryCapabilities(split.query, this.stack.capabilities);
    if (query.filter?.includeUnlisted && !this.#authority.ownerActingAlone) {
      throw new StackPermissionError('includeUnlisted is owner-only');
    }
    const reach = await this.#authority.snapshot().reach('read');
    const page = await this.queryReadable(split, reach);
    // Projected here as well as in get(), or `includeDeleted` would be a
    // strictly better read channel than the fetch-by-ID it is supposed to
    // match.
    return { records: page.records.map(presentDeleted), cursor: page.cursor };
  }

  /**
   * Patch content on behalf of the subject, on the write gate, plus the
   * gates a content value can carry: a card's binding fields and the files
   * a `file-ref` field names. See docs/spec/access-control.md § Per-verb gates.
   */
  async patchContent(
    id: RecordId,
    patch: Record<string, unknown | null>,
    opts: IfVersionOptions & ExpectationOptions = {},
  ): Promise<StackRecord> {
    // Every argument check sits ahead of the gate, here and in each write
    // verb below, so a malformed call earns one refusal from every requester.
    assertContentPatch(patch);
    const patchErrors = validatePatchValues(patch);
    if (patchErrors.length > 0) throw new StackValidationError(patchErrors);
    const snapshot = this.#authority.snapshot();
    const record = await this.requireUpdatable(id, { expect: opts }, snapshot);

    // A patch for another version is refused by `Stack`, which owes the
    // tombstone and `ifVersion` refusals first; the content gates would read
    // a stored Type it was not written for. Pinned to this read, `Stack`
    // cannot find a record the patch lands on.
    const mismatched = storedVersionDiffers(record, opts, true);
    if (!mismatched) {
      // Value-wise, not presence-wise: a client that reads a card, edits
      // its `name` and sends the whole content object back is not setting
      // the binding it round-trips, and `name` is writable by record-level
      // permission.
      const content = record.content as Record<string, unknown>;
      this.requireOwnerFields(record.typeId, content, { ...content, ...patch });
      await this.requireFileRefAccess(record.typeId, patch, snapshot);
    }

    const ifVersion = mismatched ? (opts.ifVersion ?? record.version) : opts.ifVersion;
    return this.stack.patchContent(id, patch, { ...opts, ifVersion, ...this.actor });
  }

  /**
   * The write gate, plus read access to the destination: a container is a
   * reference the requester has to be allowed to create.
   */
  async setParent(
    id: RecordId,
    parentId: RecordId | null,
    opts: IfVersionOptions & ExpectationOptions = {},
  ): Promise<StackRecord> {
    assertParentArgument(parentId);
    const snapshot = this.#authority.snapshot();
    const record = await this.requireUpdatable(id, { expect: opts }, snapshot);
    if (
      typeof parentId === 'string' &&
      parentId !== (record.parentId ?? null) &&
      !(await this.#authority.canReadReferent(parentId, snapshot))
    ) {
      throw new StackPermissionError(
        `Cannot reference record "${parentId}" as parent: it does not exist or you cannot read it`,
      );
    }
    return this.stack.setParent(id, parentId, { ...opts, ...this.actor });
  }

  /**
   * Listing decides who can enumerate a record, so it carries the reshare
   * gate rather than the write bit. See docs/spec/unlisted.md.
   */
  async setUnlisted(
    id: RecordId,
    unlisted: boolean,
    opts: IfVersionOptions & ExpectationOptions = {},
  ): Promise<StackRecord> {
    assertUnlistedArgument(unlisted);
    await this.requireReshareable(id, opts, this.#authority.snapshot());
    return this.stack.setUnlisted(id, unlisted, { ...opts, ...this.actor });
  }

  /**
   * The write gate, plus the reference gate on each add new to the record:
   * a remove, or an add of an identity already held, names a reference the
   * record carries, so it is gated by the write bit alone.
   */
  async editAssociations(
    id: RecordId,
    edits: AssociationEdit[],
    opts: IfVersionOptions & ExpectationOptions = {},
  ): Promise<StackRecord> {
    assertAssociationEdits(edits, 'editAssociations()', 'data');
    const snapshot = this.#authority.snapshot();
    return this.stack.editAssociations(id, edits, {
      ...opts,
      ...this.actor,
      [WRITE_GATE]: (record) => this.gateAssociationWrite(record, addsOf(edits), snapshot),
    });
  }

  /** editAssociations()'s gates, with every element new to the set an add. */
  async setAssociations(
    id: RecordId,
    associations: DataAssociation[],
    opts: IfVersionOptions & ExpectationOptions = {},
  ): Promise<StackRecord> {
    assertAssociationSet(associations, 'associations');
    const snapshot = this.#authority.snapshot();
    return this.stack.setAssociations(id, associations, {
      ...opts,
      ...this.actor,
      [WRITE_GATE]: (record) => this.gateAssociationWrite(record, associations, snapshot),
    });
  }

  /**
   * The write gate, then the reference gate over the elements a write adds,
   * asked against the stored set so an association the record already
   * carries is not re-gated. `Stack` asks it of each read it writes from,
   * so a retried write is gated on the set it lands on.
   */
  private async gateAssociationWrite(
    record: StackRecord,
    added: Association[],
    snapshot: AuthoritySnapshot,
  ): Promise<void> {
    await this.gateVerb(record, 'update', true, snapshot);
    for (const association of added) {
      if ((record.associations ?? []).some((a) => associationEqual(a, association))) continue;
      await this.requireAssociationAccess(record.typeId, association, snapshot);
    }
  }

  /**
   * Extend or withdraw who reaches a record, on the reshare gate. The write
   * bit does not confer it, or a write-holder could decide who else reaches
   * the record. See docs/spec/access-control.md § Record-level permissions.
   */
  async editAccess(
    id: RecordId,
    edits: AssociationEdit[],
    opts: IfVersionOptions & ExpectationOptions = {},
  ): Promise<StackRecord> {
    assertAssociationEdits(edits, 'editAccess()', 'authority');
    const snapshot = this.#authority.snapshot();
    return this.stack.editAccess(id, edits, {
      ...opts,
      ...this.actor,
      [WRITE_GATE]: (record) => this.gateReshare(record, snapshot),
    });
  }

  /** See editAccess() — the same gate. */
  async setAccess(
    id: RecordId,
    permissions: AuthorityAssociation[],
    opts: IfVersionOptions & ExpectationOptions = {},
  ): Promise<StackRecord> {
    assertAssociationSet(permissions, 'permissions');
    const snapshot = this.#authority.snapshot();
    return this.stack.setAccess(id, permissions, {
      ...opts,
      ...this.actor,
      [WRITE_GATE]: (record) => this.gateReshare(record, snapshot),
    });
  }

  /**
   * The record, having established that this request may decide who else
   * reaches it — the owner-or-creator rule, asked of both sides of a
   * delegation, or a Group's admin rule for a `_group`. The gate the access
   * and listing verbs carry, which the write bit deliberately does not confer.
   */
  private async requireReshareable(
    id: string,
    expect: ExpectationOptions,
    snapshot: AuthoritySnapshot,
  ): Promise<StackRecord> {
    const record = await this.stack.get(id, { includeDeleted: true });
    if (!record) throw new StackNotFoundError(`Record not found: "${id}"`);
    checkFamily(record, expect);
    await this.gateReshare(record, snapshot);
    return record;
  }

  /** requireReshareable()'s gate, asked of a record already found in its family. */
  private async gateReshare(record: StackRecord, snapshot: AuthoritySnapshot): Promise<void> {
    await this.requireOwnerAloneWriter(record, snapshot);
    if (!this.#authority.canReshare(record)) {
      throw await this.#authority.denialFor(
        record,
        `Cannot change permissions on "${record.id}": only its author or the stack owner can reshare it`,
        snapshot,
      );
    }
  }

  /**
   * Refuse a write moving content its family reserves to the owner acting
   * alone — an `_app` card's bindings, the owner's own DID on an `_entity`
   * — whichever verb carries it. See docs/spec/identity.md § DID bindings.
   */
  private requireOwnerFields(
    typeId: TypeId,
    before: Record<string, unknown> | undefined,
    after: Record<string, unknown>,
  ): void {
    if (this.#authority.ownerActingAlone) return;
    const refusal = ownerFieldRefusal(typeId, before, after, this.stack.ownerEntityId);
    if (refusal) throw new StackPermissionError(refusal);
  }

  /**
   * A delegated write's `appId` must match the `_app` card the owner
   * registered for the principal's DID, if there is one: a verified
   * principal may not claim a name the owner gave other software.
   * See docs/spec/identity.md § Attribution and what can be trusted.
   */
  private async requireAppIdMatchesPrincipal(appId: AppId | undefined): Promise<void> {
    const principal = this.#authority.principalId;
    if (appId === undefined || !this.#authority.delegated || !principal) return;
    const card = await findAppCardByDid(this.stack, principal);
    if (card && (card.content as AppContent).appId !== appId) {
      throw new StackPermissionError(
        `appId "${appId}" is not the appId registered for this principal`,
      );
    }
  }

  /**
   * Refuse anyone but the owner acting alone a write to a family only the
   * owner writes — `_grant` and `_install`, which are authority — with the
   * refusal an unreadable Record answers with. Any other family passes.
   * See docs/spec/access-control.md § What a grant covers.
   */
  private async requireOwnerAloneWriter(
    record: StackRecord,
    snapshot: AuthoritySnapshot,
  ): Promise<void> {
    if (familyPolicy(record.typeId).writers !== 'owner-alone') return;
    if (this.#authority.ownerActingAlone) return;
    throw await this.#authority.denialFor(
      record,
      `Only the stack owner may write a ${baseIdOf(record.typeId)} record`,
      snapshot,
    );
  }

  /**
   * Purge is owner-only: it is irreversible and destroys version
   * history, so neither the write bit nor delete-own/delete-any grants
   * reach it, and delegation doesn't carry it either. Everyone else is
   * limited to soft delete.
   */
  async delete(
    id: RecordId,
    opts: DeleteRecordOptions & ExpectationOptions = {},
  ): Promise<DeleteResult> {
    const record = await this.requireDeletable(id, opts, this.#authority.snapshot());
    if (opts.purge && !this.#authority.ownerActingAlone) {
      throw new StackPermissionError('Purge is owner-only');
    }
    // Checked against the read above, which the delete is pinned to.
    // Forwarded, it would cost a purge the read `Stack` otherwise skips.
    const { [WRITE_EXPECTATION]: expectation, ...rest } = opts;
    const result = await this.stack.delete(id, {
      ...rest,
      ...(expectation && { ifVersion: opts.ifVersion ?? record.version }),
      ...this.actor,
    });
    // A soft delete's record reaches the caller as every scoped read
    // presents one; a purge is the owner's, and reports what it destroyed.
    // See docs/spec/versioning.md § The tombstone is literal.
    return opts.purge || !result.record
      ? result
      : { ...result, record: presentDeleted(result.record) };
  }

  /**
   * Reverse a soft delete. Gated the same as delete() — undelete is the
   * inverse of soft delete, so granting one direction without the other
   * would be backwards. Idempotent, per Stack.undelete().
   */
  async undelete(
    id: RecordId,
    opts: IfVersionOptions & ExpectationOptions = {},
  ): Promise<StackRecord> {
    await this.requireDeletable(id, opts, this.#authority.snapshot());
    return this.stack.undelete(id, { ...opts, ...this.actor });
  }

  /**
   * History is the mutation/recovery surface, not a read surface — gated
   * like patchContent(). Reading it changes nothing, so it is the one path
   * the `_grant` write fence leaves alone: seeing how a Record you can
   * already read got that way is not the escalation that fence exists to
   * stop. See docs/spec/versioning.md § History access.
   */
  async getVersions(id: RecordId, query: VersionsQuery = {}): Promise<RecordVersion[]> {
    await this.requireUpdatable(id, { mutating: false }, this.#authority.snapshot());
    return this.stack.getVersions(id, query);
  }

  /**
   * See getVersions() — the same gate. A requester who may not reshare the
   * record is served each `reshare` op without the elements beneath it.
   * See docs/spec/journal.md § Reading it.
   */
  async getJournal(id: RecordId, query: JournalQuery = {}): Promise<RecordJournalEntry[]> {
    const record = await this.requireUpdatable(id, { mutating: false }, this.#authority.snapshot());
    const entries = await this.stack.getJournal(id, query);
    return this.#authority.canReshare(record) ? entries : entries.map(withoutAuthorityChanges);
  }

  /** See getVersions() — the same mutate-surface gate. */
  async getVersion(id: RecordId, version: number): Promise<RecordVersion | null> {
    await this.requireUpdatable(id, { mutating: false }, this.#authority.snapshot());
    return this.stack.getVersion(id, version);
  }

  /**
   * Re-runs the reference-creation checks against the snapshot, so a
   * restore can't re-convey access to a file the subject can no longer
   * reach today. Only the owner acting alone is exempt: under delegation
   * the checks resolve against the subject, which is whose reach the
   * restore would widen. See docs/spec/versioning.md § Restore semantics.
   */
  async restoreVersion(
    id: RecordId,
    version: number,
    opts: IfVersionOptions & ExpectationOptions = {},
  ): Promise<StackRecord> {
    const snapshot = this.#authority.snapshot();
    const record = await this.requireUpdatable(id, { expect: opts }, snapshot);
    if (!this.#authority.ownerActingAlone) {
      const target = await this.stack.getVersion(id, version);
      if (target) {
        // A rollback moving a reserved value is the same trust decision a
        // content patch reserves to the owner, reached by another route.
        this.requireOwnerFields(
          record.typeId,
          record.content as Record<string, unknown>,
          target.content as Record<string, unknown>,
        );
        await this.requireFileRefAccess(target.typeId, target.content, snapshot);
        // Content's file refs are the only reference a restore can put
        // back: containment and associations are not on a snapshot at all,
        // so a restore never introduces either — see
        // docs/spec/versioning.md § Restore semantics.
      }
    }
    return this.stack.restoreVersion(id, version, { ...opts, ...this.actor });
  }

  /**
   * Commit a per-record migration: the owner acting alone, or an installed
   * app within its own families (requireInstallMigration()). Ordinary write
   * access is not consent to move a record between families.
   * See docs/spec/access-control.md § What a grant covers.
   */
  async commitMigration(
    id: RecordId,
    toTypeId: TypeId,
    content: Record<string, unknown>,
    opts: IfVersionOptions = {},
  ): Promise<StackRecord> {
    if (!this.#authority.ownerActingAlone) {
      const snapshot = this.#authority.snapshot();
      const record = await this.requireInstallMigration(id, toTypeId, snapshot);
      this.requireOwnerFields(toTypeId, record.content, content);
      // The new content is a fresh set of file references, so an app is held
      // to the gate create() applies; otherwise a migration could point one
      // of its records at any attachment and read the bytes through it.
      await this.requireFileRefAccess(toTypeId, content, snapshot);
    }
    return this.stack.commitMigration(id, toTypeId, content, { ...opts, ...this.actor });
  }

  /**
   * Refuse a migration this request may not commit as an installed app —
   * see ScopeAuthority.installMayMigrate(). The tombstone refusal comes
   * only once authority is settled, as every mutating verb asks it: the
   * owner may migrate a tombstone; an app sees it without content.
   * See docs/spec/apps.md § Migrating an installed app's types.
   */
  private async requireInstallMigration(
    id: RecordId,
    toTypeId: TypeId,
    snapshot: AuthoritySnapshot,
  ): Promise<StackRecord> {
    const record = await this.stack.get(id, { includeDeleted: true });
    if (!record || !(await this.#authority.installMayMigrate(record, toTypeId, snapshot))) {
      throw new StackPermissionError(
        'Only the stack owner, or an installed app within the type families it defines, may commit a migration',
      );
    }
    if (record.deletedAt) {
      throw new StackConflictError(
        `Record "${id}" is soft-deleted; undelete it before migrating it.`,
      );
    }
    return record;
  }

  /**
   * Store bytes and create an _attachment@1 metadata record (create grant
   * on `_attachment@1` required; anonymous denied), returning that record.
   * Authorship and principal are stamped exactly as create() does.
   */
  async putAttachment(
    data: Uint8Array,
    opts: PutAttachmentOptions,
  ): Promise<StackRecord & { content: AttachmentContent }> {
    const { appId } = opts;
    // The one ScopedStack path that reaches the adapter without going
    // through Stack first — without this, a closed stack would still write
    // bytes before the delegated create() refused.
    this.assertStackOpen();
    const principal = this.#authority.principalId;
    if (!principal) {
      throw new StackPermissionError('Anonymous requesters cannot upload attachments');
    }
    await this.requireCreateGrant(`${SYSTEM_TYPES.ATTACHMENT}@1`, this.#authority.snapshot());
    await this.requireAppIdMatchesPrincipal(appId);
    assertAttachmentSize(data.byteLength, this.capabilities.limits.attachmentBytes);
    const fileId = await this.adapter.putBlob(data);
    return this.stack.create<AttachmentContent>(
      `${SYSTEM_TYPES.ATTACHMENT}@1`,
      uploadContent(fileId, data, opts),
      { createdBy: this.#authority.requester, appId },
    );
  }

  /**
   * Download attachment bytes. Accessible to the owner, a reader of any
   * referencing record, or the uploader pre-association — the same
   * predicate as the reference-creation gate (canAccessFile).
   */
  async getAttachment(fileId: FileId): Promise<Uint8Array> {
    if (!(await this.#authority.canAccessFile(fileId, this.#authority.snapshot()))) {
      throw new StackPermissionError(
        `Cannot read file "${fileId}": it does not exist or you cannot read it`,
      );
    }
    return this.stack.getAttachment(fileId);
  }

  /**
   * Delete an attachment. Only the stack owner may delete attachments.
   * Delegates to Stack.deleteAttachment(), which enforces the "not referenced" check.
   */
  async deleteAttachment(fileId: FileId): Promise<void> {
    this.requireOwnerActingAlone('Only the stack owner can delete attachments');
    return this.stack.deleteAttachment(fileId, this.actor);
  }

  /**
   * Sweep for unreferenced attachment bytes and delete them. Only the stack
   * owner may run this. Delegates to Stack.collectAttachmentGarbage().
   */
  async collectAttachmentGarbage(
    opts?: CollectAttachmentGarbageOptions,
  ): Promise<CollectAttachmentGarbageResult> {
    this.requireOwnerActingAlone('Only the stack owner can collect attachment garbage');
    return this.stack.collectAttachmentGarbage({ ...opts, ...this.actor });
  }

  /**
   * Observe the changes this request may read, decided per event by the
   * same read reach that get() and query() ask. An unreadable record yields
   * no event at all, since a change's existence is itself a disclosure.
   * See docs/spec/events.md § Permission scoping.
   */
  async subscribe(
    handler: (change: RecordChange) => void,
    opts: SubscribeOptions = {},
  ): Promise<Unsubscribe> {
    this.assertStackOpen();
    // A scoped view exists only over a stack that relays nothing, so
    // `since` never has a cursor to mean anything by.
    assertSinceUsable(opts.since, false);
    assertValidBaseIdFilter(opts.filter);
    if (opts.includeUnlisted && !this.#authority.ownerActingAlone) {
      throw new StackPermissionError('includeUnlisted is owner-only');
    }
    return this.changes.add(
      new ScopedSubscription(
        this.#authority.snapshot(),
        (record, snapshot) => this.#authority.canRead(record, snapshot),
        handler,
        opts,
      ),
    );
  }
}
