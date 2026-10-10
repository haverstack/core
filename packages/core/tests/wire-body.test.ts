import { describe, test, expect } from 'vitest';
import {
  parseAssociationEditsBody,
  parseAuthChallengeBody,
  parseAuthTokenBody,
  parseEntityPatchBody,
  parseTypeBody,
  parseMigrationBody,
  parseInstallBody,
} from '../src/wire/index.js';
import { Stack } from '../src/stack/stack.js';
import { StackBadRequestError, StackValidationError } from '../src/errors.js';
import { MemoryAdapter } from '../src/testing.js';
import type { TypeSchema } from '../src/types/index.js';

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
  test('reads contentPatch, keeping null as a removal', () => {
    expect(parseEntityPatchBody({ contentPatch: { name: 'Jane', handle: null } })).toEqual({
      contentPatch: { name: 'Jane', handle: null },
    });
  });

  test('an unknown key is 400, content included', () => {
    expect(() => parseEntityPatchBody({ contentPatch: {}, did: DID })).toThrow(
      StackBadRequestError,
    );
    expect(() => parseEntityPatchBody({ content: {} })).toThrow(StackBadRequestError);
  });

  test('an absent contentPatch is 400; a non-object one is 422 naming the field', () => {
    expect(() => parseEntityPatchBody({})).toThrow(StackBadRequestError);
    expect(pathOf(() => parseEntityPatchBody({ contentPatch: [] }))).toBe('contentPatch');
    expect(pathOf(() => parseEntityPatchBody({ contentPatch: null }))).toBe('contentPatch');
  });
});

describe('parseTypeBody', () => {
  const schema: TypeSchema = { title: { kind: 'string', required: true } };

  test('a whole Type as a client serializes one parses to defineType() options', async () => {
    const stack = await Stack.open(
      await MemoryAdapter.open({ ownerEntityId: 'did:key:owner', timezone: 'UTC' }),
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
      await MemoryAdapter.open({ ownerEntityId: 'did:key:owner', timezone: 'UTC' }),
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

describe('parseAssociationEditsBody', () => {
  const tag = { kind: 'tag', label: 'starred' };

  test('returns the edits in the order they were sent', () => {
    const changes = [
      { op: 'remove', association: tag },
      { op: 'add', association: { kind: 'tag', label: 'new' } },
    ];
    expect(parseAssociationEditsBody({ changes })).toEqual(changes);
  });

  test.each([
    ['a body that is not an object', []],
    ['a missing changes list', {}],
    ['an empty changes list', { changes: [] }],
    ['an unknown body key', { changes: [{ op: 'add', association: tag }], extra: 1 }],
    ['an unknown edit key', { changes: [{ op: 'add', association: tag, extra: 1 }] }],
    [
      'a repoint, which only the journal records',
      { changes: [{ op: 'repoint', association: tag }] },
    ],
    ['an unknown op', { changes: [{ op: 'replace', association: tag }] }],
  ])('refuses %s with 400', (_name, body) => {
    expect(() => parseAssociationEditsBody(body)).toThrow(StackBadRequestError);
  });

  test('a malformed element is a 422 naming its path', () => {
    expect(
      pathOf(() =>
        parseAssociationEditsBody({
          changes: [{ op: 'add', association: { kind: 'anyone', label: 'write' } }],
        }),
      ),
    ).toBe('changes[0].association.label');
  });
});

describe('parseInstallBody', () => {
  const manifest = {
    appId: 'com.example.notes',
    name: 'Notes',
    version: '1.0.0',
    types: [{ id: 'com.example.notes/note@1', name: 'Note', schema: { text: { kind: 'text' } } }],
    requests: [{ baseId: 'com.example.notes/note', actions: ['create', 'read-any'] }],
  };

  test('reads a manifest into what planInstall() takes', () => {
    expect(parseInstallBody({ manifest })).toEqual(manifest);
  });

  test('an unknown key at either level, or a missing field, is not this request', () => {
    expect(() => parseInstallBody({ manifest, did: DID })).toThrow(StackBadRequestError);
    expect(() => parseInstallBody({ manifest: { ...manifest, did: DID } })).toThrow(
      StackBadRequestError,
    );
    const { requests: _, ...noRequests } = manifest;
    expect(() => parseInstallBody({ manifest: noRequests })).toThrow(StackBadRequestError);
  });

  test('a wrongly typed field names its path', () => {
    expect(pathOf(() => parseInstallBody({ manifest: { ...manifest, types: {} } }))).toBe(
      'manifest.types',
    );
    expect(
      pathOf(() =>
        parseInstallBody({
          manifest: { ...manifest, requests: [{ baseId: 'com.example.notes/note', actions: [1] }] },
        }),
      ),
    ).toBe('manifest.requests[0].actions[0]');
  });
});
