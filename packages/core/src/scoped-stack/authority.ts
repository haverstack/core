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

import {
  groupRoleFromAssociations,
  isOwnerActingAlone,
  permitsWrite,
  roleSatisfies,
} from '../access.js';
import { inReach } from '../adapter/reach.js';
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
import { AuthorityReads } from './authority-reads.js';
import { SYSTEM_TYPES } from '../types/index.js';
import type {
  Actor,
  AppContent,
  BaseId,
  AuthorityAssociation,
  AttachmentContent,
  EntityId,
  GrantAction,
  GrantContent,
  InstallContent,
  ReadReach,
  StackRecord,
  TypeId,
} from '../types/index.js';
import type { Stack } from '../stack/stack.js';

/**
 * How each side of a request reads a grant. The subject is the entity a
 * grant is written about, so every tier counts and `-own` keeps its
 * meaning; on the principal's side only a grant naming it directly counts,
 * and the suffix collapses to the bare verb. See
 * docs/spec/access-control.md § Delegation: principal and subject.
 */
const SUBJECT_SIDE = { matchOwn: true, allowDefault: true, allowGroup: true } as const;
const PRINCIPAL_SIDE = { matchOwn: false, allowDefault: false, allowGroup: false } as const;
type GrantSide = typeof SUBJECT_SIDE | typeof PRINCIPAL_SIDE;

const READ_ACTIONS: GrantAction[] = ['read-own', 'read-any'];

/** The family a Record is listed under in a reach ScopeAuthority builds. */
const familyOf = (record: StackRecord): string => baseIdOf(record.typeId);

export class ScopeAuthority {
  constructor(
    private readonly stack: Stack,
    /** Whose grants bound what this request may do — see ScopedStack.principalId. */
    readonly principalId: EntityId | null,
    /** Whom this request acts for and attributes writes to — see ScopedStack.subjectId. */
    readonly subjectId: EntityId | null,
  ) {}

  /** Every `_grant` Record — see loadGrantRecords(). */
  readonly loadGrants = (): Promise<StackRecord[]> => loadGrantRecords((q) => this.stack.query(q));

  /**
   * The authority one operation's checks read, loaded as they first need it:
   * pass it to each check the operation makes, so the `_grant` scan and the
   * roster read happen at most once. An anonymous request is named by no
   * grant and held by no roster, so it reads neither.
   */
  reads(): AuthorityReads {
    const subject = this.subjectId;
    return new AuthorityReads({
      grants: () => (this.identified ? this.loadGrants() : Promise.resolve([])),
      roles: () =>
        subject === null
          ? Promise.resolve(new Map())
          : loadRosterRoles((q) => this.stack.query(q), subject),
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

  /** Whether the record's own `write` elements let the subject mutate it. */
  permitsWrite(record: StackRecord, reads: AuthorityReads = this.reads()): Promise<boolean> {
    return permitsWrite(record, this.subjectId, this.stack.ownerEntityId, reads.roles);
  }

  /**
   * The grants reaching `grantee`, each as the family it names and the
   * verbs it carries, read the way `side` reads a grant. Only the subject's
   * side counts a group, so the rosters read are always the subject's.
   * See docs/spec/access-control.md § Who a grant reaches.
   */
  private async grantsReaching(
    grantee: EntityId | null,
    side: GrantSide,
    reads: AuthorityReads,
    familyId?: string,
  ): Promise<{ familyId: string; actions: GrantAction[] }[]> {
    if (!grantee) return [];
    const reaching: { familyId: string; actions: GrantAction[] }[] = [];
    for (const r of await reads.grants()) {
      const c = r.content as GrantContent;
      // A stored baseId is judged by grantReach(), which refuses a
      // versioned one.
      const reach = grantReach(c);
      if (!reach) continue;
      if (familyId !== undefined && reach.familyId !== familyId) continue;
      // grantType() refuses to write these, but a _grant record is an
      // ordinary Record: an unscoped Stack, an import, or a server mapping
      // a request body onto Stack can mint one anyway. Refusing at the
      // point of use is what makes the rule hold regardless of how the
      // record got there.
      if (UNGRANTABLE_SYSTEM_TYPES.has(reach.familyId)) continue;
      const covers = await grantCoversGrantee(c, grantee, {
        allowDefault: side.allowDefault,
        allowGroup: side.allowGroup,
        roles: reads.roles,
      });
      if (covers) reaching.push(reach);
    }
    return reaching;
  }

  /**
   * Whether `grantee` holds a _grant covering one of `actions` on the type's
   * family, with `-own` matched against `record`'s author where `side` keeps
   * the suffix.
   */
  private async hasGrant(
    typeId: TypeId,
    actions: GrantAction[],
    grantee: EntityId | null,
    side: GrantSide,
    reads: AuthorityReads,
    record?: StackRecord,
  ): Promise<boolean> {
    const grants = await this.grantsReaching(grantee, side, reads, baseIdOf(typeId));
    return grants.some((grant) =>
      actions.some((action) => {
        if (!grantConveys(grant.actions, action)) return false;
        if (side.matchOwn && action.endsWith('-own')) {
          return record?.createdBy?.subjectId === grantee;
        }
        return true;
      }),
    );
  }

  /**
   * The families the principal's own grants convey one of `actions` on, or
   * undefined when no grant bounds it. The principal half of a delegated
   * request's authority, which bounds what the subject reaches so neither
   * lends its reach to the other.
   */
  private async principalFamilies(
    actions: GrantAction[],
    reads: AuthorityReads,
  ): Promise<string[] | undefined> {
    if (this.principalUnbounded) return undefined;
    const held = await this.grantsReaching(this.principalId, PRINCIPAL_SIDE, reads);
    const families = held.filter((g) => actions.some((a) => grantConveys(g.actions, a)));
    return [...new Set(families.map((g) => g.familyId))];
  }

  /** Whether the principal half admits one of `actions` on the type's family — see principalFamilies(). */
  async principalAllows(
    typeId: TypeId,
    actions: GrantAction[],
    reads: AuthorityReads = this.reads(),
  ): Promise<boolean> {
    const families = await this.principalFamilies(actions, reads);
    return !families || families.includes(baseIdOf(typeId));
  }

  /**
   * principalAllows() without its shortcut: whether the principal itself
   * holds a grant naming it for these verbs. What an installed app's own
   * migration authority rests on — see installMayMigrate().
   */
  principalHolds(
    typeId: TypeId,
    actions: GrantAction[],
    reads: AuthorityReads = this.reads(),
  ): Promise<boolean> {
    return this.hasGrant(typeId, actions, this.principalId, PRINCIPAL_SIDE, reads);
  }

  /** The subject half: whether its grants reach `record`, or the type when there is none yet. */
  subjectAllows(
    typeId: TypeId,
    actions: GrantAction[],
    opts: { record?: StackRecord; reads?: AuthorityReads } = {},
  ): Promise<boolean> {
    const reads = opts.reads ?? this.reads();
    return this.hasGrant(typeId, actions, this.subjectId, SUBJECT_SIDE, reads, opts.record);
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
    reads: AuthorityReads = this.reads(),
  ): Promise<StackError> {
    if (await this.canRead(record, await this.readReach(reads))) {
      return new StackPermissionError(message);
    }
    return new StackNotFoundError(`Record not found: "${record.id}"`);
  }

  /**
   * What this request may read, over type families — the one statement of
   * the read rules, which canRead() asks of one Record and an adapter
   * matches across a query. The owner acting alone reaches everything, so
   * nothing in it constrains. See docs/spec/adapters.md § Querying within a
   * reach.
   */
  async readReach(reads: AuthorityReads = this.reads()): Promise<ReadReach<BaseId>> {
    const fence = await this.principalFamilies(READ_ACTIONS, reads);
    const reach: ReadReach<BaseId> = fence ? { fence } : {};
    // An owner subject passes every record-level check.
    if (this.subjectId === this.stack.ownerEntityId) return reach;

    // `read-any` reaches a family whole, `read-own` the subject's own
    // Records in it.
    const reaching = await this.grantsReaching(this.subjectId, SUBJECT_SIDE, reads);
    const conveying = (action: GrantAction) =>
      reaching.filter((g) => grantConveys(g.actions, action)).map((g) => g.familyId);
    reach.within = {
      types: conveying('read-any'),
      ...(this.subjectId !== null && {
        authored: { subjectId: this.subjectId, types: conveying('read-own') },
      }),
      permissions: await this.readElements(reads),
    };
    return reach;
  }

  /**
   * The permission elements conveying read to the subject: `anyone`, a
   * `read` naming it, and a `read` naming each roster that holds it, at
   * every role it holds there. A `write` is never one — see
   * docs/spec/access-control.md § Write implies read.
   */
  private async readElements(reads: AuthorityReads): Promise<AuthorityAssociation[]> {
    const elements: AuthorityAssociation[] = [{ kind: 'anyone', label: 'read' }];
    const subject = this.subjectId;
    if (subject === null) return elements;
    elements.push({
      kind: 'permission',
      label: 'read',
      grantee: { kind: 'entity', entityId: subject },
    });
    for (const [groupId, held] of await reads.roles()) {
      for (const role of ['member', 'admin'] as const) {
        if (!roleSatisfies(held, role)) continue;
        elements.push({
          kind: 'permission',
          label: 'read',
          grantee: { kind: 'group', groupId, role },
        });
      }
    }
    return elements;
  }

  /**
   * Whether this request may read `record`: the reach, asked of one Record.
   * A caller deciding many passes the reach it built once.
   */
  async canRead(record: StackRecord, reach?: ReadReach<BaseId>): Promise<boolean> {
    return inReach(record, reach ?? (await this.readReach()), familyOf);
  }

  async checkCreateGrant(typeId: TypeId): Promise<boolean> {
    if (this.ownerActingAlone) return true;
    const reads = this.reads();
    const reachable =
      this.subjectId === this.stack.ownerEntityId ||
      (await this.subjectAllows(typeId, ['create'], { reads }));
    if (!reachable) return false;
    return this.principalAllows(typeId, ['create'], reads);
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
  async canReadReferent(recordId: string): Promise<boolean> {
    if (this.ownerActingAlone) return true;
    const record = await this.stack.get(recordId, { includeDeleted: true });
    if (!record) return false;
    return this.canRead(record);
  }

  /**
   * Whether this request can read some record referencing `fileId`, other
   * than an `_attachment@1` record — otherwise one correct guess would
   * unlock unlimited further metadata records for the file.
   * See docs/spec/attachments.md § Creating `_attachment@1` records directly.
   */
  async hasReadableReference(fileId: string, reach?: ReadReach<BaseId>): Promise<boolean> {
    const readable = reach ?? (await this.readReach());
    const match = await findFirstMatch(
      (q) => this.stack.query(q),
      // Reach, not enumeration: a record readable by ID conveys the file it
      // references. See docs/spec/unlisted.md.
      { filter: { referencesFileId: fileId, includeUnlisted: true } },
      (record) =>
        baseIdOf(record.typeId) !== SYSTEM_TYPES.ATTACHMENT && inReach(record, readable, familyOf),
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
    // fully intersected — the reach fences that record's own type, which
    // is the type the reference lives on.
    const reach = await this.readReach();
    if (await this.hasReadableReference(fileId, reach)) return true;

    if (!this.subjectId) return false;

    // The remaining paths are authorship facts about the subject, so they
    // decide *which* files match — they are not themselves a grant, and the
    // principal still needs one of its own on the attachment type.
    if (reach.fence && !reach.fence.includes(SYSTEM_TYPES.ATTACHMENT)) return false;

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

    const reads = this.reads();
    for (const family of families) {
      if (!(await this.principalHolds(`${family}@1`, ['update-any'], reads))) return false;
    }
    return true;
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
