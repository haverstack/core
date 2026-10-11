/**
 * The two derived indexes a records database keeps beside its rows: FTS5
 * for `filter.search`, and content_index for `sort.contentField` and the
 * file-reference filters. Both can be rebuilt from `records` alone, and
 * both must be rewritten in the same transaction as any write that changes
 * what they cover, or a query answers from a record that no longer exists.
 */

import type { StackType, ScalarFieldKind } from '@haverstack/core';
import { contentSortEntry } from '@haverstack/core/adapter';
import type { SqlExecutor } from './executor.js';

/**
 * FTS5's external-content table needs its special `('delete', rowid,
 * content)` command — with the *old* content — to unindex a row; a plain
 * DELETE leaves stale, still-searchable entries. remove() therefore reads
 * the current rowid/content and must run before the caller's change.
 */
export const fts5Strategy = {
  /** Index a record that has no FTS entry yet (used right after an INSERT). */
  insert(exec: SqlExecutor, recordId: string, content: string): void {
    exec.run(`INSERT INTO records_fts(rowid, content) SELECT rowid, ? FROM records WHERE id = ?`, [
      content,
      recordId,
    ]);
  },
  /**
   * Remove a record's FTS entry. MUST be called before the records row's
   * content changes or the row is deleted — see the note above.
   */
  remove(exec: SqlExecutor, recordId: string): void {
    const row = exec.get<{ rowid: number; content: string }>(
      'SELECT rowid, content FROM records WHERE id = ?',
      [recordId],
    );
    if (!row) return;
    exec.run(`INSERT INTO records_fts(records_fts, rowid, content) VALUES('delete', ?, ?)`, [
      row.rowid,
      row.content,
    ]);
  },
};

/**
 * Top-level scalar fields, by name and declared kind — what content_index
 * covers. Arrays and objects are left out: a value inside one has no
 * single position to order its record by, and no file reference the
 * attachment filter can see.
 */
const indexedFieldKinds = (
  schema: Record<string, { kind?: string }>,
): Map<string, ScalarFieldKind> => {
  const kinds = new Map<string, ScalarFieldKind>();
  for (const [field, def] of Object.entries(schema)) {
    if (!def.kind || def.kind === 'array' || def.kind === 'object') continue;
    kinds.set(field, def.kind as ScalarFieldKind);
  }
  return kinds;
};

/**
 * One row per top-level scalar field a record holds a value at. Caches each
 * type's indexed fields so a write doesn't re-read and re-parse the schema.
 */
export class ContentIndex {
  private readonly fieldsByType = new Map<string, Map<string, ScalarFieldKind>>();

  constructor(private readonly exec: SqlExecutor) {}

  /** Prime the cache from a type as it is saved. */
  rememberType(type: StackType): void {
    this.fieldsByType.set(
      type.id,
      indexedFieldKinds(type.schema as Record<string, { kind?: string }>),
    );
  }

  /**
   * Replace a record's rows with what its content currently holds, on every
   * write that can change content or typeId, so neither the ordering nor the
   * file-reference lookup can drift from the record. A field holding no
   * orderable value gets no row at all, which is what puts the record at the
   * end of a sort on that field.
   */
  sync(recordId: string, typeId: string, content: Record<string, unknown>): void {
    this.remove(recordId);

    for (const [field, kind] of this.fieldsOf(typeId)) {
      const entry = contentSortEntry(kind, content[field]);
      if (!entry) continue;
      const sql = `INSERT OR IGNORE INTO content_index
          (record_id, field, value_rank, num_value, text_key, text_value, file_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`;
      if (entry.kind === 'num') {
        this.exec.run(sql, [recordId, field, 0, entry.num, null, null, null]);
      } else {
        // A file-ref field's value is its file id, so the row it already
        // needs for ordering also answers the attachment filter — one
        // field is one row, whatever a query reads it for.
        const fileId = kind === 'file-ref' ? entry.text : null;
        this.exec.run(sql, [recordId, field, 1, null, entry.key, entry.text, fileId]);
      }
    }
  }

  remove(recordId: string): void {
    this.exec.run('DELETE FROM content_index WHERE record_id = ?', [recordId]);
  }

  /** The declared kind of a type's top-level `field`, if it has one. */
  kindOf(typeId: string, field: string): ScalarFieldKind | undefined {
    return this.fieldsOf(typeId).get(field);
  }

  /**
   * From the cache, falling back to a `types` lookup only for a typeId this
   * process hasn't seen via rememberType() yet, e.g. right after open().
   */
  private fieldsOf(typeId: string): Map<string, ScalarFieldKind> {
    const cached = this.fieldsByType.get(typeId);
    if (cached) return cached;

    const typeRow = this.exec.get<{ schema: string }>('SELECT schema FROM types WHERE id = ?', [
      typeId,
    ]);
    const fields = typeRow
      ? indexedFieldKinds(JSON.parse(typeRow.schema) as Record<string, { kind?: string }>)
      : new Map<string, ScalarFieldKind>();
    this.fieldsByType.set(typeId, fields);
    return fields;
  }
}
