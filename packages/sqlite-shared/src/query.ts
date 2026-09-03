/**
 * WHERE/ORDER clause building for StackQuery. Engine-independent SQL —
 * shared verbatim between SQLite-backed record adapters. The one caveat is
 * full-text search: `f.search` here assumes a `records_fts` virtual table
 * with a MATCH-able `content` column (see fts5.ts).
 */

import { StackQueryError, type StackQuery } from '@haverstack/core';
import { parseContentFilterKey } from '@haverstack/core/adapter';
import { decodeCursor, getSortColumn, getSortField, type SortField } from './cursor.js';
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
 * Normalize a json_each row's value to something json_each can iterate, so
 * one array element and one bare value are walked by the same clause: an
 * array stands for its elements, anything else for itself. This is what
 * makes `emails.value` reach into an array of objects without the caller
 * saying so. See docs/spec/data-model.md § Nested content paths.
 */
const spread = (alias: string): string =>
  `CASE WHEN ${alias}.type = 'array' THEN ${alias}.value ` +
  `WHEN ${alias}.type = 'object' THEN json_array(json(${alias}.value)) ` +
  `ELSE json_array(${alias}.value) END`;

/**
 * True when some value reached by `segments` satisfies `leaf` (an operator
 * fragment such as `= ?` or `IS NULL`, applied to the value found there).
 *
 * Segments are matched against json_each's `key` column rather than
 * interpolated into a JSON path expression: a path string would have to be
 * repeated inside the CASE above, and a repeated `?` needs its parameter
 * bound once per occurrence — the kind of bookkeeping that silently
 * mismatches. Matching on `key` binds each segment exactly once, in the
 * order it appears, and `leaf`'s own parameter (when it has one) is the
 * last placeholder in the fragment, so the caller pushes it immediately
 * after this returns.
 *
 * Cost is an unindexed walk of every candidate row's JSON, in the same
 * bucket as full-text search — see docs/spec/wire-format.md
 * § Bounding query cost.
 */
const contentPathExists = (
  segments: string[],
  leaf: string,
  params: unknown[],
  nextAlias: () => string,
): string => {
  const descend = (alias: string, rest: string[]): string => {
    const child = nextAlias();
    const source = `json_each(${spread(alias)}) AS ${child}`;
    if (rest.length === 0) {
      return `EXISTS (SELECT 1 FROM ${source} WHERE ${child}.value ${leaf})`;
    }
    const member = nextAlias();
    params.push(rest[0]);
    return (
      `EXISTS (SELECT 1 FROM ${source} WHERE ${child}.type = 'object' AND EXISTS (` +
      `SELECT 1 FROM json_each(${child}.value) AS ${member} ` +
      `WHERE ${member}.key = ? AND ${descend(member, rest.slice(1))}))`
    );
  };

  // Content is always a JSON object, so the first segment is a plain
  // member lookup — no array to spread above it.
  const root = nextAlias();
  params.push(segments[0]);
  return (
    `EXISTS (SELECT 1 FROM json_each(r.content) AS ${root} ` +
    `WHERE ${root}.key = ? AND ${descend(root, segments.slice(1))})`
  );
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
        const isNull = contentPathExists(segments, 'IS NULL', params, nextAlias);
        const anyValue = contentPathExists(segments, 'IS NOT NULL', params, nextAlias);
        conditions.push(`(${isNull} OR NOT ${anyValue})`);
      } else {
        const match = contentPathExists(segments, '= ?', params, nextAlias);
        params.push(value);
        conditions.push(match);
      }
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

  // Cursor (sort-field value + id for stable pagination)
  if (query.cursor) {
    const { field: cursorField, value: numericValue, id: cursorId } = decodeCursor(query.cursor);
    const sortField = getSortField(query);
    if (cursorField !== sortField) {
      throw new StackQueryError(
        `Cursor sort field "${cursorField}" does not match query sort field "${sortField}"`,
      );
    }
    const col = getSortColumn(cursorField);
    const op = sqlDirection(query) === 'ASC' ? '>' : '<';
    conditions.push(`(r.${col} ${op} ? OR (r.${col} = ? AND r.id ${op} ?))`);
    params.push(numericValue, numericValue, cursorId);
  }

  return {
    sql: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
};

export const buildOrderClause = (query: StackQuery): string => {
  const field = getSortField(query);
  const dir = sqlDirection(query);
  return `ORDER BY r.${getSortColumn(field)} ${dir}, r.id ${dir}`;
};
