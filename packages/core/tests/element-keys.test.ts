import { describe, test, expect, beforeEach } from 'vitest';
import { Stack } from '../src/stack.js';
import { StackBadRequestError, StackValidationError } from '../src/errors.js';
import { MemoryAdapter } from '../src/testing.js';
import type { Association, DataAssociation, AuthorityAssociation } from '../src/types.js';

const NOTE = 'com.example.test/note@1';
const OWNER = 'did:key:owner';

let stack: Stack;
let recordId: string;

beforeEach(async () => {
  stack = await Stack.open(new MemoryAdapter({ ownerEntityId: OWNER, timezone: 'UTC' }));
  await stack.defineType({ id: NOTE, name: 'Note', schema: { text: { kind: 'text' } } });
  recordId = (await stack.create(NOTE, { text: 'x' })).id;
});

/** An element carrying a key its kind does not define. */
const extra = <T extends Association>(a: T, key: string, value: unknown = 'x'): T =>
  ({ ...a, [key]: value }) as T;

describe('an association element carries only the keys its kind defines', () => {
  const data: DataAssociation[] = [
    { kind: 'tag', label: 'starred' },
    { kind: 'attachment', label: 'avatar', fileId: 'abc' },
    { kind: 'relationship', label: 'reply-to', target: { kind: 'record', recordId: 'r1' } },
  ];

  for (const a of data) {
    test(`a ${a.kind} with an unknown key is refused on create, mutate and associate`, async () => {
      const bad = extra(a, 'scope');
      const message = 'Unknown key in associations[0]: scope';
      await expect(stack.create(NOTE, { text: 'y' }, { associations: [bad] })).rejects.toThrow(
        new StackBadRequestError(message),
      );
      await expect(stack.mutate(recordId, { associations: [bad] })).rejects.toThrow(
        new StackBadRequestError(message),
      );
      await expect(stack.associate(recordId, bad)).rejects.toThrow(
        new StackBadRequestError('Unknown key in association: scope'),
      );
    });
  }

  test('an attachment keeps attachmentRecordId, the one optional key it defines', async () => {
    const upload = await stack.putAttachment(new Uint8Array([1]), { mimeType: 'text/plain' });
    const { fileId } = upload.content as { fileId: string };
    const a = { kind: 'attachment', label: 'avatar', fileId, attachmentRecordId: upload.id };
    await expect(stack.associate(recordId, a as DataAssociation)).resolves.toBeDefined();
  });

  test('a key its target arm does not define is refused, even one another arm defines', async () => {
    const a = {
      kind: 'relationship',
      label: 'author',
      target: { kind: 'entity', entityId: 'did:key:a', ns: 'atproto' },
    } as DataAssociation;
    await expect(stack.associate(recordId, a)).rejects.toThrow(
      new StackBadRequestError('Unknown key in association.target: ns'),
    );
  });

  test('a relationship filter target is held to the same keys', async () => {
    await expect(
      stack.query({
        filter: {
          relatedTo: { target: { kind: 'entity', entityId: 'did:key:a', recordId: 'r1' } as never },
        },
      }),
    ).rejects.toThrow(StackBadRequestError);
  });
});

describe('a permission element carries only the keys its kind and grantee define', () => {
  const read = (grantee: object): AuthorityAssociation =>
    ({ kind: 'permission', label: 'read', grantee }) as AuthorityAssociation;

  test('an unknown key on the grantee is refused', async () => {
    const p = read({ kind: 'entity', entityId: 'did:key:a', scope: 'all' });
    await expect(stack.grantAccess(recordId, p)).rejects.toThrow(
      new StackBadRequestError('Unknown key in permission.grantee: scope'),
    );
    await expect(stack.mutate(recordId, { permissions: [p] })).rejects.toThrow(
      new StackBadRequestError('Unknown key in permissions[0].grantee: scope'),
    );
  });

  test('a key from the other grantee arm is refused rather than ignored', async () => {
    const p = read({ kind: 'entity', entityId: 'did:key:a', role: 'admin' });
    await expect(stack.grantAccess(recordId, p)).rejects.toThrow(StackBadRequestError);
  });

  test('an unknown key on the element itself is refused', async () => {
    const anyone = extra({ kind: 'anyone', label: 'read' } as AuthorityAssociation, 'until');
    await expect(stack.grantAccess(recordId, anyone)).rejects.toThrow(
      new StackBadRequestError('Unknown key in permission: until'),
    );
  });
});

describe('a grant target carries only the keys its tier defines', () => {
  test('grantType() and revokeType() refuse an unknown key', async () => {
    const grantee = { kind: 'entity', entityId: 'did:key:a', scope: 'all' } as never;
    const message = 'Unknown key in grant target: scope';
    await expect(stack.grantType(NOTE, { actions: ['read-any'], grantee })).rejects.toThrow(
      new StackBadRequestError(message),
    );
    await expect(stack.revokeType(NOTE, { actions: ['read-any'], grantee })).rejects.toThrow(
      new StackBadRequestError(message),
    );
  });

  test('listTypeGrants() refuses one too, so a misspelled query narrows nothing', async () => {
    await expect(
      stack.listTypeGrants({ kind: 'authenticated', entityId: 'did:key:a' } as never),
    ).rejects.toThrow(StackBadRequestError);
  });

  test('a _grant written directly is held to the same keys, as content', async () => {
    await expect(
      stack.create('_grant@1', {
        typeId: NOTE,
        actions: ['read-any'],
        grantee: { kind: 'authenticated', entityId: 'did:key:a' },
      }),
    ).rejects.toThrow(StackValidationError);
  });
});
