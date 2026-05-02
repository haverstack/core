import { describe, test, expect } from 'vitest';
import { hashSchema, isCompatible, parseTypeId, buildTypeId } from '../src/schema.js';
import type { TypeSchema } from '../src/types.js';

// -------------------------------------------------------
// hashSchema
// -------------------------------------------------------

describe('hashSchema', () => {
  test('returns a 64-character hex string', async () => {
    const hash = await hashSchema({ name: { kind: 'string', required: true } });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('same schema always produces the same hash', async () => {
    const schema: TypeSchema = {
      text: { kind: 'text', required: true },
      title: { kind: 'string', required: false },
    };
    const h1 = await hashSchema(schema);
    const h2 = await hashSchema(schema);
    expect(h1).toBe(h2);
  });

  test('different schemas produce different hashes', async () => {
    const h1 = await hashSchema({ text: { kind: 'text', required: true } });
    const h2 = await hashSchema({ text: { kind: 'string', required: true } });
    expect(h1).not.toBe(h2);
  });

  test('key order does not affect the hash (canonical alphabetical sort)', async () => {
    const schemaAB: TypeSchema = {
      a: { kind: 'string', required: true },
      b: { kind: 'number', required: false },
    };
    const schemaBA: TypeSchema = {
      b: { kind: 'number', required: false },
      a: { kind: 'string', required: true },
    };
    const h1 = await hashSchema(schemaAB);
    const h2 = await hashSchema(schemaBA);
    expect(h1).toBe(h2);
  });

  test('required: true vs required: false produces different hashes', async () => {
    const h1 = await hashSchema({ name: { kind: 'string', required: true } });
    const h2 = await hashSchema({ name: { kind: 'string', required: false } });
    expect(h1).not.toBe(h2);
  });

  test('omitting required vs required: false produces different hashes', async () => {
    const h1 = await hashSchema({ name: { kind: 'string' } });
    const h2 = await hashSchema({ name: { kind: 'string', required: false } });
    expect(h1).not.toBe(h2);
  });

  test('adding a field produces a different hash', async () => {
    const h1 = await hashSchema({ text: { kind: 'text', required: true } });
    const h2 = await hashSchema({
      text: { kind: 'text', required: true },
      title: { kind: 'string' },
    });
    expect(h1).not.toBe(h2);
  });

  test('nested object keys are sorted canonically', async () => {
    const schemaAB: TypeSchema = {
      address: {
        kind: 'object',
        properties: {
          city: { kind: 'string', required: true },
          street: { kind: 'string', required: true },
        },
      },
    };
    const schemaBA: TypeSchema = {
      address: {
        kind: 'object',
        properties: {
          street: { kind: 'string', required: true },
          city: { kind: 'string', required: true },
        },
      },
    };
    expect(await hashSchema(schemaAB)).toBe(await hashSchema(schemaBA));
  });

  test('array item type affects the hash', async () => {
    const h1 = await hashSchema({ tags: { kind: 'array', items: { kind: 'string' } } });
    const h2 = await hashSchema({ tags: { kind: 'array', items: { kind: 'number' } } });
    expect(h1).not.toBe(h2);
  });
});

// -------------------------------------------------------
// isCompatible
// -------------------------------------------------------

describe('isCompatible', () => {
  test('exact match is compatible', () => {
    const schema: TypeSchema = { text: { kind: 'text', required: true } };
    expect(isCompatible(schema, schema)).toBe(true);
  });

  test('candidate with extra fields is compatible', () => {
    const candidate: TypeSchema = {
      text: { kind: 'text', required: true },
      title: { kind: 'string', required: false },
    };
    const required: TypeSchema = {
      text: { kind: 'text', required: true },
    };
    expect(isCompatible(candidate, required)).toBe(true);
  });

  test('candidate missing a required field is not compatible', () => {
    const candidate: TypeSchema = {
      title: { kind: 'string', required: true },
    };
    const required: TypeSchema = {
      text: { kind: 'text', required: true },
    };
    expect(isCompatible(candidate, required)).toBe(false);
  });

  test('field kind mismatch is not compatible', () => {
    const candidate: TypeSchema = { text: { kind: 'number', required: true } };
    const required: TypeSchema = { text: { kind: 'text', required: true } };
    expect(isCompatible(candidate, required)).toBe(false);
  });

  test('optional fields in required schema are ignored', () => {
    const candidate: TypeSchema = {
      text: { kind: 'text', required: true },
    };
    const required: TypeSchema = {
      text: { kind: 'text', required: true },
      title: { kind: 'string', required: false }, // optional — candidate doesn't need it
    };
    expect(isCompatible(candidate, required)).toBe(true);
  });

  test('empty required schema is always compatible', () => {
    const candidate: TypeSchema = { text: { kind: 'text', required: true } };
    expect(isCompatible(candidate, {})).toBe(true);
  });

  test('empty candidate schema is not compatible with required fields', () => {
    const required: TypeSchema = { text: { kind: 'text', required: true } };
    expect(isCompatible({}, required)).toBe(false);
  });
});

// -------------------------------------------------------
// parseTypeId
// -------------------------------------------------------

describe('parseTypeId', () => {
  test('parses a versioned type ID correctly', () => {
    expect(parseTypeId('com.example.myapp/note@2')).toEqual({
      baseId: 'com.example.myapp/note',
      version: 2,
    });
  });

  test('parses version 1 correctly', () => {
    expect(parseTypeId('com.example.myapp/note@1')).toEqual({
      baseId: 'com.example.myapp/note',
      version: 1,
    });
  });

  test('parses system type IDs correctly', () => {
    expect(parseTypeId('_entity@1')).toEqual({ baseId: '_entity', version: 1 });
    expect(parseTypeId('_app@1')).toEqual({ baseId: '_app', version: 1 });
    expect(parseTypeId('_group@1')).toEqual({ baseId: '_group', version: 1 });
  });

  test('returns null for unversioned IDs', () => {
    expect(parseTypeId('com.example.myapp/note')).toBeNull();
    expect(parseTypeId('_entity')).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(parseTypeId('')).toBeNull();
  });

  test('handles multi-digit versions', () => {
    expect(parseTypeId('com.example.myapp/note@42')).toEqual({
      baseId: 'com.example.myapp/note',
      version: 42,
    });
  });
});

// -------------------------------------------------------
// buildTypeId
// -------------------------------------------------------

describe('buildTypeId', () => {
  test('builds a versioned type ID', () => {
    expect(buildTypeId('com.example.myapp/note', 2)).toBe('com.example.myapp/note@2');
  });

  test('roundtrips with parseTypeId', () => {
    const baseId = 'com.example.myapp/note';
    const version = 3;
    const id = buildTypeId(baseId, version);
    const parsed = parseTypeId(id);
    expect(parsed).toEqual({ baseId, version });
  });
});
