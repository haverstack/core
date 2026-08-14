/**
 * FTS5 query sanitization and indexing — the full-text search half of the
 * shared record logic.
 *
 * FTS5's query language supports operators (AND/OR/NOT, phrases, NEAR,
 * wildcards) that can be expensive or cause parse errors with untrusted
 * input, so a search string is rewritten before it reaches the engine:
 *
 *   kept:    AND/OR/NOT (with a left operand), phrase queries ("…"), implicit AND
 *   removed: wildcards (*), NEAR(...) (terms kept, wrapper dropped), column-filter
 *            colons, bare NOT (no left operand)
 *   capped:  parenthesis nesting depth (default: 2)
 *
 * Two FTS5 grammar details drive the less obvious rules:
 *
 * - FTS5's NEAR is a function-call form — `NEAR(a b, 10)`. Deleting the
 *   whole span would also delete the terms inside it, which can leave a
 *   dangling operator when NEAR(...) sits next to AND/OR (e.g. "x AND
 *   NEAR(a b, 5)" -> "x AND" — a syntax error). So this keeps the terms
 *   and drops only the NEAR(...) wrapper and distance.
 * - FTS5 has real column-filter syntax (`colname:term`) and errors hard
 *   on any name but the table's actual columns — since records_fts has
 *   exactly one column and callers have no business targeting columns
 *   explicitly, colons are stripped outright rather than validated.
 *
 * What this bounds is the grammar, not the cost: a syntactically modest
 * search over a large index can still be expensive, and node:sqlite blocks
 * the calling thread, so there is no timeout to set from inside the call.
 * Bounding execution time belongs to whoever drives the engine under load
 * — see docs/spec/wire-format.md § Bounding query cost for the server-side
 * expectation and the `timeout` wire error that goes with it.
 */

import type { SqlExecutor } from './executor.js';

export const sanitizeFts5Query = (query: string, maxDepth = 2): string => {
  if (!query) return '';

  // Remove wildcards
  let clean = query.replace(/\*/g, '');

  // Replace NEAR(terms, distance) with just its terms — see note above.
  clean = clean.replace(/\bNEAR\s*\(\s*([^,)]*)(?:,[^)]*)?\)/gi, '$1');

  // Strip column-filter colons — see note above.
  clean = clean.replace(/:/g, ' ');

  // Strip bare NOT with no left operand — FTS5 requires "term NOT term", not "NOT term"
  clean = clean.replace(/(?:^|\(\s*)NOT\s+/gi, (m) => m.replace(/NOT\s+/i, ''));

  // Enforce max nesting depth; replace excess ( with a space and discard unmatched )
  let currentDepth = 0;
  let result = '';
  for (const char of clean) {
    if (char === '(') {
      if (currentDepth < maxDepth) {
        currentDepth++;
        result += char;
      } else result += ' ';
    } else if (char === ')') {
      if (currentDepth > 0) {
        currentDepth--;
        result += char;
      } else result += ' ';
    } else {
      result += char;
    }
  }

  // Auto-close any unclosed parens
  if (currentDepth > 0) result += ')'.repeat(currentDepth);

  // Iteratively remove empty paren pairs left behind by NEAR/NOT stripping
  let prev: string;
  do {
    prev = result;
    result = result.replace(/\(\s*\)/g, ' ');
  } while (result !== prev);

  return result.replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();
};

// -------------------------------------------------------
// Indexing strategy
// -------------------------------------------------------

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
