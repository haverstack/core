import { describe, test, expect, beforeEach } from 'vitest';
import { Stack } from '../src/stack/stack.js';
import { StackBadRequestError, StackValidationError } from '../src/errors.js';
import { MemoryAdapter } from '../src/testing.js';
import type { AuthorityAssociation, ValidationError } from '../src/index.js';

// One validator holds every grantee to the same rules: a permission
// element's, a `_grant` record's, and a grant target's.
// See docs/spec/access-control.md § Record-level permissions.

const NOTE = 'com.example.test/note@1';
const OWNER = 'did:key:owner';

let stack: Stack;
let recordId: string;

beforeEach(async () => {
  stack = await Stack.open(await MemoryAdapter.open({ ownerEntityId: OWNER, timezone: 'UTC' }));
  await stack.defineType({ id: NOTE, name: 'Note', schema: { text: { kind: 'text' } } });
  recordId = (await stack.create(NOTE, { text: 'x' })).id;
});

/** The details a write is refused with, or a failure if it is not refused. */
const refusal = async (write: Promise<unknown>): Promise<ValidationError[]> => {
  const err = await write.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(StackValidationError);
  return (err as StackValidationError).errors;
};

const permission = (grantee: unknown): AuthorityAssociation =>
  ({ kind: 'permission', label: 'read', grantee }) as AuthorityAssociation;

describe('a permission element names the grantee field it is refused for', () => {
  test('a missing entityId is reported at grantee.entityId', async () => {
    const errors = await refusal(
      stack.mutate(recordId, { permissions: [permission({ kind: 'entity', entityId: '' })] }),
    );
    expect(errors).toEqual([
      {
        path: 'permissions[0].grantee.entityId',
        message: 'An entity grantee requires a non-empty entityId.',
      },
    ]);
  });

  test('a group grantee missing groupId and role reports both', async () => {
    const errors = await refusal(
      stack.mutate(recordId, { permissions: [permission({ kind: 'group', groupId: '' })] }),
    );
    expect(errors.map((e) => e.path)).toEqual([
      'permissions[0].grantee.groupId',
      'permissions[0].grantee.role',
    ]);
  });

  test('the authenticated tier is a _grant tier, not a permission one', async () => {
    const errors = await refusal(
      stack.mutate(recordId, { permissions: [permission({ kind: 'authenticated' })] }),
    );
    expect(errors).toEqual([
      {
        path: 'permissions[0].grantee.kind',
        message: "A grantee must name its tier: 'entity' or 'group'.",
      },
    ]);
  });

  test('every message in one refusal ends the same way', async () => {
    const errors = await refusal(
      stack.mutate(recordId, {
        permissions: [
          { kind: 'permission', label: 'admin', grantee: { kind: 'entity', entityId: 'a' } },
          permission({ kind: 'group', groupId: '' }),
          { kind: 'anyone', label: 'write' },
        ] as AuthorityAssociation[],
      }),
    );
    expect(errors).toHaveLength(4);
    for (const { message } of errors) expect(message).toMatch(/\.$/);
  });
});

describe('a _grant record names the grantee field it is refused for', () => {
  test('a group grantee missing groupId and role reports both', async () => {
    const errors = await refusal(
      stack.create('_grant@1', {
        baseId: 'com.example.test/note',
        actions: ['read-any'],
        grantee: { kind: 'group', groupId: '' },
      }),
    );
    expect(errors).toEqual([
      { path: 'grantee.groupId', message: 'A group grantee requires a non-empty groupId.' },
      { path: 'grantee.role', message: "A group grantee requires role 'member' or 'admin'." },
    ]);
  });

  test('a key its tier does not define is collected, not thrown', async () => {
    const errors = await refusal(
      stack.create('_grant@1', {
        baseId: 'com.example.test/note',
        actions: ['read-any'],
        grantee: { kind: 'entity', entityId: 'did:key:a', role: 'admin' },
      }),
    );
    expect(errors).toEqual([
      { path: 'grantee.role', message: 'An entity grantee does not carry role.' },
    ]);
  });
});

describe('a grant target is refused as a grant target, every problem at once', () => {
  test('a group target missing groupId and role reports both', async () => {
    await expect(
      stack.grantType('com.example.test/note', {
        actions: ['read-any'],
        grantee: { kind: 'group', groupId: '' } as never,
      }),
    ).rejects.toThrow(
      new StackBadRequestError(
        'Invalid grant target: A group grantee requires a non-empty groupId. ' +
          "A group grantee requires role 'member' or 'admin'.",
      ),
    );
  });

  test("a listing admits role 'any' and still requires its groupId", async () => {
    await expect(stack.listTypeGrants({ kind: 'group', groupId: '', role: 'any' })).rejects.toThrow(
      new StackBadRequestError(
        'Invalid grant target: A group grantee requires a non-empty groupId.',
      ),
    );
  });
});
