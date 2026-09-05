/**
 * Stack — Wire Request Parsing
 * -------------------------------------------------------
 * The parse half of the request encoding `adapter-api` builds: URL search
 * params and JSON bodies in, the core types `Stack` takes out. Core has no
 * HTTP server of its own — this module exists so every server
 * implementation shares one decoding of the query grammar rather than
 * transcribing docs/spec/wire-format.md § Records' parameter table and
 * re-deriving its rules, which is where a miss produces a query that
 * silently widens rather than one that fails.
 *
 * Three things this deliberately does not do:
 *
 * - **No clamping.** A `limit` ceiling is deployment policy, not wire
 *   contract, so the requested limit is reported as asked and the server
 *   applies its own cap afterwards.
 * - **No capability gating.** `assertQueryCapabilities()` in
 *   `@haverstack/core/adapter` stays a separate, deliberate call.
 * - **No value validation beyond shape.** An ID's or a cursor's legality is
 *   `Stack`'s to judge, and judging it twice would let the two answers
 *   drift.
 *
 * Everything here throws `StackQueryError` on malformed input, which
 * servers already map to 400 — see docs/spec/wire-format.md § Error
 * responses.
 */

import { StackQueryError } from './stack.js';
import type {
  ChangeFilter,
  ChangeKind,
  NativeSortField,
  QuerySort,
  RecordFilter,
  RelatedToFilter,
  RelationshipTargetPattern,
  StackQuery,
} from './types.js';

// -------------------------------------------------------
// Shared primitives
// -------------------------------------------------------

/** Parse an ISO date string from a wire body; undefined if absent or invalid. */
export function parseDate(val: unknown): Date | undefined {
  if (typeof val !== 'string') return undefined;
  const d = new Date(val);
  return isNaN(d.getTime()) ? undefined : d;
}

const POSITIVE_INTEGER = /^\d+$/;
const SORT_FIELDS: ReadonlySet<NativeSortField> = new Set(['createdAt', 'updatedAt', 'version']);
const SORT_DIRECTIONS: ReadonlySet<NonNullable<QuerySort['direction']>> = new Set(['asc', 'desc']);
const CHANGE_KINDS: ReadonlySet<ChangeKind> = new Set(['created', 'changed', 'deleted', 'purged']);
const TARGET_SCOPES: ReadonlySet<string> = new Set(['record', 'entity', 'external']);

/**
 * Strict positive-integer parse for a URL param — rejects "1abc", "2.7",
 * "-5". Also serves the `:version` path params, which share this
 * "malformed, don't silently coerce" requirement.
 */
export function parsePositiveInt(raw: string, label: string): number {
  if (!POSITIVE_INTEGER.test(raw)) throw new StackQueryError(`Invalid ${label}: "${raw}"`);
  return parseInt(raw, 10);
}

function requireDate(raw: unknown, label: string): Date {
  const d = parseDate(raw);
  if (!d) throw new StackQueryError(`Invalid ${label}: ${JSON.stringify(raw)}`);
  return d;
}

function requireSortField(raw: unknown): NativeSortField {
  if (typeof raw !== 'string' || !SORT_FIELDS.has(raw as NativeSortField))
    throw new StackQueryError(`Invalid sort field: ${JSON.stringify(raw)}`);
  return raw as NativeSortField;
}

/**
 * The two sort forms are mutually exclusive, and a request naming both is
 * refused rather than resolved in one direction: a content field may be
 * called `version`, so guessing which was meant is exactly the conflation
 * the separate member exists to prevent.
 */
function buildSort(
  field: unknown,
  contentField: unknown,
  direction: unknown,
): QuerySort | undefined {
  if (field !== undefined && field !== null && contentField !== undefined && contentField !== null)
    throw new StackQueryError('A sort names either a native field or a content field, never both.');
  const dir =
    direction === undefined || direction === null ? undefined : requireSortDirection(direction);
  if (contentField !== undefined && contentField !== null) {
    return {
      contentField: requireString(contentField, 'sort content field'),
      ...(dir && { direction: dir }),
    };
  }
  if (field !== undefined && field !== null) {
    return { field: requireSortField(field), ...(dir && { direction: dir }) };
  }
  return undefined;
}

function requireSortDirection(raw: unknown): NonNullable<QuerySort['direction']> {
  if (typeof raw !== 'string' || !SORT_DIRECTIONS.has(raw as NonNullable<QuerySort['direction']>))
    throw new StackQueryError(`Invalid sort direction: ${JSON.stringify(raw)}`);
  return raw as NonNullable<QuerySort['direction']>;
}

function requireString(raw: unknown, label: string): string {
  if (typeof raw !== 'string') throw new StackQueryError(`Invalid ${label}: expected a string`);
  return raw;
}

function requireStringOrArray(raw: unknown, label: string): string | string[] {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw) && raw.every((v) => typeof v === 'string')) return raw as string[];
  throw new StackQueryError(`Invalid ${label}: expected a string or array of strings`);
}

function requireStringArray(raw: unknown, label: string): string[] {
  if (!Array.isArray(raw) || !raw.every((v) => typeof v === 'string'))
    throw new StackQueryError(`Invalid ${label}: expected an array of strings`);
  return raw as string[];
}

function requirePlainObject(raw: unknown, label: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new StackQueryError(`Invalid ${label}: expected an object`);
  return raw as Record<string, unknown>;
}

// -------------------------------------------------------
// Filter fields that never travel
// -------------------------------------------------------

const BASE_ID_REFUSAL =
  'baseId is resolved client-side against registered Types and never travels — send the ' +
  'concrete typeId set it resolves to. See docs/spec/data-model.md § Filter.';

const PRESENT_AT_REFUSAL =
  'presentAt applies migration functions, which are app code rather than server code, so no ' +
  'server can honor it — read records as stored and migrate them client-side. See ' +
  'docs/spec/data-model.md § Type migrations.';

/**
 * Refuse the two `StackQuery` fields with no wire encoding, rather than
 * dropping them. Both would otherwise return a result the caller believes
 * is narrower (`baseId`) or migrated (`presentAt`) than what it holds —
 * the same silent degradation `assertQueryCapabilities()` refuses for a
 * capability-gated filter. See docs/spec/wire-format.md § Records.
 */
function assertNoUntravelableFields(hasBaseId: boolean, hasPresentAt: boolean): void {
  if (hasBaseId) throw new StackQueryError(BASE_ID_REFUSAL);
  if (hasPresentAt) throw new StackQueryError(PRESENT_AT_REFUSAL);
}

// -------------------------------------------------------
// Relationship filter
// -------------------------------------------------------

/**
 * Route a `filter.relatedTo.target` by scope. Core validates the
 * non-emptiness of whichever fields the scope names, so this only rejects
 * a scope it does not recognize.
 */
function parseRelatedToTarget(raw: unknown): RelationshipTargetPattern {
  const t = requirePlainObject(raw, 'filter.relatedTo.target');
  if (typeof t.scope !== 'string' || !TARGET_SCOPES.has(t.scope))
    throw new StackQueryError(`Invalid filter.relatedTo.target.scope: ${JSON.stringify(t.scope)}`);
  if (t.scope === 'record') {
    return {
      scope: 'record',
      recordId: requireString(t.recordId, 'filter.relatedTo.target.recordId'),
      ...(t.stackUrl !== undefined && {
        stackUrl: requireString(t.stackUrl, 'filter.relatedTo.target.stackUrl'),
      }),
    };
  }
  if (t.scope === 'entity') {
    return {
      scope: 'entity',
      entityId: requireString(t.entityId, 'filter.relatedTo.target.entityId'),
    };
  }
  return {
    scope: 'external',
    ns: requireString(t.ns, 'filter.relatedTo.target.ns'),
    ...(t.id !== undefined && { id: requireString(t.id, 'filter.relatedTo.target.id') }),
  };
}

/** A label, a target, or both — the body form of the same filter. */
function parseRelatedToBody(raw: unknown): RelatedToFilter {
  const r = requirePlainObject(raw, 'filter.relatedTo');
  const label =
    r.label !== undefined ? requireString(r.label, 'filter.relatedTo.label') : undefined;
  const target = r.target !== undefined ? parseRelatedToTarget(r.target) : undefined;
  return {
    ...(label !== undefined && { label }),
    ...(target !== undefined && { target }),
  } as RelatedToFilter;
}

/**
 * The `relatedTo*` URL params. Scope is implied by which of them appear and
 * the three are mutually exclusive. An empty value passes through raw
 * rather than as absent — that is what lets core's target validation tell
 * "omitted" from "empty" for `relatedToStack` and `relatedToId`, where the
 * two mean different things and neither is a wildcard.
 * See docs/spec/wire-format.md § Records.
 */
function parseRelatedToParams(url: URL): RelatedToFilter | undefined {
  const hasRecord = url.searchParams.has('relatedTo');
  const hasStack = url.searchParams.has('relatedToStack');
  const hasEntity = url.searchParams.has('relatedToEntity');
  const hasNs = url.searchParams.has('relatedToNs');
  const hasId = url.searchParams.has('relatedToId');
  const label = url.searchParams.get('relatedToLabel');

  if ([hasRecord, hasEntity, hasNs].filter(Boolean).length > 1) {
    throw new StackQueryError(
      'relatedTo, relatedToEntity and relatedToNs name different target scopes and are mutually exclusive',
    );
  }
  if (hasStack && !hasRecord)
    throw new StackQueryError('relatedToStack is only valid alongside relatedTo');
  if (hasId && !hasNs) throw new StackQueryError('relatedToId is only valid alongside relatedToNs');

  let target: RelationshipTargetPattern | undefined;
  if (hasRecord) {
    target = {
      scope: 'record',
      recordId: url.searchParams.get('relatedTo')!,
      ...(hasStack && { stackUrl: url.searchParams.get('relatedToStack')! }),
    };
  } else if (hasEntity) {
    target = { scope: 'entity', entityId: url.searchParams.get('relatedToEntity')! };
  } else if (hasNs) {
    target = {
      scope: 'external',
      ns: url.searchParams.get('relatedToNs')!,
      ...(hasId && { id: url.searchParams.get('relatedToId')! }),
    };
  }

  if (target === undefined && !label) return undefined;
  return {
    ...(target !== undefined && { target }),
    ...(label && { label }),
  } as RelatedToFilter;
}

// -------------------------------------------------------
// GET /records
// -------------------------------------------------------

/**
 * Build a `StackQuery` from `GET /records` search params — the inverse of
 * what `APIAdapter` encodes for a server without `contentFieldQuery`.
 * `parentId=null` is the literal string, the sentinel for "top level":
 * Crockford base-32 excludes `u` and `l`, so no record ID can collide
 * with it. See docs/spec/wire-format.md § Records.
 */
export function parseQueryParams(url: URL): StackQuery {
  assertNoUntravelableFields(url.searchParams.has('baseId'), url.searchParams.has('presentAt'));

  const filter: RecordFilter = {};

  const typeIds = url.searchParams.getAll('typeId');
  if (typeIds.length) filter.typeId = typeIds.length === 1 ? typeIds[0] : typeIds;

  const parentId = url.searchParams.get('parentId');
  if (parentId !== null) filter.parentId = parentId === 'null' ? null : parentId;

  const appIds = url.searchParams.getAll('appId');
  if (appIds.length) filter.appId = appIds.length === 1 ? appIds[0] : appIds;

  const entityIds = url.searchParams.getAll('entityId');
  if (entityIds.length) filter.entityId = entityIds.length === 1 ? entityIds[0] : entityIds;

  const principalIds = url.searchParams.getAll('principalId');
  if (principalIds.length)
    filter.principalId = principalIds.length === 1 ? principalIds[0] : principalIds;

  const tags = url.searchParams.getAll('tag');
  if (tags.length) filter.tags = tags;

  const hasAttachment = url.searchParams.get('hasAttachment');
  if (hasAttachment) filter.hasAttachment = hasAttachment;

  const attachmentFileId = url.searchParams.get('attachmentFileId');
  if (attachmentFileId) filter.attachmentFileId = attachmentFileId;

  const relatedTo = parseRelatedToParams(url);
  if (relatedTo) filter.relatedTo = relatedTo;

  const search = url.searchParams.get('search');
  if (search) filter.search = search;

  const createdBefore = url.searchParams.get('createdBefore');
  const createdAfter = url.searchParams.get('createdAfter');
  if (createdBefore || createdAfter) {
    filter.createdAt = {
      ...(createdBefore && { before: requireDate(createdBefore, 'createdBefore') }),
      ...(createdAfter && { after: requireDate(createdAfter, 'createdAfter') }),
    };
  }

  const updatedBefore = url.searchParams.get('updatedBefore');
  const updatedAfter = url.searchParams.get('updatedAfter');
  if (updatedBefore || updatedAfter) {
    filter.updatedAt = {
      ...(updatedBefore && { before: requireDate(updatedBefore, 'updatedBefore') }),
      ...(updatedAfter && { after: requireDate(updatedAfter, 'updatedAfter') }),
    };
  }

  if (url.searchParams.get('includeDeleted') === 'true') filter.includeDeleted = true;
  if (url.searchParams.get('includeUnlisted') === 'true') filter.includeUnlisted = true;

  const query: StackQuery = {};
  if (Object.keys(filter).length) query.filter = filter;

  const sort = buildSort(
    url.searchParams.get('sort'),
    url.searchParams.get('sortContent'),
    url.searchParams.get('direction'),
  );
  if (sort) query.sort = sort;

  const limit = url.searchParams.get('limit');
  if (limit) query.limit = parsePositiveInt(limit, 'limit');

  const cursor = url.searchParams.get('cursor');
  if (cursor) query.cursor = cursor;

  return query;
}

// -------------------------------------------------------
// POST /records/query
// -------------------------------------------------------

/** Validate a limit that already arrived as a JSON number. */
function parseLimitValue(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0)
    throw new StackQueryError(`Invalid limit: ${JSON.stringify(raw)}`);
  return raw;
}

/**
 * Build a `StackQuery` from a `POST /records/query` JSON body — the
 * superset form, which additionally carries `filter.content`. Dates arrive
 * as the ISO strings `JSON.stringify` made of them and are decoded back to
 * `Date`. See docs/spec/wire-format.md § Records.
 */
export function parseQueryBody(raw: unknown): StackQuery {
  if (!raw || typeof raw !== 'object') return {};
  const body = raw as Record<string, unknown>;
  const f = body.filter !== undefined ? requirePlainObject(body.filter, 'filter') : undefined;
  assertNoUntravelableFields(f !== undefined && 'baseId' in f, 'presentAt' in body);

  const query: StackQuery = {};

  if (f) {
    const filter: RecordFilter = {};

    if (f.typeId !== undefined) filter.typeId = requireStringOrArray(f.typeId, 'filter.typeId');
    if (f.parentId !== undefined)
      filter.parentId = f.parentId === null ? null : requireString(f.parentId, 'filter.parentId');
    if (f.appId !== undefined) filter.appId = requireStringOrArray(f.appId, 'filter.appId');
    if (f.entityId !== undefined)
      filter.entityId = requireStringOrArray(f.entityId, 'filter.entityId');
    if (f.principalId !== undefined)
      filter.principalId = requireStringOrArray(f.principalId, 'filter.principalId');
    if (f.tags !== undefined) filter.tags = requireStringArray(f.tags, 'filter.tags');
    if (f.hasAttachment !== undefined)
      filter.hasAttachment = requireString(f.hasAttachment, 'filter.hasAttachment');
    if (f.attachmentFileId !== undefined)
      filter.attachmentFileId = requireString(f.attachmentFileId, 'filter.attachmentFileId');
    if (f.relatedTo !== undefined) filter.relatedTo = parseRelatedToBody(f.relatedTo);
    if (f.content !== undefined) filter.content = requirePlainObject(f.content, 'filter.content');
    if (f.search !== undefined) filter.search = requireString(f.search, 'filter.search');
    if (f.includeDeleted) filter.includeDeleted = true;
    if (f.includeUnlisted) filter.includeUnlisted = true;

    if (f.createdAt) {
      const r = requirePlainObject(f.createdAt, 'filter.createdAt');
      filter.createdAt = {
        ...(r.before !== undefined && { before: requireDate(r.before, 'filter.createdAt.before') }),
        ...(r.after !== undefined && { after: requireDate(r.after, 'filter.createdAt.after') }),
      };
    }
    if (f.updatedAt) {
      const r = requirePlainObject(f.updatedAt, 'filter.updatedAt');
      filter.updatedAt = {
        ...(r.before !== undefined && { before: requireDate(r.before, 'filter.updatedAt.before') }),
        ...(r.after !== undefined && { after: requireDate(r.after, 'filter.updatedAt.after') }),
      };
    }

    query.filter = filter;
  }

  if (body.sort) {
    const s = requirePlainObject(body.sort, 'sort');
    const sort = buildSort(s.field, s.contentField, s.direction);
    if (!sort) throw new StackQueryError('Invalid sort: expected a field or a contentField.');
    query.sort = sort;
  }

  if (body.limit !== undefined) query.limit = parseLimitValue(body.limit);
  if (typeof body.cursor === 'string') query.cursor = body.cursor;

  return query;
}

// -------------------------------------------------------
// GET /changes
// -------------------------------------------------------

/**
 * What `GET /changes`' query params carry. One object rather than three
 * exports because `includeUnlisted` sits on `SubscribeOptions` rather than
 * `ChangeFilter`, and a server needs it before the stream opens to answer
 * the owner-only 403. See docs/spec/change-feed.md.
 */
export type ParsedChangeParams = {
  filter: ChangeFilter;
  includeRecords: boolean;
  includeUnlisted: boolean;
};

/**
 * Parse `GET /changes`' query params. The resume cursor is deliberately
 * absent: `Last-Event-ID` outranks `?since=`, and reconciling the two is
 * the server's own resumption machinery rather than request encoding.
 */
export function parseChangeParams(url: URL): ParsedChangeParams {
  const filter: ChangeFilter = {};

  const typeIds = url.searchParams.getAll('typeId');
  if (typeIds.length) filter.typeId = typeIds.length === 1 ? typeIds[0] : typeIds;

  const parentId = url.searchParams.get('parentId');
  if (parentId !== null) filter.parentId = parentId === 'null' ? null : parentId;

  const entityId = url.searchParams.get('entityId');
  if (entityId !== null) filter.entityId = entityId;

  const kinds = url.searchParams.getAll('kind');
  if (kinds.length) {
    for (const kind of kinds) {
      if (!CHANGE_KINDS.has(kind as ChangeKind))
        throw new StackQueryError(`Invalid kind: "${kind}"`);
    }
    filter.kinds = kinds as ChangeKind[];
  }

  const include = url.searchParams.get('include');
  if (include !== null && include !== 'record')
    throw new StackQueryError(`Invalid include: "${include}"`);

  return {
    filter,
    includeRecords: include === 'record',
    includeUnlisted: url.searchParams.get('includeUnlisted') === 'true',
  };
}

// -------------------------------------------------------
// Headers
// -------------------------------------------------------

/**
 * Parse an `If-Match: "5"` header into the version for `ifVersion`.
 * A value that is not a bare, optionally quoted version is refused rather
 * than read as absent: the header exists to fence a write, so degrading a
 * malformed one to an unconditional last-writer-wins mutation defeats the
 * only thing it was sent to do. Weak comparators (`W/"5"`) are refused for
 * the same reason — a version match is exact or it is nothing.
 * See docs/spec/wire-format.md § Records.
 */
export function parseIfMatch(header: string | undefined): number | undefined {
  if (header === undefined) return undefined;
  const trimmed = header.trim();
  const unquoted = /^"(.*)"$/.exec(trimmed)?.[1] ?? trimmed;
  return parsePositiveInt(unquoted, 'If-Match');
}

/**
 * Read an upload's filename from its `Content-Disposition`. Prefers the
 * RFC 5987 extended form (`filename*=UTF-8''name.txt`), which is what a
 * client carrying a non-ASCII name sends, and falls back to the plain
 * quoted form. See docs/spec/wire-format.md § Upload.
 */
export function parseUploadFilename(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const extended = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(header);
  if (extended) {
    try {
      return decodeURIComponent(extended[1].trim());
    } catch {
      // Malformed percent-encoding — fall through to the plain form.
    }
  }
  const plain = /filename\s*=\s*"([^"]+)"/i.exec(header);
  return plain ? plain[1] : undefined;
}
