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
 * Everything here throws `StackBadRequestError` on malformed input, which
 * servers already map to 400 — see docs/spec/wire-format.md § Error
 * responses.
 */

import { StackBadRequestError } from './errors.js';
import { TARGET_KEYS } from './query-validation.js';
import { NATIVE_SORT_FIELDS } from './types.js';
import type {
  DataAssociation,
  ChangeFilter,
  ChangeKind,
  JournalQuery,
  NativeSortField,
  QuerySort,
  RecordFilter,
  RelatedToFilter,
  AttachmentFilter,
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
const SORT_FIELDS: ReadonlySet<NativeSortField> = new Set(NATIVE_SORT_FIELDS);
const SORT_DIRECTIONS: ReadonlySet<NonNullable<QuerySort['direction']>> = new Set(['asc', 'desc']);
const CHANGE_KINDS: ReadonlySet<ChangeKind> = new Set(['created', 'changed', 'deleted', 'purged']);
const ASSOCIATION_KINDS: ReadonlySet<string> = new Set(['tag', 'attachment', 'relationship']);
const TARGET_KINDS: ReadonlySet<string> = new Set(['record', 'entity', 'external']);

/** Every param `GET /records` defines. See docs/spec/wire-format.md § Records. */
const RECORD_QUERY_PARAMS = [
  'typeId',
  'parentId',
  'appId',
  'createdBySubject',
  'createdByPrincipal',
  'tag',
  'attachmentLabel',
  'attachmentFileId',
  'referencesFileId',
  'relatedTo',
  'relatedToStack',
  'relatedToEntity',
  'relatedToNs',
  'relatedToId',
  'relatedToLabel',
  'search',
  'createdBefore',
  'createdAfter',
  'updatedBefore',
  'updatedAfter',
  'includeDeleted',
  'includeUnlisted',
  'sort',
  'sortContent',
  'direction',
  'limit',
  'cursor',
] as const;

const QUERY_BODY_FILTER_KEYS = [
  'typeId',
  'parentId',
  'appId',
  'createdBy',
  'tags',
  'attachment',
  'referencesFileId',
  'relatedTo',
  'content',
  'contentPresent',
  'search',
  'includeDeleted',
  'includeUnlisted',
  'createdAt',
  'updatedAt',
] as const;

/**
 * Every param `GET /changes` defines. `since` is the resume cursor, which
 * the server reads itself — see parseChangeParams().
 */
const CHANGE_PARAMS = [
  'typeId',
  'baseId',
  'parentId',
  'createdBySubject',
  'createdByPrincipal',
  'kind',
  'include',
  'includeUnlisted',
  'since',
] as const;

/**
 * Strict positive-integer parse for a URL param — rejects "1abc", "2.7",
 * "-5". Also serves the `:version` path params, which share this
 * "malformed, don't silently coerce" requirement.
 */
export function parsePositiveInt(raw: string, label: string): number {
  if (!POSITIVE_INTEGER.test(raw)) throw new StackBadRequestError(`Invalid ${label}: "${raw}"`);
  return parseInt(raw, 10);
}

function requireDate(raw: unknown, label: string): Date {
  const d = parseDate(raw);
  if (!d) throw new StackBadRequestError(`Invalid ${label}: ${JSON.stringify(raw)}`);
  return d;
}

function requireSortField(raw: unknown): NativeSortField {
  if (typeof raw !== 'string' || !SORT_FIELDS.has(raw as NativeSortField))
    throw new StackBadRequestError(`Invalid sort field: ${JSON.stringify(raw)}`);
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
    throw new StackBadRequestError(
      'A sort names either a native field or a content field, never both.',
    );
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
    throw new StackBadRequestError(`Invalid sort direction: ${JSON.stringify(raw)}`);
  return raw as NonNullable<QuerySort['direction']>;
}

function requireString(raw: unknown, label: string): string {
  if (typeof raw !== 'string')
    throw new StackBadRequestError(`Invalid ${label}: expected a string`);
  return raw;
}

function requireStringOrArray(raw: unknown, label: string): string | string[] {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw) && raw.every((v) => typeof v === 'string')) return raw as string[];
  throw new StackBadRequestError(`Invalid ${label}: expected a string or array of strings`);
}

function requireStringArray(raw: unknown, label: string): string[] {
  if (!Array.isArray(raw) || !raw.every((v) => typeof v === 'string'))
    throw new StackBadRequestError(`Invalid ${label}: expected an array of strings`);
  return raw as string[];
}

function requirePlainObject(raw: unknown, label: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new StackBadRequestError(`Invalid ${label}: expected an object`);
  return raw as Record<string, unknown>;
}

/**
 * A plain object carrying only `keys`. An unrecognized key is refused
 * rather than ignored, since ignoring it answers a different request than
 * the one sent. See docs/spec/wire-format.md § Unrecognized input.
 */
function requireKnownKeys(
  raw: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  const obj = requirePlainObject(raw, label);
  const unknown = Object.keys(obj).filter((key) => !keys.includes(key));
  if (unknown.length > 0)
    throw new StackBadRequestError(
      `Unknown key${unknown.length > 1 ? 's' : ''} in ${label}: ${unknown.join(', ')}`,
    );
  return obj;
}

/**
 * Params a filter repeats to name several values. Any other param names
 * one value, so a repeat of it is refused rather than read as its first.
 */
const REPEATABLE_PARAMS: ReadonlySet<string> = new Set([
  'typeId',
  'baseId',
  'appId',
  'createdBySubject',
  'createdByPrincipal',
  'tag',
  'kind',
]);

/** The URL-param form of requireKnownKeys(), which also refuses a repeat. */
function requireKnownParams(url: URL, names: readonly string[]): void {
  const present = [...new Set(url.searchParams.keys())];
  const unknown = present.filter((name) => !names.includes(name));
  if (unknown.length > 0)
    throw new StackBadRequestError(
      `Unknown query param${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`,
    );
  const repeated = present.filter(
    (name) => !REPEATABLE_PARAMS.has(name) && url.searchParams.getAll(name).length > 1,
  );
  if (repeated.length > 0)
    throw new StackBadRequestError(
      `Repeated query param${repeated.length > 1 ? 's' : ''}: ${repeated.join(', ')}`,
    );
}

/** A boolean URL param: absent is false, and only `true`/`false` are values. */
function booleanParam(url: URL, name: string): boolean {
  const value = url.searchParams.get(name);
  if (value === null || value === 'false') return false;
  if (value === 'true') return true;
  throw new StackBadRequestError(`Invalid ${name}: expected true or false, got "${value}"`);
}

function optionalBoolean(raw: unknown, label: string): boolean | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'boolean')
    throw new StackBadRequestError(`Invalid ${label}: expected a boolean`);
  return raw;
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
  if (hasBaseId) throw new StackBadRequestError(BASE_ID_REFUSAL);
  if (hasPresentAt) throw new StackBadRequestError(PRESENT_AT_REFUSAL);
}

/**
 * The client half of the same refusal, applied before a request is built
 * rather than after one arrives. `Stack.query()` resolves `filter.baseId`
 * against registered Types and applies `presentAt` itself, so neither
 * reaches an adapter through it — this catches the direct adapter call,
 * where the encoding would otherwise decide the answer: a query body
 * carries both fields to a server that refuses them, while search params
 * have nowhere to put them and would drop them into a wider result set.
 *
 * Absent and explicitly `undefined` are the same thing here, as they are
 * to `Stack.query()`. The parsers above test key presence instead, because
 * over the wire writing the key at all is a client that meant to send it.
 */
export function assertQueryTravels(query: StackQuery): void {
  assertNoUntravelableFields(query.filter?.baseId !== undefined, query.presentAt !== undefined);
}

// -------------------------------------------------------
// Relationship filter
// -------------------------------------------------------

/**
 * Route a `filter.relatedTo.target` by kind. Core validates the
 * non-emptiness of whichever fields the kind names, so this only rejects
 * a kind it does not recognize.
 */
function parseRelatedToTarget(raw: unknown): RelationshipTargetPattern {
  const label = 'filter.relatedTo.target';
  const kind = requirePlainObject(raw, label).kind;
  if (typeof kind !== 'string' || !TARGET_KINDS.has(kind))
    throw new StackBadRequestError(`Invalid filter.relatedTo.target.kind: ${JSON.stringify(kind)}`);
  const t = requireKnownKeys(raw, TARGET_KEYS[kind as RelationshipTargetPattern['kind']], label);
  if (t.kind === 'record') {
    return {
      kind: 'record',
      recordId: requireString(t.recordId, 'filter.relatedTo.target.recordId'),
      ...(t.stackUrl !== undefined && {
        stackUrl: requireString(t.stackUrl, 'filter.relatedTo.target.stackUrl'),
      }),
    };
  }
  if (t.kind === 'entity') {
    return {
      kind: 'entity',
      entityId: requireString(t.entityId, 'filter.relatedTo.target.entityId'),
    };
  }
  return {
    kind: 'external',
    ns: requireString(t.ns, 'filter.relatedTo.target.ns'),
    ...(t.id !== undefined && { id: requireString(t.id, 'filter.relatedTo.target.id') }),
  };
}

/** A label, a target, or both — the body form of the same filter. */
function parseRelatedToBody(raw: unknown): RelatedToFilter {
  const r = requireKnownKeys(raw, ['label', 'target'], 'filter.relatedTo');
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
    throw new StackBadRequestError(
      'relatedTo, relatedToEntity and relatedToNs name different target kinds and are mutually exclusive',
    );
  }
  if (hasStack && !hasRecord)
    throw new StackBadRequestError('relatedToStack is only valid alongside relatedTo');
  if (hasId && !hasNs)
    throw new StackBadRequestError('relatedToId is only valid alongside relatedToNs');

  let target: RelationshipTargetPattern | undefined;
  if (hasRecord) {
    target = {
      kind: 'record',
      recordId: url.searchParams.get('relatedTo')!,
      ...(hasStack && { stackUrl: url.searchParams.get('relatedToStack')! }),
    };
  } else if (hasEntity) {
    target = { kind: 'entity', entityId: url.searchParams.get('relatedToEntity')! };
  } else if (hasNs) {
    target = {
      kind: 'external',
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

/**
 * The `attachment*` URL params; both halves together match one association.
 * An empty value passes through rather than reading as absent, so it
 * narrows to nothing instead of silently widening the query.
 */
function parseAttachmentParams(url: URL): AttachmentFilter | undefined {
  const label = url.searchParams.get('attachmentLabel');
  const fileId = url.searchParams.get('attachmentFileId');
  if (label === null && fileId === null) return undefined;
  return {
    ...(label !== null && { label }),
    ...(fileId !== null && { fileId }),
  } as AttachmentFilter;
}

function parseAttachmentBody(raw: unknown): AttachmentFilter {
  const a = requireKnownKeys(raw, ['label', 'fileId'], 'filter.attachment');
  return {
    ...(a.label !== undefined && { label: requireString(a.label, 'filter.attachment.label') }),
    ...(a.fileId !== undefined && { fileId: requireString(a.fileId, 'filter.attachment.fileId') }),
  } as AttachmentFilter;
}

// -------------------------------------------------------
// GET /records
// -------------------------------------------------------

/** The author filter, spelled the same on `GET /records` and `GET /changes`. */
function parseCreatedByParams(url: URL): RecordFilter['createdBy'] {
  const subjectIds = url.searchParams.getAll('createdBySubject');
  const principalIds = url.searchParams.getAll('createdByPrincipal');
  if (!subjectIds.length && !principalIds.length) return undefined;
  return {
    ...(subjectIds.length && { subjectId: subjectIds.length === 1 ? subjectIds[0] : subjectIds }),
    ...(principalIds.length && {
      principalId: principalIds.length === 1 ? principalIds[0] : principalIds,
    }),
  };
}

/**
 * Build a `StackQuery` from `GET /records` search params — the inverse of
 * what `APIAdapter` encodes for a server that reaches no content.
 * `parentId=null` is the literal string, the sentinel for "top level":
 * Crockford base-32 excludes `u` and `l`, so no record ID can collide
 * with it. See docs/spec/wire-format.md § Records.
 */
export function parseQueryParams(url: URL): StackQuery {
  assertNoUntravelableFields(url.searchParams.has('baseId'), url.searchParams.has('presentAt'));
  requireKnownParams(url, RECORD_QUERY_PARAMS);

  const filter: RecordFilter = {};

  const typeIds = url.searchParams.getAll('typeId');
  if (typeIds.length) filter.typeId = typeIds.length === 1 ? typeIds[0] : typeIds;

  const parentId = url.searchParams.get('parentId');
  if (parentId !== null) filter.parentId = parentId === 'null' ? null : parentId;

  const appIds = url.searchParams.getAll('appId');
  if (appIds.length) filter.appId = appIds.length === 1 ? appIds[0] : appIds;

  const createdBy = parseCreatedByParams(url);
  if (createdBy) filter.createdBy = createdBy;

  const tags = url.searchParams.getAll('tag');
  if (tags.length) filter.tags = tags;

  const attachment = parseAttachmentParams(url);
  if (attachment) filter.attachment = attachment;

  const referencesFileId = url.searchParams.get('referencesFileId');
  if (referencesFileId) filter.referencesFileId = referencesFileId;

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

  if (booleanParam(url, 'includeDeleted')) filter.includeDeleted = true;
  if (booleanParam(url, 'includeUnlisted')) filter.includeUnlisted = true;

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
    throw new StackBadRequestError(`Invalid limit: ${JSON.stringify(raw)}`);
  return raw;
}

/**
 * Build a `StackQuery` from a `POST /records/query` JSON body — the
 * superset form, which additionally carries `filter.content`. Dates arrive
 * as the ISO strings `JSON.stringify` made of them and are decoded back to
 * `Date`. `undefined` is the absent body; `null` or any other non-object
 * is refused, so a server hands over no body as `undefined`.
 * See docs/spec/wire-format.md § Records.
 */
export function parseQueryBody(raw: unknown): StackQuery {
  if (raw === undefined) return {};
  const body = requirePlainObject(raw, 'query body');
  const f = body.filter !== undefined ? requirePlainObject(body.filter, 'filter') : undefined;
  assertNoUntravelableFields(f !== undefined && 'baseId' in f, 'presentAt' in body);
  requireKnownKeys(body, ['filter', 'sort', 'limit', 'cursor'], 'query body');
  if (f) requireKnownKeys(f, QUERY_BODY_FILTER_KEYS, 'filter');

  const query: StackQuery = {};

  if (f) {
    const filter: RecordFilter = {};

    if (f.typeId !== undefined) filter.typeId = requireStringOrArray(f.typeId, 'filter.typeId');
    if (f.parentId !== undefined)
      filter.parentId = f.parentId === null ? null : requireString(f.parentId, 'filter.parentId');
    if (f.appId !== undefined) filter.appId = requireStringOrArray(f.appId, 'filter.appId');
    if (f.createdBy !== undefined) {
      const by = requireKnownKeys(f.createdBy, ['subjectId', 'principalId'], 'filter.createdBy');
      filter.createdBy = {
        ...(by.subjectId !== undefined && {
          subjectId: requireStringOrArray(by.subjectId, 'filter.createdBy.subjectId'),
        }),
        ...(by.principalId !== undefined && {
          principalId: requireStringOrArray(by.principalId, 'filter.createdBy.principalId'),
        }),
      };
    }
    if (f.tags !== undefined) filter.tags = requireStringArray(f.tags, 'filter.tags');
    if (f.attachment !== undefined) filter.attachment = parseAttachmentBody(f.attachment);
    if (f.referencesFileId !== undefined)
      filter.referencesFileId = requireString(f.referencesFileId, 'filter.referencesFileId');
    if (f.relatedTo !== undefined) filter.relatedTo = parseRelatedToBody(f.relatedTo);
    if (f.content !== undefined) filter.content = requirePlainObject(f.content, 'filter.content');
    if (f.contentPresent !== undefined)
      filter.contentPresent = requireStringArray(f.contentPresent, 'filter.contentPresent');
    if (f.search !== undefined) filter.search = requireString(f.search, 'filter.search');
    if (optionalBoolean(f.includeDeleted, 'filter.includeDeleted')) filter.includeDeleted = true;
    if (optionalBoolean(f.includeUnlisted, 'filter.includeUnlisted')) filter.includeUnlisted = true;

    if (f.createdAt !== undefined) {
      const r = requireKnownKeys(f.createdAt, ['before', 'after'], 'filter.createdAt');
      filter.createdAt = {
        ...(r.before !== undefined && { before: requireDate(r.before, 'filter.createdAt.before') }),
        ...(r.after !== undefined && { after: requireDate(r.after, 'filter.createdAt.after') }),
      };
    }
    if (f.updatedAt !== undefined) {
      const r = requireKnownKeys(f.updatedAt, ['before', 'after'], 'filter.updatedAt');
      filter.updatedAt = {
        ...(r.before !== undefined && { before: requireDate(r.before, 'filter.updatedAt.before') }),
        ...(r.after !== undefined && { after: requireDate(r.after, 'filter.updatedAt.after') }),
      };
    }

    query.filter = filter;
  }

  if (body.sort !== undefined) {
    const s = requireKnownKeys(body.sort, ['field', 'contentField', 'direction'], 'sort');
    const sort = buildSort(s.field, s.contentField, s.direction);
    if (!sort) throw new StackBadRequestError('Invalid sort: expected a field or a contentField.');
    query.sort = sort;
  }

  if (body.limit !== undefined) query.limit = parseLimitValue(body.limit);
  if (body.cursor !== undefined) query.cursor = requireString(body.cursor, 'cursor');

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
  requireKnownParams(url, CHANGE_PARAMS);
  const filter: ChangeFilter = {};

  const typeIds = url.searchParams.getAll('typeId');
  if (typeIds.length) filter.typeId = typeIds.length === 1 ? typeIds[0] : typeIds;

  const baseIds = url.searchParams.getAll('baseId');
  if (baseIds.length) filter.baseId = baseIds.length === 1 ? baseIds[0] : baseIds;

  const parentId = url.searchParams.get('parentId');
  if (parentId !== null) filter.parentId = parentId === 'null' ? null : parentId;

  const createdBy = parseCreatedByParams(url);
  if (createdBy) filter.createdBy = createdBy;

  const kinds = url.searchParams.getAll('kind');
  if (kinds.length) {
    for (const kind of kinds) {
      if (!CHANGE_KINDS.has(kind as ChangeKind))
        throw new StackBadRequestError(`Invalid kind: "${kind}"`);
    }
    filter.kinds = kinds as ChangeKind[];
  }

  const include = url.searchParams.get('include');
  if (include !== null && include !== 'record')
    throw new StackBadRequestError(`Invalid include: "${include}"`);

  return {
    filter,
    includeRecords: include === 'record',
    includeUnlisted: booleanParam(url, 'includeUnlisted'),
  };
}

/**
 * Parse `GET /records/:id/journal`'s query params into the `JournalQuery`
 * `getJournal()` takes. Absent params stay absent rather than defaulting:
 * omitting `limit` reads the whole log by contract, so supplying a page
 * size here would truncate exactly the caller that omitted it.
 *
 * `afterSeq` is a journal `seq` — a dense per-record integer, never the
 * change feed's opaque cursor. See docs/spec/wire-format.md § Journal.
 */
export function parseJournalParams(url: URL): JournalQuery {
  requireKnownParams(url, ['afterSeq', 'limit']);
  const query: JournalQuery = {};
  const afterSeq = url.searchParams.get('afterSeq');
  if (afterSeq !== null) query.afterSeq = parsePositiveInt(afterSeq, 'afterSeq');
  const limit = url.searchParams.get('limit');
  if (limit !== null) query.limit = parsePositiveInt(limit, 'limit');
  return query;
}

// -------------------------------------------------------
// DELETE /records/:id
// -------------------------------------------------------

/**
 * Parse `DELETE /records/:id`'s query params into the `purge` flag. A
 * misspelled or non-boolean `purge` is refused rather than read as a soft
 * delete. See docs/spec/wire-format.md § Records.
 */
export function parseDeleteParams(url: URL): { purge: boolean } {
  requireKnownParams(url, ['purge']);
  return { purge: booleanParam(url, 'purge') };
}

// -------------------------------------------------------
// GET /attachments/:fileId
// -------------------------------------------------------

/**
 * The download params, in the names `resolveAttachmentDownloadContentType()`
 * takes them by. An empty value stays empty rather than absent, so the
 * resolution treats it exactly as it would an omitted one.
 */
export type ParsedDownloadParams = { contentTypeParam?: string; filenameParam?: string };

/** Parse `GET /attachments/:fileId`'s query params. See docs/spec/wire-format.md § Download. */
export function parseDownloadParams(url: URL): ParsedDownloadParams {
  requireKnownParams(url, ['contentType', 'filename']);
  const contentType = url.searchParams.get('contentType');
  const filename = url.searchParams.get('filename');
  return {
    ...(contentType !== null && { contentTypeParam: contentType }),
    ...(filename !== null && { filenameParam: filename }),
  };
}

// -------------------------------------------------------
// GET /records/:id/associations
// -------------------------------------------------------

export type ParsedAssociationParams = { kind?: DataAssociation['kind']; label?: string };

/**
 * Parse `GET /records/:id/associations`' query params. An unrecognized
 * `kind` is refused, since reading it as absent would answer with every
 * kind. `kind` repeats on `GET /changes` but names one value here, so a
 * repeat is refused rather than read as its first.
 * See docs/spec/wire-format.md § Associations.
 */
export function parseAssociationParams(url: URL): ParsedAssociationParams {
  requireKnownParams(url, ['kind', 'label']);
  if (url.searchParams.getAll('kind').length > 1)
    throw new StackBadRequestError('Repeated query param: kind');
  const kind = url.searchParams.get('kind');
  if (kind !== null && !ASSOCIATION_KINDS.has(kind))
    throw new StackBadRequestError(`Invalid kind: "${kind}"`);
  const label = url.searchParams.get('label');
  return {
    ...(kind !== null && { kind: kind as DataAssociation['kind'] }),
    ...(label !== null && { label }),
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
