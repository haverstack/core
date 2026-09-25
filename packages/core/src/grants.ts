/**
 * Grant vocabulary and coverage
 * -------------------------------------------------------
 * What a `_grant` Record says, and who it says it about. The coverage
 * question — does this grant reach this grantee — is answered here rather
 * than at each call site so that the access checks and listTypeGrants() cannot
 * drift apart about it.
 *
 * See docs/spec/access-control.md § Type-level grants.
 */

import { baseIdOf } from './schema.js';
import { StackBadRequestError } from './errors.js';
import { SYSTEM_TYPES, GRANT_ACTIONS } from './types.js';
import { carriesRoster, groupRoleFromAssociations } from './access.js';
import type {
  EntityId,
  GrantAction,
  GrantContent,
  GrantGrantee,
  GroupRole,
  QueryResult,
  RecordId,
  StackQuery,
  StackRecord,
  TypeId,
} from './types.js';
import { queryAllPages } from './stack-reads.js';
import type { ValidationError } from './validate.js';

/**
 * Valid GrantAction values, for runtime validation in Stack.grantType(). Built
 * from GRANT_ACTIONS, which GrantAction itself derives from, so the set and
 * the type cannot drift.
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
 * sit in the same `_grant` Record: a grant is revoked whole, so a rule
 * satisfied across two records would let revoking the read one leave a
 * mutate-without-read grant standing.
 *
 * Takes the list grantReach() produced, never a stored field: `includes()`
 * over a string is substring matching, so one would answer for every verb
 * spelled inside it.
 */
export function grantConveys(actions: readonly GrantAction[], action: GrantAction): boolean {
  if (!actions.includes(action)) return false;
  const companions = READ_COMPANIONS.get(action);
  return !companions || companions.some((c) => actions.includes(c));
}

/**
 * What a stored `_grant` reaches, or null where it names nothing the
 * evaluator recognizes. Read as data, like the grantee beside it: a grant
 * Record can arrive from an import, a direct adapter write or a foreign
 * server, where no schema saw it, so both fields are asked for their shape
 * rather than taken from the type. An unknown action is dropped from the
 * list, on the same terms an unknown grantee `kind` confers nothing.
 * See docs/spec/access-control.md § Refused at the write, and again at evaluation.
 */
export function grantReach(content: unknown): { familyId: string; actions: GrantAction[] } | null {
  const c = content as { typeId?: unknown; actions?: unknown } | null;
  if (!c || typeof c !== 'object') return null;
  if (typeof c.typeId !== 'string' || c.typeId.length === 0) return null;
  if (!Array.isArray(c.actions)) return null;
  return {
    familyId: baseIdOf(c.typeId),
    actions: c.actions.filter((a): a is GrantAction => GRANT_ACTION_SET.has(a as GrantAction)),
  };
}

/**
 * What listTypeGrants() accepts: a GrantGrantee, widened so a group listing can
 * ask for every role at once. `role: 'any'` is not a role an entity can
 * hold and never reaches storage — a query can say it, a grantee cannot.
 */
export type GrantQuery =
  | Exclude<GrantGrantee, { kind: 'group' }>
  | { kind: 'group'; groupId: RecordId; role: GroupRole | 'any' };

/**
 * Direct (non-roster) match between a stored _grant's content and a target:
 * the whole grantee, `role` included. A target is the identity grantType()
 * wrote, so a revoke aimed at a group's admins leaves the members' grant
 * standing. A query's `role: 'any'` is the one widening, and it is spelled.
 */
export function matchesGrantTarget(content: GrantContent, target: GrantQuery): boolean {
  const g = content.grantee;
  if (!g || g.kind !== target.kind) return false;
  if (g.kind === 'entity') return g.entityId === (target as { entityId: EntityId }).entityId;
  if (g.kind === 'group') {
    const t = target as { groupId: RecordId; role: string };
    return g.groupId === t.groupId && (t.role === 'any' || g.role === t.role);
  }
  return g.kind === 'authenticated';
}

/**
 * Reject a grant target that names no tier, or whose tier names nobody. An
 * empty groupId or entityId reaches no one, so storing it would leave a
 * grant that can only ever deny while looking like a share that worked.
 * Read as data, not as the type: a target reaching Stack from a request
 * body or an import has whatever shape it arrived with. `allowAny` admits
 * the listing-only `role: 'any'`, which grantType() and revokeType() refuse.
 */
export function validateGrantTarget(target: GrantQuery, allowAny = false): void {
  const t = target as Partial<Record<'kind' | 'entityId' | 'groupId' | 'role', unknown>> | null;
  switch (t?.kind) {
    case 'authenticated':
      return;
    case 'entity':
      if (typeof t.entityId !== 'string' || t.entityId.length === 0) {
        throw new StackBadRequestError('An entity grant target requires a non-empty entityId.');
      }
      return;
    case 'group':
      if (typeof t.groupId !== 'string' || t.groupId.length === 0) {
        throw new StackBadRequestError('A group grant target requires a non-empty groupId.');
      }
      if (t.role !== 'member' && t.role !== 'admin' && !(allowAny && t.role === 'any')) {
        throw new StackBadRequestError(
          allowAny
            ? "A group grant target requires role 'member', 'admin' or 'any'."
            : "A group grant target requires role 'member' or 'admin'.",
        );
      }
      // No format check: groupId is a reference, like parentId or an
      // association's recordId. One that resolves to nothing simply denies.
      return;
    default:
      throw new StackBadRequestError(
        "A grant target must name its tier: { kind: 'entity' }, { kind: 'group' } or { kind: 'authenticated' }.",
      );
  }
}

/**
 * The fields each grantee arm must carry, asked of a `_grant`'s content on
 * every write. The schema cannot ask it — a closed `object` field holds one
 * `properties` set, so only `kind` is required there — and an arm missing
 * its own field would otherwise store, answer 200, then deny forever.
 */
export function validateGrantee(typeId: TypeId, content: unknown): ValidationError[] {
  if (baseIdOf(typeId) !== SYSTEM_TYPES.GRANT) return [];
  const c = content as { grantee?: unknown } | null;
  const g = c?.grantee as Partial<Record<'kind' | 'entityId' | 'groupId' | 'role', unknown>> | null;
  // An absent or non-object grantee is the schema's to refuse, and it does.
  if (!g || typeof g !== 'object') return [];
  switch (g.kind) {
    case 'authenticated':
      return [];
    case 'entity':
      return typeof g.entityId === 'string' && g.entityId.length > 0
        ? []
        : [
            {
              path: 'grantee.entityId',
              message: 'An entity grantee requires a non-empty entityId',
            },
          ];
    case 'group': {
      const errors: ValidationError[] = [];
      if (typeof g.groupId !== 'string' || g.groupId.length === 0) {
        errors.push({
          path: 'grantee.groupId',
          message: 'A group grantee requires a non-empty groupId',
        });
      }
      if (g.role !== 'member' && g.role !== 'admin') {
        errors.push({
          path: 'grantee.role',
          message: "A group grantee requires role 'member' or 'admin'",
        });
      }
      return errors;
    }
    default:
      return [
        {
          path: 'grantee.kind',
          message: "A grantee must name its tier: 'entity', 'group' or 'authenticated'",
        },
      ];
  }
}

/**
 * Whether a stored _grant covers `grantee`: a direct DID match, roster
 * membership when `allowGroup`, or the authenticated tier when
 * `allowDefault`. The grantee's own `kind` decides which question is asked
 * — every tier is affirmative, and none is reachable by omission, so a
 * grant carrying nothing recognizable confers nothing.
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
  const g = c.grantee;
  if (!g || typeof g !== 'object') return false;
  switch (g.kind) {
    case 'authenticated':
      return opts.allowDefault;
    case 'entity':
      return !!g.entityId && g.entityId === grantee;
    case 'group': {
      if (!opts.allowGroup) return false;
      if (!g.groupId) return false;
      if (g.role !== 'member' && g.role !== 'admin') return false;
      const role = await resolveGroupRoleMemoized(
        g.groupId,
        grantee,
        opts.groupRoles,
        opts.resolveRecord,
      );
      return g.role === 'admin' ? role === 'admin' : role !== null;
    }
    default:
      return false;
  }
}

/**
 * An entity's role on a `_group` roster, memoized in the caller's
 * `groupRoles` map. That map is built per operation, so no resolved role
 * outlives the operation that resolved it — removal from a group must never
 * go stale.
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
  const role =
    group && carriesRoster(group) ? groupRoleFromAssociations(group.associations, entityId) : null;
  groupRoles.set(key, role);
  return role;
}

/**
 * System type families grantType() refuses to target: a grant on any of them
 * would let the grantee mint their own grants, touch stack config, or
 * register an app card claiming a DID that isn't theirs — the last of which
 * is what verified app attribution rests on.
 */
export const UNGRANTABLE_SYSTEM_TYPES: ReadonlySet<string> = new Set([
  SYSTEM_TYPES.GRANT,
  SYSTEM_TYPES.CONFIG,
  SYSTEM_TYPES.APP,
]);

/**
 * Every `_grant` Record, cursor-walked. Read through an unscoped query at
 * every call site: a grant is what decides who may read, so it can never
 * itself sit behind a read check.
 *
 * `includeUnlisted`, because withholding a Record from enumeration decides
 * nothing about what it confers. Deleted grants are excluded on the
 * opposite grounds — a soft delete is how revokeType() withdraws one.
 * See docs/spec/unlisted.md.
 */
export function loadGrantRecords(
  query: (q: StackQuery) => Promise<QueryResult>,
): Promise<StackRecord[]> {
  return queryAllPages(query, {
    filter: { typeId: `${SYSTEM_TYPES.GRANT}@1`, includeUnlisted: true },
  });
}
