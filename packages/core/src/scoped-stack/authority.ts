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

import { groupRoleFromAssociations, isOwnerActingAlone, roleSatisfies } from '../access.js';
import { inReach } from '../adapter/reach.js';
import type { ReachedRecord } from '../adapter/reach.js';
import { StackError, StackNotFoundError, StackPermissionError } from '../errors.js';
import {
  UNGRANTABLE_SYSTEM_TYPES,
  grantConveys,
  grantCoversGrantee,
  grantReach,
} from '../grants.js';
import { filtersContent } from '../query-validation.js';
import { baseIdOf, fileRefFields } from '../schema.js';
import { familyPolicy } from './family-policy.js';
import { claimedFamilies, familyStanding, INSTALL_APP_LABEL, linkedIds } from '../install.js';
import {
  findFirstMatch,
  loadGrantRecords,
  loadInstallRecords,
  loadRosterRoles,
  queryAllPages,
} from '../stack/reads.js';
import { AuthoritySnapshot } from './authority-snapshot.js';
import type { ReachVerb } from './authority-snapshot.js';
import { SYSTEM_TYPES } from '../types/index.js';
import type {
  Actor,
  AppContent,
  AttachmentContent,
  AuthorityAssociation,
  BaseId,
  EntityId,
  GrantAction,
  GrantContent,
  Grantee,
  InstallContent,
  QueryResult,
  Reach,
  StackQuery,
  StackRecord,
  TypeId,
} from '../types/index.js';
import type { Stack } from '../stack/stack.js';

/**
 * How each side of a request reads a grant. The subject is the entity a
 * grant is written about, so every tier counts; on the principal's side
 * only a grant naming it directly counts. See
 * docs/spec/access-control.md § Delegation: principal and subject.
 */
const SUBJECT_SIDE = { allowDefault: true, allowGroup: true } as const;
const PRINCIPAL_SIDE = { allowDefault: false, allowGroup: false } as const;
type GrantSide = typeof SUBJECT_SIDE | typeof PRINCIPAL_SIDE;

/**
 * What each verb is granted by: the grant action reaching a family whole,
 * the one reaching the subject's own Records in it, and the permission bit
 * reaching one Record. See docs/spec/access-control.md § Reach.
 */
const VERBS: Record<ReachVerb, { any: GrantAction; own?: GrantAction; bit?: 'read' | 'write' }> = {
  create: { any: 'create' },
  read: { any: 'read-any', own: 'read-own', bit: 'read' },
  update: { any: 'update-any', own: 'update-own', bit: 'write' },
  delete: { any: 'delete-any', own: 'delete-own', bit: 'write' },
};

const ANYONE: AuthorityAssociation = { kind: 'anyone', label: 'read' };

/** The family a Record is listed under in a reach ScopeAuthority builds. */
const familyOf = (record: ReachedRecord): string => baseIdOf(record.typeId);

export class ScopeAuthority {
  constructor(
    private readonly stack: Stack,
    /** Whose grants bound what this request may do — see ScopedStack.principalId. */
    readonly principalId: EntityId | null,
    /** Whom this request acts for and attributes writes to — see ScopedStack.subjectId. */
    readonly subjectId: EntityId | null,
    /** Stack.query() within a reach — see ScopedStack.query(). */
    private readonly queryReadable: (
      query: StackQuery,
      reach: Reach<BaseId>,
    ) => Promise<QueryResult>,
  ) {}

  /**
   * The authority this request acts with, for one operation: pass it to
   * each check the operation makes, so the grants, the rosters and each
   * verb's reach are read at most once. An anonymous request is named by no
   * grant and held by no roster, so it reads neither.
   */
  snapshot(): AuthoritySnapshot {
    const subject = this.subjectId;
    return new AuthoritySnapshot({
      grants: () =>
        this.identified ? loadGrantRecords((q) => this.stack.query(q)) : Promise.resolve([]),
      roles: () =>
        subject === null
          ? Promise.resolve(new Map())
          : loadRosterRoles((q) => this.stack.query(q), subject),
      reach: (verb, snapshot) => this.buildReach(verb, snapshot),
    });
  }

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
   * itself. The verbs resting on it are irreversible or disclose the sharing
   * graph, so delegation never carries it, whichever side the owner is on.
   * See docs/spec/access-control.md § Delegation: principal and subject.
   */
  get ownerActingAlone(): boolean {
    return isOwnerActingAlone(
      { principalId: this.principalId, subjectId: this.subjectId },
      this.stack.ownerEntityId,
    );
  }

  /**
   * Whether no grant bounds the principal: undelegated, it is the subject
   * itself, and the owner as principal is the owner's own software.
   * See docs/spec/access-control.md § Delegation: principal and subject.
   */
  private get principalUnbounded(): boolean {
    return !this.delegated || this.principalId === this.stack.ownerEntityId;
  }

  /**
   * The families `grantee`'s grants convey one of `actions` on, read the way
   * `side` reads a grant. Only the subject's side counts a group, so the
   * rosters read are always the subject's.
   * See docs/spec/access-control.md § Who a grant reaches.
   */
  private async familiesConveying(
    grantee: EntityId | null,
    side: GrantSide,
    actions: readonly GrantAction[],
    snapshot: AuthoritySnapshot,
  ): Promise<BaseId[]> {
    if (!grantee) return [];
    const families = new Set<BaseId>();
    for (const r of await snapshot.grants()) {
      const c = r.content as GrantContent;
      // A stored baseId is judged by grantReach(), which refuses a
      // versioned one.
      const reach = grantReach(c);
      if (!reach || families.has(reach.familyId)) continue;
      // grantType() refuses to write these, but a _grant record is an
      // ordinary Record: an unscoped Stack, an import, or a server mapping
      // a request body onto Stack can mint one anyway. Refusing at the
      // point of use is what makes the rule hold regardless of how the
      // record got there.
      if (UNGRANTABLE_SYSTEM_TYPES.has(reach.familyId)) continue;
      if (!actions.some((a) => grantConveys(reach.actions, a))) continue;
      if (await grantCoversGrantee(c, grantee, { ...side, roles: snapshot.roles })) {
        families.add(reach.familyId);
      }
    }
    return [...families];
  }

  /**
   * What this request may do with `verb`, over type families — the one
   * statement of that verb's rules. The principal's own grants fence it,
   * `-own` and `-any` alike; within the fence the subject reaches what its
   * grants and the Records' own permissions give it, and an owner subject
   * reaches everything. See docs/spec/access-control.md § Reach.
   */
  private async buildReach(verb: ReachVerb, snapshot: AuthoritySnapshot): Promise<Reach<BaseId>> {
    const { any, own, bit } = VERBS[verb];
    const reach: Reach<BaseId> = this.principalUnbounded
      ? {}
      : {
          fence: await this.familiesConveying(
            this.principalId,
            PRINCIPAL_SIDE,
            own ? [any, own] : [any],
            snapshot,
          ),
        };
    const subject = this.subjectId;
    if (subject === this.stack.ownerEntityId) return reach;

    const families = (action: GrantAction) =>
      this.familiesConveying(subject, SUBJECT_SIDE, [action], snapshot);
    reach.within = {
      types: await families(any),
      ...(subject !== null &&
        own && { authored: { subjectId: subject, types: await families(own) } }),
      permissions: bit ? await this.elementSets(bit, snapshot) : [],
    };
    return reach;
  }

  /**
   * The permission elements carrying `bit` to the subject, as the sets a
   * Record must hold whole. A `read` stands alone, as does `anyone`; a
   * `write` needs the same grantee's `read`, or `anyone`, beside it — see
   * docs/spec/access-control.md § Write implies read.
   */
  private async elementSets(
    bit: 'read' | 'write',
    snapshot: AuthoritySnapshot,
  ): Promise<AuthorityAssociation[][]> {
    const grantees: Grantee[] = [];
    const subject = this.subjectId;
    if (subject !== null) {
      grantees.push({ kind: 'entity', entityId: subject });
      for (const [groupId, held] of await snapshot.roles()) {
        for (const role of ['member', 'admin'] as const) {
          if (roleSatisfies(held, role)) grantees.push({ kind: 'group', groupId, role });
        }
      }
    }
    const element = (label: 'read' | 'write', grantee: Grantee): AuthorityAssociation => ({
      kind: 'permission',
      label,
      grantee,
    });
    if (bit === 'read') return [[ANYONE], ...grantees.map((g) => [element('read', g)])];
    return grantees.flatMap((g) => [
      [element('write', g), element('read', g)],
      [element('write', g), ANYONE],
    ]);
  }

  /** Whether this request may `verb` the Record: its reach, asked of one Record. */
  async may(verb: ReachVerb, record: ReachedRecord, snapshot: AuthoritySnapshot): Promise<boolean> {
    return inReach(record, await snapshot.reach(verb), familyOf);
  }

  /**
   * may() with the principal's fence set aside — whether the subject alone
   * reaches the Record, for a refusal that says which side lacked the verb.
   */
  async subjectMay(
    verb: ReachVerb,
    record: ReachedRecord,
    snapshot: AuthoritySnapshot,
  ): Promise<boolean> {
    const { within } = await snapshot.reach(verb);
    return inReach(record, within ? { within } : {}, familyOf);
  }

  canRead(record: StackRecord, snapshot: AuthoritySnapshot): Promise<boolean> {
    return this.may('read', record, snapshot);
  }

  /** Whether this request may create a Record of the type, asked of the Record it would make. */
  canCreate(typeId: TypeId, snapshot: AuthoritySnapshot): Promise<boolean> {
    return this.may('create', { typeId, createdBy: this.requester }, snapshot);
  }

  /**
   * How to refuse a record this request addressed by ID: a permission error
   * to a requester who can read it, the not-found answer to anyone else, so
   * `message` only reaches someone holding the record already.
   * See docs/spec/disclosure.md § Which refusal a Record answers with.
   */
  async denialFor(
    record: StackRecord,
    message: string,
    snapshot: AuthoritySnapshot,
  ): Promise<StackError> {
    if (await this.canRead(record, snapshot)) return new StackPermissionError(message);
    return new StackNotFoundError(`Record not found: "${record.id}"`);
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
   * Whether this request may reference `recordId` as a parent or target.
   * Missing and unreadable are both false, so this probes nothing. The
   * owner acting alone skips the lookup and leaves absence to `Stack`.
   * See docs/spec/access-control.md § Reference-creation gating.
   */
  async canReadReferent(recordId: string, snapshot: AuthoritySnapshot): Promise<boolean> {
    if (this.ownerActingAlone) return true;
    const record = await this.stack.get(recordId, { includeDeleted: true });
    if (!record) return false;
    return this.canRead(record, snapshot);
  }

  /**
   * Whether this request can read some record referencing `fileId`, other
   * than an `_attachment@1` record — otherwise one correct guess would
   * unlock unlimited further metadata records for the file.
   * See docs/spec/attachments.md § Creating `_attachment@1` records directly.
   */
  async hasReadableReference(fileId: string, snapshot: AuthoritySnapshot): Promise<boolean> {
    const reach = await snapshot.reach('read');
    const match = await findFirstMatch(
      (q) => this.queryReadable(q, reach),
      // Reach, not enumeration: a record readable by ID conveys the file it
      // references. See docs/spec/unlisted.md.
      { filter: { referencesFileId: fileId, includeUnlisted: true } },
      (record) => baseIdOf(record.typeId) !== SYSTEM_TYPES.ATTACHMENT,
    );
    return match !== undefined;
  }

  /**
   * Whether this request may reference or download `fileId` — the dual of
   * getAttachment()'s access rule. Nonexistent and inaccessible are
   * indistinguishable (both false), so no confirmation oracle for guessed
   * hashes. See docs/spec/access-control.md § Reference-creation gating.
   */
  async canAccessFile(fileId: string, snapshot: AuthoritySnapshot): Promise<boolean> {
    if (this.ownerActingAlone) return true;

    // Reaching a file through a record this request can read is already
    // fully intersected — the reach fences that record's own type, which
    // is the type the reference lives on.
    if (await this.hasReadableReference(fileId, snapshot)) return true;

    if (!this.subjectId) return false;

    // The remaining paths are authorship facts about the subject, so they
    // decide *which* files match — they are not themselves a grant, and the
    // principal still needs one of its own on the attachment type.
    const { fence } = await snapshot.reach('read');
    if (fence && !fence.includes(SYSTEM_TYPES.ATTACHMENT)) return false;

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

  /**
   * Whether this request is an installed app, acting as itself, migrating
   * `record` within families its one live install claims, to a version the
   * owner approved, holding `update-any` on each directly.
   * See docs/spec/apps.md § Migrating an installed app's types.
   */
  async installMayMigrate(record: StackRecord, toTypeId: TypeId): Promise<boolean> {
    const principal = this.principalId;
    if (!principal || this.delegated) return false;
    const families = new Set([baseIdOf(record.typeId), baseIdOf(toTypeId)]);

    const installs = await loadInstallRecords(this.stack);
    let install: (StackRecord & { content: InstallContent }) | undefined;
    for (const family of families) {
      const claimants = installs.filter((r) => claimedFamilies(r.content).has(family));
      if (claimants.length !== 1) return false;
      if (familyStanding(family, claimants[0]!.content.appId) !== 'own') return false;
      if (install && install.id !== claimants[0]!.id) return false;
      install = claimants[0];
    }
    if (!install || install.deletedAt) return false;
    if (!Array.isArray(install.content.defines) || !install.content.defines.includes(toTypeId)) {
      return false;
    }

    let linked = false;
    for (const cardId of linkedIds(install, INSTALL_APP_LABEL)) {
      const card = await this.stack.get(cardId);
      if (card && baseIdOf(card.typeId) === SYSTEM_TYPES.APP) {
        if ((card.content as AppContent).did === principal) linked = true;
      }
    }
    if (!linked) return false;

    // Grants naming the app itself: an install reaches only families the
    // owner named it to, whoever else holds them.
    const held = await this.familiesConveying(
      principal,
      PRINCIPAL_SIDE,
      ['update-any'],
      this.snapshot(),
    );
    return [...families].every((family) => held.includes(family));
  }

  /** Names of the type's top-level file-ref fields — the content-reference half of referencesFileId matching. */
  async fileRefFieldNames(typeId: TypeId): Promise<string[]> {
    const type = await this.stack.getType(typeId);
    return type ? fileRefFields(type.schema) : [];
  }

  /**
   * Whether this request may widen who reaches a record, at create time or
   * after. A delegated app may not, unless the owner is its principal:
   * widening access is what containment most needs to hold.
   * See docs/spec/access-control.md § Delegation: principal and subject.
   */
  mayGrantAccess(): boolean {
    return this.principalUnbounded;
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
   * Whether this request may decide who else reaches `record`: management
   * for a `_group`, so a demoted creator keeps no side door; otherwise the
   * owner-or-author rule, asked of both sides of a delegation.
   * See docs/spec/access-control.md § Record-level permissions.
   */
  canReshare(record: StackRecord): boolean {
    if (familyPolicy(record.typeId).writers === 'group-managers') {
      return this.isGroupManager(record);
    }
    if (!this.mayReshare(this.principalId, record)) return false;
    return !this.delegated || this.mayReshare(this.subjectId, record);
  }
}
