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

// -------------------------------------------------------
// Reserved keys: a patch key that names object machinery must set a
// field, not reach a setter. Stack.update() rejects these before the
// merge (see validateReservedKeys); this is the backstop for adapters
// that call applyMergePatch directly.
// -------------------------------------------------------

describe('applyMergePatch — reserved keys', () => {
  test('a __proto__ patch key sets an own field instead of reassigning the prototype', () => {
    const patch = JSON.parse('{"__proto__": {"polluted": true}}') as Record<string, unknown>;

    const result = applyMergePatch({ title: 'Hello' }, patch);

    expect(Object.hasOwn(result, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect((result as { polluted?: boolean }).polluted).toBeUndefined();
    // Nothing escaped onto the shared prototype.
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  test('the field survives serialization, so the write is not silently lost', () => {
    const patch = JSON.parse('{"__proto__": "surprise"}') as Record<string, unknown>;

    const result = applyMergePatch({}, patch);

    // Built through JSON.parse, not a literal: `{ __proto__: 'surprise' }`
    // in source sets a prototype (and a string prototype is ignored), so
    // the literal would be an empty object rather than the expectation.
    expect(JSON.parse(JSON.stringify(result))).toEqual(JSON.parse('{"__proto__": "surprise"}'));
  });

  test('constructor and prototype patch keys behave as ordinary fields', () => {
    const result = applyMergePatch({}, { constructor: 'c', prototype: 'p' });

    expect(result.constructor).toBe('c');
    expect(result.prototype).toBe('p');
  });
});
