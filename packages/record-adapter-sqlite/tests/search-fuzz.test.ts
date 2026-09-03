/**
 * The sanitizer's contract is not "these rewrites happen" — it is "FTS5
 * accepts the result". The unit tests in sqlite-shared pin the rewrites,
 * but they are string-in/string-out and cannot see the engine, which is how
 * a sanitizer that stripped `:` shipped while `-cats`, `cats-dogs` and
 * `{a b}` still reached FTS5 as column filters.
 *
 * This is the test that asks the engine. It lives here rather than in
 * sqlite-shared because this is the package with a real FTS5 to ask.
 */

import { describe, test, expect } from 'vitest';
import { DatabaseSync } from '../src/node-sqlite.js';
import { sanitizeFts5Query } from '@haverstack/sqlite-shared';

const withFts = <T>(use: (match: (query: string) => void) => T): T => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE VIRTUAL TABLE fts USING fts5(content)`);
    db.exec(`INSERT INTO fts(content) VALUES ('hello world cats dogs')`);
    const stmt = db.prepare(`SELECT count(*) AS c FROM fts WHERE fts MATCH ?`);
    return use((query) => void stmt.get(query));
  } finally {
    db.close();
  }
};

/** Feed `raw` through the sanitizer and require FTS5 to accept the result. */
const expectAccepted = (match: (q: string) => void, raw: string): void => {
  const sanitized = sanitizeFts5Query(raw);
  if (!sanitized) return; // empty => the caller's honest zero-match path
  expect(
    () => match(sanitized),
    `input ${JSON.stringify(raw)} sanitized to ${JSON.stringify(sanitized)}`,
  ).not.toThrow();
};

describe('sanitized search text is accepted by FTS5', () => {
  // Each of these reached the engine as something other than a search for
  // its own words before the allow-list replaced the strip-list.
  test.each([
    ['a leading minus, the exclude idiom', '-cats'],
    ['an ordinary hyphenated word', 'cats-dogs'],
    ['a longer hyphenated word', 'mother-in-law'],
    ['a column-set brace', '{cats}'],
    ['a multi-name column set', '{a b} cats'],
    ['a leading plus', '+cats'],
    ['a quoted minus, which is legal but must survive', '"-cats"'],
    ['an unclosed NEAR(', 'NEAR(cats'],
    ['a NUL byte, which truncates SQLite’s C string', 'cats\u0000dogs'],
    ['a NUL inside a phrase', '"((\u0000,))"'],
    ['a term beside a group', 'cats (dogs)'],
    ['a group beside a term', '(cats) dogs'],
    ['two adjacent groups', '(cats) (dogs)'],
    ['an unbalanced quote', '5" nails'],
    ['a trailing operator', 'cats AND'],
    ['stacked operators before a group', 'cats AND OR (dogs)'],
    ['runs of quotes', '""""AND AND((AND"""""NEAR(('],
    ['punctuation only', '$;,.!?'],
    ['an email address', 'someone@example.com'],
    ['a path', '/usr/local/bin'],
    ['a decimal', '3.14'],
  ])('accepts %s', (_label, raw) => {
    withFts((match) => expectAccepted(match, raw));
  });

  // Deterministic rather than random: a fuzz failure that cannot be
  // reproduced from the test name is a fuzz failure nobody fixes.
  test('accepts 20000 generated inputs', () => {
    const TOKENS = [
      'a',
      'cats',
      '"',
      '(',
      ')',
      'AND',
      'OR',
      'NOT',
      'NEAR',
      '*',
      ':',
      ',',
      '-',
      '+',
      '^',
      '.',
      '{',
      '}',
      '[',
      ']',
      '\\',
      '/',
      '~',
      '%',
      '#',
      '!',
      '?',
      '|',
      '&',
      '=',
      '<',
      '>',
      ';',
      "'",
      '`',
      'é',
      '日',
      '\u0000', // truncates SQLite's C string — a hazard, not a term
      ' ',
      ' ',
      '  ',
      '""',
      '((',
      '))',
      'NEAR(',
      'AND AND',
    ];
    // xorshift32 — a seeded PRNG, so a failure reproduces exactly.
    let state = 0x2545f491;
    const next = () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) / 0x100000000;
    };
    const pick = <T>(xs: T[]): T => xs[Math.floor(next() * xs.length)];

    withFts((match) => {
      for (let i = 0; i < 20000; i++) {
        const parts = Array.from({ length: 1 + Math.floor(next() * 9) }, () => pick(TOKENS));
        expectAccepted(match, parts.join(next() < 0.5 ? ' ' : ''));
      }
    });
  });

  // The repair has to leave a query that still means something, not just
  // one the engine accepts — "delete everything" would pass the test above.
  test.each([
    ['-cats', 1],
    ['cats AND', 1],
    ['cats-dogs', 1],
    ['"hello world"', 1],
    ['cats AND dogs', 1],
    ['cats AND absent', 0],
    ['(cats) dogs', 1],
  ])('%s still matches the right rows', (raw, expected) => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(`CREATE VIRTUAL TABLE fts USING fts5(content)`);
      db.exec(`INSERT INTO fts(content) VALUES ('hello world cats dogs')`);
      const row = db
        .prepare(`SELECT count(*) AS c FROM fts WHERE fts MATCH ?`)
        .get(sanitizeFts5Query(raw)) as { c: number };
      expect(row.c).toBe(expected);
    } finally {
      db.close();
    }
  });
});
