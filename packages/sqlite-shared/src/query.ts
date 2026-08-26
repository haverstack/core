/**
 * WHERE/ORDER clause building for StackQuery. Engine-independent SQL —
 * shared verbatim between SQLite-backed record adapters. The one caveat is
 * full-text search: `f.search` here assumes a `records_fts` virtual table
 * with a MATCH-able `content` column (see fts5.ts).
 */

import { StackQueryError, type StackQuery } from '@haverstack/core';
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

export const buildWhereClause = (query: StackQuery): { sql: string; params: unknown[] } => {
  const conditions: string[] = ["r.id != '_config'"];
  const params: unknown[] = [];
  const f = query.filter ?? {};

  if (!f.includeDeleted) {
    conditions.push('r.deleted_at IS NULL');
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

  // Tag filter — record must have ALL specified tags
  if (f.tags?.length) {
    for (const tag of f.tags) {
      conditions.push(
        `EXISTS (SELECT 1 FROM associations a WHERE a.record_id = r.id AND a.kind = 'tag' AND a.label = ?)`,
      );
      params.push(tag);
    }
  }

  // Attachment label filter
  if (f.hasAttachment) {
    conditions.push(
      `EXISTS (SELECT 1 FROM associations a WHERE a.record_id = r.id AND a.kind = 'attachment' AND a.label = ?)`,
    );
    params.push(f.hasAttachment);
  }

  // Attachment file ID filter — find records that reference a specific file,
  // either via an attachment association or a top-level file-ref content field
  if (f.attachmentFileId) {
    conditions.push(
      `(EXISTS (SELECT 1 FROM associations a WHERE a.record_id = r.id AND a.kind = 'attachment' AND a.file_id = ?)
        OR EXISTS (SELECT 1 FROM file_refs fr WHERE fr.record_id = r.id AND fr.file_id = ?))`,
    );
    params.push(f.attachmentFileId, f.attachmentFileId);
  }

  // Relationship filter
  if (f.relatedTo) {
    conditions.push(
      `EXISTS (SELECT 1 FROM associations a WHERE a.record_id = r.id AND a.kind = 'relationship' AND a.related_id = ?` +
        (f.relatedTo.label ? ` AND a.label = ?` : '') +
        `)`,
    );
    params.push(f.relatedTo.recordId);
    if (f.relatedTo.label) params.push(f.relatedTo.label);
  }

  // Content field filters (top-level scalar exact match). A `null` value
  // means "field absent or null", not "match nothing"
  // (docs/spec/data-model.md § Filter) — json_extract() returns SQL NULL
  // for both a missing path and a stored JSON null, so IS NULL captures both.
  if (f.content) {
    for (const [key, value] of Object.entries(f.content)) {
      if (value === null) {
        conditions.push(`json_extract(r.content, ?) IS NULL`);
        params.push(`$.${key}`);
      } else {
        conditions.push(`json_extract(r.content, ?) = ?`);
        params.push(`$.${key}`, value);
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
