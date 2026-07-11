/**
 * FTS4 query sanitization.
 *
 * FTS4's query language supports operators (AND/OR/NOT, phrases, NEAR, wildcards)
 * that can be expensive or cause parse errors with untrusted input.
 * This function removes the dangerous operators while preserving useful ones:
 *   kept:    AND/OR/NOT (with a left operand), phrase queries ("…"), implicit AND
 *   removed: wildcards (*), NEAR/N, bare NOT (no left operand)
 *   capped:  parenthesis nesting depth (default: 2)
 *
 * A query timeout is not implementable for a synchronous, in-process SQLite
 * engine (sql.js runs as WASM that blocks the JS event loop; native SQLite's
 * interrupt() would need a worker thread to be usable as a timeout) — out of
 * scope here.
 *
 * FTS5 (used by the native adapter) has different grammar and needs its own
 * sanitizer reviewed against FTS5's rules rather than assuming this one
 * transfers — tracked with the native adapter's work, not duplicated here.
 */

import type { FtsStrategy } from './fts-strategy.js';

export const sanitizeFts4Query = (query: string, maxDepth = 2): string => {
  if (!query) return '';

  // Remove wildcards
  let clean = query.replace(/\*/g, '');

  // Remove NEAR operator (handles NEAR and NEAR/N variants)
  clean = clean.replace(/\bNEAR(?:\/\d+)?\b/gi, '');

  // Strip bare NOT with no left operand — FTS4 requires "term NOT term", not "NOT term"
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
 * FTS4's `content='records'` table uses `docid` as its rowid alias. A
 * plain DELETE by docid is sufficient to unindex a row — FTS4 doesn't
 * need the old content to do so, unlike FTS5 (see fts5Strategy).
 */
export const fts4Strategy: FtsStrategy = {
  insert(exec, recordId, content) {
    exec.run(`INSERT INTO records_fts(docid, content) SELECT rowid, ? FROM records WHERE id = ?`, [
      content,
      recordId,
    ]);
  },
  remove(exec, recordId) {
    exec.run(`DELETE FROM records_fts WHERE docid = (SELECT rowid FROM records WHERE id = ?)`, [
      recordId,
    ]);
  },
};
