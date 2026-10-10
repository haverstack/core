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

import { baseIdOf, familyIdProblem } from './schema.js';
import { ARGUMENTS_INVALID, StackBadRequestError, StackValidationError } from './errors.js';
import { granteeErrors } from './associations/validation.js';
import { SYSTEM_TYPES, GRANT_ACTIONS } from './types/index.js';
import { resolveGroupRole, roleSatisfies } from './access.js';
import type {
  BaseId,
  EntityId,
  GrantAction,
  GrantContent,
  GrantGrantee,
  GroupRole,
  RecordId,
  StackRecord,
  TypeId,
} from './types/index.js';
import type { ValidationError } from './validate.js';

/**
 * Valid GrantAction values, for runtime validation in Stack.grantType(). Built
 * from GRANT_ACTIONS, which GrantAction itself derives from, so the set and
 * the type cannot drift.
 */
export const GRANT_ACTION_SET: ReadonlySet<GrantAction> = new Set(GRANT_ACTIONS);

/**
 * The read actions that make a mutate action coherent, scope for scope. A
 * grant carrying none conveys the verb to nobody. `create` has none:
 * writing a Record you cannot read is the drop-box, and discloses nothing.
 * See docs/spec/access-control.md § Write implies read.
 */
const READ_COMPANIONS: ReadonlyMap<GrantAction, readonly GrantAction[]> = new Map([
  ['update-own', ['read-own', 'read-any']],
  ['delete-own', ['read-own', 'read-any']],
  ['update-any', ['read-any']],
  ['delete-any', ['read-any']],
]);

/**
 * Whether one grant's action list conveys `action`. The companion must sit
 * in the same `_grant`: a grant is revoked whole, so a rule met across two
 * records could leave mutate-without-read standing. Takes grantReach()'s
 * list, never a stored field, whose `includes()` would match substrings.
 */
export function grantConveys(actions: readonly GrantAction[], action: GrantAction): boolean {
  if (!actions.includes(action)) return false;
  const companions = READ_COMPANIONS.get(action);
  return !companions || companions.some((c) => actions.includes(c));
}

/**
 * What a stored `_grant` reaches, or null where it names nothing the
 * evaluator recognizes. Read as data — a grant can arrive from an import or
 * a foreign server no schema saw — so an unknown action is dropped, as an
 * unknown grantee confers nothing. See docs/spec/access-control.md
 * § Refused at the write, and again at evaluation.
 */
export function grantReach(content: unknown): { familyId: string; actions: GrantAction[] } | null {
  const c = content as { baseId?: unknown; actions?: unknown } | null;
  if (!c || typeof c !== 'object') return null;
  // A versioned target names one version, which a grant cannot: it confers nothing.
  if (typeof c.baseId !== 'string' || c.baseId.length === 0 || c.baseId.includes('@')) return null;
  if (!Array.isArray(c.actions)) return null;
  return {
    familyId: c.baseId,
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

/** Whether two action lists name the same verbs, order and repeats aside. */
export function sameActions(a: readonly GrantAction[], b: readonly GrantAction[]): boolean {
  const as = new Set(a);
  const bs = new Set(b);
  return as.size === bs.size && [...bs].every((x) => as.has(x));
}

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
 * Reject a grant target that names no tier, or whose tier names nobody: it
 * would store a grant that can only deny while looking like a share that
 * worked. Read as data, so a key its tier does not define is refused too.
 * `allowAny` admits the listing-only `role: 'any'`.
 */
export function validateGrantTarget(target: GrantQuery, allowAny = false): void {
  // No format check on a groupId: it is a reference, like parentId or an
  // association's recordId. One that resolves to nothing simply denies.
  const errors = granteeErrors(target, 'grant target', {
    unknownKeys: 'throw',
    authenticated: true,
    anyRole: allowAny,
  });
  if (errors.length > 0) {
    throw new StackBadRequestError(
      `Invalid grant target: ${errors.map((e) => e.message).join(' ')}`,
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
  const g = (content as { grantee?: unknown } | null)?.grantee;
  // An absent or non-object grantee is the schema's to refuse, and it does.
  if (!g || typeof g !== 'object') return [];
  return granteeErrors(g, 'grantee', { unknownKeys: 'collect', authenticated: true });
}

/**
 * A `_grant`'s target, asked of its content on every write: a bare baseId
 * naming a family, and not one of the protected system types. Read as data
 * like the grantee beside it. See docs/spec/access-control.md
 * § Refused at the write, and again at evaluation.
 */
export function validateGrantBaseId(typeId: TypeId, content: unknown): ValidationError[] {
  if (baseIdOf(typeId) !== SYSTEM_TYPES.GRANT) return [];
  const baseId = (content as { baseId?: unknown } | null)?.baseId;
  // A missing or non-string baseId is the schema's to refuse.
  if (typeof baseId !== 'string') return [];
  const problem = familyIdProblem(baseId, 'baseId');
  if (problem) return [{ path: 'baseId', message: problem }];
  if (UNGRANTABLE_SYSTEM_TYPES.has(baseId)) {
    const refused = [...UNGRANTABLE_SYSTEM_TYPES].join(', ');
    return [
      {
        path: 'baseId',
        message: `Cannot grant on "${baseId}": grants on ${refused} are refused to prevent privilege escalation`,
      },
    ];
  }
  return [];
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
      const role = await resolveGroupRole(g.groupId, grantee, opts.resolveRecord, opts.groupRoles);
      return roleSatisfies(role, g.role);
    }
    default:
      return false;
  }
}

/**
 * System type families grantType() refuses to target: a grant on any of them
 * would let the grantee mint their own grants, touch stack config, or
 * register an app card claiming a DID that isn't theirs — the last of which
 * is what verified app attribution rests on — or approve an install, which
 * decides grants and migration authority.
 */
export const UNGRANTABLE_SYSTEM_TYPES: ReadonlySet<string> = new Set([
  SYSTEM_TYPES.GRANT,
  SYSTEM_TYPES.CONFIG,
  SYSTEM_TYPES.APP,
  SYSTEM_TYPES.INSTALL,
]);

/**
 * Actions must be known GrantAction values; the target is held to the
 * same rule every `_grant` write meets — see validateGrantBaseId().
 */
export function checkGrantValid(baseId: BaseId, actions: GrantAction[]): void {
  const errors: ValidationError[] = [];
  actions.forEach((action, j) => {
    if (!GRANT_ACTION_SET.has(action)) {
      errors.push({ path: `actions[${j}]`, message: `Unknown grant action "${action}"` });
    }
  });

  const problem = familyIdProblem(baseId, 'grantType');
  if (problem) {
    errors.push({ path: 'baseId', message: problem });
  } else {
    errors.push(...validateGrantBaseId(`${SYSTEM_TYPES.GRANT}@1`, { baseId }));
  }

  actions.forEach((action, j) => {
    if (grantConveys(actions, action)) return;
    const companions = READ_COMPANIONS.get(action);
    if (!companions) return;
    errors.push({
      path: `actions[${j}]`,
      message: `"${action}" requires ${companions.map((c) => `"${c}"`).join(' or ')} in the same grant: a mutate verb reaches the record and its history, so it conveys nothing without read. Name both in one grant: actions: [${companions.map((c) => `'${c}'`).join(' | ')}, '${action}']`,
    });
  });
  if (errors.length > 0) {
    throw new StackValidationError(errors, ARGUMENTS_INVALID);
  }
}
