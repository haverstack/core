import { describe, test, expect, beforeEach } from 'vitest';
import { Stack } from '../src/stack.js';
import type { StackClient } from '../src/stack.js';
import { StackBadRequestError, StackValidationError } from '../src/errors.js';
import { MemoryAdapter } from '../src/testing.js';
import type { DataAssociation, TypeGrant } from '../src/types.js';

const NOTE = 'com.example.test/note@1';
const OWNER = 'did:key:owner';
const TAG: DataAssociation = { kind: 'tag', label: 'starred' };
const GRANT: TypeGrant = {
  grantee: { kind: 'entity', entityId: 'did:key:a' },
  actions: ['read-any'],
};

let stack: Stack;
let recordId: string;

beforeEach(async () => {
  stack = await Stack.open(await MemoryAdapter.open({ ownerEntityId: OWNER, timezone: 'UTC' }));
  await stack.defineType({ id: NOTE, name: 'Note', schema: { text: { kind: 'text' } } });
  recordId = (await stack.create(NOTE, { text: 'x' })).id;
});

/** The refusal's header — its message's first line — and the path of each line under it. */
const refusal = async (p: Promise<unknown>): Promise<{ header: string; paths: string[] }> => {
  const err = await p.then(
    () => {
      throw new Error('expected a refusal');
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(StackValidationError);
  const { message, errors } = err as StackValidationError;
  return { header: message.split('\n')[0]!, paths: errors.map((e) => e.path) };
};

describe('a content refusal says content was validated', () => {
  test('create() with content the schema refuses', async () => {
    expect(await refusal(stack.create(NOTE, { text: 1 }))).toEqual({
      header: 'Content validation failed:',
      paths: ['text'],
    });
  });

  test('mutate() with a patch the schema refuses', async () => {
    expect(await refusal(stack.mutate(recordId, { contentPatch: { text: 1 } }))).toEqual({
      header: 'Content validation failed:',
      paths: ['text'],
    });
  });
});

describe('an argument refusal says the arguments were invalid, under their own names', () => {
  test('defineType() names the schema', async () => {
    const bad = { id: 'com.example.test/bad@1', name: 'Bad', schema: { x: { kind: 'nope' } } };
    expect((await refusal(stack.defineType(bad as never))).header).toBe(
      'Schema validation failed:',
    );
  });

  test('create() with an option the schema never sees', async () => {
    expect(await refusal(stack.create(NOTE, { text: 'y' }, { associations: [TAG, TAG] }))).toEqual({
      header: 'Invalid arguments:',
      paths: ['associations[1]'],
    });
    expect(
      await refusal(stack.create(NOTE, { text: 'y' }, { createdAt: new Date('nope') })),
    ).toEqual({ header: 'Invalid arguments:', paths: ['createdAt'] });
  });

  test('create() and mutate() report argument and content problems in one refusal', async () => {
    expect(await refusal(stack.create(NOTE, { text: 1 }, { associations: [TAG, TAG] }))).toEqual({
      header: 'Invalid arguments:',
      paths: ['associations[1]', 'text'],
    });
    expect(
      await refusal(
        stack.mutate(recordId, { associations: [TAG, TAG], contentPatch: { text: undefined } }),
      ),
    ).toEqual({ header: 'Invalid arguments:', paths: ['associations[1]', 'text'] });
  });

  test('mutate() with a duplicate association', async () => {
    expect(await refusal(stack.mutate(recordId, { associations: [TAG, TAG] }))).toEqual({
      header: 'Invalid arguments:',
      paths: ['associations[1]'],
    });
  });

  test('migrateAll() and revokeType() given a TypeId', async () => {
    expect(await refusal(stack.migrateAll(NOTE as never))).toEqual({
      header: 'Invalid arguments:',
      paths: ['baseId'],
    });
    expect(await refusal(stack.revokeType(NOTE as never, GRANT))).toEqual({
      header: 'Invalid arguments:',
      paths: ['baseId'],
    });
  });

  test('grantType() given a TypeId', async () => {
    expect(await refusal(stack.grantType(NOTE as never, GRANT))).toEqual({
      header: 'Invalid arguments:',
      paths: ['baseId'],
    });
  });

  test('query() with a versioned filter.baseId', async () => {
    expect(await refusal(stack.query({ filter: { baseId: NOTE } }))).toEqual({
      header: 'Invalid arguments:',
      paths: ['filter.baseId'],
    });
  });

  test('amendAssociations() reports under changes', async () => {
    expect(await refusal(stack.amendAssociations(recordId, []))).toEqual({
      header: 'Invalid arguments:',
      paths: ['changes'],
    });
    const add = { op: 'add', association: TAG } as const;
    expect(await refusal(stack.amendAssociations(recordId, [add, add]))).toEqual({
      header: 'Invalid arguments:',
      paths: ['changes[1]'],
    });
  });

  for (const [name, client] of [
    ['Stack', () => stack],
    ['ScopedStack', () => stack.asEntity(OWNER)],
  ] as [string, () => StackClient][]) {
    describe(`${name}: the list verbs report under the list they were passed`, () => {
      test('associate() and dissociate() under associations', async () => {
        for (const verb of ['associate', 'dissociate'] as const) {
          expect(await refusal(client()[verb](recordId, []))).toEqual({
            header: 'Invalid arguments:',
            paths: ['associations'],
          });
          expect(await refusal(client()[verb](recordId, [TAG, TAG]))).toEqual({
            header: 'Invalid arguments:',
            paths: ['associations[1]'],
          });
        }
      });

      test('a wrong-surface element is refused as such, even when duplicated', async () => {
        const read = { kind: 'anyone', label: 'read' } as never;
        for (const verb of ['associate', 'dissociate'] as const) {
          await expect(client()[verb](recordId, [read, read])).rejects.toBeInstanceOf(
            StackBadRequestError,
          );
        }
        for (const verb of ['grantAccess', 'revokeAccess'] as const) {
          await expect(client()[verb](recordId, [TAG, TAG] as never)).rejects.toBeInstanceOf(
            StackBadRequestError,
          );
        }
      });

      test('grantAccess() and revokeAccess() under permissions', async () => {
        const anyone = { kind: 'anyone', label: 'write' } as never;
        for (const verb of ['grantAccess', 'revokeAccess'] as const) {
          expect(await refusal(client()[verb](recordId, []))).toEqual({
            header: 'Invalid arguments:',
            paths: ['permissions'],
          });
          expect(await refusal(client()[verb](recordId, [anyone]))).toEqual({
            header: 'Invalid arguments:',
            paths: ['permissions[0].label'],
          });
        }
      });
    });
  }
});
