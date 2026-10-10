/**
 * Type-level grants
 * -------------------------------------------------------
 * The bodies of Stack.grantType(), listTypeGrants() and revokeType(), whose
 * doc comments describe the contract. Written against Stack's public API
 * alone. See docs/spec/access-control.md § Type-level grants.
 */

import {
  checkGrantValid,
  grantCoversGrantee,
  grantReach,
  loadGrantRecords,
  matchesGrantTarget,
  validateGrantTarget,
} from '../grants.js';
import { assertFamilyId } from '../query-validation.js';
import { SYSTEM_TYPES } from '../types/index.js';
import type { GrantQuery } from '../grants.js';
import type { BaseId, GrantContent, GroupRole, StackRecord, TypeGrant } from '../types/index.js';
import type { Stack } from './stack.js';

export async function grantType(
  stack: Stack,
  baseId: BaseId,
  grant: TypeGrant,
): Promise<StackRecord & { content: GrantContent }> {
  validateGrantTarget(grant.grantee);
  checkGrantValid(baseId, grant.actions);
  return stack.create<GrantContent>(`${SYSTEM_TYPES.GRANT}@1`, {
    baseId,
    actions: grant.actions,
    grantee: grant.grantee,
  });
}

export async function listTypeGrants(
  stack: Stack,
  query?: GrantQuery,
): Promise<(StackRecord & { content: GrantContent })[]> {
  if (query !== undefined) validateGrantTarget(query, true);
  const all = await loadGrantRecords((q) => stack.query(q));
  if (query === undefined) return all;
  if (query.kind !== 'entity') {
    return all.filter((r) => matchesGrantTarget(r.content, query));
  }

  // An entity query resolves group rosters, since a grant naming a group
  // the entity belongs to also currently applies to them. Shares
  // grantCoversGrantee() with the access checks, so a listing can't
  // disagree with them about who a grant covers.
  const groupRoles = new Map<string, GroupRole | null>();
  const result: (StackRecord & { content: GrantContent })[] = [];
  for (const r of all) {
    const covers = await grantCoversGrantee(r.content, query.entityId, {
      allowDefault: true,
      allowGroup: true,
      groupRoles,
      resolveRecord: (id) => stack.get(id, { includeDeleted: true }),
    });
    if (covers) result.push(r);
  }
  return result;
}

export async function revokeType(
  stack: Stack,
  baseId: BaseId,
  grant: TypeGrant,
): Promise<(StackRecord & { content: GrantContent })[]> {
  validateGrantTarget(grant.grantee);
  assertFamilyId(baseId, 'revokeType');
  const familyId = baseId;
  const actionSet = new Set(grant.actions);
  const all = await loadGrantRecords((q) => stack.query(q));
  const matches = all.filter((r) => {
    const c = r.content;
    // Establishes the family and that `actions` is a list, so the exact
    // match below reads a real one. Matched against the stored list
    // rather than the reach, so a grant carrying an action this
    // vocabulary drops is not withdrawn by a target that omits it.
    const reach = grantReach(c);
    if (!reach || reach.familyId !== familyId) return false;
    if (!matchesGrantTarget(c, grant.grantee)) return false;
    return c.actions.length === actionSet.size && c.actions.every((a) => actionSet.has(a));
  });
  for (const match of matches) await stack.delete(match.id);
  return matches;
}
