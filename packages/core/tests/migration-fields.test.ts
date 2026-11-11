import { describe, test, expect } from 'vitest';
import { composeOrigins, fieldOrigins, migrationBuilder } from '../src/migration-fields.js';
import type { FieldOrigins } from '../src/migration-fields.js';
import type { ReadonlyTypeSchema } from '../src/type-handle.js';

const { fields, field, constant, derive } = migrationBuilder;

const origins = (
  declared: Parameters<typeof fields>[0],
  from: ReadonlyTypeSchema,
  to: ReadonlyTypeSchema,
): FieldOrigins => {
  const result = fieldOrigins(fields(declared), from, to);
  if (typeof result === 'string') throw new Error(result);
  return result;
};

const status = (values: string[]) => ({ kind: 'enum', values }) as const;

describe('fieldOrigins()', () => {
  test("names each target field's origin, and each field the target drops as no value", () => {
    const result = origins(
      { b: field('a', { x: 'y' }), c: constant('k'), d: derive(() => 1) },
      { a: status(['x', 'z']), e: { kind: 'date' }, z: { kind: 'string' } },
      { b: status(['y', 'z']), c: { kind: 'string' }, d: { kind: 'number' }, e: { kind: 'date' } },
    );
    expect(Object.fromEntries(result)).toEqual({
      b: { kind: 'field', field: 'a', values: { x: 'y' } },
      c: { kind: 'constant', value: 'k' },
      d: { kind: 'derived' },
      e: { kind: 'field', field: 'e' },
      a: { kind: 'constant', value: undefined },
      z: { kind: 'constant', value: undefined },
    });
  });

  test('reads a field an origin replaces by that origin', () => {
    const result = origins(
      { a: constant('k'), b: derive(() => 'v') },
      { a: { kind: 'string' }, b: { kind: 'string' } },
      { a: { kind: 'string' }, b: { kind: 'string' } },
    );
    expect(result.get('a')).toEqual({ kind: 'constant', value: 'k' });
    expect(result.get('b')).toEqual({ kind: 'derived' });
  });
});

describe('composeOrigins()', () => {
  test('follows a name no origin names through a migration that does not declare it', () => {
    const lower = origins({}, { a: { kind: 'string' } }, { a: { kind: 'string' } });
    const both = { a: { kind: 'string' }, n: { kind: 'string' } } as const;
    const upper = origins({}, both, both);
    expect(composeOrigins(lower, upper).get('n')).toEqual({ kind: 'field', field: 'n' });
  });

  test('reads a name a lower migration dropped as no value, though an upper one declares it', () => {
    const lower = origins({}, { n: { kind: 'string' } }, {});
    const upper = origins({}, { n: { kind: 'string' } }, { n: { kind: 'string' } });
    expect(composeOrigins(lower, upper).get('n')).toEqual({ kind: 'constant', value: undefined });
  });

  test('follows a field through a rename at each migration, composing its maps', () => {
    const lower = origins(
      { b: field('a', { x: 'y' }) },
      { a: status(['x']) },
      { b: status(['y']) },
    );
    const upper = origins(
      { c: field('b', { y: 'z' }) },
      { b: status(['y']) },
      { c: status(['z']) },
    );
    expect(composeOrigins(lower, upper).get('c')).toEqual({
      kind: 'field',
      field: 'a',
      values: { x: 'z', y: 'z' },
    });
  });

  test('carries a constant or a derivation from the lower migration through the upper', () => {
    const lower = origins(
      { k: constant('a'), d: derive(() => 1) },
      {},
      { k: status(['a']), d: { kind: 'number' } },
    );
    const upper = origins(
      { k: field('k', { a: 'b' }) },
      { k: status(['a']), d: { kind: 'number' } },
      { k: status(['b']), d: { kind: 'number' } },
    );
    const composed = composeOrigins(lower, upper);
    expect(composed.get('k')).toEqual({ kind: 'constant', value: 'b' });
    expect(composed.get('d')).toEqual({ kind: 'derived' });
  });
});
