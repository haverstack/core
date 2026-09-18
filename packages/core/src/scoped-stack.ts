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
 * that depends on it.
 *
 * Also holds the feed side of the same rule: a subscription's deliveries
 * run through the same canRead() a get() answers with, so a feed can never
 * disagree with a read about what a session sees.
 *
 * See docs/spec/access-control.md and docs/spec/events.md § Permission scoping.
 */

import { baseIdOf } from './schema.js';
import { validatePatchValues } from './validate.js';
import { checkAccess, groupRoleFromAssociations, isOwnerActingAlone } from './access.js';
import type { GroupRole } from './access.js';
import {
  ChangeEmitter,
  Subscription,
  matchesFilter,
  passesUnlistedBoundary,
  assertSinceUsable,
} from './changes.js';
import type { EmittedChange } from './changes.js';
import { SYSTEM_TYPES } from './types.js';
import type {
  ActorOptions,
  AppContent,
  AppId,
  Association,
  AttachmentContent,
  AuthorityAssociation,
  DataAssociation,
  EntityId,
  GrantAction,
  GrantContent,
  QueryResult,
  RecordChange,
  RecordVersion,
  RecordJournalEntry,
  JournalQuery,
  StackAdapter,
  StackFeatures,
  StackQuery,
  StackRecord,
  SubscribeOptions,
  TypeId,
  Unsubscribe,
  RecordChanges,
} from './types.js';
import {
  StackConflictError,
  StackError,
  StackNotFoundError,
  StackPermissionError,
  StackRelayScopeError,
  StackValidationError,
} from './errors.js';
import {
  assertAuthorityAssociations,
  assertDataAssociations,
  assertSortCapability,
  assertValidRelatedTo,
  assertValidSort,
  filtersContent,
} from './query-validation.js';
import {
  grantConveys,
  grantCoversGrantee,
  loadGrantRecords,
  UNGRANTABLE_SYSTEM_TYPES,
} from './grants.js';
import { bindingFieldsOf } from './identity-bindings.js';
import { assertAttachmentSize } from './limits.js';
import { validateIdTimestampSkew, validateRecordId } from './record-id.js';
import {
  DEFAULT_QUERY_LIMIT,
  MAX_QUERY_LIMIT,
  findFirstMatch,
  lookupEntityByDid,
  queryAllPages,
} from './stack-reads.js';
import {
  associationDelta,
  associationEqual,
  isGroupRecord,
  presentDeleted,
  withoutAuthorityChanges,
  assertNonEmptyChangeSet,
} from './record-changes.js';
// Every import from stack.js is type-only: a ScopedStack never constructs
// a Stack, so nothing here closes a runtime cycle with stack.ts, which does
// construct a ScopedStack.
import type {
  Stack,
  BackdatableCreateRecordOptions,
  CollectAttachmentGarbageOptions,
  CollectAttachmentGarbageResult,
  DeleteRecordOptions,
  DeleteResult,
  GetRecordOptions,
  IfVersionOptions,
  StackClient,
} from './stack.js';

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
    // After the permission decision, which needs the whole record: a frame
    // carrying a deleted record's body would be a read channel around the
    // tombstone. See docs/spec/events.md § Soft-deleted records reach the
    // feed as tombstones.
    this.deliver(this.project(emission));
  }

  private project(emission: EmittedChange): EmittedChange {
    const record = presentDeleted(emission.record);
    return record === emission.record ? emission : { ...emission, record };
  }
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
 * no grant reaches (resharing, group management, hard delete, widening
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

  /** Every `_grant` Record — see loadGrantRecords(). */
  private loadGrants = (): Promise<StackRecord[]> => loadGrantRecords((q) => this.stack.query(q));

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
   * side the owner is on. Shared with the predicate a server applies to a
   * session, which decides the same tier one step earlier. See
   * docs/spec/access-control.md § Delegation: principal and subject.
   */
  private get ownerActingAlone(): boolean {
    return isOwnerActingAlone(
      { principalId: this.principalEntityId, subjectId: this.subjectEntityId },
      this.stack.ownerEntityId,
    );
  }

  /**
   * Refuse anything but the owner acting as itself. The verbs resting on
   * this tier are irreversible or disclose the sharing graph, so delegation
   * never carries one to a subject — see ownerActingAlone.
   */
  private requireOwnerActingAlone(message: string): void {
    if (!this.ownerActingAlone) throw new StackPermissionError(message);
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
      grantRecords = await this.loadGrants();
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
      this.principalEntityId || this.subjectEntityId ? await this.loadGrants() : undefined;
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
   * a reshare. See docs/spec/identity.md § Group.
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
    const mutating = opts.mutating ?? true;
    // The `_grant` write fence applies to mutating callers only: reading a
    // grant Record's history is not the escalation that fence exists to stop.
    const record = await this.requireVerb(id, ['update-own', 'update-any'], {
      fenceGrantRecord: mutating,
    });
    return this.refuseIfDeleted(record, mutating);
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
    actions: GrantAction[],
    opts: { fenceGrantRecord: boolean },
  ): Promise<StackRecord> {
    const record = await this.stack.get(id);
    if (!record) throw new StackNotFoundError(`Record not found: "${id}"`);
    if (opts.fenceGrantRecord) await this.requireOwnerForGrantRecord(record);
    if (isGroupRecord(record)) {
      if (!this.isGroupManager(record)) throw await this.denialFor(record);
      return record;
    }
    const allowed =
      ((await this.checkWrite(record)) ||
        (await this.subjectAllows(record.typeId, actions, { record }))) &&
      (await this.principalAllows(record.typeId, actions));
    if (!allowed) throw await this.denialFor(record);
    return record;
  }

  /**
   * Refuse a mutation aimed at a soft-deleted Record. Asked only of a
   * mutating caller, so the history readers borrowing this gate still work,
   * and only after the authority decision, so "exists but deleted" is never
   * a probe a stranger can run. See docs/spec/versioning.md § Mutations are
   * refused, not applied to a tombstone.
   */
  private refuseIfDeleted(record: StackRecord, mutating: boolean): StackRecord {
    if (mutating && record.deletedAt) {
      throw new StackConflictError(
        `Record "${record.id}" is soft-deleted; undelete it before mutating it.`,
      );
    }
    return record;
  }

  /**
   * Fetch a record the subject can reach and the principal holds `delete` on
   * (via permissions or a delete grant), or throw.
   */
  private requireDeletable(id: string): Promise<StackRecord> {
    // No soft-delete refusal: undelete() shares this gate, and a tombstone
    // is exactly what it addresses.
    return this.requireVerb(id, ['delete-own', 'delete-any'], { fenceGrantRecord: true });
  }

  /**
   * Whether this request may reference `recordId` (as a parentId or
   * relationship target). Missing and unreadable both return false —
   * indistinguishable, so this can't probe for a record's existence.
   *
   * The owner acting alone passes without the lookup, which costs nothing:
   * there is no record in their own stack they may not read, so the gate
   * could only ever refuse them for absence — and absence is `Stack`'s to
   * answer, with the conflict that names the problem rather than a
   * refusal standing in for it. The anti-oracle property is unchanged for
   * every other requester.
   * See docs/spec/access-control.md § Reference-creation gating.
   */
  private async canReadReferent(recordId: string): Promise<boolean> {
    if (this.ownerActingAlone) return true;
    const record = await this.stack.get(recordId);
    if (!record) return false;
    return this.canRead(record);
  }

  /**
   * Whether this request can read some record referencing `fileId` —
   * shared by canAccessFile() and the non-owner _attachment@1 create()
   * carve-out, which deliberately excludes the uploader clause. Walks
   * every referencing record, short-circuiting on the first readable one.
   * `_attachment@1` records are excluded from matching outright: the
   * carve-out must be satisfied by some *other* record referencing the
   * file, never by the requester's own prior metadata record for it —
   * allowing that would let one successful guess unlock unlimited further
   * metadata records for the same fileId, reintroducing the circularity
   * the carve-out's uploader-clause exclusion closes.
   * See docs/spec/attachments.md § Creating `_attachment@1` records directly.
   */
  private async hasReadableReference(fileId: string): Promise<boolean> {
    const prefetchedGrants = this.subjectEntityId ? await this.loadGrants() : undefined;
    const groupRoles = new Map<string, GroupRole | null>();

    const match = await findFirstMatch(
      (q) => this.stack.query(q),
      // Reach, not enumeration: a record readable by ID conveys the file it
      // references. See docs/spec/unlisted.md.
      { filter: { attachmentFileId: fileId, includeUnlisted: true } },
      (record) =>
        baseIdOf(record.typeId) !== SYSTEM_TYPES.ATTACHMENT &&
        this.canRead(record, prefetchedGrants, groupRoles),
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

    return filtersContent(this.stack.features)
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
   * in `content` are checked (a content patch is a merge patch; untouched fields
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
    // published something it didn't — asked value-wise, since an
    // `undefined` carries no date and Stack.create() reads it as absent.
    // This is also the enforcement a server built on ScopedStack inherits
    // for `POST /records`: an owner-authenticated request may carry both
    // fields, anyone else's has them ignored.
    if ((opts.createdAt !== undefined || opts.updatedAt !== undefined) && !this.ownerActingAlone) {
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
   * a reshare enforces, asked at create time too so the reach it
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
   * — the owner-or-creator rule a reshare enforces, asked of one
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
    if (!(await this.canRead(record))) return null;
    return presentDeleted(record);
  }

  /**
   * Runs through this.query(), so canRead() still applies — this answers a
   * question the caller asks on its own behalf. includeUnlisted is passed
   * only when the request is the owner acting alone, per
   * docs/spec/identity.md § DID bindings.
   */
  async getEntityByDid(did: EntityId): Promise<StackRecord | null> {
    return lookupEntityByDid(
      (q) => this.query(q),
      did,
      filtersContent(this.stack.features),
      this.ownerActingAlone,
    );
  }

  async getOwnerEntity(): Promise<StackRecord | null> {
    return this.getEntityByDid(this.stack.ownerEntityId);
  }

  /**
   * Query records, filtered to those this request can read. Pages are
   * filtered then refilled, so a page may slightly overshoot `limit` but
   * never skips a record. Grants are prefetched once, cursor-walked to
   * exhaustion.
   */
  async query(query: StackQuery = {}): Promise<QueryResult> {
    assertValidSort(query.sort);
    assertSortCapability(query.sort, this.stack.features);
    assertValidRelatedTo(query.filter?.relatedTo);
    if (query.filter?.includeUnlisted && !this.ownerActingAlone) {
      throw new StackPermissionError('includeUnlisted is owner-only');
    }
    const limit = Math.min(query.limit ?? DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT);
    const records: StackRecord[] = [];
    const maxFetched = limit * 10;
    let totalFetched = 0;

    const prefetchedGrants = this.principalEntityId ? await this.loadGrants() : undefined;
    // Scoped to this query, like prefetchedGrants beside it: every
    // candidate Record shares one roster resolution per group, and nothing
    // is carried into the next operation.
    const groupRoles = new Map<string, GroupRole | null>();

    let page: QueryResult = { records: [], cursor: query.cursor ?? null };
    do {
      page = await this.stack.query({ ...query, cursor: page.cursor ?? undefined });
      totalFetched += page.records.length;
      for (const record of page.records) {
        // Projected here as well as in get(), or `includeDeleted` would be
        // a strictly better read channel than the fetch-by-ID it is
        // supposed to match.
        if (await this.canRead(record, prefetchedGrants, groupRoles)) {
          records.push(presentDeleted(record));
        }
      }
    } while (records.length < limit && page.cursor && totalFetched < maxFetched);

    return { records, cursor: page.cursor };
  }

  /**
   * Apply a change set on behalf of the subject. Authority is resolved
   * **per key** and every gate reads the record as it stands, never as the
   * change set would leave it: a widened `permissions` never satisfies the
   * read check on a `parentId` named in the same call, and a `_group`
   * roster never satisfies the admin check that same call has to pass.
   * One refused key refuses the whole call, so nothing is partially
   * applied and no key is silently dropped.
   * See docs/spec/access-control.md § Composing a change set.
   */
  async mutate(
    id: string,
    changes: RecordChanges,
    opts: IfVersionOptions = {},
  ): Promise<StackRecord> {
    // Ahead of every gate: a malformed change set is a validation error
    // for every requester, rather than one for the owner and a permission
    // refusal for everyone else.
    assertNonEmptyChangeSet(changes);
    if (changes.contentPatch) {
      const patchErrors = validatePatchValues(changes.contentPatch);
      if (patchErrors.length > 0) throw new StackValidationError(patchErrors);
    }

    // Refused here as well as in `Stack` below, so the partition is a
    // refusal rather than a permission question: an `associations` key
    // naming an authority kind is the wrong surface for every requester,
    // owner included.
    if (changes.associations) assertDataAssociations(changes.associations, 'associations');
    if (changes.permissions) assertAuthorityAssociations(changes.permissions, 'permissions');

    const writes =
      changes.contentPatch !== undefined ||
      changes.associations !== undefined ||
      changes.parentId !== undefined;
    // `unlisted` reshares on the key's presence alone: it is a boolean, so
    // naming it is the whole of what it can say. `permissions` is a set,
    // and a set restated is not a reshare — see permissionsMove() below,
    // which refines the escalation on this branch alone. A change set
    // naming no writable key is gated before any record is in hand to
    // compute a delta from, so there it reshares on presence, like the
    // boolean. See docs/spec/access-control.md
    // § Storage unifies; the API does not.
    const unlists = changes.unlisted !== undefined;

    // requireUpdatable() reads the record and applies the write gate; the
    // reshare keys need the record before their own gate, and a change set
    // carrying only those must not be held to the write gate it doesn't
    // need. One read either way.
    const record = writes ? await this.requireUpdatable(id) : await this.requireReshareable(id);
    if (writes && (unlists || this.permissionsMove(record, changes))) {
      await this.requireReshareOf(record);
    }

    if (changes.contentPatch) {
      const patch = changes.contentPatch;
      // Value-wise, not presence-wise: a client that reads a card, edits
      // its `name` and sends the whole content object back is not setting
      // the binding it round-trips, and `name` is writable by record-level
      // permission. Same predicate restoreVersion() applies to a snapshot.
      this.requireOwnerForAppIdentity(
        record.typeId,
        (field) =>
          field in patch && patch[field] !== (record.content as Record<string, unknown>)[field],
      );
      // Likewise value-wise: re-sending the DID a card already holds
      // claims nothing, and immutability refuses changing it regardless.
      if ('did' in patch && patch.did !== (record.content as Record<string, unknown>).did) {
        this.requireOwnerForOwnerDid(record.typeId, patch.did);
      }
      await this.requireFileRefAccess(record.typeId, patch);
    }

    // Every association the change set would add is a reference this
    // requester has to be allowed to create — asked against the stored
    // set, so an association already on the record is not re-gated.
    for (const assoc of changes.associations ?? []) {
      if ((record.associations ?? []).some((a) => associationEqual(a, assoc))) continue;
      await this.requireAssociationAccess(record.typeId, assoc);
    }

    if (changes.parentId != null && !(await this.canReadReferent(changes.parentId))) {
      throw new StackPermissionError();
    }

    return this.stack.mutate(id, changes, { ...opts, ...this.actor });
  }

  async patchContent(
    id: string,
    patch: Record<string, unknown | null>,
    opts: IfVersionOptions = {},
  ): Promise<StackRecord> {
    return this.mutate(id, { contentPatch: patch }, opts);
  }

  /**
   * The record, having established that this request may decide who else
   * reaches it — the owner-or-creator rule, asked of both sides of a
   * delegation, or a Group's admin rule for a `_group`. The gate the
   * `permissions` and `unlisted` keys carry, which the write bit
   * deliberately does not confer.
   */
  private async requireReshareable(id: string): Promise<StackRecord> {
    const record = await this.stack.get(id);
    if (!record) throw new StackNotFoundError(`Record not found: "${id}"`);
    await this.requireOwnerForGrantRecord(record);
    await this.requireReshareOf(record);
    // Reached through its own gate rather than requireUpdatable(), so the
    // soft-delete refusal has to be asked here too — after the authority
    // decision above, for the reason refuseIfDeleted() gives.
    return this.refuseIfDeleted(record, true);
  }

  /**
   * Whether a change set's `permissions` key actually moves the ACL. Read
   * off the computed delta rather than the elements the caller supplied:
   * a gate that inspected only what was named would miss the wholesale
   * replacement that drops everything, which names nothing at all. Any
   * add, remove or repoint in either direction is a reshare.
   * See docs/spec/access-control.md § Record-level permissions.
   */
  private permissionsMove(record: StackRecord, changes: RecordChanges): boolean {
    if (changes.permissions === undefined) return false;
    return associationDelta(record.permissions ?? [], changes.permissions).length > 0;
  }

  /** The reshare decision alone, for a record already read and write-gated. */
  private async requireReshareOf(record: StackRecord): Promise<void> {
    if (!this.canReshare(record)) throw await this.denialFor(record);
  }

  /**
   * Whether this request may decide who else reaches `record` — the
   * decision requireReshareOf() refuses on, without the refusal, for the
   * read paths that project on it rather than throw.
   *
   * A `_group` asks management, not authorship: a creator later demoted
   * from the admin roster shouldn't retain a side door to reassign who can
   * read or write the group record. Everything else is intersected like
   * every other authority here — the principal must hold it, and the
   * subject must be able to reach this record, without which an owner
   * principal would carry its subject to records the subject cannot touch.
   * create() withholds the same reach via mayGrantAccess().
   */
  private canReshare(record: StackRecord): boolean {
    if (baseIdOf(record.typeId) === SYSTEM_TYPES.GROUP) return this.isGroupManager(record);
    if (!this.mayReshare(this.principalEntityId, record)) return false;
    return !this.delegated || this.mayReshare(this.subjectEntityId, record);
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
    this.requireOwnerActingAlone('Only the stack owner may set an _app record’s did or appId');
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
          ...(filtersContent(this.stack.features) && {
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
    this.requireOwnerActingAlone('Only the stack owner may claim the owner’s own did');
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

  /**
   * Gated on the write bit alone, which is why the kind refusal comes
   * first: authority reached through this verb would be exactly the
   * escalation the partition exists to stop, decided before any record is
   * read so it cannot depend on who is asking.
   */
  async associate(id: string, association: DataAssociation): Promise<StackRecord> {
    assertDataAssociations([association], 'associate()');
    const record = await this.requireUpdatable(id);
    await this.requireAssociationAccess(record.typeId, association);
    return this.stack.associate(id, association, this.actor);
  }

  /** See associate() — the same write gate, the same kind refusal. */
  async dissociate(id: string, association: DataAssociation): Promise<StackRecord> {
    assertDataAssociations([association], 'dissociate()');
    await this.requireUpdatable(id);
    return this.stack.dissociate(id, association, this.actor);
  }

  /**
   * Extend who reaches a record — the reshare gate's own verb, on the
   * owner-or-creator rule the `permissions` key carries. The write bit
   * does not confer it: a write-holder who could grant would escalate to
   * deciding who else reaches the record, which is the whole of what
   * scoping access is for.
   * See docs/spec/access-control.md § Record-level permissions.
   */
  async grantAccess(id: string, permission: AuthorityAssociation): Promise<StackRecord> {
    assertAuthorityAssociations([permission], 'grantAccess()');
    await this.requireReshareable(id);
    return this.stack.grantAccess(id, permission, this.actor);
  }

  /** Withdraw one element of who reaches a record — see grantAccess(). */
  async revokeAccess(id: string, permission: AuthorityAssociation): Promise<StackRecord> {
    assertAuthorityAssociations([permission], 'revokeAccess()');
    await this.requireReshareable(id);
    return this.stack.revokeAccess(id, permission, this.actor);
  }

  /**
   * Hard delete is owner-only: it is irreversible and destroys version
   * history, so neither the write bit nor delete-own/delete-any grants
   * reach it, and delegation doesn't carry it either. Everyone else is
   * limited to soft delete.
   */
  async delete(id: string, opts: DeleteRecordOptions = {}): Promise<DeleteResult> {
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
   * like patchContent(). A snapshot carries content and the typeId it is
   * read under, so every requester who passes that gate sees the same
   * rows. Reading history changes nothing, so it is the one path the
   * `_grant` write fence leaves alone: seeing how a Record you can already
   * read got that way is not the escalation that fence exists to stop, and
   * losing it would leave a write-holder unable to audit the Record they
   * hold. See docs/spec/versioning.md § History access.
   */
  async getVersions(id: string): Promise<RecordVersion[]> {
    await this.requireUpdatable(id, { mutating: false });
    return this.stack.getVersions(id);
  }

  /**
   * See getVersions() — the same mutate-surface gate, for the same reason.
   *
   * The journal is where a Record's sharing history lives, and that half
   * is the resharer's: a reader who could not have moved the ACL is served
   * the `permissions` op without the elements beneath it, so the entry
   * still names that it moved. Asked of both identities, so delegation is
   * no route to it either. See docs/spec/journal.md § Reading it.
   */
  async getJournal(id: string, query: JournalQuery = {}): Promise<RecordJournalEntry[]> {
    const record = await this.requireUpdatable(id, { mutating: false });
    const entries = await this.stack.getJournal(id, query);
    return this.canReshare(record) ? entries : entries.map(withoutAuthorityChanges);
  }

  /** See getVersions() — the same mutate-surface gate. */
  async getVersion(id: string, version: number): Promise<RecordVersion | null> {
    await this.requireUpdatable(id, { mutating: false });
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
    id: string,
    version: number,
    opts: IfVersionOptions = {},
  ): Promise<StackRecord> {
    const record = await this.requireUpdatable(id);
    if (!this.ownerActingAlone) {
      const target = await this.stack.getVersion(id, version);
      if (target) {
        // A rollback that would move a card's binding is the same trust
        // decision a content patch reserves to the owner, reached by another route.
        this.requireOwnerForAppIdentity(
          record.typeId,
          (field) =>
            (target.content as Record<string, unknown>)[field] !==
            (record.content as Record<string, unknown>)[field],
        );
        await this.requireFileRefAccess(target.typeId, target.content);
        // Content's file refs are the only reference a restore can put
        // back: containment and associations are not on a snapshot at all,
        // so a restore never introduces either — see
        // docs/spec/versioning.md § Restore semantics.
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
   * destination *and* every gate `mutate()` applies over the existing
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
    this.requireOwnerActingAlone('Only the stack owner may commit a migration');
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
    assertAttachmentSize(data.byteLength, this.features.limits.attachmentBytes);
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
   * Observe the changes this request may read. The predicate is canRead
   * applied per event — the same one get() and query() answer with, so a
   * feed can't disagree with them about what this session sees.
   *
   * A record the subscriber cannot read produces no event at all, rather
   * than an empty or redacted one: the existence of a change is itself a
   * disclosure, the same reasoning that keeps a count of the whole match
   * off a query result. See docs/spec/events.md § Permission scoping.
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
    // A relaying stack was already refused above, so relaysChanges is
    // always false here — `since` never has a cursor to mean anything by.
    assertSinceUsable(opts.since, false);
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
    const grants = this.principalEntityId ? await cache.grants(() => this.loadGrants()) : undefined;
    return this.canRead(record, grants, cache.roles);
  }
}
