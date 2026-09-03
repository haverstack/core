/**
 * Stack — Permission Resolution
 * -------------------------------------------------------
 * Implements the Permissions model from the spec: a pure predicate over a
 * Record's `permissions` field, with no dependency on a transport layer or
 * storage backend. Used by ScopedStack (see stack.ts) to enforce access
 * control; exported standalone for callers that want the raw predicate.
 */

import { SYSTEM_TYPES } from './types.js';
import type { Association, EntityId, Permission, RecordId, StackRecord } from './types.js';
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
 * permissions = owner only; public = anyone reads; entity = direct match;
 * group = walk the _group Record's roster associations. See
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
    if (p.access === 'public' && mode === 'read') return true;

    if (p.access === 'entity' && p.entityId === subjectEntityId) {
      if (entryConveys(p, mode)) return true;
    }

    if (p.access === 'group' && subjectEntityId) {
      const role = await resolveGroupRole(p.groupId, subjectEntityId, resolveRecord);
      const satisfiesRole = p.role === 'admin' ? role === 'admin' : role !== null;
      if (satisfiesRole && entryConveys(p, mode)) return true;
    }
  }

  return false;
}

/**
 * Whether an entry the requester already matches conveys `mode`. The write
 * bit is inert without read alongside it: the mutate surface hands back the
 * record it wrote and opens its whole history, so a write bit without read
 * would disclose exactly what withholding read asks to withhold. Refused at
 * the write by validatePermissions() and again here, since a `permissions`
 * array can also arrive from an import or a foreign server. See
 * docs/spec/access-control.md § Write implies read.
 */
function entryConveys(p: { read: boolean; write: boolean }, mode: AccessMode): boolean {
  return mode === 'read' ? p.read : p.write && p.read;
}

/**
 * Rejects permission entries that convey write without read — the shape
 * entryConveys() refuses to honor, caught at the point of storage so an
 * owner writing one is told rather than left with a bit that does nothing.
 * See docs/spec/access-control.md § Write implies read.
 */
export function validatePermissions(
  permissions: Permission[] | undefined,
  path = 'permissions',
): ValidationError[] {
  const errors: ValidationError[] = [];
  (permissions ?? []).forEach((p, i) => {
    if (p.access === 'public') return;
    if (p.write && !p.read) {
      errors.push({
        path: `${path}[${i}]`,
        message:
          'write requires read: a write-holder reaches the record and its history through the mutate surface, so `write: true, read: false` withholds nothing',
      });
    }
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
  associations: Association[] | undefined,
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
