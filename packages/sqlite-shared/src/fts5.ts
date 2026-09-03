/**
 * FTS5 query sanitization and indexing — the full-text search half of the
 * shared record logic.
 *
 * FTS5's query language supports operators (AND/OR/NOT, phrases, NEAR,
 * wildcards) that can be expensive or cause parse errors with untrusted
 * input, so a search string is rewritten before it reaches the engine:
 *
 *   kept:    AND/OR/NOT (with a left operand), phrase queries ("…"), implicit AND
 *   removed: wildcards (*), NEAR(...) (terms kept, wrapper dropped), every
 *            character outside the allow-list, bare NOT (no left operand),
 *            operators with no right operand
 *   capped:  parenthesis nesting depth (default: 2)
 *   closed:  an odd trailing quote
 *
 * Two FTS5 grammar details drive the less obvious rules:
 *
 * - FTS5's NEAR is a function-call form — `NEAR(a b, 10)`. Deleting the
 *   whole span would also delete the terms inside it, which can leave a
 *   dangling operator when NEAR(...) sits next to AND/OR (e.g. "x AND
 *   NEAR(a b, 5)" -> "x AND" — a syntax error). So this keeps the terms
 *   and drops only the NEAR(...) wrapper and distance.
 * - FTS5 has real column-filter syntax and errors hard on any name but
 *   the table's actual columns. It is wider than `colname:term`: `-name`
 *   and `{a b}` filter columns with no colon at all, so an ordinary
 *   hyphenated word is read as one. Since records_fts has exactly one
 *   column and callers have no business targeting columns explicitly,
 *   everything outside a phrase is reduced to an allow-list rather than
 *   validated — see OUTSIDE_PHRASE_DISALLOWED.
 *
 * The rewrite is best-effort and makes no completeness claim against
 * FTS5's grammar — which is why the caller wraps execution as well, so a
 * case this misses surfaces as a StackQueryError rather than a raw engine
 * error. Search text is what a person typed into a box: an unbalanced
 * quote or a trailing "AND" is ordinary input, not a malformed request.
 *
 * What this bounds is the grammar, not the cost: a syntactically modest
 * search over a large index can still be expensive, and node:sqlite blocks
 * the calling thread, so there is no timeout to set from inside the call.
 * Bounding execution time belongs to whoever drives the engine under load
 * — see docs/spec/wire-format.md § Bounding query cost for the server-side
 * expectation and the `timeout` wire error that goes with it.
 */

import type { SqlExecutor } from './executor.js';

/**
 * Outside a phrase, everything but a letter, digit, mark, underscore,
 * whitespace, paren or quote becomes a separator.
 *
 * An allow-list rather than a list of metacharacters to strip, because
 * FTS5's column-filter syntax is wider than it looks and an enumeration
 * kept missing parts of it: `-name` and `{a b}` filter columns with no
 * colon in sight, so `-cats` and even the hyphen inside `cats-dogs` were
 * read as column names and answered "no such column". `+` is a bare
 * syntax error. Listing what may pass means the next piece of syntax
 * nobody here anticipated arrives as a separator instead of as an error.
 *
 * Nothing is lost by it: FTS5's default tokenizer already splits terms on
 * these characters, so `cats-dogs` searches for the same two tokens it was
 * indexed as.
 */
const OUTSIDE_PHRASE_DISALLOWED = /[^\p{L}\p{N}\p{M}_\s()"]/gu;

export const sanitizeFts5Query = (query: string, maxDepth = 2): string => {
  if (!query) return '';

  // Drop control characters, inside a phrase as well as outside. A NUL in
  // particular ends the string early for SQLite's C API, so the engine sees
  // an opening quote whose closing one is past the truncation and reports an
  // unterminated string; none of them can match an indexed token anyway.
  let clean = query.replace(/[\p{Cc}\p{Cf}]/gu, ' ');

  // Remove wildcards
  clean = clean.replace(/\*/g, '');

  // Replace NEAR(terms, distance) with just its terms — see note above.
  clean = clean.replace(/\bNEAR\s*\(\s*([^,)]*)(?:,[^)]*)?\)/gi, '$1');

  // A NEAR( with no closing paren isn't the function-call form the rule
  // above rewrites, and the paren auto-close below would hand FTS5 a NEAR
  // call it never meant to write. Keep the grouping, drop the keyword.
  clean = clean.replace(/\bNEAR\s*\(/gi, '(');

  // Reduce to the characters that carry meaning outside a phrase — see note
  // above. Everything else becomes a separator, which is what FTS5's own
  // tokenizer would do with it anyway.
  clean = clean.replace(/"[^"]*"|[^"]+/g, (span) =>
    span.startsWith('"') ? span : span.replace(OUTSIDE_PHRASE_DISALLOWED, ' '),
  );

  // Strip bare NOT with no left operand — FTS5 requires "term NOT term", not "NOT term"
  clean = clean.replace(/(?:^|\(\s*)NOT\s+/gi, (m) => m.replace(/NOT\s+/i, ''));

  // Enforce max nesting depth; replace excess ( with a space and discard
  // unmatched ). Parens inside a phrase are literal text to FTS5, so the
  // depth count steps over quoted spans rather than reading them as syntax.
  let currentDepth = 0;
  let inPhrase = false;
  let result = '';
  for (const char of clean) {
    if (char === '"') {
      inPhrase = !inPhrase;
      result += char;
    } else if (inPhrase) {
      result += char;
    } else if (char === '(') {
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

  // Close an odd trailing quote before the parens, so the added ) lands
  // outside the phrase rather than becoming a literal character in it.
  if (inPhrase) result += '"';

  // Auto-close any unclosed parens
  if (currentDepth > 0) result += ')'.repeat(currentDepth);

  // Remove empty paren pairs left behind by NEAR/NOT stripping, and drop
  // operators left without an operand. Looped together because each can
  // create work for the other: removing an operator can empty a paren pair
  // ("(a AND)" -> "(a)" -> ...), and removing a pair can strand the
  // operator that pointed at it ("x AND ()" -> "x AND").
  let prev: string;
  do {
    prev = result;
    // An empty phrase matches nothing and is the one construct whose
    // quotes can re-pair differently once a rule inserts text beside it.
    result = result.replace(/""/g, ' ');
    result = result.replace(/\(\s*\)/g, ' ');
    result = dropDanglingOperators(result);
    result = restoreImplicitAnd(result);
  } while (result !== prev);

  return result.replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();
};

/** An operator FTS5 requires a term on both sides of. */
const OPERATOR = String.raw`(?:AND|OR|NOT)`;

/**
 * Stands in for a phrase while operators are rewritten. A private-use
 * character is not a word character, so `\b` still sees the operator
 * beside it, while `^`, `$` and the paren anchors see an operand — which
 * is what a phrase is. Nothing reaches here holding one: `clean` is
 * rewritten from the caller's string, and a literal U+E000 in it would be
 * a term character FTS5 tokenizes away regardless.
 */
const PHRASE_HOLE = '\u{E000}';

/**
 * Drop operators left without an operand — the shape a person types on
 * their way to a longer query ("cats AND") or lands on once the rules
 * above have removed a term. FTS5 rejects each of them outright, so what
 * would otherwise be a syntax error becomes the search for the terms that
 * are actually there.
 *
 * Phrases are masked out first: `"cats AND dogs"` is literal text to FTS5,
 * and rewriting inside it would change what the user asked for.
 */
const dropDanglingOperators = (query: string): string =>
  withPhrasesMasked(query, (masked) => {
    let out = masked;
    let prev: string;
    do {
      prev = out;
      // A run of operators keeps only the first — the rest have no left operand.
      out = out.replace(
        new RegExp(String.raw`\b(${OPERATOR})\b(?:\s+\b${OPERATOR}\b)+`, 'gi'),
        '$1',
      );
      // No left operand: at the start of the query or straight after "(".
      out = out.replace(new RegExp(String.raw`(^|\()\s*\b${OPERATOR}\b\s*`, 'gi'), '$1');
      // No right operand: at the end of the query or straight before ")".
      out = out.replace(new RegExp(String.raw`\s*\b${OPERATOR}\b\s*($|\))`, 'gi'), '$1');
    } while (out !== prev);
    return out;
  });

/**
 * Run `rewrite` over the query with each phrase swapped for PHRASE_HOLE,
 * then put the phrases back in order. Every rule that reasons about what
 * sits beside an operator or a paren needs this: inside a phrase the text
 * is literal, and from outside one the phrase is a single operand.
 */
const withPhrasesMasked = (query: string, rewrite: (masked: string) => string): string => {
  const phrases: string[] = [];
  const masked = query.replace(/"[^"]*"/g, (phrase) => {
    phrases.push(phrase);
    return PHRASE_HOLE;
  });
  let i = 0;
  return rewrite(masked).replace(new RegExp(PHRASE_HOLE, 'g'), () => phrases[i++]);
};

/**
 * Put back the operator FTS5 requires around a group. Two terms side by
 * side are an implicit AND (`cats dogs`), but a group is not: `cats (dogs)`
 * is a syntax error where `cats AND (dogs)` is fine. Grouping survives a
 * rewrite that strips the operator which used to sit beside it, so this
 * names the AND that was always meant rather than dropping the parens.
 *
 * Both rules test a *whole* word against the operator list. Matching a
 * prefix instead reads the `D` of a preceding `AND` as a term and inserts
 * a second one beside it.
 *
 * Phrases are masked for the same reason as elsewhere — a phrase is an
 * operand, so `"a b" (c)` needs the operator too.
 */
const OPERAND_CHAR = String.raw`[\p{L}\p{N}_${PHRASE_HOLE}]`;

const isOperator = (word: string): boolean => /^(?:AND|OR|NOT)$/i.test(word);

const restoreImplicitAnd = (query: string): string =>
  withPhrasesMasked(query, (masked) =>
    masked
      // ")" then an operand — ") cats", ") (", ") <phrase>" — unless that
      // operand is an operator, which already joins the two sides.
      .replace(
        new RegExp(String.raw`\)\s*(?=${OPERAND_CHAR}|\()`, 'gu'),
        (match, offset: number, whole: string) => {
          const next = /^\s*([\p{L}\p{N}_]+)/u.exec(whole.slice(offset + match.length));
          return next && isOperator(next[1]) ? match : ') AND ';
        },
      )
      // An operand then "(", unless the operand is an operator.
      .replace(new RegExp(String.raw`(${OPERAND_CHAR}+)\s*(?=\()`, 'gu'), (match, word: string) =>
        isOperator(word) ? match : `${word} AND `,
      ),
  );

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
