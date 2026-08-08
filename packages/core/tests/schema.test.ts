import { describe, test, expect } from 'vitest';
import { hashSchema, isCompatible, diffSchemas, parseTypeId, buildTypeId } from '../src/schema.js';
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

  test('candidate declaring a required field as optional is not compatible', () => {
    const candidate: TypeSchema = { title: { kind: 'string', required: false } };
    const required: TypeSchema = { title: { kind: 'string', required: true } };
    expect(isCompatible(candidate, required)).toBe(false);
  });

  test('candidate declaring a required field with no required flag at all is not compatible', () => {
    const candidate: TypeSchema = { title: { kind: 'string' } };
    const required: TypeSchema = { title: { kind: 'string', required: true } };
    expect(isCompatible(candidate, required)).toBe(false);
  });

  test('text candidate satisfies a required string field', () => {
    const candidate: TypeSchema = { body: { kind: 'text', required: true } };
    const required: TypeSchema = { body: { kind: 'string', required: true } };
    expect(isCompatible(candidate, required)).toBe(true);
  });

  test('string candidate satisfies a required text field', () => {
    const candidate: TypeSchema = { body: { kind: 'string', required: true } };
    const required: TypeSchema = { body: { kind: 'text', required: true } };
    expect(isCompatible(candidate, required)).toBe(true);
  });

  test('date candidate does not satisfy a required string field', () => {
    const candidate: TypeSchema = { body: { kind: 'date', required: true } };
    const required: TypeSchema = { body: { kind: 'string', required: true } };
    expect(isCompatible(candidate, required)).toBe(false);
  });

  test('string candidate does not satisfy a required date field', () => {
    const candidate: TypeSchema = { body: { kind: 'string', required: true } };
    const required: TypeSchema = { body: { kind: 'date', required: true } };
    expect(isCompatible(candidate, required)).toBe(false);
  });

  test('file-ref candidate satisfies a required file-ref field', () => {
    const candidate: TypeSchema = { fileId: { kind: 'file-ref', required: true } };
    const required: TypeSchema = { fileId: { kind: 'file-ref', required: true } };
    expect(isCompatible(candidate, required)).toBe(true);
  });

  test('string candidate does not satisfy a required file-ref field', () => {
    const candidate: TypeSchema = { fileId: { kind: 'string', required: true } };
    const required: TypeSchema = { fileId: { kind: 'file-ref', required: true } };
    expect(isCompatible(candidate, required)).toBe(false);
  });

  test('file-ref candidate does not satisfy a required string field', () => {
    const candidate: TypeSchema = { fileId: { kind: 'file-ref', required: true } };
    const required: TypeSchema = { fileId: { kind: 'string', required: true } };
    expect(isCompatible(candidate, required)).toBe(false);
  });

  test('nested required object property mismatch is not compatible', () => {
    const candidate: TypeSchema = {
      author: {
        kind: 'object',
        required: true,
        properties: {
          name: { kind: 'string', required: false },
        },
      },
    };
    const required: TypeSchema = {
      author: {
        kind: 'object',
        required: true,
        properties: {
          name: { kind: 'string', required: true },
        },
      },
    };
    expect(isCompatible(candidate, required)).toBe(false);
  });

  test('nested object property satisfying required sub-field is compatible', () => {
    const candidate: TypeSchema = {
      author: {
        kind: 'object',
        required: true,
        properties: {
          name: { kind: 'string', required: true },
        },
      },
    };
    const required: TypeSchema = {
      author: {
        kind: 'object',
        required: true,
        properties: {
          name: { kind: 'string', required: true },
        },
      },
    };
    expect(isCompatible(candidate, required)).toBe(true);
  });

  test('nested array item kind mismatch is not compatible', () => {
    const candidate: TypeSchema = {
      tags: { kind: 'array', required: true, items: { kind: 'number' } },
    };
    const required: TypeSchema = {
      tags: { kind: 'array', required: true, items: { kind: 'string' } },
    };
    expect(isCompatible(candidate, required)).toBe(false);
  });

  test('nested array item kind text/string equivalence is compatible', () => {
    const candidate: TypeSchema = {
      tags: { kind: 'array', required: true, items: { kind: 'text' } },
    };
    const required: TypeSchema = {
      tags: { kind: 'array', required: true, items: { kind: 'string' } },
    };
    expect(isCompatible(candidate, required)).toBe(true);
  });

  test("spec's motivating example: a text body satisfies a required string requirement", () => {
    const candidate: TypeSchema = {
      text: { kind: 'text', required: true },
    };
    const required: TypeSchema = {
      text: { kind: 'string', required: true },
    };
    expect(isCompatible(candidate, required)).toBe(true);
  });

  test('deeply nested matching schemas beyond the depth limit are not compatible (fails closed)', () => {
    const buildNested = (depth: number): TypeSchema => {
      let schema: TypeSchema = { leaf: { kind: 'string', required: true } };
      for (let i = 0; i < depth; i++) {
        schema = { nested: { kind: 'object', required: true, properties: schema } };
      }
      return schema;
    };
    const candidate = buildNested(1000);
    const required = buildNested(1000);
    expect(() => isCompatible(candidate, required)).not.toThrow();
    expect(isCompatible(candidate, required)).toBe(false);
  });

  test('matching schemas within the depth limit remain compatible', () => {
    const buildNested = (depth: number): TypeSchema => {
      let schema: TypeSchema = { leaf: { kind: 'string', required: true } };
      for (let i = 0; i < depth; i++) {
        schema = { nested: { kind: 'object', required: true, properties: schema } };
      }
      return schema;
    };
    const candidate = buildNested(10);
    const required = buildNested(10);
    expect(isCompatible(candidate, required)).toBe(true);
  });
});

// -------------------------------------------------------
// diffSchemas
// -------------------------------------------------------

describe('diffSchemas', () => {
  test('identical schemas produce no violations', () => {
    const schema: TypeSchema = { text: { kind: 'text', required: true } };
    expect(diffSchemas(schema, schema)).toEqual([]);
  });

  test('a new optional field is additive-legal', () => {
    const stored: TypeSchema = { text: { kind: 'text', required: true } };
    const candidate: TypeSchema = {
      text: { kind: 'text', required: true },
      title: { kind: 'string' },
    };
    expect(diffSchemas(stored, candidate)).toEqual([]);
  });

  test('a new required field is drift', () => {
    const stored: TypeSchema = { text: { kind: 'text', required: true } };
    const candidate: TypeSchema = {
      text: { kind: 'text', required: true },
      title: { kind: 'string', required: true },
    };
    const violations = diffSchemas(stored, candidate);
    expect(violations).toEqual([
      { path: 'title', message: 'new field is required; new fields must be optional' },
    ]);
  });

  test('removing a field is drift', () => {
    const stored: TypeSchema = {
      text: { kind: 'text', required: true },
      title: { kind: 'string' },
    };
    const candidate: TypeSchema = { text: { kind: 'text', required: true } };
    const violations = diffSchemas(stored, candidate);
    expect(violations).toEqual([{ path: 'title', message: 'field removed' }]);
  });

  test('changing a field’s kind is drift, even to a read-compatible kind (text/string)', () => {
    const stored: TypeSchema = { body: { kind: 'text', required: true } };
    const candidate: TypeSchema = { body: { kind: 'string', required: true } };
    const violations = diffSchemas(stored, candidate);
    expect(violations).toEqual([{ path: 'body', message: 'kind changed from "text" to "string"' }]);
  });

  test('flipping an existing field from optional to required is drift', () => {
    const stored: TypeSchema = { title: { kind: 'string' } };
    const candidate: TypeSchema = { title: { kind: 'string', required: true } };
    const violations = diffSchemas(stored, candidate);
    expect(violations).toEqual([{ path: 'title', message: 'required changed from false to true' }]);
  });

  test('flipping an existing field from required to optional is drift', () => {
    const stored: TypeSchema = { title: { kind: 'string', required: true } };
    const candidate: TypeSchema = { title: { kind: 'string' } };
    const violations = diffSchemas(stored, candidate);
    expect(violations).toEqual([{ path: 'title', message: 'required changed from true to false' }]);
  });

  test('a new optional field nested inside an existing object is additive-legal', () => {
    const stored: TypeSchema = {
      author: { kind: 'object', required: true, properties: { name: { kind: 'string' } } },
    };
    const candidate: TypeSchema = {
      author: {
        kind: 'object',
        required: true,
        properties: { name: { kind: 'string' }, email: { kind: 'string' } },
      },
    };
    expect(diffSchemas(stored, candidate)).toEqual([]);
  });

  test('removing a nested object field is drift, with a dotted path', () => {
    const stored: TypeSchema = {
      author: {
        kind: 'object',
        required: true,
        properties: { name: { kind: 'string', required: true } },
      },
    };
    const candidate: TypeSchema = {
      author: { kind: 'object', required: true, properties: {} },
    };
    const violations = diffSchemas(stored, candidate);
    expect(violations).toEqual([{ path: 'author.name', message: 'field removed' }]);
  });

  test('changing an array item field is drift, with a bracketed path', () => {
    const stored: TypeSchema = {
      tags: { kind: 'array', required: true, items: { kind: 'string' } },
    };
    const candidate: TypeSchema = {
      tags: { kind: 'array', required: true, items: { kind: 'number' } },
    };
    const violations = diffSchemas(stored, candidate);
    expect(violations).toEqual([
      { path: 'tags[]', message: 'kind changed from "string" to "number"' },
    ]);
  });

  test('a field changing kind from object to array (or vice versa) is drift, not a recursion', () => {
    const stored: TypeSchema = {
      data: { kind: 'object', required: true, properties: { x: { kind: 'string' } } },
    };
    const candidate: TypeSchema = {
      data: { kind: 'array', required: true, items: { kind: 'string' } },
    };
    const violations = diffSchemas(stored, candidate);
    expect(violations).toEqual([
      { path: 'data', message: 'kind changed from "object" to "array"' },
    ]);
  });

  test('multiple independent violations are all reported', () => {
    const stored: TypeSchema = {
      text: { kind: 'text', required: true },
      title: { kind: 'string' },
    };
    const candidate: TypeSchema = {
      text: { kind: 'string', required: true }, // kind change
      newRequired: { kind: 'string', required: true }, // new required field
      // title removed entirely
    };
    const violations = diffSchemas(stored, candidate);
    expect(violations).toContainEqual({
      path: 'text',
      message: 'kind changed from "text" to "string"',
    });
    expect(violations).toContainEqual({ path: 'title', message: 'field removed' });
    expect(violations).toContainEqual({
      path: 'newRequired',
      message: 'new field is required; new fields must be optional',
    });
    expect(violations).toHaveLength(3);
  });

  test('exceeding the max diff depth fails closed (reported as drift, not silently accepted)', () => {
    const buildNested = (depth: number, leafKind: 'string' | 'number'): TypeSchema => {
      let schema: TypeSchema = { leaf: { kind: leafKind, required: true } };
      for (let i = 0; i < depth; i++) {
        schema = { nested: { kind: 'object', required: true, properties: schema } };
      }
      return schema;
    };
    const stored = buildNested(1000, 'string');
    const candidate = buildNested(1000, 'string');
    expect(() => diffSchemas(stored, candidate)).not.toThrow();
    expect(diffSchemas(stored, candidate).length).toBeGreaterThan(0);
  });

  test('matching schemas within the depth limit produce no violations', () => {
    const buildNested = (depth: number): TypeSchema => {
      let schema: TypeSchema = { leaf: { kind: 'string', required: true } };
      for (let i = 0; i < depth; i++) {
        schema = { nested: { kind: 'object', required: true, properties: schema } };
      }
      return schema;
    };
    const stored = buildNested(10);
    const candidate = buildNested(10);
    expect(diffSchemas(stored, candidate)).toEqual([]);
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
