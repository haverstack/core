/**
 * Stack — Permission Resolution
 * -------------------------------------------------------
 * Implements the Permissions model from the spec: a pure predicate over a
 * Record's `permissions` field, with no dependency on a transport layer or
 * storage backend. Used by ScopedStack (see stack.ts) to enforce access
 * control; exported standalone for callers that want the raw predicate.
 */

import type { Association, EntityId, RecordId, StackRecord } from './types.js';

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
      if (mode === 'read' && p.read) return true;
      if (mode === 'write' && p.write) return true;
    }

    if (p.access === 'group' && subjectEntityId) {
      const role = await resolveGroupRole(p.groupId, subjectEntityId, resolveRecord);
      const satisfiesRole = p.role === 'admin' ? role === 'admin' : role !== null;
      if (satisfiesRole) {
        if (mode === 'read' && p.read) return true;
        if (mode === 'write' && p.write) return true;
      }
    }
  }

  return false;
}

async function resolveGroupRole(
  groupRecordId: RecordId,
  entityId: EntityId,
  resolveRecord: RecordResolver,
): Promise<GroupRole | null> {
  const group = await resolveRecord(groupRecordId);
  if (!group) return null;
  return groupRoleFromAssociations(group.associations, entityId);
}

/**
 * Determine an entity's role within a `_group` Record's roster from its
 * relationship associations. `admin` short-circuits — it's strictly more
 * privileged than `member`, so a matching admin association wins regardless
 * of association order.
 */
export function groupRoleFromAssociations(
  associations: Association[] | undefined,
  entityId: EntityId,
): GroupRole | null {
  let role: GroupRole | null = null;
  for (const a of associations ?? []) {
    if (a.kind === 'relationship' && a.recordId === entityId) {
      if (a.label === 'admin') return 'admin';
      if (a.label === 'member') role = 'member';
    }
  }
  return role;
}
