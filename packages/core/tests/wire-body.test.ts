import { describe, test, expect } from 'vitest';
import {
  parseAuthChallengeBody,
  parseAuthTokenBody,
  parseEntityPatchBody,
  parseTypeBody,
  parseMigrationBody,
} from '../src/wire-entry.js';
import { Stack } from '../src/stack.js';
import { StackBadRequestError, StackValidationError } from '../src/errors.js';
import { MemoryAdapter } from '../src/testing.js';
import type { TypeSchema } from '../src/types.js';

const DID = 'did:key:z6Mkfsz9oK6i2355mvEwtDYdAmqCN6kmQETThJtARfj9iGum';

/** The path a StackValidationError reports, for asserting the 422 names the field. */
const pathOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (err) {
    if (err instanceof StackValidationError) return err.errors[0]?.path;
    throw err;
  }
  return undefined;
};

describe('body parsers — shared refusals', () => {
  const parsers = {
    parseAuthChallengeBody,
    parseAuthTokenBody,
    parseEntityPatchBody,
    parseTypeBody,
    parseMigrationBody,
  };

  for (const [name, parse] of Object.entries(parsers)) {
    test(`${name} refuses a body that is not an object with 400`, () => {
      for (const body of [undefined, null, [], 'x', 1])
        expect(() => parse(body)).toThrow(StackBadRequestError);
    });
  }
});

describe('parseAuthChallengeBody', () => {
  test('reads did', () => {
    expect(parseAuthChallengeBody({ did: DID })).toEqual({ did: DID });
  });

  test('an unknown key is 400', () => {
    expect(() => parseAuthChallengeBody({ did: DID, origin: 'x' })).toThrow(
      new StackBadRequestError('Unknown key in auth challenge body: origin'),
    );
  });

  test('an absent did is 400; a non-string one is 422 naming the field', () => {
    expect(() => parseAuthChallengeBody({})).toThrow(StackBadRequestError);
    expect(pathOf(() => parseAuthChallengeBody({ did: 1 }))).toBe('did');
  });

  test('the form of the DID is not judged here', () => {
    expect(parseAuthChallengeBody({ did: 'not-a-did' })).toEqual({ did: 'not-a-did' });
  });
});

describe('parseAuthTokenBody', () => {
  const body = { did: DID, nonce: 'k7Qm2ZxRt9vLbNc4Hy8Wf3', signature: 'CIvHvqS' };

  test('reads did, nonce and signature', () => {
    expect(parseAuthTokenBody(body)).toEqual(body);
  });

  test('a key naming a subject is refused rather than ignored', () => {
    expect(() => parseAuthTokenBody({ ...body, subjectId: 'did:key:other' })).toThrow(
      new StackBadRequestError('Unknown key in auth token body: subjectId'),
    );
  });

  test('each field is required, and must be a string', () => {
    for (const key of ['did', 'nonce', 'signature'] as const) {
      const { [key]: _, ...rest } = body;
      expect(() => parseAuthTokenBody(rest)).toThrow(StackBadRequestError);
      expect(pathOf(() => parseAuthTokenBody({ ...body, [key]: null }))).toBe(key);
    }
  });
});

describe('parseEntityPatchBody', () => {
  test('reads content, keeping null as a removal', () => {
    expect(parseEntityPatchBody({ content: { name: 'Jane', handle: null } })).toEqual({
      content: { name: 'Jane', handle: null },
    });
  });

  test('an unknown key is 400', () => {
    expect(() => parseEntityPatchBody({ content: {}, did: DID })).toThrow(StackBadRequestError);
  });

  test('an absent content is 400; a non-object one is 422 naming the field', () => {
    expect(() => parseEntityPatchBody({})).toThrow(StackBadRequestError);
    expect(pathOf(() => parseEntityPatchBody({ content: [] }))).toBe('content');
    expect(pathOf(() => parseEntityPatchBody({ content: null }))).toBe('content');
  });
});

describe('parseTypeBody', () => {
  const schema: TypeSchema = { title: { kind: 'string', required: true } };

  test('a whole Type as a client serializes one parses to defineType() options', async () => {
    const stack = await Stack.open(
      new MemoryAdapter({ ownerEntityId: 'did:key:owner', timezone: 'UTC' }),
    );
    const type = await stack.defineType({ id: 'com.example/note@1', name: 'Note', schema });
    const wire = JSON.parse(JSON.stringify(type)) as unknown;
    expect(parseTypeBody(wire)).toEqual({ id: 'com.example/note@1', name: 'Note', schema });
  });

  test('migratesFrom is read when present', () => {
    expect(
      parseTypeBody({ id: 'com.example/note@2', name: 'Note', schema, migratesFrom: 'x@1' }),
    ).toMatchObject({ migratesFrom: 'x@1' });
    expect(pathOf(() => parseTypeBody({ id: 'a@1', name: 'A', schema, migratesFrom: 1 }))).toBe(
      'migratesFrom',
    );
  });

  test('a key no Type carries is 400', () => {
    expect(() => parseTypeBody({ id: 'a@1', name: 'A', schema, description: 'x' })).toThrow(
      new StackBadRequestError('Unknown key in type body: description'),
    );
  });

  test('id, name and schema are required', () => {
    expect(() => parseTypeBody({ name: 'A', schema })).toThrow(StackBadRequestError);
    expect(() => parseTypeBody({ id: 'a@1', schema })).toThrow(StackBadRequestError);
    expect(() => parseTypeBody({ id: 'a@1', name: 'A' })).toThrow(StackBadRequestError);
    expect(pathOf(() => parseTypeBody({ id: 1, name: 'A', schema }))).toBe('id');
  });

  test('a malformed schema passes through for defineType() to answer with 422', async () => {
    const options = parseTypeBody({ id: 'a@1', name: 'A', schema: 'not a schema' });
    const stack = await Stack.open(
      new MemoryAdapter({ ownerEntityId: 'did:key:owner', timezone: 'UTC' }),
    );
    await expect(stack.defineType(options)).rejects.toThrow(StackValidationError);
  });
});

describe('parseMigrationBody', () => {
  test('reads toTypeId and content', () => {
    expect(parseMigrationBody({ toTypeId: 'a@2', content: { title: 'x' } })).toEqual({
      toTypeId: 'a@2',
      content: { title: 'x' },
    });
  });

  test('an unknown key is 400', () => {
    expect(() => parseMigrationBody({ toTypeId: 'a@2', content: {}, fromTypeId: 'a@1' })).toThrow(
      StackBadRequestError,
    );
  });

  test('both fields are required; a wrong-typed one is 422 naming the field', () => {
    expect(() => parseMigrationBody({ content: {} })).toThrow(StackBadRequestError);
    expect(() => parseMigrationBody({ toTypeId: 'a@2' })).toThrow(StackBadRequestError);
    expect(pathOf(() => parseMigrationBody({ toTypeId: 2, content: {} }))).toBe('toTypeId');
    expect(pathOf(() => parseMigrationBody({ toTypeId: 'a@2', content: 'x' }))).toBe('content');
  });
});
