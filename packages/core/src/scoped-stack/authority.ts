/**
 * Scope authority
 * -------------------------------------------------------
 * What one (principal, subject) pair may do, as questions with yes-or-no
 * answers: may this request read the record, create this type, reshare,
 * reach this file. ScopedStack turns the answers into refusals and
 * forwards what passes to its Stack; nothing here throws a refusal or
 * writes. See docs/spec/access-control.md § Delegation: principal and
 * subject.
 */

import { checkAccess, groupRoleFromAssociations, isOwnerActingAlone } from '../access.js';
import type { AccessMode } from '../access.js';
import { StackError, StackNotFoundError, StackPermissionError } from '../errors.js';
import {
  UNGRANTABLE_SYSTEM_TYPES,
  grantConveys,
  grantCoversGrantee,
  grantReach,
  loadGrantRecords,
} from '../grants.js';
import { filtersContent } from '../query-validation.js';
import { baseIdOf } from '../schema.js';
import { findFirstMatch, queryAllPages } from '../stack-reads.js';
import { SYSTEM_TYPES } from '../types/index.js';
import type {
  Actor,
  AttachmentContent,
  EntityId,
  GrantAction,
  GrantContent,
  GroupRole,
  StackRecord,
  TypeId,
} from '../types/index.js';
import type { Stack } from '../stack/stack.js';

export class ScopeAuthority {
  constructor(
    private readonly stack: Stack,
    /** Whose grants bound what this request may do — see ScopedStack.principalId. */
    readonly principalId: EntityId | null,
    /** Whom this request acts for and attributes writes to — see ScopedStack.subjectId. */
    readonly subjectId: EntityId | null,
  ) {}

  readonly resolveRecord = (id: string): Promise<StackRecord | null> =>
    this.stack.get(id, { includeDeleted: true });

  /** Every `_grant` Record — see loadGrantRecords(). */
  readonly loadGrants = (): Promise<StackRecord[]> => loadGrantRecords((q) => this.stack.query(q));

  /** Whether a delegated app is acting for someone other than itself. */
  get delegated(): boolean {
    return this.subjectId !== this.principalId;
  }

  /**
   * Whether any grant could name this request — the one question every
   * prefetch asks before scanning the `_grant` family, since an anonymous
   * requester is reached by none. Both identities are read: `asEntity()`
   * refuses an anonymous principal acting for a subject, so they are null
   * together, and saying so costs nothing.
   */
  get identified(): boolean {
    return this.principalId !== null || this.subjectId !== null;
  }

  /**
   * Who this request is, for stamping onto whatever it mutates. Attribution
   * follows record-level authorship: the subject is the actor, and the
   * principal is named beside it only when the two differ.
   * See docs/spec/data-model.md § Authorship and attribution.
   */
  get requester(): Actor | undefined {
    if (this.subjectId === null) return undefined;
    return this.delegated && this.principalId !== null
      ? { subjectId: this.subjectId, principalId: this.principalId }
      : { subjectId: this.subjectId };
  }

  /**
   * Whether unconditional owner authority applies — the owner acting as
   * itself. The verbs that rest on it are irreversible or disclose the
   * sharing graph, so delegation never carries one to a subject, whichever
   * side the owner is on. Shared with the predicate a server applies to a
   * session, which decides the same tier one step earlier. See
   * docs/spec/access-control.md § Delegation: principal and subject.
   */
  get ownerActingAlone(): boolean {
    return isOwnerActingAlone(
      { principalId: this.principalId, subjectId: this.subjectId },
      this.stack.ownerEntityId,
    );
  }

  /** Whether the record's own permissions let the subject `mode` it. */
  recordPermits(record: StackRecord, mode: AccessMode): Promise<boolean> {
    return checkAccess(record, this.subjectId, this.stack.ownerEntityId, mode, this.resolveRecord);
  }

  /**
   * Whether `grantee` holds a _grant covering one of `actions` for the
   * type's family (grants match by baseId, so a version bump never orphans
   * one). -own actions additionally require the author to be `grantee`,
   * unless `matchOwn` is false — on the principal side of a delegated
   * request the suffix reads as the bare verb, since which records are
   * reachable is the subject's business. `allowDefault` decides whether a
   * grant naming nobody counts.
   *
   * Reached only through subjectAllows()/principalHolds(), which fix those
   * two flags per side. Call one of those instead.
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

    // grantType() refuses to write these, but a _grant record is an ordinary
    // Record: an unscoped Stack, an import, or a server mapping a request
    // body onto Stack can mint one anyway. Refusing at the point of use is
    // what makes the rule hold regardless of how the record got there.
    if (UNGRANTABLE_SYSTEM_TYPES.has(familyId)) return false;

    let grantRecords: StackRecord[];
    if (prefetchedGrants !== undefined) {
      grantRecords = prefetchedGrants;
    } else {
      // Cursor-walked to see grants past page one. A stored baseId is
      // judged by grantReach(), which refuses a versioned one.
      grantRecords = await this.loadGrants();
    }

    for (const r of grantRecords) {
      const c = r.content as GrantContent;
      const reach = grantReach(c);
      if (!reach || reach.familyId !== familyId) continue;
      const covers = await grantCoversGrantee(c, grantee, {
        allowDefault,
        allowGroup,
        groupRoles,
        resolveRecord: this.resolveRecord,
      });
      if (!covers) continue;
      const matches = actions.some((action) => {
        if (!grantConveys(reach.actions, action)) return false;
        if (matchOwn && action.endsWith('-own')) return record?.createdBy?.subjectId === grantee;
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
   * Neither default nor group-targeted grants count here. "Any
   * authenticated entity" is about people who turn up, not software the
   * owner installed; and a roster is editable by any of the group's admins,
   * so authority reaching a principal through one would let someone other
   * than the owner name an app to a type.
   */
  principalAllows(
    typeId: TypeId,
    actions: GrantAction[],
    prefetchedGrants?: StackRecord[],
  ): Promise<boolean> {
    if (!this.delegated) return Promise.resolve(true);
    if (this.principalId === this.stack.ownerEntityId) return Promise.resolve(true);
    return this.principalHolds(typeId, actions, prefetchedGrants);
  }

  /**
   * principalAllows() without its shortcuts: whether the principal itself
   * holds a grant naming it for these verbs, read the principal-side way.
   * Also what an installed app's own migration authority rests on — see
   * ScopedStack.installMayMigrate().
   */
  principalHolds(
    typeId: TypeId,
    actions: GrantAction[],
    prefetchedGrants?: StackRecord[],
  ): Promise<boolean> {
    return this.hasGrant(typeId, actions, {
      grantee: this.principalId,
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
   * Paired with principalHolds() so that the two halves of the
   * intersection are the only callers of hasGrant(): its flags differ per
   * side and mean nothing on their own, so no call site sets them by hand.
   */
  subjectAllows(
    typeId: TypeId,
    actions: GrantAction[],
    opts: {
      record?: StackRecord;
      prefetchedGrants?: StackRecord[];
      groupRoles?: Map<string, GroupRole | null>;
    } = {},
  ): Promise<boolean> {
    return this.hasGrant(typeId, actions, {
      grantee: this.subjectId,
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
   * See docs/spec/disclosure.md § Which refusal a Record answers with.
   */
  async denialFor(record: StackRecord, message: string): Promise<StackError> {
    // Prefetched here rather than threaded down from the gate: a write
    // carried by a record-level permission settles without reading a grant
    // at all, and that path must not pay for this one. Both halves of
    // canRead share the one scan.
    const grants = this.identified ? await this.loadGrants() : undefined;
    if (await this.canRead(record, grants)) return new StackPermissionError(message);
    return new StackNotFoundError(`Record not found: "${record.id}"`);
  }

  async canRead(
    record: StackRecord,
    prefetchedGrants?: StackRecord[],
    groupRoles?: Map<string, GroupRole | null>,
  ): Promise<boolean> {
    const reachable =
      (await this.recordPermits(record, 'read')) ||
      (await this.subjectAllows(record.typeId, ['read-own', 'read-any'], {
        record,
        prefetchedGrants,
        groupRoles,
      }));
    if (!reachable) return false;
    return this.principalAllows(record.typeId, ['read-own', 'read-any'], prefetchedGrants);
  }

  async checkCreateGrant(typeId: TypeId): Promise<boolean> {
    if (this.ownerActingAlone) return true;
    const reachable =
      this.subjectId === this.stack.ownerEntityId || (await this.subjectAllows(typeId, ['create']));
    if (!reachable) return false;
    return this.principalAllows(typeId, ['create']);
  }

  /**
   * `_group` records are managed, not merely written: only the owner or an
   * `admin` roster holder may mutate them — ordinary write permissions and
   * grants don't apply. Asked of both identities under delegation, like
   * a reshare. See docs/spec/identity.md § Group.
   */
  isGroupManager(record: StackRecord): boolean {
    if (!this.managesGroup(this.principalId, record)) return false;
    return !this.delegated || this.managesGroup(this.subjectId, record);
  }

  /** Whether one identity, on its own, manages `record` — see isGroupManager(). */
  private managesGroup(entityId: EntityId | null, record: StackRecord): boolean {
    if (!entityId) return false;
    if (entityId === this.stack.ownerEntityId) return true;
    return groupRoleFromAssociations(record.associations, entityId) === 'admin';
  }

  /**
   * Whether this request may reference `recordId` (as a parentId or
   * relationship target). Missing and unreadable both return false —
   * indistinguishable, so this can't probe for a record's existence.
   *
   * The owner acting alone passes without the lookup: there is no record in
   * their own stack they may not read, so the gate could only refuse them
   * for absence — which is `Stack`'s to answer, with a conflict that names
   * the problem. See docs/spec/access-control.md § Reference-creation gating.
   */
  async canReadReferent(recordId: string): Promise<boolean> {
    if (this.ownerActingAlone) return true;
    const record = await this.stack.get(recordId, { includeDeleted: true });
    if (!record) return false;
    return this.canRead(record);
  }

  /**
   * Whether this request can read some record referencing `fileId` —
   * shared by canAccessFile() and the non-owner _attachment@1 create()
   * carve-out, which deliberately excludes the uploader clause.
   * `_attachment@1` records never match: the carve-out has to be satisfied
   * by some *other* record referencing the file, or one successful guess
   * would unlock unlimited further metadata records for the same fileId.
   * See docs/spec/attachments.md § Creating `_attachment@1` records directly.
   */
  async hasReadableReference(fileId: string): Promise<boolean> {
    const prefetchedGrants = this.identified ? await this.loadGrants() : undefined;
    const groupRoles = new Map<string, GroupRole | null>();

    const match = await findFirstMatch(
      (q) => this.stack.query(q),
      // Reach, not enumeration: a record readable by ID conveys the file it
      // references. See docs/spec/unlisted.md.
      { filter: { referencesFileId: fileId, includeUnlisted: true } },
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
  async canAccessFile(fileId: string): Promise<boolean> {
    if (this.ownerActingAlone) return true;

    // Reaching a file through a record this request can read is already
    // fully intersected — canRead() applied the principal's mask against
    // that record's own type, which is the type the reference lives on.
    if (await this.hasReadableReference(fileId)) return true;

    if (!this.subjectId) return false;

    // The remaining paths are authorship facts about the subject, so they
    // decide *which* files match — they are not themselves a grant, and the
    // principal still needs one of its own on the attachment type.
    if (!(await this.principalAllows(`${SYSTEM_TYPES.ATTACHMENT}@1`, ['read-own', 'read-any']))) {
      return false;
    }

    if (this.subjectId === this.stack.ownerEntityId) return true;

    // `includeUnlisted`, as hasReadableReference() above: withholding a
    // record from enumeration decides nothing about what it conveys, and
    // the uploader clause does not lapse. See docs/spec/unlisted.md.
    return filtersContent(this.stack.capabilities)
      ? (
          await this.stack.query({
            filter: {
              typeId: `${SYSTEM_TYPES.ATTACHMENT}@1`,
              createdBy: { subjectId: this.subjectId },
              content: { fileId },
              includeUnlisted: true,
            },
            limit: 1,
          })
        ).records.length > 0
      : (
          await queryAllPages((q) => this.stack.query(q), {
            filter: {
              typeId: `${SYSTEM_TYPES.ATTACHMENT}@1`,
              createdBy: { subjectId: this.subjectId },
              includeUnlisted: true,
            },
          })
        ).some((r) => (r.content as AttachmentContent).fileId === fileId);
  }

  /** Names of the type's top-level file-ref fields — the content-reference half of referencesFileId matching. */
  async fileRefFieldNames(typeId: TypeId): Promise<string[]> {
    const type = await this.stack.getType(typeId);
    if (!type) return [];
    return Object.entries(type.schema)
      .filter(([, def]) => def.kind === 'file-ref')
      .map(([field]) => field);
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
  mayGrantAccess(): boolean {
    return !this.delegated || this.principalId === this.stack.ownerEntityId;
  }

  /**
   * Whether one identity, on its own, may decide who else reaches `record`
   * — the owner-or-creator rule a reshare enforces, asked of one
   * side at a time. See
   * docs/spec/access-control.md § Delegation: principal and subject.
   */
  private mayReshare(entityId: EntityId | null, record: StackRecord): boolean {
    if (!entityId) return false;
    return entityId === this.stack.ownerEntityId || entityId === record.createdBy?.subjectId;
  }

  /**
   * Whether this request may decide who else reaches `record` — the
   * decision requireReshareOf() refuses on, without the refusal, for the
   * read paths that project on it rather than throw.
   *
   * A `_group` asks management, not authorship: a creator later demoted
   * from the admin roster shouldn't retain a side door to reassign who can
   * read or write the group record. Everything else is intersected like
   * every other authority here, or an owner principal would carry its
   * subject to records the subject cannot touch.
   */
  canReshare(record: StackRecord): boolean {
    if (baseIdOf(record.typeId) === SYSTEM_TYPES.GROUP) return this.isGroupManager(record);
    if (!this.mayReshare(this.principalId, record)) return false;
    return !this.delegated || this.mayReshare(this.subjectId, record);
  }
}
