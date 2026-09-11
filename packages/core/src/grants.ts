/**
 * Grant vocabulary and coverage
 * -------------------------------------------------------
 * What a `_grant` Record says, and who it says it about. The coverage
 * question — does this grant reach this grantee — is answered here rather
 * than at each call site so that the access checks and listGrants() cannot
 * drift apart about it.
 *
 * See docs/spec/access-control.md § Type-level grants.
 */

import { baseIdOf } from './schema.js';
import { StackQueryError } from './errors.js';
import { SYSTEM_TYPES, GRANT_ACTIONS } from './types.js';
import { groupRoleFromAssociations } from './access.js';
import type { GroupRole } from './access.js';
import type {
  EntityId,
  GrantAction,
  GrantContent,
  QueryResult,
  RecordId,
  StackQuery,
  StackRecord,
} from './types.js';
import { queryAllPages } from './stack-reads.js';

/**
 * Valid GrantAction values, for runtime validation in Stack.grant().
 * Built from GRANT_ACTIONS (types.ts), the source of truth GrantAction is
 * itself derived from — so this can't drift from the type.
 */
export const GRANT_ACTION_SET: ReadonlySet<GrantAction> = new Set(GRANT_ACTIONS);

/**
 * The read actions that make a mutate action coherent, scope for scope: a
 * `-any` verb needs read over the same reach it can mutate, a `-own` verb
 * needs read over its author's own. A grant carrying neither conveys the
 * verb to nobody. `create` has no companion — writing a Record you then
 * cannot read is the drop-box, and it discloses nothing.
 * See docs/spec/access-control.md § Write implies read.
 */
export const READ_COMPANIONS: ReadonlyMap<GrantAction, readonly GrantAction[]> = new Map([
  ['update-own', ['read-own', 'read-any']],
  ['delete-own', ['read-own', 'read-any']],
  ['update-any', ['read-any']],
  ['delete-any', ['read-any']],
]);

/**
 * Whether one grant's action list conveys `action`. The companion has to
 * sit in the same `_grant` Record, not merely somewhere in the grantee's
 * set: a grant is revoked whole, so a rule satisfied across two records
 * would let revoking the read one leave a mutate-without-read grant
 * standing — the configuration this rule exists to refuse, arrived at
 * without anyone writing it.
 */
export function grantConveys(actions: readonly string[], action: GrantAction): boolean {
  if (!actions.includes(action)) return false;
  const companions = READ_COMPANIONS.get(action);
  return !companions || companions.some((c) => actions.includes(c));
}

/**
 * Who a grant() / revoke() / listGrants() call targets: a specific entity
 * (DID), a `_group` Record's roster (by ID), or `null` for the default
 * grant / default-only listing. See docs/spec/access-control.md § Type-level
 * grants.
 */
export type GrantTarget = EntityId | { groupId: RecordId } | null;

/** Direct (non-roster) match between a stored _grant's content and a GrantTarget. */
export function matchesGrantTarget(content: GrantContent, target: GrantTarget): boolean {
  if (target !== null && typeof target === 'object') {
    // Guarded so an absent groupId can't match the absent granteeGroupId on
    // every entity-targeted and default grant — `undefined === undefined`
    // would otherwise sweep them all into a revoke aimed at one group.
    if (!target.groupId) return false;
    return content.granteeGroupId === target.groupId;
  }
  if (target === null) {
    return !content.granteeEntityId && !content.granteeGroupId;
  }
  return content.granteeEntityId === target;
}

/**
 * Reject a grant target that names nobody. An empty groupId or entityId is
 * falsy, so a stored record carrying one reads as a *default* grant — every
 * authenticated entity — instead of the target the caller meant. `null` is
 * the only way to say "default".
 */
export function validateGrantTarget(target: GrantTarget): void {
  if (target === null) return;
  if (typeof target === 'string') {
    if (target.length === 0) {
      throw new StackQueryError(
        'A grant target entityId cannot be empty. Pass null for a default grant.',
      );
    }
    return;
  }
  if (typeof target.groupId !== 'string' || target.groupId.length === 0) {
    throw new StackQueryError('A group grant target requires a non-empty groupId.');
  }
  // Not a format check: granteeGroupId is a reference to an existing
  // Record, like parentId or an association's recordId, and none of those
  // are parsed either. One that resolves to nothing simply denies.
}

/**
 * Whether a stored _grant covers `grantee`: a direct DID match, roster
 * membership when `allowGroup`, or a default when `allowDefault`. Presence
 * decides the tier, never truthiness — an empty grantee field names nobody.
 * Module-level so the access checks and listGrants() cannot drift apart.
 * See docs/spec/access-control.md § Type-level grants.
 */
export async function grantCoversGrantee(
  c: GrantContent,
  grantee: EntityId,
  opts: {
    allowDefault: boolean;
    allowGroup: boolean;
    groupRoles: Map<string, GroupRole | null>;
    resolveRecord: (id: RecordId) => Promise<StackRecord | null>;
  },
): Promise<boolean> {
  const namesEntity = c.granteeEntityId !== undefined;
  const namesGroup = c.granteeGroupId !== undefined;
  if (!namesEntity && !namesGroup) return opts.allowDefault;
  if (namesEntity && c.granteeEntityId !== grantee) return false;
  if (namesGroup) {
    if (!opts.allowGroup) return false;
    if (!c.granteeGroupId) return false;
    const role = await resolveGroupRoleMemoized(
      c.granteeGroupId,
      grantee,
      opts.groupRoles,
      opts.resolveRecord,
    );
    if (role === null) return false;
  }
  return true;
}

/**
 * An entity's role on a `_group` roster, memoized in the caller's
 * `groupRoles` map. That map is built per operation and threaded alongside
 * `prefetchedGrants`, so no resolved role outlives the operation that
 * resolved it — removal from a group must never go stale.
 * See docs/spec/access-control.md § Type-level grants.
 */
async function resolveGroupRoleMemoized(
  groupId: RecordId,
  entityId: EntityId,
  groupRoles: Map<string, GroupRole | null>,
  resolveRecord: (id: RecordId) => Promise<StackRecord | null>,
): Promise<GroupRole | null> {
  const key = `${groupId}:${entityId}`;
  const cached = groupRoles.get(key);
  if (cached !== undefined) return cached;
  const group = await resolveRecord(groupId);
  // Only a real `_group` Record carries a roster. Without the family check
  // any Record's relationship associations would serve as one, and a group
  // migrated out of the family would keep resolving after it had stopped
  // being a group.
  const role =
    group && baseIdOf(group.typeId) === SYSTEM_TYPES.GROUP
      ? groupRoleFromAssociations(group.associations, entityId)
      : null;
  groupRoles.set(key, role);
  return role;
}

/**
 * System type families grant() refuses to target: a grant on any of them
 * would let the grantee mint their own grants, touch stack config, or
 * register an app card claiming a DID that isn't theirs — the last of
 * which is what verified app attribution rests on. See
 * docs/spec/access-control.md § Type-level grants.
 */
export const UNGRANTABLE_SYSTEM_TYPES: ReadonlySet<string> = new Set([
  SYSTEM_TYPES.GRANT,
  SYSTEM_TYPES.CONFIG,
  SYSTEM_TYPES.APP,
]);

/**
 * Every `_grant` Record, cursor-walked. Read through an unscoped query at
 * every call site: a grant is what decides who may read, so it can never
 * itself sit behind a read check. No content prefilter — a stored grant's
 * typeId may be a bare baseId or versioned, so exact matching would wrongly
 * exclude family versions.
 */
export function loadGrantRecords(
  query: (q: StackQuery) => Promise<QueryResult>,
): Promise<StackRecord[]> {
  return queryAllPages(query, { filter: { typeId: `${SYSTEM_TYPES.GRANT}@1` } });
}
