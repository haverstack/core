import { describe, test, expect } from 'vitest';
import {
  add,
  composeOrigins,
  derive,
  drop,
  fieldOrigins,
  map,
  rename,
} from '../src/migration-steps.js';
import type { FieldOrigins } from '../src/migration-steps.js';
import type { ReadonlyTypeSchema } from '../src/type-handle.js';

const origins = (
  steps: Parameters<typeof fieldOrigins>[0],
  from: ReadonlyTypeSchema,
  to: ReadonlyTypeSchema,
): FieldOrigins => {
  const result = fieldOrigins(steps, from, to);
  if (typeof result === 'string') throw new Error(result);
  return result;
};

const status = (values: string[]) => ({ kind: 'enum', values }) as const;

describe('fieldOrigins()', () => {
  test("names each target field's origin after the steps run in order", () => {
    const result = origins(
      [rename('a', 'b'), map('b', { x: 'y' }), add('c', 'k'), derive('d', () => 1)],
      { a: status(['x', 'z']) },
      { b: status(['y', 'z']), c: { kind: 'string' }, d: { kind: 'number' }, e: { kind: 'date' } },
    );
    expect(Object.fromEntries(result)).toEqual({
      b: { kind: 'field', field: 'a', values: { x: 'y' } },
      c: { kind: 'constant', value: 'k' },
      d: { kind: 'derived' },
      e: { kind: 'field', field: 'e' },
      a: { kind: 'constant', value: undefined },
    });
  });

  test('composes two maps of one field into one table', () => {
    const result = origins(
      [map('s', { a: 'b' }), map('s', { b: 'c', d: 'e' })],
      { s: status(['a', 'b', 'd']) },
      { s: status(['c', 'e']) },
    );
    expect(result.get('s')).toEqual({
      kind: 'field',
      field: 's',
      values: { a: 'c', b: 'c', d: 'e' },
    });
  });

  test('maps an added constant', () => {
    const result = origins([add('s', 'a'), map('s', { a: 'b' })], {}, { s: status(['b']) });
    expect(result.get('s')).toEqual({ kind: 'constant', value: 'b' });
  });
});

describe('composeOrigins()', () => {
  test('follows a name no step touches through a step that does not declare it', () => {
    const lower = origins([], { a: { kind: 'string' } }, { a: { kind: 'string' } });
    const upper = origins(
      [],
      { a: { kind: 'string' } },
      { a: { kind: 'string' }, n: { kind: 'string' } },
    );
    expect(composeOrigins(lower, upper).get('n')).toEqual({ kind: 'field', field: 'n' });
  });

  test('reads a name a lower step removed as no value, though an upper one declares it', () => {
    const lower = origins([drop('n')], { n: { kind: 'string' } }, {});
    const upper = origins([], {}, { n: { kind: 'string' } });
    expect(composeOrigins(lower, upper).get('n')).toEqual({ kind: 'constant', value: undefined });
  });

  test('follows a field through a rename at each step, composing its maps', () => {
    const lower = origins(
      [rename('a', 'b'), map('b', { x: 'y' })],
      { a: status(['x']) },
      { b: status(['y']) },
    );
    const upper = origins(
      [rename('b', 'c'), map('c', { y: 'z' })],
      { b: status(['y']) },
      { c: status(['z']) },
    );
    expect(composeOrigins(lower, upper).get('c')).toEqual({
      kind: 'field',
      field: 'a',
      values: { x: 'z', y: 'z' },
    });
  });

  test('carries a constant or a derivation from the lower step through the upper', () => {
    const lower = origins(
      [add('k', 'a'), derive('d', () => 1)],
      {},
      { k: status(['a']), d: { kind: 'number' } },
    );
    const upper = origins(
      [map('k', { a: 'b' })],
      { k: status(['a']), d: { kind: 'number' } },
      { k: status(['b']), d: { kind: 'number' } },
    );
    const composed = composeOrigins(lower, upper);
    expect(composed.get('k')).toEqual({ kind: 'constant', value: 'b' });
    expect(composed.get('d')).toEqual({ kind: 'derived' });
  });
});
