/**
 * Cursor encode/decode for keyset pagination. The payload is JSON in
 * base64 rather than delimited fields: a content sort carries the field's
 * stored text, and neither a field name nor a text value is constrained
 * to avoid whatever character a delimiter would claim. Uses btoa/atob
 * with an explicit UTF-8 step rather than Node's Buffer, so the codec
 * stays runtime-agnostic and a non-Latin-1 value survives the round trip.
 */

import { StackQueryError } from '@haverstack/core';
import { contentSortEntry } from '@haverstack/core/adapter';
import type { StackRecord, NativeSortField, QuerySort, ScalarFieldKind } from '@haverstack/core';

export type SortField = NativeSortField;

export const SORT_FIELDS: readonly SortField[] = ['createdAt', 'updatedAt', 'version'];

/**
 * Which partition of the ordering a cursor sits in: a native column or a
 * content field's number, text, or absent value. The three content cases
 * are the boundary keyset pagination has to hold — a page that ended on
 * the last numeric value resumes at the first text one, not back at the
 * top of either.
 */
export type CursorKind = 'native' | 'num' | 'text' | 'absent';

export type DecodedCursor =
  | { kind: 'native'; field: SortField; value: number; id: string }
  | { kind: 'num'; field: string; value: number; id: string }
  | { kind: 'text'; field: string; value: string; id: string }
  | { kind: 'absent'; field: string; id: string };

const toBase64 = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const fromBase64 = (cursor: string): string => {
  const binary = atob(cursor);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
};

export const encodeCursor = (decoded: DecodedCursor): string =>
  toBase64(
    JSON.stringify(
      decoded.kind === 'absent'
        ? { k: decoded.kind, f: decoded.field, i: decoded.id }
        : { k: decoded.kind, f: decoded.field, i: decoded.id, v: decoded.value },
    ),
  );

/** Throws StackQueryError for any malformed, corrupt, or unrecognized cursor. */
export const decodeCursor = (cursor: string): DecodedCursor => {
  const malformed = () => new StackQueryError(`Invalid cursor: malformed "${cursor}"`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64(cursor));
  } catch {
    throw malformed();
  }
  if (!parsed || typeof parsed !== 'object') throw malformed();
  const { k, f, i, v } = parsed as Record<string, unknown>;
  if (typeof f !== 'string' || !f || typeof i !== 'string') throw malformed();

  if (k === 'absent') return { kind: 'absent', field: f, id: i };
  if (k === 'text') {
    if (typeof v !== 'string') throw malformed();
    return { kind: 'text', field: f, value: v, id: i };
  }
  if (k === 'num' || k === 'native') {
    if (typeof v !== 'number' || !isFinite(v)) {
      throw new StackQueryError(`Invalid cursor: non-numeric sort value`);
    }
    if (k === 'native') {
      if (!SORT_FIELDS.includes(f as SortField)) {
        throw new StackQueryError(`Invalid cursor: unknown sort field "${f}"`);
      }
      return { kind: 'native', field: f as SortField, value: v, id: i };
    }
    return { kind: 'num', field: f, value: v, id: i };
  }
  throw malformed();
};

export const getSortField = (query: { sort?: QuerySort }): SortField =>
  query.sort?.field ?? 'createdAt';

export const getSortColumn = (field: SortField): string =>
  field === 'createdAt' ? 'created_at' : field === 'updatedAt' ? 'updated_at' : 'version';

/**
 * The cursor naming the last record of a page: where the next page
 * resumes. A content sort re-derives the record's ordered value from its
 * stored content rather than reading it back out of the index, so the
 * cursor and the index can only ever disagree if the write path is
 * broken — in which case pagination is not the thing to paper over.
 */
export const makeCursor = (
  record: StackRecord,
  sort: QuerySort | undefined,
  kindOf?: (record: StackRecord, field: string) => ScalarFieldKind | undefined,
): string => {
  const contentField = sort?.contentField;
  if (contentField === undefined) {
    const field = getSortField({ sort });
    const value =
      field === 'updatedAt'
        ? record.updatedAt.getTime()
        : field === 'version'
          ? record.version
          : record.createdAt.getTime();
    return encodeCursor({ kind: 'native', field, value, id: record.id });
  }

  const kind = kindOf?.(record, contentField);
  const entry = kind ? contentSortEntry(kind, record.content[contentField]) : null;
  if (!entry) return encodeCursor({ kind: 'absent', field: contentField, id: record.id });
  return entry.kind === 'num'
    ? encodeCursor({ kind: 'num', field: contentField, value: entry.num, id: record.id })
    : encodeCursor({ kind: 'text', field: contentField, value: entry.text, id: record.id });
};
