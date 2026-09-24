/**
 * Stack — Permission Resolution
 * -------------------------------------------------------
 * Implements the Permissions model from the spec: a pure predicate over a
 * Record's `permissions` field, with no dependency on a transport layer or
 * storage backend. Used by ScopedStack (see scoped-stack.ts) to enforce
 * access control; exported standalone for callers that want the raw
 * predicate.
 *
 * A permission set is read as data throughout, never as the type: it can
 * arrive from an import or a foreign server, where no compiler has seen
 * it. Every tier is affirmative, so an element read past its own kind —
 * or carrying no kind at all — confers nothing.
 */

import { SYSTEM_TYPES } from './types.js';
import type {
  Association,
  AuthorityAssociation,
  DataAssociation,
  EntityId,
  GroupRole,
  PermissionGrantee,
  RecordId,
  StackRecord,
} from './types.js';
import { granteeEqual } from './record-changes.js';
import { baseIdOf } from './schema.js';
import type { ValidationError } from './validate.js';

export type AccessMode = 'read' | 'write';

/**
 * Resolves a Record by ID. Used to walk a `_group` Record's associations for
 * membership checks without requiring a full StackAdapter.
 */
export type RecordResolver = (id: RecordId) => Promise<StackRecord | null>;

/**
 * Whether an entity has read or write access to a Record.
 *
 * The entity here is the **subject** — record-level permissions are written
 * about who data is for, never about the software that carried the request.
 * A delegated app's own authority is a separate question, asked of the
 * principal. See docs/spec/access-control.md § Record-level permissions and
 * § Delegation: principal and subject.
 */
export async function checkAccess(
  record: StackRecord,
  subjectEntityId: EntityId | null,
  ownerEntityId: EntityId | null,
  mode: AccessMode,
  resolveRecord: RecordResolver,
): Promise<boolean> {
  if (subjectEntityId && subjectEntityId === ownerEntityId) return true;

  const perms = record.permissions;

  // No permissions = private.
  if (!perms || perms.length === 0) return false;

  for (const p of perms) {
    if (p?.kind === 'anyone') {
      if (mode === 'read' && isWorldRead(p)) return true;
      continue;
    }
    if (p?.kind !== 'permission' || !p.grantee) continue;
    if (p.label !== mode) continue;
    // The write bit is inert without read alongside it: the mutate surface
    // hands back the record it wrote and opens its whole history, so a
    // write element standing alone would withhold nothing. Refused at the
    // write by validatePermissions() and again here.
    // See docs/spec/access-control.md § Write implies read.
    if (mode === 'write' && !holdsRead(perms, p.grantee)) continue;
    if (await granteeCovers(p.grantee, subjectEntityId, resolveRecord)) return true;
  }

  return false;
}

/**
 * Whether the set conveys read to this grantee — a `read` of its own, or
 * an `anyone` that already reaches everyone. Demanding a second, redundant
 * `read` beside the write would refuse a set that withholds nothing;
 * revoking the `anyone` is what the invariant catches instead.
 * See docs/spec/access-control.md § Write implies read.
 */
function holdsRead(permissions: AuthorityAssociation[], grantee: PermissionGrantee): boolean {
  return permissions.some((p) =>
    p?.kind === 'anyone'
      ? isWorldRead(p)
      : p?.kind === 'permission' && p.label === 'read' && granteeEqual(p.grantee, grantee),
  );
}

/**
 * Whether an `anyone` element reaches the world. `read` is the only bit it
 * can carry, so one labelled otherwise names no reach — refused at the
 * write by validateAssociation() and read as nothing here.
 */
function isWorldRead(association: AuthorityAssociation): boolean {
  return association.label === 'read';
}

/**
 * Whether a grantee reaches this subject. `role: 'member'` is the wider
 * set — an admin satisfies it — and `role: 'admin'` the narrower.
 */
async function granteeCovers(
  grantee: PermissionGrantee,
  subjectEntityId: EntityId | null,
  resolveRecord: RecordResolver,
): Promise<boolean> {
  if (!subjectEntityId) return false;
  if (grantee.kind === 'entity') return grantee.entityId === subjectEntityId;
  const role = await resolveGroupRole(grantee.groupId, subjectEntityId, resolveRecord);
  return grantee.role === 'admin' ? role === 'admin' : role !== null;
}

/**
 * Rejects a permission set where some grantee holds `write` with no `read`
 * beside it — the shape checkAccess() refuses to honor. A cross-element
 * invariant, so it is asked of the set the write would *produce*, the same
 * way hasGroupAdmin() reads its post-state below.
 * See docs/spec/access-control.md § Write implies read.
 */
export function validatePermissions(
  permissions: AuthorityAssociation[] | undefined,
  path = 'permissions',
): ValidationError[] {
  const list = permissions ?? [];
  const errors: ValidationError[] = [];
  list.forEach((p, i) => {
    if (p?.kind !== 'permission' || p.label !== 'write') return;
    if (holdsRead(list, p.grantee)) return;
    errors.push({
      path: `${path}[${i}]`,
      message:
        'write requires read: a write-holder reaches the record and its history through the mutate surface, so a `write` element with no `read` for the same grantee withholds nothing',
    });
  });
  return errors;
}

/** Resolve a role from the `_group` Record a permission's `groupId` names. */
async function resolveGroupRole(
  groupRecordId: RecordId,
  entityId: EntityId,
  resolveRecord: RecordResolver,
): Promise<GroupRole | null> {
  const group = await resolveRecord(groupRecordId);
  if (!group || !carriesRoster(group)) return null;
  return groupRoleFromAssociations(group.associations, entityId);
}

/**
 * Whether a Record is a roster anything may resolve against, on two counts.
 * The family check: without it an app modelling its own `member` links
 * would turn every record it points a permission at into an ACL. The
 * tombstone check: deleting a Group is how a Group is withdrawn. Shared
 * with the grant path, so the two layers cannot disagree about which Groups
 * still reach anyone. See docs/spec/identity.md § Group.
 */
export function carriesRoster(record: StackRecord): boolean {
  return baseIdOf(record.typeId) === SYSTEM_TYPES.GROUP && !record.deletedAt;
}

/**
 * An entity's role within a `_group` Record's roster. `admin`
 * short-circuits, so a matching admin association wins regardless of order.
 *
 * Reads associations alone and cannot tell whose they are: callers pass
 * carriesRoster() first, or an app's own `member` relationships become a
 * roster.
 */
export function groupRoleFromAssociations(
  associations: DataAssociation[] | undefined,
  entityId: EntityId,
): GroupRole | null {
  let role: GroupRole | null = null;
  for (const a of associations ?? []) {
    if (
      a.kind === 'relationship' &&
      a.target.scope === 'entity' &&
      a.target.entityId === entityId
    ) {
      if (a.label === 'admin') return 'admin';
      if (a.label === 'member') role = 'member';
    }
  }
  return role;
}

/**
 * Whether a roster carries at least one `admin` — the invariant every write
 * to a `_group` Record must leave standing. Asked of the roster a write
 * would *produce*, never the one it started from: that is what lets an
 * admin remove themselves while another remains, and refuses the same
 * removal when they are the last, without either case naming who is going.
 * Reads associations alone, on the same terms as
 * groupRoleFromAssociations() above.
 */
export function hasGroupAdmin(associations: DataAssociation[] | undefined): boolean {
  return (associations ?? []).some(isGroupAdminAssociation);
}

/**
 * Whether one association is an `admin` roster entry. The `entity` scope is
 * what makes it one — a `record` target carrying the same label confers
 * nothing, so it must not count toward the invariant either.
 * See docs/spec/data-model.md § Relationship targets.
 */
export function isGroupAdminAssociation(association: Association): boolean {
  return (
    association.kind === 'relationship' &&
    association.label === 'admin' &&
    association.target.scope === 'entity'
  );
}

/**
 * Whether a request is the stack owner acting alone — the tier behind every
 * unconditional owner authority. Being the owner is never sufficient on its
 * own, whichever side of a delegation the owner is on.
 * See docs/spec/access-control.md § Delegation: principal and subject.
 */
export function isOwnerActingAlone(
  session: { principalId: EntityId | null; subjectId: EntityId | null },
  ownerEntityId: EntityId,
): boolean {
  return session.principalId === ownerEntityId && session.subjectId === ownerEntityId;
}
