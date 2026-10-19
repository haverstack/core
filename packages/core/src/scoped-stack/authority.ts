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
  checkAccess,
  groupRoleFromAssociations,
  isOwnerActingAlone,
  roleSatisfies,
} from '../access.js';
import type { AccessMode } from '../access.js';
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
  queryAllPages,
} from '../stack/reads.js';
import { SYSTEM_TYPES } from '../types/index.js';
import type {
  Actor,
  AppContent,
  AuthorityAssociation,
  AttachmentContent,
  EntityId,
  GrantAction,
  GrantContent,
  GroupRole,
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

const READ_ACTIONS: GrantAction[] = ['read-own', 'read-any'];

export class ScopeAuthority {
  constructor(
    private readonly stack: Stack,
    /** Whose grants bound what this request may do — see ScopedStack.principalId. */
    readonly principalId: EntityId | null,
    /** Whom this request acts for and attributes writes to — see ScopedStack.subjectId. */
    readonly subjectId: EntityId | null,
  ) {}

  private readonly resolveRecord = (id: string): Promise<StackRecord | null> =>
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

  /** Whether the record's own permissions let the subject `mode` it. */
  recordPermits(record: StackRecord, mode: AccessMode): Promise<boolean> {
    return checkAccess(record, this.subjectId, this.stack.ownerEntityId, mode, this.resolveRecord);
  }

  /**
   * The grants reaching `grantee`, each as the family it names and the
   * verbs it carries. The flags are fixed per side of a delegation and mean
   * nothing alone, so this is reached only through the subject-side and
   * principal-side readings below. See docs/spec/access-control.md § Who a
   * grant reaches.
   */
  private async grantsReaching(
    grantee: EntityId | null,
    opts: {
      familyId?: string;
      prefetchedGrants?: StackRecord[];
      groupRoles?: Map<string, GroupRole | null>;
      allowDefault: boolean;
      allowGroup: boolean;
    },
  ): Promise<{ familyId: string; actions: GrantAction[] }[]> {
    if (!grantee) return [];
    // Absent when the caller has no operation-scoped map to share — one
    // call's worth of memoization, which is still every grant record in
    // this loop naming the same group.
    const groupRoles = opts.groupRoles ?? new Map<string, GroupRole | null>();
    // Cursor-walked to see grants past page one. A stored baseId is
    // judged by grantReach(), which refuses a versioned one.
    const grantRecords = opts.prefetchedGrants ?? (await this.loadGrants());

    const reaching: { familyId: string; actions: GrantAction[] }[] = [];
    for (const r of grantRecords) {
      const c = r.content as GrantContent;
      const reach = grantReach(c);
      if (!reach) continue;
      if (opts.familyId !== undefined && reach.familyId !== opts.familyId) continue;
      // grantType() refuses to write these, but a _grant record is an
      // ordinary Record: an unscoped Stack, an import, or a server mapping
      // a request body onto Stack can mint one anyway. Refusing at the
      // point of use is what makes the rule hold regardless of how the
      // record got there.
      if (UNGRANTABLE_SYSTEM_TYPES.has(reach.familyId)) continue;
      const covers = await grantCoversGrantee(c, grantee, {
        allowDefault: opts.allowDefault,
        allowGroup: opts.allowGroup,
        groupRoles,
        resolveRecord: this.resolveRecord,
      });
      if (covers) reaching.push(reach);
    }
    return reaching;
  }

  /**
   * Whether `grantee` holds a _grant covering one of `actions` on the type's
   * family, with `-own` matched against `record`'s author when `matchOwn`.
   */
  private async hasGrant(
    typeId: TypeId,
    actions: GrantAction[],
    opts: {
      grantee: EntityId | null;
      record?: StackRecord;
      prefetchedGrants?: StackRecord[];
      groupRoles?: Map<string, GroupRole | null>;
      matchOwn: boolean;
      allowDefault: boolean;
      allowGroup: boolean;
    },
  ): Promise<boolean> {
    const grants = await this.grantsReaching(opts.grantee, {
      ...opts,
      familyId: baseIdOf(typeId),
    });
    return grants.some((grant) =>
      actions.some((action) => {
        if (!grantConveys(grant.actions, action)) return false;
        if (opts.matchOwn && action.endsWith('-own')) {
          return opts.record?.createdBy?.subjectId === opts.grantee;
        }
        return true;
      }),
    );
  }

  /**
   * The principal half of a delegated request's authority, which bounds
   * what the subject's reaches so neither lends its reach to the other.
   * Vacuously true without delegation. Default and group grants do not
   * count — see docs/spec/access-control.md § Who a grant reaches.
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
   * installMayMigrate().
   */
  principalHolds(
    typeId: TypeId,
    actions: GrantAction[],
    prefetchedGrants?: StackRecord[],
  ): Promise<boolean> {
    return this.hasGrant(typeId, actions, {
      grantee: this.principalId,
      prefetchedGrants,
      ...PRINCIPAL_SIDE,
    });
  }

  /**
   * The subject half: which records are reachable, with `-own` matching and
   * default grants in force — the ordinary reading of a grant, since the
   * subject is the entity a grant is written about.
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
      ...SUBJECT_SIDE,
    });
  }

  /**
   * How to refuse a record this request addressed by ID: a permission error
   * to a requester who can read it, the not-found answer to anyone else, so
   * `message` only reaches someone holding the record already.
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

  /**
   * canRead() stated as data, for an adapter to match: which Records this
   * request may read, or null when nothing narrows it — the owner acting
   * alone. Built from the same grant readings canRead() asks, so the two
   * agree Record for Record. See docs/spec/adapters.md § Querying within a
   * reach.
   */
  async readReach(
    prefetchedGrants?: StackRecord[],
    groupRoles?: Map<string, GroupRole | null>,
  ): Promise<ReadReach | null> {
    if (this.ownerActingAlone) return null;
    const grants = prefetchedGrants ?? (this.identified ? await this.loadGrants() : []);

    const typeIdsByFamily = new Map<string, TypeId[]>();
    for (const type of await this.stack.listTypes()) {
      const list = typeIdsByFamily.get(type.baseId);
      if (list) list.push(type.id);
      else typeIdsByFamily.set(type.baseId, [type.id]);
    }
    const typeIdsOf = (families: Iterable<string>): TypeId[] =>
      [...new Set(families)].flatMap((family) => typeIdsByFamily.get(family) ?? []);

    // principalAllows(), family by family.
    let fence: TypeId[] | undefined;
    if (this.delegated && this.principalId !== this.stack.ownerEntityId) {
      const held = await this.grantsReaching(this.principalId, {
        prefetchedGrants: grants,
        ...PRINCIPAL_SIDE,
      });
      fence = typeIdsOf(
        held
          .filter((g) => READ_ACTIONS.some((a) => grantConveys(g.actions, a)))
          .map((g) => g.familyId),
      );
    }

    // recordPermits() passes every Record for an owner subject.
    if (this.subjectId === this.stack.ownerEntityId) {
      return { fence, typeIds: typeIdsOf(typeIdsByFamily.keys()), permissions: [] };
    }

    // subjectAllows(): `read-any` reaches a family whole, `read-own` the
    // subject's own Records in it.
    const reaching = await this.grantsReaching(this.subjectId, {
      prefetchedGrants: grants,
      groupRoles,
      ...SUBJECT_SIDE,
    });
    const any = reaching.filter((g) => grantConveys(g.actions, 'read-any')).map((g) => g.familyId);
    const own = reaching.filter((g) => grantConveys(g.actions, 'read-own')).map((g) => g.familyId);

    return {
      fence,
      typeIds: typeIdsOf(any),
      ...(this.subjectId !== null && {
        authored: { subjectId: this.subjectId, typeIds: typeIdsOf(own) },
      }),
      permissions: await this.readElements(),
    };
  }

  /**
   * recordPermits() stated as the elements a Record could carry to pass it:
   * `anyone`, a `read` naming the subject, and a `read` naming each live
   * `_group` the subject is rostered on, at every role it holds there.
   */
  private async readElements(): Promise<AuthorityAssociation[]> {
    const elements: AuthorityAssociation[] = [{ kind: 'anyone', label: 'read' }];
    const subject = this.subjectId;
    if (subject === null) return elements;
    elements.push({
      kind: 'permission',
      label: 'read',
      grantee: { kind: 'entity', entityId: subject },
    });

    // A roster is a live Group's relationships, so the subject's Groups are
    // the undeleted `_group` Records relating to it — carriesRoster(), asked
    // by the query. Unlisted ones included: listing state decides
    // enumeration, never what a roster confers.
    const groups = await queryAllPages((q) => this.stack.query(q), {
      filter: {
        baseId: SYSTEM_TYPES.GROUP,
        relatedTo: { target: { kind: 'entity', entityId: subject } },
        includeUnlisted: true,
      },
    });
    for (const group of groups) {
      const held = groupRoleFromAssociations(group.associations, subject);
      for (const role of ['member', 'admin'] as const) {
        if (!roleSatisfies(held, role)) continue;
        elements.push({
          kind: 'permission',
          label: 'read',
          grantee: { kind: 'group', groupId: group.id, role },
        });
      }
    }
    return elements;
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

    const grants = await this.loadGrants();
    for (const family of families) {
      if (!(await this.principalHolds(`${family}@1`, ['update-any'], grants))) return false;
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
