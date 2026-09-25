/**
 * StackQuery -> SQL. Engine-independent — shared verbatim between
 * SQLite-backed record adapters. The one caveat is full-text search:
 * `f.search` here assumes a `records_fts` virtual table with a MATCH-able
 * `content` column (see fts5.ts).
 *
 * A query compiles to a plan rather than to a single statement, because a
 * content-field sort is two orderings end to end: the records that hold a
 * value at the field, ordered by it, then the records that hold none,
 * ordered by id. Reading them as two statements lets each one walk an
 * index in order and stop at the page boundary; the LEFT JOIN that would
 * express the same result in one statement can only be sorted after the
 * fact, which costs a full pass over the table for every page.
 */

import { StackBadRequestError, type StackQuery } from '@haverstack/core';
import { contentSortKey, parseContentFilterKey } from '@haverstack/core/adapter';
import {
  decodeCursor,
  getSortColumn,
  getSortField,
  type DecodedCursor,
  type SortField,
} from './cursor.js';
import { sanitizeFts5Query } from './fts5.js';

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
 * Reduce `sort.direction` to a keyword this module may interpolate into
 * SQL. Core's assertValidSort() already rejects anything else at the
 * invariant layer, but this builder writes the value straight into
 * `ORDER BY` and the cursor comparison, so it re-checks rather than trust
 * an upstream that a future refactor could bypass: an unvalidated direction
 * here is a SQL-injection sink. Anything but "asc" is treated as the
 * default "desc" only after passing the guard.
 */
const sqlDirection = (query: StackQuery): 'ASC' | 'DESC' => {
  const dir = query.sort?.direction ?? 'desc';
  if (dir !== 'asc' && dir !== 'desc') {
    throw new StackBadRequestError(`Invalid sort direction "${dir}": expected "asc" or "desc".`);
  }
  return dir === 'asc' ? 'ASC' : 'DESC';
};

/**
 * Normalize a json_each row's value so one array element and one bare
 * value are walked by the same clause: an array stands for its elements,
 * anything else for itself. See docs/spec/data-model.md § Nested content
 * paths.
 */
const spread = (alias: string): string =>
  `CASE WHEN ${alias}.type = 'array' THEN ${alias}.value ` +
  `WHEN ${alias}.type = 'object' THEN json_array(json(${alias}.value)) ` +
  `ELSE json_array(${alias}.value) END`;

/**
 * The members of a json_each row that is an object, and none for a row
 * that is not — a path descending through a scalar reaches no value rather
 * than reaching an error.
 */
const members = (alias: string): string =>
  `CASE WHEN ${alias}.type = 'object' THEN ${alias}.value ELSE '{}' END`;

/**
 * True when some value reached by `segments` satisfies `leaf`, applied to
 * the alias holding that value. Each segment is a bound parameter matched
 * against json_each's `key`, never interpolated into a path expression, so
 * no key can be read as syntax. See docs/spec/data-model.md § Filter.
 */
const contentPathExists = (
  segments: string[],
  leaf: (alias: string) => string,
  params: unknown[],
  nextAlias: () => string,
): string => {
  // The walk is a flat join list, not a subquery per segment: both SQLite
  // builds cap expression-tree depth far below the segment cap, and
  // nesting spends that budget while a join list spends the join budget
  // the cap is actually sized against.
  let key = nextAlias();
  let value = nextAlias();
  const from = [`json_each(r.content) AS ${key}`, `json_each(${spread(key)}) AS ${value}`];
  const where = [`${key}.key = ?`];
  params.push(segments[0]);

  for (const segment of segments.slice(1)) {
    key = nextAlias();
    from.push(`json_each(${members(value)}) AS ${key}`);
    value = nextAlias();
    from.push(`json_each(${spread(key)}) AS ${value}`);
    where.push(`${key}.key = ?`);
    params.push(segment);
  }

  where.push(leaf(value));
  return `EXISTS (SELECT 1 FROM ${from.join(', ')} WHERE ${where.join(' AND ')})`;
};

/**
 * A scalar filter value never matches an object or array stored at the
 * path: json_each exposes those as their JSON text, which would compare
 * equal to a string spelling the same document while every non-SQL adapter
 * compares the value itself.
 */
const equalsLeaf = (alias: string): string =>
  `${alias}.type NOT IN ('object', 'array') AND ${alias}.value = ?`;

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

const nativeCursor = (cursor: DecodedCursor, field: SortField) => {
  if (cursor.kind !== 'native' || cursor.field !== field) throw cursorMismatch(cursor, field);
  return cursor;
};

const contentCursor = (cursor: DecodedCursor, field: string) => {
  if (cursor.kind === 'native' || cursor.field !== field) throw cursorMismatch(cursor, field);
  return cursor;
};

/**
 * Every condition on the records row itself — everything a query asks
 * except where in the ordering to resume, which is per-partition and gets
 * appended by the caller.
 */
const recordConditions = (query: StackQuery): { conditions: string[]; params: unknown[] } => {
  const conditions: string[] = ["r.id != '_config'"];
  const params: unknown[] = [];
  const f = query.filter ?? {};

  /**
   * A filter that accepts one value or a list of them, as the `IN` that
   * covers both. Written even for a single value rather than as `= ?`,
   * since SQLite plans a one-element IN identically and one form means one
   * place for the filter's placeholder count and its bindings to agree.
   */
  const inFilter = (column: string, value: string | readonly string[] | undefined): void => {
    if (value === undefined) return;
    const values = Array.isArray(value) ? value : [value as string];
    conditions.push(`r.${column} IN (${values.map(() => '?').join(',')})`);
    params.push(...values);
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
  // EXISTS, so the planner drives from the association side — reading the
  // matching record ids straight out of idx_assoc_kind_label /
  // idx_assoc_kind_file_id / idx_assoc_related / idx_content_index_file,
  // each of which ends with record_id and so needs no table read at all —
  // instead of scanning every record and probing for each. The work is
  // proportional to how many records match, not to how many the stack
  // holds.

  /**
   * The semi-join itself. `kind` is one of this module's own literals, never
   * caller text, and each clause carries its own placeholder — so the only
   * thing interpolated here is SQL this file wrote.
   */
  const hasAssociation = (kind: 'tag' | 'attachment' | 'relationship', clauses: string[]): string =>
    `r.id IN (SELECT a.record_id FROM associations a WHERE a.kind = '${kind}'` +
    clauses.map((c) => ` AND ${c}`).join('') +
    `)`;

  // Conjunctive: a record must carry every tag named.
  if (f.tags?.length) {
    for (const tag of f.tags) {
      conditions.push(hasAssociation('tag', ['a.label = ?']));
      params.push(tag);
    }
  }

  if (f.hasAttachment) {
    conditions.push(hasAssociation('attachment', ['a.label = ?']));
    params.push(f.hasAttachment);
  }

  // Attachment file ID filter — find records that reference a specific file,
  // either via an attachment association or a top-level file-ref content field
  if (f.attachmentFileId) {
    conditions.push(
      `(${hasAssociation('attachment', ['a.file_id = ?'])}
        OR r.id IN (SELECT ci.record_id FROM content_index ci WHERE ci.file_id = ?))`,
    );
    params.push(f.attachmentFileId, f.attachmentFileId);
  }

  // Relationship filter — each clause is an optional pattern, so a bare
  // label matches every target under it and an external target with no
  // `id` matches its whole namespace (docs/spec/data-model.md § Filter).
  //
  // A record or entity target always stores '' in related_ns (see
  // associationKeyColumns). Saying so turns idx_assoc_related's
  // (related_scope, related_ns, related_id) prefix into a contiguous
  // equality run for those kinds instead of a seek on related_scope alone.
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

  // Content field filters — a dot-separated path, matched element-wise
  // through arrays. A `null` value means "no value at the path, or a value
  // that is null" (docs/spec/data-model.md § Filter), which is the second
  // arm below: "some value there is null" OR "nothing is there at all".
  if (f.content) {
    let aliasSeq = 0;
    const nextAlias = () => `cp${aliasSeq++}`;
    for (const [key, value] of Object.entries(f.content)) {
      const segments = parseContentFilterKey(key);
      // undefined is the same absence null names — JSON drops it on the
      // way over the wire, so treating it as a value would make an
      // in-process query and its wire equivalent disagree.
      if (value === null || value === undefined) {
        const isNull = contentPathExists(segments, (a) => `${a}.value IS NULL`, params, nextAlias);
        const anyValue = contentPathExists(
          segments,
          (a) => `${a}.value IS NOT NULL`,
          params,
          nextAlias,
        );
        conditions.push(`(${isNull} OR NOT ${anyValue})`);
      } else {
        const match = contentPathExists(segments, equalsLeaf, params, nextAlias);
        params.push(value);
        conditions.push(match);
      }
    }
  }

  // Presence — the question an exact-match value cannot ask. Element-wise
  // like the content filter above: a path holds a value when at least one
  // non-null value is reachable at it. See docs/spec/data-model.md
  // § Filter.
  if (f.contentPresent?.length) {
    let aliasSeq = 0;
    const nextAlias = () => `pp${aliasSeq++}`;
    for (const key of f.contentPresent) {
      conditions.push(
        contentPathExists(
          parseContentFilterKey(key),
          (a) => `${a}.value IS NOT NULL`,
          params,
          nextAlias,
        ),
      );
    }
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

  return { conditions, params };
};

/**
 * Everything ordered after the cursor's record within the partition that
 * holds a value: a later value rank, or the same rank past the cursor's
 * value and id. `op` runs the comparison the same way the ORDER BY does,
 * so one form covers both directions — in the direction where the
 * cursor's rank is the last one, the leading disjunct is simply never
 * true.
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

const statement = (
  select: string,
  from: string,
  conditions: string[],
  params: unknown[],
  tail = '',
): QueryStatement => ({
  sql: `SELECT ${select} FROM ${from} WHERE ${conditions.join(' AND ')}${tail}`,
  params,
});

/**
 * Compile a query into the statements that answer it, read in order and
 * their rows concatenated: the first that fills the page ends the read,
 * so the second is never run for a page that doesn't reach it. Each still
 * needs the row budget its `LIMIT ?` binds — see atBudget.
 */
export const buildQueryPlan = (query: StackQuery): QueryStatement[] => {
  const dir = sqlDirection(query);
  const op = dir === 'ASC' ? '>' : '<';
  const decoded = query.cursor ? decodeCursor(query.cursor) : null;
  const contentField = query.sort?.contentField;

  if (contentField === undefined) {
    const { conditions, params } = recordConditions(query);
    const col = getSortColumn(getSortField(query));
    if (decoded) {
      const cursor = nativeCursor(decoded, getSortField(query));
      conditions.push(`(r.${col} ${op} ? OR (r.${col} = ? AND r.id ${op} ?))`);
      params.push(cursor.value, cursor.value, cursor.id);
    }
    return [
      statement(
        'r.*',
        'records r',
        conditions,
        params,
        ` ORDER BY r.${col} ${dir}, r.id ${dir} LIMIT ?`,
      ),
    ];
  }

  const cursor = decoded ? contentCursor(decoded, contentField) : null;
  const pages: QueryStatement[] = [];

  // Records holding a value at the field, in that value's order. A cursor
  // sitting in the absent partition has already passed every one of them.
  if (cursor?.kind !== 'absent') {
    const { conditions, params } = recordConditions(query);
    const from = `content_index ${SORT_ALIAS} JOIN records r ON r.id = ${SORT_ALIAS}.record_id`;
    conditions.push(`${SORT_ALIAS}.field = ?`);
    params.push(contentField);
    if (cursor) conditions.push(presentCursorCondition(cursor, op, params));
    // Ordered exactly as idx_content_index_sort stores it, so the page is
    // an ordered walk of the index rather than a sort of the matches.
    const order =
      `${SORT_ALIAS}.value_rank ${dir}, ${SORT_ALIAS}.num_value ${dir}, ` +
      `${SORT_ALIAS}.text_key ${dir}, ${SORT_ALIAS}.text_value ${dir}, ` +
      `${SORT_ALIAS}.record_id ${dir}`;
    pages.push(statement('r.*', from, conditions, params, ` ORDER BY ${order} LIMIT ?`));
  }

  // Records holding nothing there, which trail the others whichever way
  // the sort runs (docs/spec/data-model.md § Sorting by a content field).
  {
    const { conditions, params } = recordConditions(query);
    conditions.push(
      `NOT EXISTS (SELECT 1 FROM content_index ${SORT_ALIAS} ` +
        `WHERE ${SORT_ALIAS}.record_id = r.id AND ${SORT_ALIAS}.field = ?)`,
    );
    params.push(contentField);
    if (cursor?.kind === 'absent') {
      conditions.push(`r.id ${op} ?`);
      params.push(cursor.id);
    }
    pages.push(statement('r.*', 'records r', conditions, params, ` ORDER BY r.id ${dir} LIMIT ?`));
  }

  return pages;
};
