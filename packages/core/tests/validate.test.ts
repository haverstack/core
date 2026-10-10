import { describe, test, expect } from 'vitest';
import {
  validateContent,
  validateSchemaShape,
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

  // Date.parse accepts these, but they are engine-dependent and not ISO
  // 8601, which is what the error message promises.
  test('date field rejects a long-form date', () => {
    const schema: TypeSchema = { dueAt: { kind: 'date', required: true } };
    expect(paths({ dueAt: 'March 1 2020' }, schema)).toContain('dueAt');
  });

  test('date field rejects a slash-formatted date', () => {
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

// -------------------------------------------------------
// Schema shape: defineType() takes a TypeSchema, but a schema off the wire
// is parsed JSON no compiler has seen.
// -------------------------------------------------------

describe('validateSchemaShape', () => {
  const shapeOf = (json: string) => validateSchemaShape(JSON.parse(json));
  const messages = (json: string) => shapeOf(json).map((e) => e.message);

  test('a well-formed schema produces no errors', () => {
    expect(
      shapeOf(`{
        "title": {"kind": "string", "required": true},
        "meta": {"kind": "object", "open": true},
        "tags": {"kind": "array", "items": {"kind": "string"}},
        "address": {"kind": "object", "properties": {"city": {"kind": "string"}}}
      }`),
    ).toEqual([]);
  });

  test('a container declaring neither its interior nor open is refused', () => {
    expect(messages('{"meta": {"kind": "object"}}')).toEqual([
      'An object must declare "properties", or "open": true to leave its keys unvalidated',
    ]);
    expect(messages('{"tags": {"kind": "array"}}')).toEqual([
      'An array must declare "items", or "open": true to leave its elements unvalidated',
    ]);
  });

  // Contradictory rather than merely redundant: one of the two has to be
  // ignored, and nothing says which.
  test('a container declaring both is refused', () => {
    expect(messages('{"meta": {"kind": "object", "open": true, "properties": {}}}')).toEqual([
      'An open object cannot also declare "properties"',
    ]);
    expect(
      messages('{"tags": {"kind": "array", "open": true, "items": {"kind": "string"}}}'),
    ).toEqual(['An open array cannot also declare "items"']);
  });

  test('an unknown or missing kind is refused', () => {
    expect(messages('{"meta": {"kind": "blorp"}}')).toEqual(['"blorp" is not a field kind']);
    expect(messages('{"meta": {"label": "x"}}')).toEqual(['A field definition must name a "kind"']);
  });

  test('a definition that is not an object is refused', () => {
    expect(messages('{"meta": "string"}')).toEqual([
      'A field definition must be an object, got string',
    ]);
    expect(messages('{"meta": null}')).toEqual([
      'A field definition must be an object, got object',
    ]);
  });

  test('a schema that is not an object is refused at the root', () => {
    expect(validateSchemaShape('nope')).toEqual([
      {
        path: '(root)',
        message: 'A schema must be an object mapping field names to definitions, got string',
      },
    ]);
  });

  test('non-boolean required and open are refused', () => {
    expect(messages('{"meta": {"kind": "string", "required": "yes"}}')).toEqual([
      '"required" must be a boolean',
    ]);
    expect(messages('{"meta": {"kind": "object", "open": "yes", "properties": {}}}')).toEqual([
      '"open" must be a boolean',
    ]);
  });

  test('nested definitions are checked, and report their path', () => {
    expect(
      shapeOf('{"address": {"kind": "object", "properties": {"city": {"kind": "blorp"}}}}'),
    ).toEqual([{ path: 'address.city', message: '"blorp" is not a field kind' }]);
    expect(shapeOf('{"tags": {"kind": "array", "items": {"kind": "object"}}}')).toEqual([
      {
        path: 'tags[]',
        message:
          'An object must declare "properties", or "open": true to leave its keys unvalidated',
      },
    ]);
  });

  test('every malformed field is reported, not just the first', () => {
    expect(messages('{"a": {"kind": "blorp"}, "b": {"kind": "array"}}')).toHaveLength(2);
  });
});

describe('plain JSON content', () => {
  const when = new Date('2026-09-28T00:00:00Z');

  test('a Date in a date field is refused with guidance', () => {
    const schema: TypeSchema = { finishedOn: { kind: 'date' } };
    expect(errorsFor({ finishedOn: when }, schema)).toEqual([
      {
        path: 'finishedOn',
        message:
          'Expected an ISO 8601 date string, got a Date. Pass date.toISOString() for a moment in time, or a "YYYY-MM-DD" string for a calendar day.',
      },
    ]);
  });

  test('a Date is named as "a Date" in a string field', () => {
    const schema: TypeSchema = { title: { kind: 'string' } };
    expect(errorsFor({ title: when }, schema)).toEqual([
      { path: 'title', message: 'Expected string, got a Date' },
    ]);
  });

  test('a Date in a closed object field is refused at its path', () => {
    const schema: TypeSchema = {
      meta: { kind: 'object', properties: { a: { kind: 'string' } } },
    };
    expect(errorsFor({ meta: when }, schema)).toEqual([
      { path: 'meta', message: 'Expected object, got a Date' },
    ]);
  });

  test('a Date inside an open object is refused at its path', () => {
    const schema: TypeSchema = { meta: { kind: 'object', open: true } };
    expect(errorsFor({ meta: { nested: { when } } }, schema)).toEqual([
      { path: 'meta.nested.when', message: 'Expected a JSON value, got a Date' },
    ]);
  });

  test('NaN and Infinity inside an open array are refused', () => {
    const schema: TypeSchema = { xs: { kind: 'array', open: true } };
    expect(paths({ xs: [1, NaN, Infinity] }, schema)).toEqual(['xs[1]', 'xs[2]']);
  });

  test('a non-finite number in a number field is refused', () => {
    const schema: TypeSchema = { n: { kind: 'number' } };
    expect(paths({ n: NaN }, schema)).toEqual(['n']);
  });

  test('values that are not plain objects, and undefined, are refused inside open values', () => {
    const schema: TypeSchema = { meta: { kind: 'object', open: true } };
    class Point {}
    expect(
      paths({ meta: { p: new Point(), m: new Map(), u: undefined, f: () => 1 } }, schema),
    ).toEqual(['meta.p', 'meta.m', 'meta.u', 'meta.f']);
  });

  test('null-prototype objects and nulls are plain JSON', () => {
    const schema: TypeSchema = { meta: { kind: 'object', open: true } };
    expect(
      errorsFor({ meta: { a: null, b: Object.assign(Object.create(null), { c: 1 }) } }, schema),
    ).toEqual([]);
  });

  test('a circular open value is refused rather than looping', () => {
    const schema: TypeSchema = { meta: { kind: 'object', open: true } };
    const meta: Record<string, unknown> = {};
    meta.self = meta;
    expect(paths({ meta }, schema)).toEqual(['meta.self']);
  });

  test('an open value nested past the depth cap is refused, not overflowed', () => {
    const schema: TypeSchema = { xs: { kind: 'array', open: true } };
    const deep = JSON.parse('['.repeat(10_000) + ']'.repeat(10_000));
    expect(errorsFor({ xs: deep }, schema)).toEqual([
      {
        path: `xs${'[0]'.repeat(33)}`,
        message: 'Content nesting exceeds maximum depth of 32',
      },
    ]);
  });

  test('an open value at the depth cap is accepted', () => {
    const schema: TypeSchema = { xs: { kind: 'array', open: true } };
    const atCap = JSON.parse('['.repeat(33) + ']'.repeat(33));
    expect(errorsFor({ xs: atCap }, schema)).toEqual([]);
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

// -------------------------------------------------------
// Enums
// -------------------------------------------------------

describe('enum', () => {
  const schema: TypeSchema = {
    status: { kind: 'enum', values: ['want', 'reading', 'finished'] },
  };

  test('a listed value is accepted', () => {
    expect(errorsFor({ status: 'reading' }, schema)).toEqual([]);
  });

  test('an unlisted value is refused at its path, naming the allowed values', () => {
    expect(errorsFor({ status: 'abandoned' }, schema)).toEqual([
      {
        path: 'status',
        message: 'Expected one of "want", "reading", "finished", got "abandoned"',
      },
    ]);
  });

  test('a non-string is refused by the type check, not the value list', () => {
    expect(errorsFor({ status: 3 }, schema)).toEqual([
      { path: 'status', message: 'Expected string, got number' },
    ]);
  });

  test('an enum constrains each element of a declared array', () => {
    const tags: TypeSchema = {
      tags: { kind: 'array', items: { kind: 'enum', values: ['a', 'b'] } },
    };
    expect(paths({ tags: ['a', 'c'] }, tags)).toEqual(['tags[1]']);
  });
});

describe('validateSchemaShape enum', () => {
  const messages = (json: string) => validateSchemaShape(JSON.parse(json)).map((e) => e.message);

  test('a non-empty list of distinct strings is well-formed', () => {
    expect(messages('{"s": {"kind": "enum", "values": ["a", "b"]}}')).toEqual([]);
  });

  test('a misspelled kind is named as the problem, not its values', () => {
    expect(messages('{"s": {"kind": "enm", "values": ["a"]}}')).toEqual([
      '"enm" is not a field kind',
    ]);
  });

  test('missing, empty or non-array values are refused', () => {
    const expected = ['An enum must declare "values", a non-empty array of strings'];
    expect(messages('{"s": {"kind": "enum"}}')).toEqual(expected);
    expect(messages('{"s": {"kind": "enum", "values": []}}')).toEqual(expected);
    expect(messages('{"s": {"kind": "enum", "values": "a"}}')).toEqual(expected);
  });

  test('non-string and duplicate values are refused', () => {
    expect(messages('{"s": {"kind": "enum", "values": ["a", 1]}}')).toEqual([
      '"values" entries must be strings, got number',
    ]);
    expect(messages('{"s": {"kind": "enum", "values": ["a", "a"]}}')).toEqual([
      '"values" lists "a" more than once',
    ]);
  });

  test('values on any other kind are refused', () => {
    expect(messages('{"s": {"kind": "string", "values": ["a"]}}')).toEqual([
      '"values" is only allowed on an enum field, not "string"',
    ]);
    expect(messages('{"a": {"kind": "array", "open": true, "values": ["a"]}}')).toEqual([
      '"values" is only allowed on an enum field, not "array"',
    ]);
    expect(messages('{"o": {"kind": "object", "open": true, "values": ["a"]}}')).toEqual([
      '"values" is only allowed on an enum field, not "object"',
    ]);
  });

  test('an enum key on any field is refused, not ignored', () => {
    expect(messages('{"s": {"kind": "string", "enum": ["a"]}}')).toEqual([
      '"enum" is a field kind, not a field key',
    ]);
  });
});
