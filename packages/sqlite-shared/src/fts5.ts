/**
 * FTS5 query sanitization: turning what a person typed into a search box
 * into a query FTS5 will parse. Indexing lives in indexes.ts.
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
 * case this misses surfaces as a StackBadRequestError rather than a raw engine
 * error. Search text is what a person typed into a box: an unbalanced
 * quote or a trailing "AND" is ordinary input, not a malformed request.
 *
 * What this bounds is the grammar, not the cost: a syntactically modest
 * search over a large index can still be expensive, and node:sqlite blocks
 * the calling thread, so there is no timeout to set from inside the call.
 * Bounding execution time belongs to whoever drives the engine under load
 * — see docs/spec/wire-format.md § Bounding query cost for the server-side
 * expectation and the `timeout` wire error that goes with it.
 *
 * Backtracking. The input is untrusted text, so every regex here is
 * written not to backtrack quadratically on it:
 *
 * - Whitespace runs are collapsed before any rule that spells "beside an
 *   operator or paren" as `\s*`; a `\s*` facing a long run re-tries the
 *   whole run per starting position. The rewrite is still a little
 *   worse than linear overall, so bounding a search's length belongs to
 *   whoever accepts it.
 * - The NEAR rule has no `\s*` after its paren (its `[^,()]*` already
 *   takes a space, and two quantifiers matching the same character give
 *   the engine an ambiguous split), and neither of its runs crosses a
 *   `(`, so an unclosed `NEAR(NEAR(NEAR(` doesn't re-scan to the end once
 *   per occurrence.
 * - The no-right-operand rule has no leading `\s*`, for the same reason
 *   as the collapse.
 * - The operand-before-paren rule's lookbehind pins each match to the
 *   start of a word; without it every position inside a long word is a
 *   start, each re-scanning the rest of it.
 * - Empty phrases and empty paren pairs are removed by one rule, so a run
 *   of them becomes one space rather than one per construct.
 */

/**
 * Outside a phrase, everything but a letter, digit, mark, underscore,
 * whitespace, paren or quote becomes a separator. An allow-list because
 * FTS5's column-filter syntax is wider than any list of metacharacters.
 * See docs/spec/data-model.md § Capability-gated filters.
 */
const OUTSIDE_PHRASE_DISALLOWED = /[^\p{L}\p{N}\p{M}_\s()"]/gu;

/**
 * Bounds what any `\s*` can backtrack over (see Backtracking above). Safe
 * inside a phrase too: FTS5 matches a phrase as a sequence of tokens, not
 * the spacing between them.
 */
const collapseWhitespace = (query: string): string => query.replace(/\s+/g, ' ');

export const sanitizeFts5Query = (query: string, maxDepth = 2): string => {
  if (!query) return '';

  // Drop control characters, inside a phrase as well as outside. A NUL in
  // particular ends the string early for SQLite's C API, so the engine sees
  // an opening quote whose closing one is past the truncation and reports an
  // unterminated string; none of them can match an indexed token anyway.
  let clean = query.replace(/[\p{Cc}\p{Cf}]/gu, ' ');

  clean = clean.replace(/\*/g, '');

  // NEAR(terms, distance) keeps its terms — see the note above. The
  // pattern's shape is about backtracking (see Backtracking); excluding `(`
  // costs nothing, since a NEAR's terms and distance never hold one.
  clean = clean.replace(/\bNEAR\s*\(([^,()]*)(?:,[^()]*)?\)/gi, '$1');

  // A NEAR( with no closing paren isn't the function-call form the rule
  // above rewrites, and the paren auto-close below would hand FTS5 a NEAR
  // call it never meant to write. Keep the grouping, drop the keyword.
  clean = clean.replace(/\bNEAR\s*\(/gi, '(');

  // See OUTSIDE_PHRASE_DISALLOWED.
  clean = clean.replace(/"[^"]*"|[^"]+/g, (span) =>
    span.startsWith('"') ? span : span.replace(OUTSIDE_PHRASE_DISALLOWED, ' '),
  );

  // The reduction above is where long whitespace runs come from.
  clean = collapseWhitespace(clean);

  // Strip bare NOT with no left operand — FTS5 requires "term NOT term", not
  // "NOT term". A phrase is matched first and kept whole, so a NOT inside one
  // stays the word it is; the closing quote is optional because an odd one
  // is only closed further down.
  clean = clean.replace(/"[^"]*"?|(^|\(\s*)NOT\s+/gi, (m, lead?: string) => lead ?? m);

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

  if (currentDepth > 0) result += ')'.repeat(currentDepth);

  // Looped to a fixpoint because each rule can create work for another:
  // dropping an operator can empty a pair ("(a AND)"), dropping a pair can
  // strand an operator ("x AND ()"), and an empty phrase's quotes can
  // re-pair once text is inserted beside it.
  let prev: string;
  do {
    prev = result;
    // Empty phrases and empty paren pairs match nothing. One rule for both
    // (see Backtracking).
    result = result.replace(/(?:""|\(\s*\))+/g, ' ');
    result = dropDanglingOperators(result);
    result = restoreImplicitAnd(result);
  } while (result !== prev);

  return collapseWhitespace(result).replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();
};

/** An operator FTS5 requires a term on both sides of. */
const OPERATOR = String.raw`(?:AND|OR|NOT)`;

/**
 * Stands in for a phrase while operators are rewritten. A private-use
 * character is not a word character, so `\b` still sees an operator beside
 * it, while the anchors see an operand. A literal U+E000 in the input is
 * one FTS5 tokenizes away regardless.
 */
const PHRASE_HOLE = '\u{E000}';

/**
 * Drop operators left without an operand — typed on the way to a longer
 * query ("cats AND"), or left behind once a rule above removed a term.
 * FTS5 rejects each outright. Phrases are masked: inside one, an operator
 * is a word the user searched for.
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
      // No leading `\s*` (see Backtracking); the collapse on the way out
      // takes that whitespace.
      out = out.replace(new RegExp(String.raw`\b${OPERATOR}\b\s*($|\))`, 'gi'), '$1');
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

const OPERAND_CHAR = String.raw`[\p{L}\p{N}_${PHRASE_HOLE}]`;

/** A whole word, never a prefix: the `D` of `AND` is not a term. */
const isOperator = (word: string): boolean => /^(?:AND|OR|NOT)$/i.test(word);

/**
 * Put back the operator FTS5 requires beside a group: `cats dogs` is an
 * implicit AND, but `cats (dogs)` is a syntax error. A rewrite that strips
 * the operator beside a group keeps the grouping, so this writes back the
 * AND that was meant. A masked phrase is an operand like any other.
 */
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
      // An operand then "(", unless the operand is an operator. The
      // lookbehind is load-bearing (see Backtracking).
      .replace(
        new RegExp(String.raw`(?<!${OPERAND_CHAR})(${OPERAND_CHAR}+)\s*(?=\()`, 'gu'),
        (match, word: string) => (isOperator(word) ? match : `${word} AND `),
      ),
  );
