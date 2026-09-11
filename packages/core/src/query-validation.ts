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
 * same questions of a request arriving over the wire.
 * See docs/spec/data-model.md § Capability-gated filters.
 */

import { StackQueryError } from './errors.js';
import { CONTENT_SEGMENT_METACHARACTERS, SEGMENT_METACHARACTER_RE } from './validate.js';
import type { ValidationError } from './validate.js';
import { NATIVE_SORT_FIELDS } from './types.js';
import type {
  Association,
  QuerySort,
  RecordFilter,
  RelationshipTarget,
  RelationshipTargetPattern,
  StackFeatures,
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
  capabilities: Pick<StackFeatures, 'filter'>,
): void {
  const { content: reach, contentPresent, search } = capabilities.filter;
  if (filter?.search && !search) {
    throw new StackQueryError(
      'Query uses filter.search, but this adapter does not declare the filter.search capability.',
    );
  }
  const present = filter?.contentPresent?.length ? filter.contentPresent : undefined;
  if (!filter?.content && !present) return;
  if (reach === 'none') {
    throw new StackQueryError(
      `Query uses ${present && !filter?.content ? 'filter.contentPresent' : 'filter.content'}, ` +
        'but this adapter declares filter.content: "none".',
    );
  }
  if (present && !contentPresent) {
    throw new StackQueryError(
      'Query uses filter.contentPresent, but this adapter does not declare the ' +
        'filter.contentPresent capability.',
    );
  }
  for (const key of [...Object.keys(filter?.content ?? {}), ...(present ?? [])]) {
    if (parseContentFilterKey(key).length > 1 && reach !== 'path') {
      throw new StackQueryError(
        `Query uses the nested content path "${key}", but this adapter declares ` +
          `filter.content: "${reach}".`,
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
export function filtersContent(features: Pick<StackFeatures, 'filter'>): boolean {
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
    throw new StackQueryError(
      `Invalid content filter path "${key}": at most ${MAX_CONTENT_PATH_SEGMENTS} segments.`,
    );
  }
  for (const segment of segments) {
    if (segment === '') {
      throw new StackQueryError(
        `Invalid content filter path "${key}": a path segment cannot be empty.`,
      );
    }
    if (SEGMENT_METACHARACTER_RE.test(segment)) {
      throw new StackQueryError(
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
    throw new StackQueryError('A sort names either a native field or a content field, never both.');
  }
  if (sort.field !== undefined && !VALID_SORT_FIELDS.has(sort.field)) {
    throw new StackQueryError(
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
      throw new StackQueryError(
        `Invalid sort content field "${sort.contentField}": sorting reaches top-level fields only.`,
      );
    }
  }
  if (sort.direction !== undefined && !VALID_SORT_DIRECTIONS.has(sort.direction)) {
    throw new StackQueryError(
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
  capabilities: Pick<StackFeatures, 'sort'>,
): void {
  if (!sort) return;
  if (sort.contentField !== undefined) {
    if (!capabilities.sort.contentField) {
      throw new StackQueryError(
        'Query uses sort.contentField, but this adapter does not declare the sort.contentField ' +
          'capability.',
      );
    }
    return;
  }
  const field = sort.field ?? 'createdAt';
  if (!capabilities.sort.fields.includes(field)) {
    throw new StackQueryError(
      `Query sorts by "${field}", which this adapter does not declare in sort.fields.`,
    );
  }
}

/** The identifier spaces a relationship target may name. */
const TARGET_SCOPES = new Set(['record', 'entity', 'external']);

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
  if (!TARGET_SCOPES.has(target.scope)) {
    return fail(
      `Unknown relationship target scope "${target.scope}": expected "record", "entity" or "external".`,
    );
  }
  if (target.scope === 'record') {
    if (!target.recordId) return fail('A record target requires a non-empty recordId.');
    if (target.stackUrl !== undefined && !target.stackUrl) {
      return fail("A record target's stackUrl must be non-empty; omit it to name this stack.");
    }
    return [];
  }
  if (target.scope === 'entity') {
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
 * unrecognized scope would otherwise be stored under the one arm that
 * names a Record in this stack. See docs/spec/data-model.md
 * § Relationship targets.
 */
export function validateAssociation(
  association: Association,
  path = 'association',
): ValidationError[] {
  if (association?.kind !== 'relationship') return [];
  return targetErrors(association.target, `${path}.target`);
}

/** validateAssociation() over a create's `associations` array. */
export function validateAssociations(
  associations: Association[] | undefined,
  path = 'associations',
): ValidationError[] {
  return (associations ?? []).flatMap((a, i) => validateAssociation(a, `${path}[${i}]`));
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
    throw new StackQueryError(
      'filter.relatedTo must name a label, a target, or both — "any relationship at all" is not a filter.',
    );
  }
  if (relatedTo.target === undefined) return;
  const errors = targetErrors(relatedTo.target, 'filter.relatedTo.target', {
    externalIdOptional: true,
  });
  if (errors.length > 0) throw new StackQueryError(errors[0].message);
}
