/**
 * WHERE/ORDER clause building for StackQuery. Engine-independent SQL —
 * shared verbatim between SQLite-backed record adapters. The one caveat is
 * full-text search: `f.search` here assumes a `records_fts` virtual table
 * with a MATCH-able `content` column (see fts5.ts).
 */

import { StackQueryError, type StackQuery } from '@haverstack/core';
import { contentSortKey, parseContentFilterKey } from '@haverstack/core/adapter';
import {
  decodeCursor,
  getSortColumn,
  getSortField,
  type DecodedCursor,
  type SortField,
} from './cursor.js';
import { sanitizeFts5Query } from './fts5.js';

export { getSortField, getSortColumn };
export type { SortField };

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
    throw new StackQueryError(`Invalid sort direction "${dir}": expected "asc" or "desc".`);
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

/** The join alias the sort index is read through. */
const SORT_ALIAS = 'cs';

/**
 * The sort index row for each record, or none — the source of every
 * `cs.*` term in the order and cursor clauses. A LEFT JOIN rather than an
 * inner one: a record holding no value at the sort field still belongs in
 * the result, at the end of it.
 */
export const buildFromClause = (query: StackQuery): { sql: string; params: unknown[] } => {
  const field = query.sort?.contentField;
  if (field === undefined) return { sql: 'records r', params: [] };
  return {
    sql: `records r LEFT JOIN content_sort ${SORT_ALIAS} ON ${SORT_ALIAS}.record_id = r.id AND ${SORT_ALIAS}.field = ?`,
    params: [field],
  };
};

/**
 * A cursor names a position in one ordering; carrying it into another
 * would silently resume somewhere arbitrary. The partition matters as
 * much as the field name — a cursor from a numeric page can't be read
 * against text values.
 */
const assertCursorMatchesSort = (cursor: DecodedCursor, query: StackQuery): void => {
  const contentField = query.sort?.contentField;
  if (cursor.kind === 'native') {
    const sortField = getSortField(query);
    if (contentField !== undefined || cursor.field !== sortField) {
      throw new StackQueryError(
        `Cursor sort field "${cursor.field}" does not match query sort field ` +
          `"${contentField ?? sortField}"`,
      );
    }
    return;
  }
  if (contentField === undefined || cursor.field !== contentField) {
    throw new StackQueryError(
      `Cursor sort field "${cursor.field}" does not match query sort field ` +
        `"${contentField ?? getSortField(query)}"`,
    );
  }
};

/**
 * Everything ordered after the cursor's record: a later partition, or the
 * same partition past the cursor's value and id. `rank` counts up in the
 * direction the query runs, so one comparison covers both directions and
 * keeps absent values at the end of each.
 */
const contentCursorCondition = (
  cursor: Exclude<DecodedCursor, { kind: 'native' }>,
  op: '>' | '<',
  params: unknown[],
): string => {
  const ascending = op === '>';
  const numRank = ascending ? 0 : 1;
  const textRank = ascending ? 1 : 0;
  const rank = `CASE WHEN ${SORT_ALIAS}.record_id IS NULL THEN 2 WHEN ${SORT_ALIAS}.num_value IS NULL THEN ${textRank} ELSE ${numRank} END`;
  const cursorRank = cursor.kind === 'absent' ? 2 : cursor.kind === 'num' ? numRank : textRank;

  let tail: string;
  if (cursor.kind === 'num') {
    tail = `(${SORT_ALIAS}.num_value ${op} ? OR (${SORT_ALIAS}.num_value = ? AND r.id ${op} ?))`;
    params.push(cursor.value, cursor.value, cursor.id);
  } else if (cursor.kind === 'text') {
    const key = contentSortKey(cursor.value);
    tail =
      `(${SORT_ALIAS}.text_key ${op} ? OR (${SORT_ALIAS}.text_key = ? AND ` +
      `(${SORT_ALIAS}.text_value ${op} ? OR (${SORT_ALIAS}.text_value = ? AND r.id ${op} ?))))`;
    params.push(key, key, cursor.value, cursor.value, cursor.id);
  } else {
    tail = `r.id ${op} ?`;
    params.push(cursor.id);
  }

  return `((${rank}) > ${cursorRank} OR ((${rank}) = ${cursorRank} AND ${tail}))`;
};

export const buildWhereClause = (query: StackQuery): { sql: string; params: unknown[] } => {
  const conditions: string[] = ["r.id != '_config'"];
  const params: unknown[] = [];
  const f = query.filter ?? {};

  if (!f.includeDeleted) {
    conditions.push('r.deleted_at IS NULL');
  }

  if (!f.includeUnlisted) {
    conditions.push('r.unlisted_at IS NULL');
  }

  if (f.typeId !== undefined) {
    const ids = Array.isArray(f.typeId) ? f.typeId : [f.typeId];
    conditions.push(`r.type_id IN (${ids.map(() => '?').join(',')})`);
    params.push(...ids);
  }

  if (f.parentId !== undefined) {
    if (f.parentId === null) {
      conditions.push('r.parent_id IS NULL');
    } else {
      conditions.push('r.parent_id = ?');
      params.push(f.parentId);
    }
  }

  if (f.appId !== undefined) {
    const ids = Array.isArray(f.appId) ? f.appId : [f.appId];
    conditions.push(`r.app_id IN (${ids.map(() => '?').join(',')})`);
    params.push(...ids);
  }

  if (f.entityId !== undefined) {
    const ids = Array.isArray(f.entityId) ? f.entityId : [f.entityId];
    conditions.push(`r.entity_id IN (${ids.map(() => '?').join(',')})`);
    params.push(...ids);
  }

  if (f.principalId !== undefined) {
    const ids = Array.isArray(f.principalId) ? f.principalId : [f.principalId];
    conditions.push(`r.principal_id IN (${ids.map(() => '?').join(',')})`);
    params.push(...ids);
  }

  if (f.createdAt?.after) {
    conditions.push('r.created_at > ?');
    params.push(f.createdAt.after.getTime());
  }
  if (f.createdAt?.before) {
    conditions.push('r.created_at < ?');
    params.push(f.createdAt.before.getTime());
  }
  if (f.updatedAt?.after) {
    conditions.push('r.updated_at > ?');
    params.push(f.updatedAt.after.getTime());
  }
  if (f.updatedAt?.before) {
    conditions.push('r.updated_at < ?');
    params.push(f.updatedAt.before.getTime());
  }

  // Every association filter below is a semi-join rather than a correlated
  // EXISTS, so the planner drives from the association side — reading the
  // matching rows through idx_assoc_kind_label / idx_assoc_kind_file_id /
  // idx_file_refs_file_id and looking up those records — instead of
  // scanning every record and probing for each. The work is proportional
  // to how many records match, not to how many the stack holds.

  // Tag filter — record must have ALL specified tags
  if (f.tags?.length) {
    for (const tag of f.tags) {
      conditions.push(
        `r.id IN (SELECT a.record_id FROM associations a WHERE a.kind = 'tag' AND a.label = ?)`,
      );
      params.push(tag);
    }
  }

  // Attachment label filter
  if (f.hasAttachment) {
    conditions.push(
      `r.id IN (SELECT a.record_id FROM associations a WHERE a.kind = 'attachment' AND a.label = ?)`,
    );
    params.push(f.hasAttachment);
  }

  // Attachment file ID filter — find records that reference a specific file,
  // either via an attachment association or a top-level file-ref content field
  if (f.attachmentFileId) {
    conditions.push(
      `(r.id IN (SELECT a.record_id FROM associations a WHERE a.kind = 'attachment' AND a.file_id = ?)
        OR r.id IN (SELECT fr.record_id FROM file_refs fr WHERE fr.file_id = ?))`,
    );
    params.push(f.attachmentFileId, f.attachmentFileId);
  }

  // Relationship filter — each clause is an optional pattern, so a bare
  // label matches every target under it and an external target with no
  // `id` matches its whole namespace (docs/spec/data-model.md § Filter).
  // A target-bearing pattern reads through idx_assoc_related; a bare label
  // through idx_assoc_kind_label.
  if (f.relatedTo) {
    const clauses: string[] = [];
    const target = f.relatedTo.target;
    if (f.relatedTo.label !== undefined) {
      clauses.push('a.label = ?');
      params.push(f.relatedTo.label);
    }
    if (target) {
      clauses.push('a.related_scope = ?');
      params.push(target.scope);
      if (target.scope === 'record') {
        clauses.push('a.related_id = ?', 'a.related_stack = ?');
        params.push(target.recordId, target.stackUrl ?? '');
      } else if (target.scope === 'entity') {
        clauses.push('a.related_id = ?');
        params.push(target.entityId);
      } else {
        clauses.push('a.related_ns = ?');
        params.push(target.ns);
        if (target.id !== undefined) {
          clauses.push('a.related_id = ?');
          params.push(target.id);
        }
      }
    }
    conditions.push(
      `r.id IN (SELECT a.record_id FROM associations a WHERE a.kind = 'relationship'` +
        clauses.map((c) => ` AND ${c}`).join('') +
        `)`,
    );
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

  // Cursor (sort value + id for stable pagination)
  if (query.cursor) {
    const cursor = decodeCursor(query.cursor);
    assertCursorMatchesSort(cursor, query);
    const op = sqlDirection(query) === 'ASC' ? '>' : '<';
    if (cursor.kind === 'native') {
      const col = getSortColumn(cursor.field);
      conditions.push(`(r.${col} ${op} ? OR (r.${col} = ? AND r.id ${op} ?))`);
      params.push(cursor.value, cursor.value, cursor.id);
    } else {
      conditions.push(contentCursorCondition(cursor, op, params));
    }
  }

  return {
    sql: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
};

export const buildOrderClause = (query: StackQuery): string => {
  const dir = sqlDirection(query);
  if (query.sort?.contentField === undefined) {
    return `ORDER BY r.${getSortColumn(getSortField(query))} ${dir}, r.id ${dir}`;
  }
  // Three leading terms before the value itself: absence last whichever
  // way the sort runs, then the numeric partition against the text one,
  // which does turn over with the direction because it is part of the
  // order between values. See docs/spec/data-model.md § Sorting by a
  // content field.
  return (
    `ORDER BY (${SORT_ALIAS}.record_id IS NULL) ASC, (${SORT_ALIAS}.num_value IS NULL) ${dir}, ` +
    `${SORT_ALIAS}.num_value ${dir}, ${SORT_ALIAS}.text_key ${dir}, ` +
    `${SORT_ALIAS}.text_value ${dir}, r.id ${dir}`
  );
};
