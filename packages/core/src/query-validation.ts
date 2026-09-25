/**
 * Query and association validation
 * -------------------------------------------------------
 * The sanitizers a query passes through before any adapter sees it, plus
 * the relationship-target rules an association is held to. Both sides of
 * the same job: a discriminated union and a `QuerySort` field are compile-
 * time promises, and a server mapping a request body onto either supplies
 * raw JSON that no compiler has seen.
 *
 * These live in the invariant layer for the reason validation and
 * `_config` protection do — so no adapter can forget one. `assertQueryCapabilities`
 * and its neighbours are shared verbatim with `adapter-api`, which asks the
 * same questions of a request arriving over the wire. A refusal names the
 * capability it was refused for on the error itself, so a client reporting
 * it in its own vocabulary reads that name rather than re-deriving it from
 * the query — one rule, one answer.
 * See docs/spec/data-model.md § Capability-gated filters.
 */

import { StackBadRequestError } from './errors.js';
import { associationEqual, isAuthorityAssociation } from './record-changes.js';
import { CONTENT_SEGMENT_METACHARACTERS, SEGMENT_METACHARACTER_RE } from './validate.js';
import type { ValidationError } from './validate.js';
import { NATIVE_SORT_FIELDS } from './types.js';
import type {
  Association,
  AuthorityAssociation,
  DataAssociation,
  JournalQuery,
  Grantee,
  QuerySort,
  RecordFilter,
  RelationshipTarget,
  RelationshipTargetPattern,
  StackCapabilities,
} from './types.js';

/**
 * Fail loud rather than silently widen: a filter the adapter can't honor
 * would otherwise be dropped, returning an unfiltered superset presented
 * as the filtered result. Shared by Stack.query() and
 * APIAdapter.queryRecords(). See docs/spec/data-model.md
 * § Capability-gated filters.
 */
export function assertQueryCapabilities(
  filter: RecordFilter | undefined,
  capabilities: Pick<StackCapabilities, 'filter'>,
): void {
  const { content: reach, contentPresent, search } = capabilities.filter;
  if (filter?.search && !search) {
    throw new StackBadRequestError(
      'Query uses filter.search, but this adapter does not declare the filter.search capability.',
      'filter.search',
    );
  }
  const present = filter?.contentPresent?.length ? filter.contentPresent : undefined;
  if (!filter?.content && !present) return;
  if (reach === 'none') {
    // Named as `filter.content` whichever key the query used: the reach
    // is what is absent, and it is the entry to look at in discovery.
    throw new StackBadRequestError(
      `Query uses ${present && !filter?.content ? 'filter.contentPresent' : 'filter.content'}, ` +
        'but this adapter declares filter.content: "none".',
      'filter.content',
    );
  }
  if (present && !contentPresent) {
    throw new StackBadRequestError(
      'Query uses filter.contentPresent, but this adapter does not declare the ' +
        'filter.contentPresent capability.',
      'filter.contentPresent',
    );
  }
  for (const key of [...Object.keys(filter?.content ?? {}), ...(present ?? [])]) {
    if (parseContentFilterKey(key).length > 1 && reach !== 'path') {
      throw new StackBadRequestError(
        `Query uses the nested content path "${key}", but this adapter declares ` +
          `filter.content: "${reach}".`,
        'filter.content',
      );
    }
  }
}

/**
 * Whether a single-segment content filter can be pushed down to the
 * adapter. Callers that read a content field pair this with an in-memory
 * predicate over the wider result, so the query stays correct against an
 * adapter that reaches no content at all — the rung comparison lives here
 * rather than at each of them.
 */
export function filtersContent(features: Pick<StackCapabilities, 'filter'>): boolean {
  return features.filter.content !== 'none';
}

/** The longest path both SQLite engines can execute — see the spec link below. */
const MAX_CONTENT_PATH_SEGMENTS = 32;

/**
 * Split a content filter key into path segments. Write-time validation
 * keeps stored field names free of the path metacharacters, but a filter
 * arrives from a request body and has made no such promise, so the same
 * rule is enforced here. See docs/spec/data-model.md § Content field names.
 */
export function parseContentFilterKey(key: string): string[] {
  const segments = key.split('.');
  // A SQLite adapter spends two json_each joins per segment against a
  // 64-table join limit, so a path past the cap is one the engine could
  // not execute. See docs/spec/data-model.md § Nested content paths.
  if (segments.length > MAX_CONTENT_PATH_SEGMENTS) {
    throw new StackBadRequestError(
      `Invalid content filter path "${key}": at most ${MAX_CONTENT_PATH_SEGMENTS} segments.`,
    );
  }
  for (const segment of segments) {
    if (segment === '') {
      throw new StackBadRequestError(
        `Invalid content filter path "${key}": a path segment cannot be empty.`,
      );
    }
    if (SEGMENT_METACHARACTER_RE.test(segment)) {
      throw new StackBadRequestError(
        `Invalid content filter path "${key}": a segment cannot contain any of ` +
          `${CONTENT_SEGMENT_METACHARACTERS.join(' ')}.`,
      );
    }
  }
  return segments;
}

/**
 * The only sort fields any adapter maps; anything else is a caller error.
 * Narrowed against the one array NativeSortField is derived from, so this
 * gate — which every query passes through before an adapter sees it —
 * can't be the copy that a fourth native column is missing from.
 */
const VALID_SORT_FIELDS: ReadonlySet<string> = new Set(NATIVE_SORT_FIELDS);
/** The only two sort directions; see assertValidSort. */
const VALID_SORT_DIRECTIONS = new Set(['asc', 'desc']);

/**
 * Reject a sort whose field or direction is outside the closed set the
 * types promise. `QuerySort` is typed `'asc' | 'desc'`, but a type is not a
 * runtime guard: a server mapping `?direction=` onto a query, or a
 * delegated app calling query(), supplies a raw string. A SQLite record
 * adapter interpolates the direction straight into `ORDER BY`, so an
 * unvalidated value there is a SQL-injection sink reachable from every
 * untrusted caller. Validating in the invariant layer — the same reason
 * emission and _config protection live here — means no adapter can forget
 * it. See docs/spec/data-model.md § Sorting and pagination.
 */
export function assertValidSort(sort: QuerySort | undefined): void {
  if (!sort) return;
  if (sort.field !== undefined && sort.contentField !== undefined) {
    throw new StackBadRequestError(
      'A sort names either a native field or a content field, never both.',
    );
  }
  if (sort.field !== undefined && !VALID_SORT_FIELDS.has(sort.field)) {
    throw new StackBadRequestError(
      `Invalid sort field "${sort.field}": expected one of ${NATIVE_SORT_FIELDS.join(', ')}.`,
    );
  }
  if (sort.contentField !== undefined) {
    // Parsed by the same rule a filter key is, so a name a filter could
    // never address is not one a sort can either — then held to one
    // segment, because a value inside an array or object has no single
    // position to order its record by (docs/spec/data-model.md
    // § Sorting by a content field).
    if (parseContentFilterKey(sort.contentField).length > 1) {
      throw new StackBadRequestError(
        `Invalid sort content field "${sort.contentField}": sorting reaches top-level fields only.`,
      );
    }
  }
  if (sort.direction !== undefined && !VALID_SORT_DIRECTIONS.has(sort.direction)) {
    throw new StackBadRequestError(
      `Invalid sort direction "${sort.direction}": expected "asc" or "desc".`,
    );
  }
}

/**
 * Fail loud rather than silently reorder: an adapter that can't honor the
 * requested sort would otherwise answer in some other order, which a
 * caller paging a bounded window has no way to notice. The companion to
 * assertQueryCapabilities(), split from it because a sort is not a filter
 * — see docs/spec/data-model.md § Capability-gated filters.
 */
export function assertSortCapability(
  sort: QuerySort | undefined,
  capabilities: Pick<StackCapabilities, 'sort'>,
): void {
  if (!sort) return;
  if (sort.contentField !== undefined) {
    if (!capabilities.sort.contentField) {
      throw new StackBadRequestError(
        'Query uses sort.contentField, but this adapter does not declare the sort.contentField ' +
          'capability.',
        'sort.contentField',
      );
    }
    return;
  }
  const field = sort.field ?? 'createdAt';
  if (!capabilities.sort.fields.includes(field)) {
    throw new StackBadRequestError(
      `Query sorts by "${field}", which this adapter does not declare in sort.fields.`,
      'sort.fields',
    );
  }
}

/** The identifier spaces a relationship target may name. */
const TARGET_KINDS = new Set(['record', 'entity', 'external']);

/**
 * Collect what makes a relationship target malformed. Absence is
 * meaningful on `stackUrl` and an external `id` — this stack, and the
 * whole namespace — so every part that names something must be non-empty:
 * an empty string stores and matches as though it were absent.
 * See docs/spec/data-model.md § Relationship targets.
 */
function targetErrors(
  target: RelationshipTarget | RelationshipTargetPattern,
  path: string,
  opts: { externalIdOptional?: boolean } = {},
): ValidationError[] {
  const fail = (message: string): ValidationError[] => [{ path, message }];
  if (!target || typeof target !== 'object')
    return fail('A relationship target must be an object.');
  if (!TARGET_KINDS.has(target.kind)) {
    return fail(
      `Unknown relationship target kind "${target.kind}": expected "record", "entity" or "external".`,
    );
  }
  if (target.kind === 'record') {
    if (!target.recordId) return fail('A record target requires a non-empty recordId.');
    if (target.stackUrl !== undefined && !target.stackUrl) {
      return fail("A record target's stackUrl must be non-empty; omit it to name this stack.");
    }
    return [];
  }
  if (target.kind === 'entity') {
    return target.entityId ? [] : fail('An entity target requires a non-empty entityId.');
  }
  if (!target.ns) return fail('An external target requires a non-empty ns.');
  if (target.id === undefined) {
    return opts.externalIdOptional ? [] : fail('An external target requires an id.');
  }
  return target.id ? [] : fail("An external target's id must be non-empty when present.");
}

/**
 * Reject a relationship target outside the closed set the types promise.
 * A discriminated union is not a runtime guard — a server mapping a
 * request body onto an association supplies raw JSON — and an
 * unrecognized kind would otherwise be stored under the one arm that
 * names a Record in this stack. See docs/spec/data-model.md
 * § Relationship targets.
 */
export function validateAssociation(
  association: Association,
  path = 'association',
): ValidationError[] {
  if (!namesKind(association)) {
    return [
      {
        path: `${path}.kind`,
        message: `Unknown association kind "${String((association as { kind?: unknown })?.kind)}": expected ${[...ASSOCIATION_KINDS].map((k) => `"${k}"`).join(', ')}.`,
      },
    ];
  }
  if (association.kind === 'permission') {
    return granteeErrors(association, `${path}.grantee`);
  }
  if (association.kind === 'anyone') {
    return association.label === 'read'
      ? []
      : [{ path: `${path}.label`, message: 'An `anyone` association carries only `read`.' }];
  }
  if (association.kind !== 'relationship') return [];
  return targetErrors(association.target, `${path}.target`);
}

/**
 * Who a duplicated permission names, since kind and label alone don't
 * distinguish two grants of the same bit to different grantees.
 */
function granteeSuffix(association: Association): string {
  if (association.kind !== 'permission') return '';
  const g = association.grantee;
  return g.kind === 'entity' ? ` for "${g.entityId}"` : ` for ${g.role}s of "${g.groupId}"`;
}

/** The kinds an association may name — the closed set every surface reads. */
const ASSOCIATION_KINDS = new Set(['tag', 'attachment', 'relationship', 'permission', 'anyone']);

/**
 * Whether a value is an association at all. Asked ahead of the partition
 * checks, so a malformed element is named as one rather than reported as
 * the wrong surface for a kind it never had — a request body supplies raw
 * JSON, and `null` or `{}` is neither half of the partition.
 */
function namesKind(association: Association): boolean {
  return (
    !!association &&
    typeof association === 'object' &&
    ASSOCIATION_KINDS.has((association as { kind?: unknown }).kind as string)
  );
}

/** The bits a permission element may name — the whole of its meaning. */
const PERMISSION_LABELS = new Set(['read', 'write']);

/**
 * Collect what makes a permission element malformed. `role` is required on
 * a group grantee: there is no "any member" default to fall back on, so an
 * absent one would otherwise widen or narrow silently depending on how the
 * reader broke the tie. See docs/spec/access-control.md
 * § Record-level permissions.
 */
function granteeErrors(
  association: { label: string; grantee: Grantee },
  path: string,
): ValidationError[] {
  const fail = (message: string): ValidationError[] => [{ path, message }];
  if (!PERMISSION_LABELS.has(association.label)) {
    return [
      {
        path: `${path.slice(0, -'.grantee'.length)}.label`,
        message: `Unknown permission label "${association.label}": expected "read" or "write".`,
      },
    ];
  }
  const grantee = association.grantee;
  if (!grantee || typeof grantee !== 'object') return fail('A permission requires a grantee.');
  if (grantee.kind === 'entity') {
    return grantee.entityId ? [] : fail('An entity grantee requires a non-empty entityId.');
  }
  if (grantee.kind === 'group') {
    if (!grantee.groupId) return fail('A group grantee requires a non-empty groupId.');
    return grantee.role === 'member' || grantee.role === 'admin'
      ? []
      : fail('A group grantee requires a role of "member" or "admin".');
  }
  return fail(
    `Unknown permission grantee kind "${String((grantee as { kind?: unknown }).kind)}": expected "entity" or "group".`,
  );
}

/**
 * Refuse an authority element reaching the data half of the partition.
 * The two share a table, a delta shape and a durability tier; they never
 * share a call, because an app editing tags would otherwise be able to
 * replace an ACL it was never shown. Thrown rather than collected: the
 * caller named the wrong surface, not a malformed value, and the verb it
 * wanted is `grantAccess()`/`revokeAccess()`.
 *
 * Lives here, in the invariant layer, so an unscoped `Stack`, an import
 * and a server mapping a request body are all held to it.
 * See docs/spec/access-control.md § Record-level permissions.
 */
export function assertDataAssociations(
  associations: readonly Association[],
  surface: string,
): asserts associations is DataAssociation[] {
  const authority = associations.find((a) => namesKind(a) && isAuthorityAssociation(a));
  if (!authority) return;
  throw new StackBadRequestError(
    `${surface} does not carry authority: a "${authority.kind}" association belongs to the ` +
      '`permissions` surface — use grantAccess()/revokeAccess(), or the `permissions` change-set key.',
  );
}

/**
 * The mirror of assertDataAssociations(): the `permissions` surface takes
 * authority kinds alone, so a tag routed through it is refused rather than
 * quietly becoming an ACL entry the `associations` projection never shows.
 */
export function assertAuthorityAssociations(
  permissions: readonly Association[],
  surface: string,
): asserts permissions is AuthorityAssociation[] {
  const data = permissions.find((a) => namesKind(a) && !isAuthorityAssociation(a));
  if (!data) return;
  throw new StackBadRequestError(
    `${surface} carries authority alone: a "${data.kind}" association belongs to the ` +
      '`associations` surface — use associate()/dissociate(), or the `associations` change-set key.',
  );
}

/** validateAssociation() over a create's `associations` array. */
/**
 * Every association in a list, plus the one rule a list has that a single
 * association does not: **identities are distinct**. A list naming one
 * identity twice describes a state no store can hold — an adapter keys
 * associations by identity, so the second entry displaces the first — and
 * which of the two the record ends up with is a question the caller did
 * not mean to ask. Refused rather than collapsed, for the reason an empty
 * change set is refused: every way of producing one is a caller bug.
 * See docs/spec/data-model.md § Associations.
 */
export function validateAssociations(
  associations: Association[] | undefined,
  path = 'associations',
): ValidationError[] {
  const list = associations ?? [];
  return [
    ...list.flatMap((a, i) => validateAssociation(a, `${path}[${i}]`)),
    ...list.flatMap((a, i) =>
      list.slice(0, i).some((b) => associationEqual(a, b))
        ? [
            {
              path: `${path}[${i}]`,
              message: `Duplicate association identity: ${a.kind} "${a.label}"${granteeSuffix(a)} is named more than once.`,
            },
          ]
        : [],
    ),
  ];
}

/**
 * Reject a relationship filter that names neither a label nor a target,
 * or whose target is malformed. `RelatedToFilter` promises one half is
 * always present; without the runtime check a filter decoded from a
 * request could arrive empty and match every record carrying any
 * relationship. See docs/spec/data-model.md § Filter.
 */
export function assertValidRelatedTo(relatedTo: RecordFilter['relatedTo']): void {
  if (!relatedTo) return;
  if (relatedTo.label === undefined && relatedTo.target === undefined) {
    throw new StackBadRequestError(
      'filter.relatedTo must name a label, a target, or both — "any relationship at all" is not a filter.',
    );
  }
  if (relatedTo.target === undefined) return;
  const errors = targetErrors(relatedTo.target, 'filter.relatedTo.target', {
    externalIdOptional: true,
  });
  if (errors.length > 0) throw new StackBadRequestError(errors[0].message);
}

/**
 * Hold a journal window to the shape both adapters can honor identically.
 *
 * Unvalidated, a negative `limit` diverges rather than failing: a JS
 * `slice(0, -1)` drops the newest entry, while SQLite reads a negative
 * LIMIT as "no ceiling" and returns the whole log. Neither is what the
 * caller asked for, and the disagreement is invisible until a stack
 * changes adapters. Refuse at the surface so no adapter has to guess.
 *
 * No ceiling is imposed: unlike a query, omitting `limit` reads the whole
 * log by contract, so a clamp would silently truncate exactly the caller
 * reconstructing an association's full history.
 */
export function assertValidJournalQuery(query: JournalQuery | undefined): void {
  if (!query) return;
  for (const key of ['sinceSeq', 'limit'] as const) {
    const value = query[key];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value < 0) {
      throw new StackBadRequestError(
        `Invalid journal ${key} ${String(value)}: expected a non-negative integer.`,
      );
    }
  }
}
