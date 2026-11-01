import { describe, test, expect, beforeEach } from 'vitest';
import { Stack } from '../src/stack/stack.js';
import { MemoryAdapter } from '../src/testing.js';
import {
  StackBadRequestError,
  StackConflictError,
  StackValidationError,
  StackPermissionError,
} from '../src/errors.js';
import type {
  AssociationEdit,
  AuthorityAssociation,
  DataAssociation,
  RecordJournalEntry,
} from '../src/types/index.js';

const NOTE = 'com.example.test/note@1';
const OWNER = 'did:key:zOwner';
const EDITOR = 'did:key:zEditor';

const read: AuthorityAssociation = {
  kind: 'permission',
  label: 'read',
  grantee: { kind: 'entity', entityId: EDITOR },
};
const write: AuthorityAssociation = { ...read, label: 'write' };
const cover = (n: string): DataAssociation => ({ kind: 'tag', label: `cover-${n}` });

let stack: Stack;
let id: string;

beforeEach(async () => {
  stack = await Stack.open(await MemoryAdapter.open({ ownerEntityId: OWNER }));
  await stack.defineType({ id: NOTE, name: 'Note', schema: { text: { kind: 'text' } } });
  id = (await stack.create(NOTE, { text: 'x' })).id;
});

const journal = (): Promise<RecordJournalEntry[]> => stack.getJournal(id);
const inverse = (e: RecordJournalEntry): AssociationEdit[] =>
  (e.associations ?? []).map((c) => {
    if (c.op === 'add') return { op: 'remove', association: c.association };
    if (c.op === 'remove') return { op: 'add', association: c.association };
    return { op: 'add', association: c.previous };
  });

describe.each([
  ['Stack', () => stack],
  ['ScopedStack', () => stack.asEntity(OWNER)],
])('list-taking verbs on %s', (_name, client) => {
  test('[read, write] in one call is one write and one journal entry; write alone is refused', async () => {
    const c = client();
    await expect(c.editAccess(id, [{ op: 'add', association: write }])).rejects.toThrow(
      StackValidationError,
    );
    const before = (await journal()).length;
    const granted = await c.editAccess(id, [
      { op: 'add', association: read },
      { op: 'add', association: write },
    ]);
    expect(granted.permissions).toHaveLength(2);
    expect((await journal()).length).toBe(before + 1);
  });

  test('editAccess() with [read, write] removes both', async () => {
    const c = client();
    await c.editAccess(id, [
      { op: 'add', association: read },
      { op: 'add', association: write },
    ]);
    expect(
      (
        await c.editAccess(id, [
          { op: 'remove', association: read },
          { op: 'remove', association: write },
        ])
      ).permissions ?? [],
    ).toEqual([]);
  });

  test('a cover swap is one write and one journal entry, and its inverse restores the original', async () => {
    const c = client();
    await c.editAssociations(id, [{ op: 'add', association: cover('old') }]);
    const before = (await journal()).length;
    const swapped = await c.editAssociations(id, [
      { op: 'remove', association: cover('old') },
      { op: 'add', association: cover('new') },
    ]);
    expect(swapped.associations?.map((a) => a.label)).toEqual(['cover-new']);
    const log = await journal();
    expect(log.length).toBe(before + 1);

    const restored = await c.editAssociations(id, inverse(log.at(-1)!));
    expect(restored.associations?.map((a) => a.label)).toEqual(['cover-old']);
  });

  test('repoint is refused as input, at the element', async () => {
    const c = client();
    const repoint = {
      op: 'repoint',
      association: cover('a'),
      previous: cover('a'),
    } as unknown as AssociationEdit;
    const err = await c.editAssociations(id, [repoint]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StackValidationError);
    expect((err as StackValidationError).errors[0]!.path).toBe('changes[0].op');
    expect((err as StackValidationError).errors[0]!.message).toContain('recorded by the journal');
  });

  test('editAccess() downgrades [read, write] to [read]; removing read while keeping write is refused', async () => {
    const c = client();
    await c.editAccess(id, [
      { op: 'add', association: read },
      { op: 'add', association: write },
    ]);
    const down = await c.editAccess(id, [{ op: 'remove', association: write }]);
    expect(down.permissions).toEqual([read]);

    await c.editAccess(id, [{ op: 'add', association: write }]);
    await expect(c.editAccess(id, [{ op: 'remove', association: read }])).rejects.toThrow(
      StackValidationError,
    );
  });

  test('an empty list is refused', async () => {
    const c = client();
    await expect(c.editAssociations(id, [])).rejects.toThrow(StackValidationError);
    await expect(c.editAccess(id, [])).rejects.toThrow(StackValidationError);
    await expect(c.editAssociations(id, [])).rejects.toThrow(StackValidationError);
    await expect(c.editAccess(id, [])).rejects.toThrow(StackValidationError);
  });

  test('a list naming one identity twice, or removing and adding it, is refused', async () => {
    const c = client();
    await expect(
      c.editAssociations(id, [
        { op: 'add', association: cover('a') },
        { op: 'add', association: cover('a') },
      ]),
    ).rejects.toThrow(StackValidationError);
    await expect(
      c.editAssociations(id, [
        { op: 'remove', association: cover('a') },
        { op: 'add', association: cover('a') },
      ]),
    ).rejects.toThrow(StackValidationError);
    await expect(
      c.editAccess(id, [
        { op: 'add', association: read },
        { op: 'add', association: read },
      ]),
    ).rejects.toThrow(StackValidationError);
  });

  test('a list never mixes authority and data', async () => {
    const c = client();
    await expect(
      c.editAssociations(id, [{ op: 'add', association: read as never }]),
    ).rejects.toThrow(StackBadRequestError);
    await expect(
      c.editAccess(id, [{ op: 'add', association: cover('a') as never }]),
    ).rejects.toThrow(StackBadRequestError);
  });

  test('a call where every element is a no-op returns the record without writing', async () => {
    const c = client();
    await c.editAssociations(id, [{ op: 'add', association: cover('a') }]);
    const before = (await journal()).length;
    await c.editAssociations(id, [{ op: 'add', association: cover('a') }]);
    await c.editAssociations(id, [{ op: 'remove', association: cover('absent') }]);
    await c.editAccess(id, [{ op: 'remove', association: read }]);
    expect((await journal()).length).toBe(before);
  });

  test('every verb refuses a soft-deleted record with a conflict', async () => {
    const c = client();
    await stack.delete(id);
    const edit: AssociationEdit[] = [{ op: 'add', association: cover('a') }];
    await expect(c.editAssociations(id, [{ op: 'add', association: cover('a') }])).rejects.toThrow(
      StackConflictError,
    );
    await expect(
      c.editAssociations(id, [{ op: 'remove', association: cover('a') }]),
    ).rejects.toThrow(StackConflictError);
    await expect(c.editAssociations(id, edit)).rejects.toThrow(StackConflictError);
    await expect(
      c.editAccess(id, [
        { op: 'add', association: read },
        { op: 'add', association: write },
      ]),
    ).rejects.toThrow(StackConflictError);
    await expect(c.editAccess(id, [{ op: 'remove', association: read }])).rejects.toThrow(
      StackConflictError,
    );
    await expect(c.editAccess(id, [{ op: 'add', association: read }])).rejects.toThrow(
      StackConflictError,
    );
  });
});

describe('ScopedStack gates', () => {
  test('a reader may neither amend associations nor access', async () => {
    await stack.editAccess(id, [{ op: 'add', association: read }]);
    const reader = stack.asEntity(EDITOR);
    await expect(
      reader.editAssociations(id, [{ op: 'add', association: cover('a') }]),
    ).rejects.toThrow(StackPermissionError);
    await expect(reader.editAccess(id, [{ op: 'add', association: write }])).rejects.toThrow(
      StackPermissionError,
    );
  });
});

describe('editAccess() that moves nothing', () => {
  // The write-implies-read check reads the set a write would produce, so a
  // call producing the stored set is not refused for a set it did not write.
  test('returns the record unchanged even where the stored set breaks write-implies-read', async () => {
    const adapter = await MemoryAdapter.open({ ownerEntityId: OWNER });
    const raw = await Stack.open(adapter);
    await raw.defineType({ id: NOTE, name: 'Note', schema: { text: { kind: 'text' } } });
    const stored = await adapter.createRecord({
      id: 'rec000000001',
      typeId: NOTE,
      createdAt: new Date(),
      updatedAt: new Date(),
      content: { text: 'x' },
      version: 1,
      permissions: [write],
    });

    const same = await raw.editAccess(stored.id, [{ op: 'add', association: write }]);
    expect(same.permissions).toEqual([write]);
    await expect(
      raw.editAccess(stored.id, [{ op: 'add', association: { kind: 'anyone', label: 'read' } }]),
    ).resolves.toBeDefined();
    await expect(
      raw.editAccess(stored.id, [{ op: 'remove', association: { kind: 'anyone', label: 'read' } }]),
    ).rejects.toThrow(StackValidationError);
  });
});
