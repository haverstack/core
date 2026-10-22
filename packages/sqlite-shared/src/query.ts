/**
 * StackQuery -> SQL. Engine-independent — shared verbatim between
 * SQLite-backed record adapters. The one caveat is full-text search:
 * `f.search` here assumes a `records_fts` virtual table with a MATCH-able
 * `content` column (see FTS5_SCHEMA_SQL in schema.ts).
 *
 * A query compiles to a plan rather than to a single statement, because a
 * content-field sort is two orderings end to end: the records that hold a
 * value at the field, ordered by it, then the records that hold none,
 * ordered by id. Reading them as two statements lets each one walk an
 * index in order and stop at the page boundary; the LEFT JOIN that would
 * express the same result in one statement can only be sorted after the
 * fact, which costs a full pass over the table for every page.
 */

import {
  StackBadRequestError,
  type AuthorityAssociation,
  type ContentArm,
  type ContentSortKey,
  type NativeSortField,
} from '@haverstack/core';
import { constantSortEntry, contentSortKey, parseContentFilterKey } from '@haverstack/core/adapter';
import type { AdapterQuery, Reach, SortEntry } from '@haverstack/core/adapter';
import {
  byTypeDescriptor,
  decodeCursor,
  getSortColumn,
  getSortField,
  type DecodedCursor,
} from './cursor.js';
import { sanitizeFts5Query } from './fts5.js';
import { permissionKeyColumns } from './mappers.js';

/** One statement plus the parameters it binds, in textual order. */
export type QueryStatement = { sql: string; params: unknown[] };

/**
 * A page statement with the row budget its trailing `LIMIT ?` binds.
 * buildQueryPlan leaves that parameter off, so the budget is never one of
 * the parameters the query itself bound: the second partition of a
 * content sort asks for what the first left of the page rather than for a
 * page it then discards.
 */
export const atBudget = (page: QueryStatement, rows: number): QueryStatement => ({
  sql: page.sql,
  params: [...page.params, rows],
});

/**
 * Reduce `sort.direction` to a keyword safe to interpolate. Core's
 * assertValidSort() already checks it, but this is where it reaches SQL
 * text, so an unchecked value here would be an injection sink. Core
 * resolves the default direction before any adapter sees the query.
 */
const sqlDirection = (query: AdapterQuery): 'ASC' | 'DESC' => {
  // No sort at all is the unsorted default; a sort always carries its direction.
  const dir = query.sort ? query.sort.direction : 'desc';
  if (dir !== 'asc' && dir !== 'desc') {
    throw new StackBadRequestError(`Invalid sort direction "${dir}": expected "asc" or "desc".`);
  }
  return dir === 'asc' ? 'ASC' : 'DESC';
};

/**
 * Normalize a json_each row's value so one array element and one bare
 * value are walked by the same clause: an array stands for its elements,
 * anything else for itself. A boolean is rewrapped from its type, since
 * json_each's `value` reads it as 0 or 1. See docs/spec/data-model.md
 * § Nested content paths.
 */
const spread = (alias: string): string =>
  `CASE ${alias}.type WHEN 'array' THEN ${alias}.value ` +
  `WHEN 'object' THEN json_array(json(${alias}.value)) ` +
  `WHEN 'true' THEN '[true]' WHEN 'false' THEN '[false]' ` +
  `ELSE json_array(${alias}.value) END`;

/**
 * The members of a walk row that is an object, and none for a row that is
 * not — a path descending through a scalar reaches no value rather than
 * reaching an error.
 */
const members = (alias: string): string =>
  `CASE WHEN ${alias}.t = 'object' THEN ${alias}.v ELSE '{}' END`;

/**
 * One statement as it is built: its tables, then its conditions on `r` and
 * the parameters its text binds, in textual order. Every table's parameter
 * binds ahead of the text's, since the tables lead the statement.
 */
type Statement = {
  tables: string[];
  tableParams: unknown[];
  conditions: string[];
  params: unknown[];
};

const emptyStatement = (): Statement => ({
  tables: [],
  tableParams: [],
  conditions: ["r.id != '_config'"],
  params: [],
});

/**
 * Tuples as a table of `s` with `columns`, named in tuple order: the one
 * shape a caller-sized part of a query takes. It binds as one JSON
 * parameter, so the statement never grows with it, and is materialized
 * once, so nothing that reads it per record re-parses the JSON. Returns the
 * table's name. See docs/spec/adapters.md § Statement size.
 */
const rows = (s: Statement, columns: readonly string[], tuples: unknown[][]): string => {
  const name = `t${s.tables.length}`;
  s.tables.push(`${name} AS MATERIALIZED ${rowsTable(columns)}`);
  s.tableParams.push(JSON.stringify(tuples));
  return name;
};

/** The table rows() binds, for a statement outside the query plan. */
export const rowsTable = (columns: readonly string[]): string => {
  const named = columns.map((column, i) => `json_extract(value, '$[${i}]') AS ${column}`);
  return `(SELECT ${named.join(', ')} FROM json_each(?))`;
};

/** The columns of a content condition; see contentRows(). */
const CONDITION_COLUMNS = ['scope', 'path', 'op', 'val', 'kind'];

/**
 * A JSON value's type as json_each reports it, with integer and real as one
 * number: what an `equals` condition compares besides the value itself, as
 * `===` does. valueKind() reads a filter value the same way.
 */
const kindOf = (type: string): string =>
  `CASE ${type} WHEN 'integer' THEN 'number' WHEN 'real' THEN 'number' ELSE ${type} END`;

/**
 * Whether condition row `c` holds for record row `r`: one walk of the path
 * as data, a segment matched against json_each's `key` per step, gathering
 * what each op asks of the values it reaches. See docs/spec/adapters.md
 * § Statement size and docs/spec/data-model.md § Filter.
 */
const holds = (c: string, r: string): string => {
  const depth = `json_array_length(${c}.path)`;
  return (
    `(WITH RECURSIVE w(d, v, t) AS (SELECT 0, ${r}.content, 'object' UNION ALL ` +
    `SELECT w.d + 1, e.value, e.type FROM w JOIN json_each(${members('w')}) m ` +
    `JOIN json_each(${spread('m')}) e ` +
    `WHERE w.d < ${depth} AND m.key = json_extract(${c}.path, '$[' || w.d || ']')) ` +
    `SELECT CASE ${c}.op ` +
    `WHEN 'equals' THEN IFNULL(MAX(${kindOf('w.t')} = ${c}.kind AND w.v = ${c}.val), 0) ` +
    "WHEN 'present' THEN IFNULL(MAX(w.t != 'null'), 0) " +
    "WHEN 'isNull' THEN IFNULL(MAX(w.t = 'null'), 0) OR NOT IFNULL(MAX(w.t != 'null'), 0) " +
    `END FROM w WHERE w.d = ${depth})`
  );
};

/** The join alias the content index is read through. */
const SORT_ALIAS = 'cs';

/**
 * A cursor names a position in one ordering; carrying it into another
 * would silently resume somewhere arbitrary. The partition matters as
 * much as the field name — a cursor from a numeric page can't be read
 * against text values — so each ordering below accepts only the cursors
 * it can read, and rejecting the rest is what narrows the cursor to them.
 */
const cursorMismatch = (cursor: DecodedCursor, field: string): StackBadRequestError =>
  new StackBadRequestError(
    `Cursor sort field "${cursor.field}" does not match query sort field "${field}"`,
  );

const nativeCursor = (cursor: DecodedCursor, field: NativeSortField) => {
  if (cursor.kind !== 'native' || cursor.field !== field) throw cursorMismatch(cursor, field);
  return cursor;
};

const contentCursor = (cursor: DecodedCursor, field: string) => {
  if (cursor.kind === 'native' || cursor.field !== field) throw cursorMismatch(cursor, field);
  return cursor;
};

/** A filter value's kindOf(), which it mirrors, or null for one nothing equals. */
const valueKind = (value: unknown): string | null => {
  if (typeof value === 'boolean') return `${value}`;
  if (typeof value === 'number') return 'number';
  return typeof value === 'string' ? 'text' : null;
};

/**
 * A `content` and `contentPresent` predicate as condition rows scoped to
 * `scope`: path segments, the op, and for `equals` the value and its
 * valueKind(). A `null` value means "no value at the path, or a value that
 * is null" (docs/spec/data-model.md § Filter).
 */
const contentRows = (scope: string | null, predicate: ContentArm): unknown[][] => {
  const row = (key: string, op: string, value: unknown = null) => {
    const path = parseContentFilterKey(key);
    return [scope, path, op, value, valueKind(value)];
  };
  return [
    ...Object.entries(predicate.content ?? {}).map(([key, value]) =>
      // undefined is the same absence null names — JSON drops it on the way
      // over the wire, so treating it as a value would make an in-process
      // query and its wire equivalent disagree.
      value === null || value === undefined ? row(key, 'isNull') : row(key, 'equals', value),
    ),
    ...(predicate.contentPresent ?? []).map((key) => row(key, 'present')),
  ];
};

/**
 * Values as the condition matching any of them: rows() of one column, or
 * one value bound as itself, so an index on the column still yields rows in
 * its order. An empty list matches nothing.
 */
const inList = (s: Statement, column: string, values: readonly string[]): string => {
  if (values.length === 1) {
    s.params.push(values[0]);
    return `${column} = ?`;
  }
  const table = rows(
    s,
    ['value'],
    values.map((value) => [value]),
  );
  return `${column} IN (SELECT value FROM ${table})`;
};

/**
 * Whether the record carries every element of one of `sets`, matched on the
 * permissions table's key — the identity editAccess() removes by — through
 * idx_permissions_element. Each element is a row naming its set and that
 * set's size; an empty set matches nothing.
 */
const carriesPermissions = (s: Statement, sets: AuthorityAssociation[][]): string => {
  const elements = rows(
    s,
    ['set_index', 'set_size', 'kind', 'label', 'grantee_kind', 'grantee_id', 'role'],
    sets.flatMap((set, i) =>
      set.map((p) => [i, set.length, p.kind, p.label, ...permissionKeyColumns(p)]),
    ),
  );
  return (
    `r.id IN (SELECT p.record_id FROM ${elements} e JOIN permissions p ` +
    'ON p.kind = e.kind AND p.label = e.label AND p.grantee_kind = e.grantee_kind ' +
    'AND p.grantee_id = e.grantee_id AND p.role = e.role ' +
    'GROUP BY p.record_id, e.set_index HAVING COUNT(*) = MAX(e.set_size))'
  );
};

/**
 * The reach as conditions on `r`: inside the fence, and inside `within` by
 * one of its arms. See docs/spec/access-control.md § Reach.
 */
const reachConditions = (s: Statement, reach: Reach): void => {
  if (reach.fence) s.conditions.push(inList(s, 'r.type_id', reach.fence));
  const within = reach.within;
  if (within) {
    const arms = [inList(s, 'r.type_id', within.types)];
    if (within.authored) {
      s.params.push(within.authored.subjectId);
      arms.push(`(r.entity_id = ? AND ${inList(s, 'r.type_id', within.authored.types)})`);
    }
    arms.push(carriesPermissions(s, within.permissions));
    s.conditions.push(`(${arms.join(' OR ')})`);
  }
};

/**
 * Every condition on the records row itself — everything a query asks
 * except where in the ordering to resume, which is per-partition and gets
 * appended by the caller.
 */
const recordConditions = (query: AdapterQuery, reach: Reach | undefined): Statement => {
  const s = emptyStatement();
  const { conditions, params } = s;
  const f = query.filter ?? {};

  /**
   * A filter that accepts one value or a list of them, as the one `IN` that
   * covers both — see inList().
   */
  const inFilter = (column: string, value: string | readonly string[] | undefined): void => {
    if (value === undefined) return;
    conditions.push(inList(s, `r.${column}`, Array.isArray(value) ? value : [value as string]));
  };

  /** One side of a date range, as the open-ended comparison it is. */
  const rangeFilter = (
    column: string,
    range: { after?: Date; before?: Date } | undefined,
  ): void => {
    if (range?.after) {
      conditions.push(`r.${column} > ?`);
      params.push(range.after.getTime());
    }
    if (range?.before) {
      conditions.push(`r.${column} < ?`);
      params.push(range.before.getTime());
    }
  };

  if (!f.includeDeleted) {
    conditions.push('r.deleted_at IS NULL');
  }

  if (!f.includeUnlisted) {
    conditions.push('r.unlisted_at IS NULL');
  }

  if (reach) reachConditions(s, reach);

  inFilter('type_id', f.typeId);

  // Not an inFilter: parentId takes an explicit null for "at the root",
  // which is a different SQL predicate rather than a different value.
  if (f.parentId !== undefined) {
    if (f.parentId === null) {
      conditions.push('r.parent_id IS NULL');
    } else {
      conditions.push('r.parent_id = ?');
      params.push(f.parentId);
    }
  }

  inFilter('app_id', f.appId);
  inFilter('entity_id', f.createdBy?.subjectId);
  inFilter('principal_id', f.createdBy?.principalId);

  rangeFilter('created_at', f.createdAt);
  rangeFilter('updated_at', f.updatedAt);

  // Every association filter below is a semi-join rather than a correlated
  // EXISTS, so the planner reads matching record ids straight out of an
  // index ending in record_id instead of probing once per record: the work
  // scales with the matches, not the stack.

  /**
   * The semi-join itself. `kind` is one of this module's own literals, never
   * caller text, and each clause carries its own placeholder — so the only
   * thing interpolated here is SQL this file wrote.
   */
  const hasAssociation = (kind: 'tag' | 'attachment' | 'relationship', clauses: string[]): string =>
    `r.id IN (SELECT a.record_id FROM associations a WHERE a.kind = '${kind}'` +
    clauses.map((c) => ` AND ${c}`).join('') +
    `)`;

  // Conjunctive: a record must carry every tag named, so its matches are
  // counted against the distinct tags asked for, the list bound as one.
  if (f.tags?.length) {
    const tags = [...new Set(f.tags)];
    const label = inList(s, 'a.label', tags);
    conditions.push(
      `r.id IN (SELECT a.record_id FROM associations a WHERE a.kind = 'tag' AND ${label} ` +
        `GROUP BY a.record_id HAVING COUNT(DISTINCT a.label) = ?)`,
    );
    params.push(tags.length);
  }

  // Both halves in one subquery, so they match the same association.
  if (f.attachment) {
    const clauses: string[] = [];
    if (f.attachment.label !== undefined) {
      clauses.push('a.label = ?');
      params.push(f.attachment.label);
    }
    if (f.attachment.fileId !== undefined) {
      clauses.push('a.file_id = ?');
      params.push(f.attachment.fileId);
    }
    conditions.push(hasAssociation('attachment', clauses));
  }

  // A reference is an attachment association or a top-level file-ref field.
  if (f.referencesFileId) {
    conditions.push(
      `(${hasAssociation('attachment', ['a.file_id = ?'])}
        OR r.id IN (SELECT ci.record_id FROM content_index ci WHERE ci.file_id = ?))`,
    );
    params.push(f.referencesFileId, f.referencesFileId);
  }

  // Each clause is an optional pattern (docs/spec/data-model.md § Filter).
  // A record or entity target always stores '' in related_ns; saying so
  // keeps idx_assoc_related's prefix a contiguous equality run.
  if (f.relatedTo) {
    const clauses: string[] = [];
    const target = f.relatedTo.target;
    if (f.relatedTo.label !== undefined) {
      clauses.push('a.label = ?');
      params.push(f.relatedTo.label);
    }
    if (target) {
      clauses.push('a.related_scope = ?');
      params.push(target.kind);
      if (target.kind === 'record') {
        clauses.push('a.related_ns = ?', 'a.related_id = ?', 'a.related_stack = ?');
        params.push('', target.recordId, target.stackUrl ?? '');
      } else if (target.kind === 'entity') {
        clauses.push('a.related_ns = ?', 'a.related_id = ?');
        params.push('', target.entityId);
      } else {
        clauses.push('a.related_ns = ?');
        params.push(target.ns);
        if (target.id !== undefined) {
          clauses.push('a.related_id = ?');
          params.push(target.id);
        }
      }
    }
    conditions.push(hasAssociation('relationship', clauses));
  }

  // An arm is the content filter scoped to one Type; types partition
  // records, so a record meets at most the arm for its own type
  // (docs/spec/data-model.md § Content by type).
  const content = contentRows(null, f);
  if (f.contentByType) {
    const arms = Object.entries(f.contentByType);
    // The Types themselves bound the result too: an empty arm adds no
    // condition row, yet still admits only its own Type.
    const typeIds = arms.map(([typeId]) => typeId);
    conditions.push(inList(s, 'r.type_id', typeIds));
    for (const [typeId, arm] of arms) content.push(...contentRows(typeId, arm));
  }

  if (content.length > 0) {
    const table = rows(s, CONDITION_COLUMNS, content);
    conditions.push(
      `NOT EXISTS (SELECT 1 FROM ${table} c WHERE (c.scope IS NULL OR c.scope = r.type_id) ` +
        `AND NOT ${holds('c', 'r')})`,
    );
  }

  if (f.search) {
    const sanitized = sanitizeFts5Query(f.search);
    if (sanitized) {
      conditions.push(`r.rowid IN (SELECT rowid FROM records_fts WHERE records_fts MATCH ?)`);
      params.push(sanitized);
    } else {
      // A search that sanitizes to nothing (e.g. "*", punctuation-only) is
      // an honest zero-match result, not "no filter" — omitting the clause
      // would silently return the full table as the "search result".
      conditions.push('0');
    }
  }

  return s;
};

/**
 * Everything after the cursor's record within the partition that holds a
 * value. `op` compares the way the ORDER BY does, so one form covers both
 * directions; where the cursor's rank is the last one, the leading
 * disjunct is simply never true.
 */
const presentCursorCondition = (
  cursor: Extract<DecodedCursor, { kind: 'num' | 'text' }>,
  op: '>' | '<',
  params: unknown[],
): string => {
  if (cursor.kind === 'num') {
    params.push(cursor.value, cursor.value, cursor.id);
    return (
      `(${SORT_ALIAS}.value_rank ${op} 0 OR (${SORT_ALIAS}.value_rank = 0 AND ` +
      `(${SORT_ALIAS}.num_value ${op} ? OR (${SORT_ALIAS}.num_value = ? AND ` +
      `${SORT_ALIAS}.record_id ${op} ?))))`
    );
  }
  const key = contentSortKey(cursor.value);
  params.push(key, key, cursor.value, cursor.value, cursor.id);
  return (
    `(${SORT_ALIAS}.value_rank ${op} 1 OR (${SORT_ALIAS}.value_rank = 1 AND ` +
    `(${SORT_ALIAS}.text_key ${op} ? OR (${SORT_ALIAS}.text_key = ? AND ` +
    `(${SORT_ALIAS}.text_value ${op} ? OR (${SORT_ALIAS}.text_value = ? AND ` +
    `${SORT_ALIAS}.record_id ${op} ?))))))`
  );
};

/** `s` as one statement reading `r` from `from`, its tables leading. */
const statement = (s: Statement, from: string, tail: string): QueryStatement => {
  const select = `SELECT r.* FROM ${from} WHERE ${s.conditions.join(' AND ')}${tail}`;
  const sql = s.tables.length === 0 ? select : `WITH ${s.tables.join(', ')} ${select}`;
  return { sql, params: [...s.tableParams, ...s.params] };
};

/**
 * Compile a query into the statements that answer it, read in order and
 * their rows concatenated: the first that fills the page ends the read,
 * so the second is never run for a page that doesn't reach it. Each still
 * needs the row budget its `LIMIT ?` binds — see atBudget.
 */
export const buildQueryPlan = (query: AdapterQuery, reach?: Reach): QueryStatement[] => {
  const dir = sqlDirection(query);
  const op = dir === 'ASC' ? '>' : '<';
  const decoded = query.cursor ? decodeCursor(query.cursor) : null;
  if (query.sort?.contentFieldByType) {
    return byTypePlan(query, reach, query.sort.contentFieldByType, dir, op, decoded);
  }
  const contentField = query.sort?.contentField;

  if (contentField === undefined) {
    const where = recordConditions(query, reach);
    const field = getSortField(query);
    const col = getSortColumn(field);
    if (decoded) {
      const cursor = nativeCursor(decoded, field);
      where.conditions.push(`(r.${col} ${op} ? OR (r.${col} = ? AND r.id ${op} ?))`);
      where.params.push(cursor.value, cursor.value, cursor.id);
    }
    return [statement(where, 'records r', ` ORDER BY r.${col} ${dir}, r.id ${dir} LIMIT ?`)];
  }

  const cursor = decoded ? contentCursor(decoded, contentField) : null;
  const pages: QueryStatement[] = [];

  // Records holding a value at the field, in that value's order. A cursor
  // sitting in the absent partition has already passed every one of them.
  if (cursor?.kind !== 'absent') {
    const where = recordConditions(query, reach);
    const from = `content_index ${SORT_ALIAS} JOIN records r ON r.id = ${SORT_ALIAS}.record_id`;
    where.conditions.push(`${SORT_ALIAS}.field = ?`);
    where.params.push(contentField);
    if (cursor) where.conditions.push(presentCursorCondition(cursor, op, where.params));
    // Ordered exactly as idx_content_index_sort stores it, so the page is
    // an ordered walk of the index rather than a sort of the matches.
    const order =
      `${SORT_ALIAS}.value_rank ${dir}, ${SORT_ALIAS}.num_value ${dir}, ` +
      `${SORT_ALIAS}.text_key ${dir}, ${SORT_ALIAS}.text_value ${dir}, ` +
      `${SORT_ALIAS}.record_id ${dir}`;
    pages.push(statement(where, from, ` ORDER BY ${order} LIMIT ?`));
  }

  // Records holding nothing there, which trail the others whichever way
  // the sort runs (docs/spec/data-model.md § Sorting by a content field).
  {
    const where = recordConditions(query, reach);
    where.conditions.push(
      `NOT EXISTS (SELECT 1 FROM content_index ${SORT_ALIAS} ` +
        `WHERE ${SORT_ALIAS}.record_id = r.id AND ${SORT_ALIAS}.field = ?)`,
    );
    where.params.push(contentField);
    if (cursor?.kind === 'absent') {
      where.conditions.push(`r.id ${op} ?`);
      where.params.push(cursor.id);
    }
    pages.push(statement(where, 'records r', ` ORDER BY r.id ${dir} LIMIT ?`));
  }

  return pages;
};

/**
 * A sort naming its value per Type, read through a derived table in place
 * of the index: each Type's own index rows, and its constant in the index's
 * columns, so one cursor condition and one ORDER BY serve both. Fields and
 * constants are each rows(). See docs/spec/data-model.md § Sorting by a content field.
 */
const byTypePlan = (
  query: AdapterQuery,
  reach: Reach | undefined,
  byType: Record<string, ContentSortKey>,
  dir: 'ASC' | 'DESC',
  op: '>' | '<',
  decoded: DecodedCursor | null,
): QueryStatement[] => {
  const cursor = decoded ? contentCursor(decoded, byTypeDescriptor(byType)) : null;
  const fields: [string, string][] = [];
  const constants: [string, SortEntry][] = [];
  for (const [typeId, key] of Object.entries(byType)) {
    if (key.field !== undefined) {
      fields.push([typeId, key.field]);
      continue;
    }
    const entry = constantSortEntry(key.value ?? null);
    if (entry) constants.push([typeId, entry]);
  }
  const pages: QueryStatement[] = [];

  if (cursor?.kind !== 'absent' && fields.length + constants.length > 0) {
    const where = recordConditions(query, reach);
    const sources: string[] = [];
    if (fields.length > 0) {
      const byField = rows(where, ['type_id', 'field'], fields);
      sources.push(
        'SELECT ci.record_id AS record_id, ci.value_rank AS value_rank, ' +
          'ci.num_value AS num_value, ci.text_key AS text_key, ci.text_value AS text_value ' +
          `FROM ${byField} f JOIN content_index ci ON ci.field = f.field ` +
          'JOIN records t ON t.id = ci.record_id AND t.type_id = f.type_id',
      );
    }
    if (constants.length > 0) {
      const byConstant = rows(
        where,
        ['type_id', 'value_rank', 'num_value', 'text_key', 'text_value'],
        constants.map(([typeId, entry]) =>
          entry.kind === 'num'
            ? [typeId, 0, entry.num, null, null]
            : [typeId, 1, null, entry.key, entry.text],
        ),
      );
      sources.push(
        'SELECT t.id AS record_id, k.value_rank AS value_rank, k.num_value AS num_value, ' +
          'k.text_key AS text_key, k.text_value AS text_value ' +
          `FROM ${byConstant} k JOIN records t ON t.type_id = k.type_id`,
      );
    }
    if (cursor) where.conditions.push(presentCursorCondition(cursor, op, where.params));
    const from =
      `(${sources.join(' UNION ALL ')}) ${SORT_ALIAS} ` +
      `JOIN records r ON r.id = ${SORT_ALIAS}.record_id`;
    const order =
      `${SORT_ALIAS}.value_rank ${dir}, ${SORT_ALIAS}.num_value ${dir}, ` +
      `${SORT_ALIAS}.text_key ${dir}, ${SORT_ALIAS}.text_value ${dir}, ` +
      `${SORT_ALIAS}.record_id ${dir}`;
    pages.push(statement(where, from, ` ORDER BY ${order} LIMIT ?`));
  }

  // Records holding nothing to order by: a Type's field with no value, a
  // `null` constant, or a Type the map does not name.
  {
    const where = recordConditions(query, reach);
    if (fields.length > 0) {
      const byField = rows(where, ['type_id', 'field'], fields);
      where.conditions.push(
        `NOT EXISTS (SELECT 1 FROM ${byField} f JOIN content_index ${SORT_ALIAS} ` +
          `ON ${SORT_ALIAS}.record_id = r.id AND ${SORT_ALIAS}.field = f.field ` +
          'WHERE f.type_id = r.type_id)',
      );
    }
    if (constants.length > 0) {
      const typeIds = constants.map(([typeId]) => typeId);
      where.conditions.push(`NOT (${inList(where, 'r.type_id', typeIds)})`);
    }
    if (cursor?.kind === 'absent') {
      where.conditions.push(`r.id ${op} ?`);
      where.params.push(cursor.id);
    }
    pages.push(statement(where, 'records r', ` ORDER BY r.id ${dir} LIMIT ?`));
  }
  return pages;
};
