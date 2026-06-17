/**
 * Stack — Permission Resolution
 * -------------------------------------------------------
 * Implements the Permissions model from the spec: a pure predicate over a
 * Record's `permissions` field, with no dependency on a transport layer or
 * storage backend. Used by ScopedStack (see stack.ts) to enforce access
 * control; exported standalone for callers that want the raw predicate.
 */

import type { RecordId, StackRecord } from './types.js';

export type AccessMode = 'read' | 'write';

/**
 * Resolves a Record by ID. Used to walk a `_group` Record's associations for
 * membership checks without requiring a full StackAdapter.
 */
export type RecordResolver = (id: RecordId) => Promise<StackRecord | null>;

/**
 * Check whether an entity has read or write access to a Record.
 *
 * - No permissions (absent/empty): owner only.
 * - public: anyone can read; write still requires an explicit grant.
 * - entity: direct entityId match.
 * - group: walk the _group Record's relationship associations for membership.
 */
export async function checkAccess(
  record: StackRecord,
  requesterEntityId: string | null,
  ownerEntityId: string | null,
  mode: AccessMode,
  resolveRecord: RecordResolver,
): Promise<boolean> {
  // Owner always has full access.
  if (requesterEntityId && requesterEntityId === ownerEntityId) return true;

  const perms = record.permissions;

  // No permissions = private.
  if (!perms || perms.length === 0) return false;

  for (const p of perms) {
    if (p.access === 'public' && mode === 'read') return true;

    if (p.access === 'entity' && p.entityId === requesterEntityId) {
      if (mode === 'read' && p.read) return true;
      if (mode === 'write' && p.write) return true;
    }

    if (p.access === 'group' && requesterEntityId) {
      const member = await isGroupMember(p.groupId, requesterEntityId, resolveRecord);
      if (member) {
        if (mode === 'read' && p.read) return true;
        if (mode === 'write' && p.write) return true;
      }
    }
  }

  return false;
}

async function isGroupMember(
  groupRecordId: RecordId,
  entityId: string,
  resolveRecord: RecordResolver,
): Promise<boolean> {
  const group = await resolveRecord(groupRecordId);
  if (!group) return false;
  return (group.associations ?? []).some(
    (a) =>
      a.kind === 'relationship' &&
      (a.label === 'member' || a.label === 'admin') &&
      a.recordId === entityId,
  );
}
