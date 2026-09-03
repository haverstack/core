import { describe, test, expect } from 'vitest';
import { sanitizeFts5Query } from '../src/fts5.js';

describe('sanitizeFts5Query', () => {
  test('returns empty string unchanged', () => {
    expect(sanitizeFts5Query('')).toBe('');
  });

  test('strips wildcards', () => {
    expect(sanitizeFts5Query('hel*lo')).toBe('hello');
  });

  test('replaces NEAR(...) with its terms, dropping the wrapper and distance', () => {
    expect(sanitizeFts5Query('NEAR(foo bar, 5)')).toBe('foo bar');
  });

  test('NEAR(...) next to AND does not leave a dangling operator', () => {
    expect(sanitizeFts5Query('foo AND NEAR(bar baz, 3)')).toBe('foo AND bar baz');
  });

  test('strips column-filter colons', () => {
    expect(sanitizeFts5Query('content:foo')).toBe('content foo');
    expect(sanitizeFts5Query('bogus:foo')).toBe('bogus foo');
  });

  test('strips bare NOT with no left operand', () => {
    expect(sanitizeFts5Query('NOT foo')).toBe('foo');
  });

  test('keeps NOT with a left operand', () => {
    expect(sanitizeFts5Query('foo NOT bar')).toBe('foo NOT bar');
  });

  test('caps parenthesis nesting depth', () => {
    expect(sanitizeFts5Query('(((deep)))', 2)).toBe('((deep))');
  });

  test('auto-closes unclosed parens', () => {
    expect(sanitizeFts5Query('(unclosed')).toBe('(unclosed)');
  });

  test('discards unmatched closing parens', () => {
    expect(sanitizeFts5Query('unmatched)')).toBe('unmatched');
  });

  test('keeps phrase queries and implicit AND', () => {
    expect(sanitizeFts5Query('"exact phrase" other')).toBe('"exact phrase" other');
  });

  // Everything below is text a person typed into a search box on the way
  // to a longer query. FTS5 rejects each shape outright, so the rewrite
  // has to leave a parseable query or the search 500s.
  describe('dangling operators', () => {
    test('drops an operator with no right operand', () => {
      expect(sanitizeFts5Query('cats AND')).toBe('cats');
      expect(sanitizeFts5Query('cats OR ')).toBe('cats');
      expect(sanitizeFts5Query('cats AND NOT')).toBe('cats');
    });

    test('drops an operator with no left operand', () => {
      expect(sanitizeFts5Query('AND cats')).toBe('cats');
      expect(sanitizeFts5Query('OR cats')).toBe('cats');
    });

    test('a run of operators keeps only the first', () => {
      expect(sanitizeFts5Query('a AND OR b')).toBe('a AND b');
    });

    test('drops an operator dangling inside parens', () => {
      expect(sanitizeFts5Query('(a AND)')).toBe('(a)');
    });

    test('keeps an operator that has both operands', () => {
      expect(sanitizeFts5Query('cats AND dogs')).toBe('cats AND dogs');
      expect(sanitizeFts5Query('cats NOT dogs')).toBe('cats NOT dogs');
    });

    // A phrase is literal text to FTS5, so an operator inside one is a
    // word the user searched for, not syntax to rewrite.
    test('leaves operators inside a phrase alone', () => {
      expect(sanitizeFts5Query('"cats AND dogs"')).toBe('"cats AND dogs"');
      expect(sanitizeFts5Query('"cats AND"')).toBe('"cats AND"');
    });

    // The mask a phrase leaves behind is an operand, so neither of these
    // operators is dangling.
    test('a phrase counts as an operand on either side', () => {
      expect(sanitizeFts5Query('"exact phrase" AND other')).toBe('"exact phrase" AND other');
      expect(sanitizeFts5Query('other AND "exact phrase"')).toBe('other AND "exact phrase"');
    });
  });

  describe('unbalanced quotes', () => {
    test('closes an odd trailing quote', () => {
      expect(sanitizeFts5Query('5" nails')).toBe('5" nails"');
      expect(sanitizeFts5Query('a"b')).toBe('a"b"');
    });

    test('closes the quote before the parens, not inside the phrase', () => {
      expect(sanitizeFts5Query('(a "b')).toBe('(a "b")');
    });

    // Parens inside a phrase are literal text to FTS5, so they spend no
    // nesting budget — the depth cap applies to the same string outside one.
    test('parens inside a phrase are text, not nesting', () => {
      expect(sanitizeFts5Query('"((((deep))))"')).toBe('"((((deep))))"');
      expect(sanitizeFts5Query('((((deep))))')).toBe('((deep))');
    });
  });
});
