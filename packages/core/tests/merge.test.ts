import { describe, test, expect } from 'vitest';
import { applyMergePatch } from '../src/merge.js';

describe('applyMergePatch', () => {
  test('adds new fields', () => {
    const result = applyMergePatch({ title: 'Hello' }, { pinned: true });
    expect(result).toEqual({ title: 'Hello', pinned: true });
  });

  test('replaces existing fields', () => {
    const result = applyMergePatch({ title: 'Hello' }, { title: 'Updated' });
    expect(result).toEqual({ title: 'Updated' });
  });

  test('null removes a field', () => {
    const result = applyMergePatch({ title: 'Hello', pinned: true }, { pinned: null });
    expect(result).toEqual({ title: 'Hello' });
  });

  test('omitted fields are retained', () => {
    const result = applyMergePatch({ title: 'Hello', pinned: true }, { title: 'Updated' });
    expect(result).toEqual({ title: 'Updated', pinned: true });
  });

  test('does not mutate the original content object', () => {
    const original = { title: 'Hello' };
    applyMergePatch(original, { title: 'Updated' });
    expect(original).toEqual({ title: 'Hello' });
  });

  test('empty patch returns an equivalent copy', () => {
    const result = applyMergePatch({ title: 'Hello' }, {});
    expect(result).toEqual({ title: 'Hello' });
  });
});
