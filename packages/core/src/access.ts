/**
 * Stack — Permission Resolution
 * -------------------------------------------------------
 * Implements the Permissions model from the spec: a pure predicate over a
 * Record's `permissions` field, with no dependency on a transport layer or
 * storage backend. Used by ScopedStack (see stack.ts) to enforce access
 * control; exported standalone for callers that want the raw predicate.
 */

import { SYSTEM_TYPES } from './types.js';
import type {
  Association,
  AuthorityAssociation,
  DataAssociation,
  EntityId,
  PermissionGrantee,
  RecordId,
  StackRecord,
} from './types.js';
import { granteeEqual } from './record-changes.js';
import { baseIdOf } from './schema.js';
import type { ValidationError } from './validate.js';

export type AccessMode = 'read' | 'write';

/** An entity's standing within a `_group` Record's roster. `admin` implies `member` for ACL purposes. */
export type GroupRole = 'member' | 'admin';

/**
 * Resolves a Record by ID. Used to walk a `_group` Record's associations for
 * membership checks without requiring a full StackAdapter.
 */
export type RecordResolver = (id: RecordId) => Promise<StackRecord | null>;

/**
 * Check whether an entity has read or write access to a Record: absent
 * permissions = owner only; an `anyone` element = anyone reads; an
 * `entity` grantee = direct match; a `group` grantee = walk the _group
 * Record's roster associations. See
 * docs/spec/access-control.md § Record-level permissions.
 *
 * The entity here is the **subject** — record-level permissions are written
 * about who data is for, never about the software that carried the request.
 * A delegated app's own authority is a separate question, asked of the
 * principal. See docs/spec/access-control.md § Delegation: principal and
 * subject.
 */
export async function checkAccess(
  record: StackRecord,
  subjectEntityId: EntityId | null,
  ownerEntityId: EntityId | null,
  mode: AccessMode,
  resolveRecord: RecordResolver,
): Promise<boolean> {
  // Owner always has full access.
  if (subjectEntityId && subjectEntityId === ownerEntityId) return true;

  const perms = record.permissions;

  // No permissions = private.
  if (!perms || perms.length === 0) return false;

  for (const p of perms) {
    if (p.kind === 'anyone') {
      if (mode === 'read') return true;
      continue;
    }
    if (p.label !== mode) continue;
    // The write bit is inert without read alongside it: the mutate surface
    // hands back the record it wrote and opens its whole history, so a
    // write element standing alone would disclose exactly what withholding
    // read asks to withhold. Refused at the write by validatePermissions()
    // and again here, since a permission element can also arrive from an
    // import or a foreign server.
    // See docs/spec/access-control.md § Write implies read.
    if (mode === 'write' && !holdsRead(perms, p.grantee)) continue;
    if (await granteeCovers(p.grantee, subjectEntityId, resolveRecord)) return true;
  }

  return false;
}

/** Whether the set carries a `read` for this exact grantee. */
function holdsRead(permissions: AuthorityAssociation[], grantee: PermissionGrantee): boolean {
  return permissions.some(
    (p) => p.kind === 'permission' && p.label === 'read' && granteeEqual(p.grantee, grantee),
  );
}

/**
 * Whether a grantee reaches this subject. `role: 'member'` is the wider
 * set — an admin satisfies it — and `role: 'admin'` the narrower.
 * See docs/spec/access-control.md § Record-level permissions.
 */
async function granteeCovers(
  grantee: PermissionGrantee,
  subjectEntityId: EntityId | null,
  resolveRecord: RecordResolver,
): Promise<boolean> {
  if (!subjectEntityId) return false;
  if (grantee.scope === 'entity') return grantee.entityId === subjectEntityId;
  const role = await resolveGroupRole(grantee.groupId, subjectEntityId, resolveRecord);
  return grantee.role === 'admin' ? role === 'admin' : role !== null;
}

/**
 * Rejects a permission set where some grantee holds `write` with no `read`
 * beside it — the shape checkAccess() refuses to honor. A cross-element
 * invariant, so it is asked of the set the write would *produce*, the same
 * way the `_group` at-least-one-admin check reads its post-state: an
 * element-wise check could not see the `read` that makes a `write` mean
 * something, nor a removal that takes it away.
 * See docs/spec/access-control.md § Write implies read.
 */
export function validatePermissions(
  permissions: AuthorityAssociation[] | undefined,
  path = 'permissions',
): ValidationError[] {
  const list = permissions ?? [];
  const errors: ValidationError[] = [];
  list.forEach((p, i) => {
    if (p.kind !== 'permission' || p.label !== 'write') return;
    if (holdsRead(list, p.grantee)) return;
    errors.push({
      path: `${path}[${i}]`,
      message:
        'write requires read: a write-holder reaches the record and its history through the mutate surface, so a `write` element with no `read` for the same grantee withholds nothing',
    });
  });
  return errors;
}

/**
 * Resolve a role from the `_group` Record a permission's `groupId` names.
 * Only a real `_group` Record carries a roster: without the family check
 * any Record's relationship associations would serve as one, so an app
 * modelling its own `member` links would silently turn every record it
 * points a permission at into an ACL. The same rule the grant path applies
 * (see resolveGroupRoleMemoized in stack.ts). See
 * docs/spec/access-control.md § Record-level permissions.
 */
async function resolveGroupRole(
  groupRecordId: RecordId,
  entityId: EntityId,
  resolveRecord: RecordResolver,
): Promise<GroupRole | null> {
  const group = await resolveRecord(groupRecordId);
  if (!group || baseIdOf(group.typeId) !== SYSTEM_TYPES.GROUP) return null;
  return groupRoleFromAssociations(group.associations, entityId);
}

/**
 * Determine an entity's role within a `_group` Record's roster from its
 * relationship associations. `admin` short-circuits — it's strictly more
 * privileged than `member`, so a matching admin association wins regardless
 * of association order.
 *
 * Reads associations alone and cannot tell whose they are: every caller
 * must first establish that the Record is in the `_group` family, or an
 * app's own `member` relationships become a roster.
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
 *
 * Reads associations alone, on the same terms as
 * groupRoleFromAssociations() above: the caller must have established that
 * the Record is in the `_group` family first. See docs/spec/identity.md
 * § Group.
 */
export function hasGroupAdmin(associations: DataAssociation[] | undefined): boolean {
  return (associations ?? []).some(isGroupAdminAssociation);
}

/**
 * Whether one association is an `admin` roster entry. The `entity` scope is
 * what makes a roster entry a roster entry — a `record` target carrying the
 * same label confers nothing, so it must not count toward the invariant
 * either. See docs/spec/data-model.md § Relationship targets.
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
 * own, whichever side of a delegation the owner is on. Both identities are
 * asked about by value rather than compared to each other, so a caller
 * holding a session and `ScopedStack`, which holds the pair separately, get
 * one answer. See docs/spec/access-control.md § Delegation: principal and
 * subject.
 */
export function isOwnerActingAlone(
  session: { principalId: EntityId | null; subjectId: EntityId | null },
  ownerEntityId: EntityId,
): boolean {
  return session.principalId === ownerEntityId && session.subjectId === ownerEntityId;
}
