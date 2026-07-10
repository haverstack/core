import { describe, test, expect } from 'vitest';
import { sanitizeFts4Query } from '../src/fts.js';

describe('sanitizeFts4Query', () => {
  test('returns empty string unchanged', () => {
    expect(sanitizeFts4Query('')).toBe('');
  });

  test('strips wildcards', () => {
    expect(sanitizeFts4Query('hel*lo')).toBe('hello');
  });

  test('strips NEAR and NEAR/N operators', () => {
    expect(sanitizeFts4Query('foo NEAR bar')).toBe('foo bar');
    expect(sanitizeFts4Query('foo NEAR/5 bar')).toBe('foo bar');
  });

  test('strips bare NOT with no left operand', () => {
    expect(sanitizeFts4Query('NOT foo')).toBe('foo');
  });

  test('keeps NOT with a left operand', () => {
    expect(sanitizeFts4Query('foo NOT bar')).toBe('foo NOT bar');
  });

  test('caps parenthesis nesting depth', () => {
    expect(sanitizeFts4Query('(((deep)))', 2)).toBe('((deep))');
  });

  test('auto-closes unclosed parens', () => {
    expect(sanitizeFts4Query('(unclosed')).toBe('(unclosed)');
  });

  test('discards unmatched closing parens', () => {
    expect(sanitizeFts4Query('unmatched)')).toBe('unmatched');
  });

  test('keeps phrase queries and implicit AND', () => {
    expect(sanitizeFts4Query('"exact phrase" other')).toBe('"exact phrase" other');
  });
});
