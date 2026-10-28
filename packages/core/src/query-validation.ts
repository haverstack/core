/**
 * Query validation
 * -------------------------------------------------------
 * The sanitizers a query passes through before any adapter sees it. A
 * `QuerySort` field or a filter's discriminated union is a compile-time
 * promise, and a server mapping a request onto either supplies raw JSON
 * that no compiler has seen.
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

import { ARGUMENTS_INVALID, StackBadRequestError, StackValidationError } from './errors.js';
import { familyIdProblem, parseTypeId } from './schema.js';
import { targetErrors } from './associations/validation.js';
import {
  CONTENT_SEGMENT_METACHARACTERS,
  MAX_VALIDATION_DEPTH,
  SEGMENT_METACHARACTER_RE,
  isPlainObject,
} from './validate.js';
import { NATIVE_SORT_FIELDS } from './types/index.js';
import type {
  AdapterQuery,
  PlainQuery,
  AdapterSort,
  StackQuery,
  JournalQuery,
  QuerySort,
  RecordFilter,
  StackCapabilities,
  VersionsQuery,
} from './types/index.js';

/**
 * Fail loud rather than silently widen or reorder: a filter or sort the
 * adapter can't honor would otherwise be dropped, answering with some
 * other result, which a caller reading one bounded page cannot detect.
 * Every refusal names the capability. The companion to resolveQuery(),
 * which refuses the query's own shape; every entry point runs both. See
 * docs/spec/data-model.md § Capability-gated filters.
 */
export function assertQueryCapabilities(
  query: AdapterQuery,
  capabilities: Pick<StackCapabilities, 'filter' | 'sort'>,
): void {
  assertFilterCapability(query.filter, capabilities);
  assertSortCapability(query.sort, capabilities);
}

function assertFilterCapability(
  filter: RecordFilter | undefined,
  capabilities: Pick<StackCapabilities, 'filter'>,
): void {
  const { content: reach, contentPresent, contentByType, search } = capabilities.filter;
  if (filter?.search && !search) {
    throw new StackBadRequestError(
      'Query uses filter.search, but this adapter does not declare the filter.search capability.',
      'filter.search',
    );
  }
  // An arm's keys are gated as the same keys at the top of the filter are.
  const arms = Object.values(filter?.contentByType ?? {});
  const parts = [filter ?? {}, ...arms];
  const keys = parts.flatMap((part) => Object.keys(part.content ?? {}));
  const present = parts.flatMap((part) => part.contentPresent ?? []);
  if (!filter?.content && present.length === 0 && arms.length === 0) return;
  if (reach === 'none') {
    // Named as `filter.content` whichever key the query used: the reach
    // is what is absent, and it is the entry to look at in discovery.
    const used =
      arms.length > 0
        ? 'filter.contentByType'
        : present.length > 0 && !filter?.content
          ? 'filter.contentPresent'
          : 'filter.content';
    throw new StackBadRequestError(
      `Query uses ${used}, but this adapter declares filter.content: "none".`,
      'filter.content',
    );
  }
  if (arms.length > 0 && !contentByType) {
    throw new StackBadRequestError(
      'Query uses filter.contentByType, but this adapter does not declare the ' +
        'filter.contentByType capability.',
      'filter.contentByType',
    );
  }
  if (present.length > 0 && !contentPresent) {
    throw new StackBadRequestError(
      'Query uses filter.contentPresent, but this adapter does not declare the ' +
        'filter.contentPresent capability.',
      'filter.contentPresent',
    );
  }
  for (const key of [...keys, ...present]) {
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
 * Hold `filter.contentByType` to a split along Types: at least one arm,
 * each pinned to a TypeId and flat, and never beside a top-level content
 * predicate, whose relation to the arms would be ambiguous. A map that
 * could arrive empty would match everything once it crossed the wire. See
 * docs/spec/data-model.md § Content by type.
 */
export function assertValidContentByType(filter: RecordFilter | undefined): void {
  const arms: unknown = filter?.contentByType;
  if (arms === undefined) return;
  if (!isPlainObject(arms) || Object.keys(arms).length === 0) {
    throw new StackBadRequestError('filter.contentByType must name at least one typeId.');
  }
  if (filter!.content !== undefined || filter!.contentPresent !== undefined) {
    throw new StackBadRequestError(
      'filter.contentByType cannot be combined with filter.content or filter.contentPresent.',
    );
  }
  for (const [typeId, arm] of Object.entries(arms)) {
    if (!parseTypeId(typeId)) {
      throw new StackBadRequestError(
        `filter.contentByType key "${typeId}" is not a versioned TypeId.`,
      );
    }
    if (!isPlainObject(arm)) {
      throw new StackBadRequestError(`filter.contentByType["${typeId}"] must be an object.`);
    }
    for (const key of Object.keys(arm)) {
      if (key !== 'content' && key !== 'contentPresent') {
        throw new StackBadRequestError(
          `filter.contentByType["${typeId}"] takes content and contentPresent only, not "${key}".`,
        );
      }
    }
    if (arm.content !== undefined && !isPlainObject(arm.content)) {
      throw new StackBadRequestError(
        `filter.contentByType["${typeId}"].content must be an object.`,
      );
    }
    if (
      arm.contentPresent !== undefined &&
      (!Array.isArray(arm.contentPresent) ||
        !arm.contentPresent.every((path) => typeof path === 'string'))
    ) {
      throw new StackBadRequestError(
        `filter.contentByType["${typeId}"].contentPresent must be an array of strings.`,
      );
    }
    for (const key of [
      ...Object.keys((arm.content as Record<string, unknown> | undefined) ?? {}),
      ...((arm.contentPresent as string[] | undefined) ?? []),
    ]) {
      parseContentFilterKey(key);
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

/**
 * The longest path that can reach a stored value: a top-level field sits at
 * depth 0 and each segment descends one level, so a path past this reaches
 * nothing a write accepts. See docs/spec/data-model.md § Nested content
 * paths.
 */
const MAX_CONTENT_PATH_SEGMENTS = MAX_VALIDATION_DEPTH + 1;

/**
 * Split a content filter key into path segments. Write-time validation
 * keeps stored field names free of the path metacharacters, but a filter
 * arrives from a request body and has made no such promise, so the same
 * rule is enforced here. See docs/spec/data-model.md § Content field names.
 */
export function parseContentFilterKey(key: string): string[] {
  const segments = key.split('.');
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
 * Reject a sort outside the closed set the types promise. A type is not a
 * runtime guard, and a SQLite adapter interpolates the direction straight
 * into `ORDER BY`, so an unvalidated one is an injection sink reachable by
 * any untrusted caller. See docs/spec/data-model.md § Sorting and pagination.
 */
export function assertValidSort(sort: QuerySort | undefined): void {
  if (!sort) return;
  const named = [sort.field, sort.contentField, sort.contentFieldByType].filter(
    (member) => member !== undefined,
  );
  if (named.length !== 1) {
    throw new StackBadRequestError(
      'A sort names exactly one of a native field, a content field or a content field per type.',
    );
  }
  if (sort.field !== undefined && !VALID_SORT_FIELDS.has(sort.field)) {
    throw new StackBadRequestError(
      `Invalid sort field "${sort.field}": expected one of ${NATIVE_SORT_FIELDS.join(', ')}.`,
    );
  }
  if (sort.contentField !== undefined) assertSortableField(sort.contentField);
  if (sort.contentFieldByType !== undefined) assertValidSortByType(sort.contentFieldByType);
  if (sort.direction !== undefined && !VALID_SORT_DIRECTIONS.has(sort.direction)) {
    throw new StackBadRequestError(
      `Invalid sort direction "${sort.direction}": expected "asc" or "desc".`,
    );
  }
}

/**
 * Parsed by the same rule a filter key is, so a name a filter could never
 * address is not one a sort can either — then held to one segment, because
 * a value inside an array or object has no single position to order its
 * record by (docs/spec/data-model.md § Sorting by a content field).
 */
const assertSortableField = (field: unknown): void => {
  if (typeof field !== 'string') {
    throw new StackBadRequestError('Invalid sort content field: expected a string.');
  }
  if (parseContentFilterKey(field).length > 1) {
    throw new StackBadRequestError(
      `Invalid sort content field "${field}": sorting reaches top-level fields only.`,
    );
  }
};

/**
 * Each key names a TypeId and orders by one field of it or one reduced
 * constant. See docs/spec/data-model.md § Sorting by a content field.
 */
const assertValidSortByType = (byType: unknown): void => {
  if (!isPlainObject(byType) || Object.keys(byType).length === 0) {
    throw new StackBadRequestError('sort.contentFieldByType must name at least one typeId.');
  }
  for (const [typeId, key] of Object.entries(byType)) {
    if (!parseTypeId(typeId)) {
      throw new StackBadRequestError(
        `sort.contentFieldByType key "${typeId}" is not a versioned TypeId.`,
      );
    }
    const shape = isPlainObject(key) ? Object.keys(key) : [];
    if (shape.length !== 1 || (shape[0] !== 'field' && shape[0] !== 'value')) {
      throw new StackBadRequestError(
        `sort.contentFieldByType["${typeId}"] must be { field } or { value }.`,
      );
    }
    const { field, value } = key as { field?: unknown; value?: unknown };
    if (shape[0] === 'field') {
      assertSortableField(field);
    } else if (
      value !== null &&
      typeof value !== 'string' &&
      !(typeof value === 'number' && Number.isFinite(value))
    ) {
      throw new StackBadRequestError(
        `sort.contentFieldByType["${typeId}"].value must be a string, a finite number or null.`,
      );
    }
  }
};

/** The page a query reads when it names no `limit`. */
export const DEFAULT_QUERY_LIMIT = 50;

/** The largest page a query reads, whatever it asks for. */
export const MAX_QUERY_LIMIT = 1000;

/**
 * The query an adapter receives: its shape checked, and every default
 * resolved so no adapter carries one — a named sort runs ascending, no
 * sort is `createdAt` newest first, and the page is DEFAULT_QUERY_LIMIT
 * up to MAX_QUERY_LIMIT. Shape refusals name no capability; see
 * assertQueryCapabilities() for those that do. See docs/spec/data-model.md
 * § Sorting and pagination.
 */
export function resolveQuery(query: PlainQuery): AdapterQuery {
  const { sort, limit, ...rest } = query;
  assertValidBaseIdFilter(query.filter);
  assertValidContentByType(query.filter);
  assertValidSort(sort);
  assertWindowInteger(limit, 'limit', 1);
  assertValidAssociationFilters(query.filter);
  return {
    ...rest,
    sort: sort
      ? ({ ...sort, direction: sort.direction ?? 'asc' } as AdapterSort)
      : { field: 'createdAt', direction: 'desc' },
    limit: Math.min(limit ?? DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT),
  };
}

/** A query split where it enters `Stack`; see splitQuery(). */
export type SplitQuery = {
  query: AdapterQuery;
  presentAt?: StackQuery['presentAt'];
};

/**
 * Split a query at the door into what an adapter sees, resolved, and
 * `presentAt`, which `Stack` applies to the results. Every check runs
 * here, before the adapter is asked. See docs/spec/data-model.md
 * § Sorting and pagination.
 */
export function splitQuery(query: StackQuery): SplitQuery {
  const { presentAt, ...plain } = query;
  return {
    query: resolveQuery(plain),
    ...(presentAt !== undefined && { presentAt }),
  };
}

/**
 * Hold a window bound — a page size, a cursor position — to an integer
 * at or above `min`, the one shape every adapter reads alike: a negative
 * `limit` drops entries from a JS slice but empties or lifts a SQL
 * `LIMIT`. See docs/spec/data-model.md § Sorting and pagination.
 */
export function assertWindowInteger(value: number | undefined, label: string, min: 0 | 1): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < min) {
    throw new StackBadRequestError(
      `Invalid ${label} ${String(value)}: expected ${min === 0 ? 'a non-negative' : 'a positive'} integer.`,
    );
  }
}

function assertSortCapability(
  sort: AdapterSort,
  capabilities: Pick<StackCapabilities, 'sort'>,
): void {
  if (sort.contentFieldByType !== undefined) {
    if (!capabilities.sort.contentFieldByType) {
      throw new StackBadRequestError(
        'Query uses sort.contentFieldByType, but this adapter does not declare the ' +
          'sort.contentFieldByType capability.',
        'sort.contentFieldByType',
      );
    }
    return;
  }
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
  const { field } = sort;
  if (!capabilities.sort.fields.includes(field)) {
    throw new StackBadRequestError(
      `Query sorts by "${field}", which this adapter does not declare in sort.fields.`,
      'sort.fields',
    );
  }
}

/**
 * Reject an association filter that names neither of its halves, or whose
 * relationship target is malformed. `RelatedToFilter` and `AttachmentFilter`
 * promise one half is always present; without the runtime check a filter
 * decoded from a request could arrive empty and match every record carrying
 * any association of that kind. See docs/spec/data-model.md § Filter.
 */
export function assertValidAssociationFilters(filter: RecordFilter | undefined): void {
  const attachment = filter?.attachment;
  if (attachment && attachment.label === undefined && attachment.fileId === undefined) {
    throw new StackBadRequestError(
      'filter.attachment must name a label, a fileId, or both — "any attachment at all" is not a filter.',
    );
  }
  const relatedTo = filter?.relatedTo;
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
 * Refuse a `baseId` argument that cannot name a type family, as an
 * argument error prefixed with the `surface` it was passed to. See
 * familyIdProblem().
 */
export function assertFamilyId(baseId: unknown, surface: string): void {
  const problem = familyIdProblem(baseId, surface);
  if (problem) {
    throw new StackValidationError([{ path: 'baseId', message: problem }], ARGUMENTS_INVALID);
  }
}

/**
 * Refuse a `baseId` carrying an `@version` suffix. A family filter resolves
 * against registered families, so a TypeId there would match nothing and
 * say nothing. See docs/spec/data-model.md § Filter.
 */
export function assertValidBaseIdFilter(filter: { baseId?: string | string[] } | undefined): void {
  if (filter?.baseId === undefined) return;
  const errors = (Array.isArray(filter.baseId) ? filter.baseId : [filter.baseId])
    .map((b) => familyIdProblem(b, 'filter.baseId'))
    .filter((m): m is string => m !== null)
    .map((message) => ({ path: 'filter.baseId', message }));
  if (errors.length > 0) throw new StackValidationError(errors, ARGUMENTS_INVALID);
}

/**
 * A journal window: `afterSeq` 0 is the start of the log. No ceiling is
 * imposed — omitting `limit` reads the whole log by contract, which a
 * clamp would silently truncate.
 */
export function assertValidJournalQuery(query: JournalQuery | undefined): void {
  assertWindowInteger(query?.afterSeq, 'journal afterSeq', 0);
  assertWindowInteger(query?.limit, 'journal limit', 1);
}

/**
 * A `getVersions()` window: `afterVersion` 0 is the start of history. No
 * ceiling is imposed — omitting `limit` reads every version by contract.
 */
export function assertValidVersionsQuery(query: VersionsQuery | undefined): void {
  assertWindowInteger(query?.afterVersion, 'versions afterVersion', 0);
  assertWindowInteger(query?.limit, 'versions limit', 1);
}
