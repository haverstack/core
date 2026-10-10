/**
 * Stack — Content sort values
 * -------------------------------------------------------
 * How a content field's stored value becomes something to order by. Lives
 * in core rather than in an adapter because every adapter must derive the
 * same value from the same field, or two adapters answering one query
 * return two different orders. A SQLite adapter materializes what these
 * functions produce into an index; an in-memory one compares them
 * directly.
 *
 * See docs/spec/data-model.md § Sorting by a content field.
 */

import type { ScalarFieldKind } from '../types/index.js';

/**
 * A field's value reduced to something ordered: a number, or text plus
 * the key its ordering actually uses (see contentSortKey).
 */
export type SortEntry = { kind: 'num'; num: number } | { kind: 'text'; text: string; key: string };

/**
 * Fold text into the key it sorts by — decompose, drop combining marks,
 * lowercase — so `Émile` files with `emile`. `toLowerCase()`, never the
 * locale form: the key is stored, so a locale-sensitive fold would bake one
 * runtime's order into the index. See docs/spec/data-model.md § Text ordering.
 */
export const contentSortKey = (value: string): string =>
  value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();

/**
 * A zone-less date-time, read as UTC as `Date.parse` already reads a
 * date-only string. Read in the host's zone, a stored index value and a
 * cursor re-derived elsewhere would disagree at a page boundary, and two
 * adapters in two zones would order one query two ways.
 */
const ZONELESS_DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/;

/**
 * The ordered form of `value` in a field of the declared `kind`, or null
 * when there is nothing to order by. The kind comes from the schema, not
 * the value, so a field orders one way on every record. `date` orders as
 * epoch ms like `createdAt`, `boolean` as 0/1, and an enum as text, since
 * its declaration order is not part of the schema.
 */
export function contentSortEntry(kind: ScalarFieldKind, value: unknown): SortEntry | null {
  switch (kind) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        ? { kind: 'num', num: value }
        : null;
    case 'boolean':
      return typeof value === 'boolean' ? { kind: 'num', num: value ? 1 : 0 } : null;
    case 'date': {
      if (typeof value !== 'string') return null;
      const ms = Date.parse(ZONELESS_DATE_TIME_RE.test(value) ? `${value}Z` : value);
      return Number.isNaN(ms) ? null : { kind: 'num', num: ms };
    }
    case 'string':
    case 'text':
    case 'record-ref':
    case 'file-ref':
    case 'enum':
      return typeof value === 'string'
        ? { kind: 'text', text: value, key: contentSortKey(value) }
        : null;
  }
}

/**
 * Order two strings by code point. JS `<` compares UTF-16 code units,
 * which files every supplementary character (U+10000 and above, stored as
 * a surrogate pair) below U+E000–U+FFFF; SQLite compares the same text as
 * UTF-8 bytes, and UTF-8 byte order *is* code-point order. Comparing by
 * code point is what makes an in-memory order and an indexed one agree.
 */
const compareCodePoints = (a: string, b: string): number => {
  if (a === b) return 0;
  const ai = a[Symbol.iterator]();
  const bi = b[Symbol.iterator]();
  for (;;) {
    const x = ai.next();
    const y = bi.next();
    if (x.done || y.done) return x.done === y.done ? 0 : x.done ? -1 : 1;
    if (x.value !== y.value) return x.value.codePointAt(0)! - y.value.codePointAt(0)!;
  }
};

/** Numbers before text; within text, the folded key, then the value itself. */
const compareValues = (a: SortEntry, b: SortEntry): number => {
  if (a.kind !== b.kind) return a.kind === 'num' ? -1 : 1;
  if (a.kind === 'num' && b.kind === 'num') return a.num - b.num;
  const x = a as { key: string; text: string };
  const y = b as { key: string; text: string };
  const byKey = compareCodePoints(x.key, y.key);
  return byKey !== 0 ? byKey : compareCodePoints(x.text, y.text);
};

/**
 * Order two records by one sort field, absent values last. `direction`
 * reverses the order between values but never moves absence: a record
 * with nothing at the field trails a record that has something either
 * way round. Ties are the caller's to break by id.
 */
export function compareSortEntries(
  a: SortEntry | null,
  b: SortEntry | null,
  direction: 'asc' | 'desc',
): number {
  if (!a || !b) return a === b ? 0 : a ? -1 : 1;
  return direction === 'asc' ? compareValues(a, b) : -compareValues(a, b);
}
