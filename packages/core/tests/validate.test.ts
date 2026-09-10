import { describe, test, expect } from 'vitest';
import {
  validateContent,
  validatePatchValues,
  validateReservedKeys,
  isValid,
} from '../src/validate.js';
import type { TypeSchema, FieldDef } from '../src/types.js';

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
// Undeclared fields: the schema is the record's shape, so a key outside it
// is refused rather than stored.
// See docs/spec/data-model.md § Undeclared content fields.
// -------------------------------------------------------

describe('undeclared content fields', () => {
  test('a top-level key the schema does not declare is an error naming it', () => {
    const schema: TypeSchema = { name: { kind: 'string', required: true } };
    const errors = errorsFor({ name: 'Alice', nickname: 'Al' }, schema);
    expect(errors).toEqual([
      { path: 'nickname', message: '"nickname" is not declared by this type' },
    ]);
  });

  test('an undeclared key inside a declared object reports its full path', () => {
    const schema: TypeSchema = {
      address: { kind: 'object', properties: { city: { kind: 'string' } } },
    };
    expect(paths({ address: { city: 'Lisbon', postcode: '1100' } }, schema)).toEqual([
      'address.postcode',
    ]);
  });

  test('an undeclared key inside an array item reports its indexed path', () => {
    const schema: TypeSchema = {
      emails: {
        kind: 'array',
        items: { kind: 'object', properties: { value: { kind: 'string' } } },
      },
    };
    expect(paths({ emails: [{ value: 'a@b.c' }, { label: 'home' }] }, schema)).toEqual([
      'emails[1].label',
    ]);
  });

  test('every undeclared key is reported, not just the first', () => {
    expect(paths({ a: 1, b: 2, c: 3 }, {})).toEqual(['a', 'b', 'c']);
  });
});

describe('open containers', () => {
  // Opacity is declared, never inferred from a missing `items`/`properties`:
  // a schema that forgets to describe its interior does not compile, so it
  // cannot become an unchecked field by accident. @ts-expect-error fails the
  // build if these ever start type-checking.
  test('a container that declares neither its interior nor `open` is a type error', () => {
    // @ts-expect-error - an object must declare `properties` or `open`
    const objectDef: FieldDef = { kind: 'object' };
    // @ts-expect-error - an array must declare `items` or `open`
    const arrayDef: FieldDef = { kind: 'array' };

    // The assertion that matters is above, and `pnpm run typecheck` is what
    // makes it: @ts-expect-error fails the build if either line ever starts
    // type-checking. These two keep the values used.
    expect(objectDef.kind).toBe('object');
    expect(arrayDef.kind).toBe('array');
  });

  test('an open object accepts any interior', () => {
    const schema: TypeSchema = { meta: { kind: 'object', open: true } };
    expect(errorsFor({ meta: { anything: 'goes', nested: { deep: [1, 2] } } }, schema)).toEqual([]);
  });

  test('an open object still has to be an object', () => {
    const schema: TypeSchema = { meta: { kind: 'object', open: true } };
    expect(paths({ meta: 'not-an-object' }, schema)).toEqual(['meta']);
    expect(paths({ meta: [1, 2] }, schema)).toEqual(['meta']);
  });

  test('an open array accepts heterogeneous and null elements', () => {
    const schema: TypeSchema = { tags: { kind: 'array', open: true } };
    expect(errorsFor({ tags: [null, 'x', 3, { a: 1 }] }, schema)).toEqual([]);
  });

  test('an open array still has to be an array', () => {
    const schema: TypeSchema = { tags: { kind: 'array', open: true } };
    expect(paths({ tags: { 0: 'x' } }, schema)).toEqual(['tags']);
  });

  test('a required open container is still required', () => {
    const schema: TypeSchema = { meta: { kind: 'object', open: true, required: true } };
    expect(paths({}, schema)).toEqual(['meta']);
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

  test('an empty schema declares no fields, so it accepts no content', () => {
    expect(isValid({}, {})).toBe(true);
    expect(isValid({ anything: 'goes' }, {})).toBe(false);
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

// -------------------------------------------------------
// validatePatchValues
// -------------------------------------------------------

describe('validatePatchValues', () => {
  test('an undefined value is rejected', () => {
    const errors = validatePatchValues({ text: 'hi', extra: undefined });

    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe('extra');
  });

  test('null is the deletion sentinel, not an undefined value', () => {
    expect(validatePatchValues({ extra: null })).toEqual([]);
  });

  test('an absent key claims nothing', () => {
    expect(validatePatchValues({ text: 'hi' })).toEqual([]);
  });

  // Top-level only, matching the shallow merge: a nested undefined is part
  // of a value being replaced wholesale, not a field the patch addresses.
  test('a nested undefined is left alone', () => {
    expect(validatePatchValues({ meta: { a: 1, b: undefined } })).toEqual([]);
  });

  test('reports every undefined value present, not just the first', () => {
    expect(validatePatchValues({ a: undefined, b: 1, c: undefined }).map((e) => e.path)).toEqual([
      'a',
      'c',
    ]);
  });
});
