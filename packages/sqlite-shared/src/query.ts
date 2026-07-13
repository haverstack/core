/**
 * WHERE/ORDER clause building for StackQuery. Engine-independent SQL —
 * shared verbatim between SQLite-backed record adapters. The one caveat is
 * full-text search: `f.search` here assumes an `records_fts` virtual table
 * with a MATCH-able `content` column and a sanitizer that accepts the raw
 * query string, which both FTS4 and FTS5 setups can satisfy even though
 * their grammars differ (see fts.ts).
 */

import type { StackQuery } from '@haverstack/core';
import { decodeCursor, getSortColumn, getSortField, type SortField } from './cursor.js';

export { getSortField, getSortColumn };
export type { SortField };

export type SanitizeSearch = (query: string) => string;

export const buildWhereClause = (
  query: StackQuery,
  sanitizeSearch: SanitizeSearch,
): { sql: string; params: unknown[] } => {
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

  // Content field filters (top-level scalar exact match)
  if (f.content) {
    for (const [key, value] of Object.entries(f.content)) {
      conditions.push(`json_extract(r.content, ?) = ?`);
      params.push(`$.${key}`, value);
    }
  }

  if (f.search) {
    const sanitized = sanitizeSearch(f.search);
    if (sanitized) {
      conditions.push(`r.rowid IN (SELECT rowid FROM records_fts WHERE records_fts MATCH ?)`);
      params.push(sanitized);
    }
  }

  // Cursor (sort-field value + id for stable pagination)
  if (query.cursor) {
    const { field: cursorField, value: numericValue, id: cursorId } = decodeCursor(query.cursor);
    const col = getSortColumn(cursorField);
    const sortDir = query.sort?.direction ?? 'desc';
    const op = sortDir === 'asc' ? '>' : '<';
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
  const dir = (query.sort?.direction ?? 'desc').toUpperCase();
  return `ORDER BY r.${getSortColumn(field)} ${dir}, r.id ${dir}`;
};
