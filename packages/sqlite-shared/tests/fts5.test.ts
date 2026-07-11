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
});
