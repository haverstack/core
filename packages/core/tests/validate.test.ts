import { describe, test, expect } from 'vitest';
import { validateContent, validateReservedKeys, isValid } from '../src/validate.js';
import type { TypeSchema } from '../src/types.js';

// -------------------------------------------------------
// Helpers
// -------------------------------------------------------

const errorsFor = (content: Record<string, unknown>, schema: TypeSchema) =>
  validateContent(content, schema);

const paths = (content: Record<string, unknown>, schema: TypeSchema) =>
  errorsFor(content, schema).map((e) => e.path);

// -------------------------------------------------------
// Scalar fields
// -------------------------------------------------------

describe('scalar field validation', () => {
  test('valid content with all required scalar fields passes', () => {
    const schema: TypeSchema = {
      name: { kind: 'string', required: true },
      age: { kind: 'number', required: true },
      active: { kind: 'boolean', required: true },
    };
    expect(errorsFor({ name: 'Alice', age: 30, active: true }, schema)).toEqual([]);
  });

  test('missing required field produces an error', () => {
    const schema: TypeSchema = {
      name: { kind: 'string', required: true },
    };
    expect(paths({}, schema)).toContain('name');
  });

  test('missing optional field passes', () => {
    const schema: TypeSchema = {
      name: { kind: 'string', required: true },
      bio: { kind: 'text', required: false },
    };
    expect(errorsFor({ name: 'Alice' }, schema)).toEqual([]);
  });

  test('wrong type for a field produces an error', () => {
    const schema: TypeSchema = { count: { kind: 'number', required: true } };
    const errors = errorsFor({ count: 'not-a-number' }, schema);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].path).toBe('count');
  });

  test('string field rejects number', () => {
    const schema: TypeSchema = { name: { kind: 'string', required: true } };
    expect(paths({ name: 42 }, schema)).toContain('name');
  });

  test('boolean field rejects string', () => {
    const schema: TypeSchema = { active: { kind: 'boolean', required: true } };
    expect(paths({ active: 'true' }, schema)).toContain('active');
  });

  test('text field accepts string', () => {
    const schema: TypeSchema = { body: { kind: 'text', required: true } };
    expect(errorsFor({ body: 'hello world' }, schema)).toEqual([]);
  });

  test('record-ref field accepts string', () => {
    const schema: TypeSchema = { parentId: { kind: 'record-ref', required: true } };
    expect(errorsFor({ parentId: 'abc123' }, schema)).toEqual([]);
  });

  const FILE_ID = 'a'.repeat(64);

  test('file-ref field accepts a well-formed SHA-256 hex fileId', () => {
    const schema: TypeSchema = { fileId: { kind: 'file-ref', required: true } };
    expect(errorsFor({ fileId: FILE_ID }, schema)).toEqual([]);
  });

  test('file-ref field rejects a string of the wrong length', () => {
    const schema: TypeSchema = { fileId: { kind: 'file-ref', required: true } };
    expect(paths({ fileId: 'abc123' }, schema)).toContain('fileId');
  });

  test('file-ref field rejects uppercase hex', () => {
    const schema: TypeSchema = { fileId: { kind: 'file-ref', required: true } };
    expect(paths({ fileId: FILE_ID.toUpperCase() }, schema)).toContain('fileId');
  });

  test('file-ref field rejects non-hex characters', () => {
    const schema: TypeSchema = { fileId: { kind: 'file-ref', required: true } };
    expect(paths({ fileId: 'g'.repeat(64) }, schema)).toContain('fileId');
  });

  test('file-ref field rejects a number', () => {
    const schema: TypeSchema = { fileId: { kind: 'file-ref', required: true } };
    expect(paths({ fileId: 12345 }, schema)).toContain('fileId');
  });

  test('date field accepts ISO 8601 string', () => {
    const schema: TypeSchema = { dueAt: { kind: 'date', required: true } };
    expect(errorsFor({ dueAt: '2024-01-15T14:30:00Z' }, schema)).toEqual([]);
  });

  test('date field accepts ISO 8601 with fractional seconds and a numeric offset', () => {
    const schema: TypeSchema = { dueAt: { kind: 'date', required: true } };
    expect(errorsFor({ dueAt: '2024-01-15T14:30:00.123+05:00' }, schema)).toEqual([]);
  });

  test('date field accepts a date-only ISO 8601 string', () => {
    const schema: TypeSchema = { dueAt: { kind: 'date', required: true } };
    expect(errorsFor({ dueAt: '2024-01-15' }, schema)).toEqual([]);
  });

  test('date field rejects non-date string', () => {
    const schema: TypeSchema = { dueAt: { kind: 'date', required: true } };
    expect(paths({ dueAt: 'not-a-date' }, schema)).toContain('dueAt');
  });

  test('date field rejects number', () => {
    const schema: TypeSchema = { dueAt: { kind: 'date', required: true } };
    expect(paths({ dueAt: 1704067200000 }, schema)).toContain('dueAt');
  });

  // bare Date.parse accepted these — engine-dependent, non-ISO formats
  // that contradicted the "Expected ISO 8601 date string" error message.
  test('date field rejects a long-form date previously accepted by bare Date.parse', () => {
    const schema: TypeSchema = { dueAt: { kind: 'date', required: true } };
    expect(paths({ dueAt: 'March 1 2020' }, schema)).toContain('dueAt');
  });

  test('date field rejects a slash-formatted date previously accepted by bare Date.parse', () => {
    const schema: TypeSchema = { dueAt: { kind: 'date', required: true } };
    expect(paths({ dueAt: '3/1/2020' }, schema)).toContain('dueAt');
  });

  test('date field rejects an ISO-shaped string with an invalid month', () => {
    const schema: TypeSchema = { dueAt: { kind: 'date', required: true } };
    expect(paths({ dueAt: '2024-13-01' }, schema)).toContain('dueAt');
  });

  test('multiple errors are all collected', () => {
    const schema: TypeSchema = {
      name: { kind: 'string', required: true },
      age: { kind: 'number', required: true },
    };
    const errors = errorsFor({}, schema);
    expect(errors.length).toBe(2);
    expect(paths({}, schema)).toContain('name');
    expect(paths({}, schema)).toContain('age');
  });
});

// -------------------------------------------------------
// Array fields
// -------------------------------------------------------

describe('array field validation', () => {
  test('valid array of strings passes', () => {
    const schema: TypeSchema = {
      tags: { kind: 'array', items: { kind: 'string' }, required: true },
    };
    expect(errorsFor({ tags: ['a', 'b', 'c'] }, schema)).toEqual([]);
  });

  test('empty array passes', () => {
    const schema: TypeSchema = {
      tags: { kind: 'array', items: { kind: 'string' }, required: true },
    };
    expect(errorsFor({ tags: [] }, schema)).toEqual([]);
  });

  test('non-array value for array field produces error', () => {
    const schema: TypeSchema = {
      tags: { kind: 'array', items: { kind: 'string' }, required: true },
    };
    expect(paths({ tags: 'not-an-array' }, schema)).toContain('tags');
  });

  test('wrong item type produces error with indexed path', () => {
    const schema: TypeSchema = {
      scores: { kind: 'array', items: { kind: 'number' }, required: true },
    };
    const errors = errorsFor({ scores: [1, 'two', 3] }, schema);
    expect(errors.some((e) => e.path === 'scores[1]')).toBe(true);
  });

  test('array of objects validates each item recursively', () => {
    const schema: TypeSchema = {
      contacts: {
        kind: 'array',
        items: {
          kind: 'object',
          properties: {
            name: { kind: 'string', required: true },
            email: { kind: 'string', required: true },
          },
        },
        required: true,
      },
    };
    const valid = { contacts: [{ name: 'Alice', email: 'a@example.com' }] };
    expect(errorsFor(valid, schema)).toEqual([]);

    const invalid = { contacts: [{ name: 'Alice' }] }; // missing email
    const errors = errorsFor(invalid, schema);
    expect(errors.some((e) => e.path === 'contacts[0].email')).toBe(true);
  });
});

// -------------------------------------------------------
// Object fields
// -------------------------------------------------------

describe('object field validation', () => {
  test('valid nested object passes', () => {
    const schema: TypeSchema = {
      address: {
        kind: 'object',
        required: true,
        properties: {
          street: { kind: 'string', required: true },
          city: { kind: 'string', required: true },
        },
      },
    };
    const content = { address: { street: '123 Main St', city: 'Boston' } };
    expect(errorsFor(content, schema)).toEqual([]);
  });

  test('non-object value for object field produces error', () => {
    const schema: TypeSchema = {
      address: { kind: 'object', required: true, properties: {} },
    };
    expect(paths({ address: 'not-an-object' }, schema)).toContain('address');
    expect(paths({ address: 42 }, schema)).toContain('address');
    expect(paths({ address: [] }, schema)).toContain('address');
  });

  test('missing required nested field produces error with dot path', () => {
    const schema: TypeSchema = {
      address: {
        kind: 'object',
        required: true,
        properties: {
          street: { kind: 'string', required: true },
          city: { kind: 'string', required: true },
        },
      },
    };
    const errors = errorsFor({ address: { street: '123 Main St' } }, schema);
    expect(errors.some((e) => e.path === 'address.city')).toBe(true);
  });

  test('deeply nested errors have correct dot paths', () => {
    const schema: TypeSchema = {
      a: {
        kind: 'object',
        required: true,
        properties: {
          b: {
            kind: 'object',
            required: true,
            properties: {
              c: { kind: 'string', required: true },
            },
          },
        },
      },
    };
    const errors = errorsFor({ a: { b: {} } }, schema);
    expect(errors.some((e) => e.path === 'a.b.c')).toBe(true);
  });
});

// -------------------------------------------------------
// isValid
// -------------------------------------------------------

describe('isValid', () => {
  test('returns true for valid content', () => {
    const schema: TypeSchema = { name: { kind: 'string', required: true } };
    expect(isValid({ name: 'Alice' }, schema)).toBe(true);
  });

  test('returns false for invalid content', () => {
    const schema: TypeSchema = { name: { kind: 'string', required: true } };
    expect(isValid({}, schema)).toBe(false);
  });

  test('returns true for empty schema', () => {
    expect(isValid({ anything: 'goes' }, {})).toBe(true);
  });
});

// -------------------------------------------------------
// validateReservedKeys
// -------------------------------------------------------

describe('validateReservedKeys', () => {
  test.each(['__proto__', 'constructor', 'prototype'])('%s is rejected', (key) => {
    const content = JSON.parse(`{"${key}": "value"}`) as Record<string, unknown>;

    const errors = validateReservedKeys(content);

    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe(key);
  });

  test('ordinary undeclared fields are untouched — they are allowed by design', () => {
    expect(validateReservedKeys({ anything: 'goes', nested: { deep: true } })).toEqual([]);
  });

  // A literal `{ __proto__: ... }` reassigns the prototype rather than
  // creating a key, so there is no own property to reject and nothing to
  // store either. Only the own-property forms (JSON, computed keys) matter.
  test('a prototype set through the literal setter is not an own key', () => {
    const viaSetter = { __proto__: { polluted: true } };

    expect(validateReservedKeys(viaSetter as Record<string, unknown>)).toEqual([]);
  });

  test('reports every reserved key present, not just the first', () => {
    const content = JSON.parse('{"__proto__": 1, "prototype": 2}') as Record<string, unknown>;

    expect(validateReservedKeys(content).map((e) => e.path)).toEqual(['__proto__', 'prototype']);
  });
});
