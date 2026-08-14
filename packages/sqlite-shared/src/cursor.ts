/**
 * Cursor encode/decode for keyset pagination. Uses btoa/atob rather than
 * Node's Buffer so the codec stays runtime-agnostic — cursor payloads
 * here are plain ASCII ("field|value|id"), so no UTF-8 encoding step is
 * needed.
 */

import { StackQueryError } from '@haverstack/core';
import type { StackRecord } from '@haverstack/core';

export type SortField = 'createdAt' | 'updatedAt' | 'version';

export const SORT_FIELDS: readonly SortField[] = ['createdAt', 'updatedAt', 'version'];

export const encodeCursor = (field: SortField, value: number, id: string): string =>
  btoa(`${field}|${value}|${id}`);

export type DecodedCursor = { field: SortField; value: number; id: string };

/** Throws StackQueryError for any malformed, corrupt, or unrecognized cursor. */
export const decodeCursor = (cursor: string): DecodedCursor => {
  let decoded: string;
  try {
    decoded = atob(cursor);
  } catch {
    throw new StackQueryError(`Invalid cursor: malformed "${cursor}"`);
  }
  const parts = decoded.split('|');
  if (parts.length !== 3) {
    throw new StackQueryError(`Invalid cursor: malformed "${cursor}"`);
  }
  const [field, value, id] = parts as [string, string, string];
  if (!SORT_FIELDS.includes(field as SortField)) {
    throw new StackQueryError(`Invalid cursor: unknown sort field "${field}"`);
  }
  const numericValue = Number(value);
  if (!isFinite(numericValue)) {
    throw new StackQueryError(`Invalid cursor: non-numeric sort value`);
  }
  return { field: field as SortField, value: numericValue, id };
};

export const getSortField = (query: { sort?: { field?: SortField } }): SortField =>
  query.sort?.field ?? 'createdAt';

export const getSortColumn = (field: SortField): string =>
  field === 'createdAt' ? 'created_at' : field === 'updatedAt' ? 'updated_at' : 'version';

export const makeCursor = (record: StackRecord, field: SortField): string => {
  const value =
    field === 'updatedAt'
      ? record.updatedAt.getTime()
      : field === 'version'
        ? record.version
        : record.createdAt.getTime();
  return encodeCursor(field, value, record.id);
};
