/**
 * Stack — Permission Resolution
 * -------------------------------------------------------
 * The record-level permission rules, with no dependency on a transport
 * layer or storage backend: how a grantee reaches an entity, the
 * write-implies-read invariant, and the `_group` roster rules both layers
 * resolve against, plus the owner-acting-alone tier. What a requester may
 * do is a reach per verb, which scoped-stack/authority.ts builds from these.
 *
 * A permission set is read as data throughout, never as the type: it can
 * arrive from an import or a foreign server, where no compiler has seen
 * it. Every tier is affirmative, so an element read past its own kind —
 * or carrying no kind at all — confers nothing.
 */

import { SYSTEM_TYPES } from './types/index.js';
import type {
  Association,
  AuthorityAssociation,
  DataAssociation,
  EntityId,
  EntityTarget,
  GroupRole,
  Grantee,
  RecordId,
  RelationshipAssociation,
  StackRecord,
} from './types/index.js';
import { associationKey } from './associations/identity.js';
import { baseIdOf } from './schema.js';
import type { ValidationError } from './validate.js';

/** Resolves a Record by ID, for walks that need no full adapter. */
export type RecordResolver = (id: RecordId) => Promise<StackRecord | null>;

/**
 * The roles one entity holds on live `_group` rosters, keyed by group id,
 * loaded on first use and at most once per operation, so no resolved role
 * outlives the operation that read it — removal from a group must never go
 * stale. See loadRosterRoles().
 */
export type RosterRoles = () => Promise<ReadonlyMap<RecordId, GroupRole>>;

/**
 * The elements beside which a `write` naming `grantee` carries its bit: its
 * own `read`, or an `anyone`, which reaches the grantee already. The one
 * statement of write-implies-read — validation and every reach ask it.
 * See docs/spec/access-control.md § Write implies read.
 */
export function readCompanions(grantee: Grantee): AuthorityAssociation[] {
  return [
    { kind: 'permission', label: 'read', grantee },
    { kind: 'anyone', label: 'read' },
  ];
}

/**
 * Whether a grantee reaches `entityId`, for both layers alike. Read as data,
 * so an arm the write would refuse confers nothing; `member` is the wider
 * role. See docs/spec/access-control.md § Refused at the write, and again at evaluation.
 */
export async function granteeReaches(
  grantee: unknown,
  entityId: EntityId,
  opts: { roles: RosterRoles; allowGroup?: boolean },
): Promise<boolean> {
  if (!grantee || typeof grantee !== 'object') return false;
  const g = grantee as Partial<{ kind: string; entityId: string; groupId: string; role: string }>;
  switch (g.kind) {
    case 'entity':
      return !!g.entityId && g.entityId === entityId;
    case 'group': {
      if (opts.allowGroup === false || !g.groupId) return false;
      if (g.role !== 'member' && g.role !== 'admin') return false;
      const held = (await opts.roles()).get(g.groupId) ?? null;
      return roleSatisfies(held, g.role);
    }
    default:
      return false;
  }
}

/**
 * Rejects a permission set where some `write` stands without a
 * readCompanions() element, which no reach would honor. A cross-element
 * invariant, so it is asked of the set the write would *produce*, the same
 * way hasGroupAdmin() reads its post-state below.
 * See docs/spec/access-control.md § Write implies read.
 */
export function validatePermissions(
  permissions: AuthorityAssociation[] | undefined,
  path = 'permissions',
): ValidationError[] {
  const list = permissions ?? [];
  const held = new Set(list.map(associationKey));
  const errors: ValidationError[] = [];
  list.forEach((p, i) => {
    if (p?.kind !== 'permission' || p.label !== 'write') return;
    if (readCompanions(p.grantee).some((c) => held.has(associationKey(c)))) return;
    errors.push({
      path: `${path}[${i}]`,
      message:
        'write requires read: a write-holder reaches the record and its history through the mutate surface, so a `write` element with no `read` for the same grantee withholds nothing. Grant `read` and `write` together in one editAccess() or setAccess() call',
    });
  });
  return errors;
}

/** Whether a held role meets a grantee's: an admin is also a member. */
export function roleSatisfies(held: GroupRole | null, required: GroupRole): boolean {
  return required === 'admin' ? held === 'admin' : held !== null;
}

/**
 * Whether a Record is a `_group`, in any of its type versions — the family
 * whose roster rules apply.
 */
export function isGroupRecord(record: StackRecord): boolean {
  return baseIdOf(record.typeId) === SYSTEM_TYPES.GROUP;
}

/**
 * An entity's role on a `_group` roster; a matching `admin` wins regardless
 * of order. Reads associations alone and cannot tell whose they are, so
 * callers ask it of a live `_group` only — see loadRosterRoles().
 */
export function groupRoleFromAssociations(
  associations: DataAssociation[] | undefined,
  entityId: EntityId,
): GroupRole | null {
  let role: GroupRole | null = null;
  for (const a of associations ?? []) {
    if (a.kind === 'relationship' && a.target.kind === 'entity' && a.target.entityId === entityId) {
      if (a.label === 'admin') return 'admin';
      if (a.label === 'member') role = 'member';
    }
  }
  return role;
}

/**
 * Whether a roster carries at least one `admin` — the invariant every
 * `_group` write must leave standing. Asked of the roster the write would
 * *produce*, which lets an admin leave while another remains and refuses
 * the last. Reads associations alone, like groupRoleFromAssociations().
 */
export function hasGroupAdmin(associations: DataAssociation[] | undefined): boolean {
  return (associations ?? []).some(isGroupAdminAssociation);
}

/**
 * Whether one association is an `admin` roster entry. The `entity` target is
 * what makes it one — a `record` target carrying the same label confers
 * nothing, so it must not count toward the invariant either.
 * See docs/spec/data-model.md § Relationship targets.
 */
function isGroupAdminAssociation(
  association: Association,
): association is RelationshipAssociation & { target: EntityTarget } {
  return (
    association.kind === 'relationship' &&
    association.label === 'admin' &&
    association.target.kind === 'entity'
  );
}

/** Bootstraps a `_group` record's first admin at create time. */
export function stampGroupAdmin(
  associations: DataAssociation[] | undefined,
  creator: EntityId,
): DataAssociation[] {
  const list = associations ?? [];
  const alreadyAdmin = list.some(
    (a) => isGroupAdminAssociation(a) && a.target.entityId === creator,
  );
  if (alreadyAdmin) return list;
  return [
    ...list,
    { kind: 'relationship', label: 'admin', target: { kind: 'entity', entityId: creator } },
  ];
}

/**
 * Whether a request is the stack owner acting alone — the tier behind every
 * unconditional owner authority. Being the owner is never sufficient on its
 * own, whichever side of a delegation the owner is on.
 * See docs/spec/access-control.md § Delegation: principal and subject.
 */
export function isOwnerActingAlone(
  actor: { subjectId: EntityId | null; principalId?: EntityId | null },
  ownerEntityId: EntityId,
): boolean {
  const principalId = actor.principalId === undefined ? actor.subjectId : actor.principalId;
  return principalId === ownerEntityId && actor.subjectId === ownerEntityId;
}
