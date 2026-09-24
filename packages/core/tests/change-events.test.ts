import { describe, test, expect, beforeEach } from 'vitest';
import { Stack } from '../src/stack.js';
import { MemoryAdapter } from '../src/testing.js';
import type { RecordChange, StackRecord } from '../src/types.js';

const NOTE = 'com.example.test/note@1';
const NOTE_V2 = 'com.example.test/note@2';
const OTHER = 'com.example.test/memo@1';
const OWNER = 'owner-123';
const AUTHOR = 'did:key:zAuthor';
const EDITOR = 'did:key:zEditor';
const APP = 'did:key:zApp';

let adapter: MemoryAdapter;
let stack: Stack;

/** Collects everything a subscription receives, in delivery order. */
const collector = () => {
  const seen: RecordChange[] = [];
  return { seen, handler: (change: RecordChange) => void seen.push(change) };
};

beforeEach(async () => {
  adapter = new MemoryAdapter({ ownerEntityId: OWNER, timezone: 'UTC' });
  stack = await Stack.create(adapter);
  await stack.defineType(NOTE, 'Note', { text: { kind: 'text', required: true } });
  await stack.defineType(OTHER, 'Memo', { text: { kind: 'text', required: true } });
});

// -------------------------------------------------------
// One event per version bump
// -------------------------------------------------------

describe('every mutation that bumps a version emits exactly one event', () => {
  test('create emits `created` at version 1', async () => {
    const { seen, handler } = collector();
    await stack.subscribe(handler, { filter: { typeId: NOTE } });

    const note = await stack.create(NOTE, { text: 'hello' });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      kind: 'created',
      ops: ['create'],
      recordId: note.id,
      typeId: NOTE,
      version: 1,
    });
  });

  test('each verb reports its own op under the kind it maps to', async () => {
    const note = await stack.create(NOTE, { text: 'hello' });
    const { seen, handler } = collector();
    await stack.subscribe(handler, { filter: { typeId: NOTE } });

    await stack.patchContent(note.id, { text: 'edited' });
    await stack.associate(note.id, { kind: 'tag', label: 'starred' });
    await stack.dissociate(note.id, { kind: 'tag', label: 'starred' });
    await stack.mutate(note.id, { permissions: [{ kind: 'anyone', label: 'read' }] });
    await stack.delete(note.id);
    await stack.undelete(note.id);
    await stack.restoreVersion(note.id, 1);

    expect(seen.map((c) => [c.ops, c.kind])).toEqual([
      [['patch'], 'changed'],
      [['associate'], 'changed'],
      [['dissociate'], 'changed'],
      [['permissions'], 'changed'],
      [['delete'], 'deleted'],
      [['undelete'], 'changed'],
      [['restore'], 'changed'],
    ]);
  });

  test('a migration commit reports `migrate`', async () => {
    await stack.defineType(NOTE_V2, 'Note', {
      text: { kind: 'text', required: true },
      title: { kind: 'string' },
    });
    const note = await stack.create(NOTE, { text: 'hello' });
    const { seen, handler } = collector();
    await stack.subscribe(handler, { filter: { typeId: NOTE } });

    await stack.commitMigration(note.id, NOTE_V2, { text: 'hello', title: 'T' });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      ops: ['migrate'],
      kind: 'changed',
      typeId: NOTE_V2,
      version: 2,
    });
  });

  test('a hard delete emits `purged` and nothing further', async () => {
    const note = await stack.create(NOTE, { text: 'hello' });
    await stack.patchContent(note.id, { text: 'edited' });
    const { seen, handler } = collector();
    await stack.subscribe(handler, { filter: { typeId: NOTE } });

    await stack.delete(note.id, { hard: true });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      kind: 'purged',
      ops: ['hard-delete'],
      recordId: note.id,
      typeId: NOTE,
      version: 2,
    });
  });

  test('the version reported is the one the mutation produced — unchanged for the ops that never bump', async () => {
    const note = await stack.create(NOTE, { text: 'v1' });
    const { seen, handler } = collector();
    await stack.subscribe(handler, { filter: { typeId: NOTE } });

    await stack.patchContent(note.id, { text: 'v2' });
    await stack.associate(note.id, { kind: 'tag', label: 'starred' });
    await stack.mutate(note.id, { permissions: [{ kind: 'anyone', label: 'read' }] });
    await stack.patchContent(note.id, { text: 'v3' });

    expect(seen.map((c) => c.version)).toEqual([2, 2, 2, 3]);
    // Read back rather than inferred: the last event agrees with storage.
    const stored = await stack.get(note.id);
    expect(seen.at(-1)!.version).toBe(stored!.version);
    expect(seen.at(-1)!.updatedAt).toEqual(stored!.updatedAt);
  });
});

describe('a mutation that changes nothing emits nothing', () => {
  test.each([
    [
      're-adding an association already present',
      async (id: string) => stack.associate(id, { kind: 'tag', label: 'starred' }),
      async (id: string) => stack.associate(id, { kind: 'tag', label: 'starred' }),
    ],
    [
      'removing an association that is not there',
      async () => {},
      async (id: string) => stack.dissociate(id, { kind: 'tag', label: 'absent' }),
    ],
    [
      'setting a deep-equal permission set',
      async (id: string) => stack.mutate(id, { permissions: [{ kind: 'anyone', label: 'read' }] }),
      async (id: string) => stack.mutate(id, { permissions: [{ kind: 'anyone', label: 'read' }] }),
    ],
    [
      'deleting an already-deleted record',
      async (id: string) => stack.delete(id),
      async (id: string) => stack.delete(id),
    ],
    [
      'undeleting a record that is not deleted',
      async () => {},
      async (id: string) => void (await stack.undelete(id)),
    ],
  ])('%s', async (_name, setup, noop) => {
    const note = await stack.create(NOTE, { text: 'hello' });
    await setup(note.id);
    const { seen, handler } = collector();
    await stack.subscribe(handler, { filter: { typeId: NOTE } });

    await noop(note.id);

    expect(seen).toEqual([]);
  });

  test('a hard delete of a record that is not there emits nothing', async () => {
    const { seen, handler } = collector();
    await stack.subscribe(handler);

    await stack.delete('1hk153x00099', { hard: true });

    expect(seen).toEqual([]);
  });

  test('a rejected write emits nothing', async () => {
    const note = await stack.create(NOTE, { text: 'hello' });
    const { seen, handler } = collector();
    await stack.subscribe(handler, { filter: { typeId: NOTE } });

    await expect(stack.patchContent(note.id, { text: null })).rejects.toThrow();
    await expect(stack.patchContent(note.id, { text: 'x' }, { ifVersion: 99 })).rejects.toThrow();

    expect(seen).toEqual([]);
  });
});

describe('every record emits, including the ones a query hides', () => {
  test('_config reports a change despite never being returned by query()', async () => {
    // Seeded through the adapter: the reserved id is unreachable from
    // create(), and MemoryAdapter carries identity as fields rather than
    // as the record the SQL adapters store.
    await adapter.createRecord({
      id: '_config',
      typeId: '_config@1',
      createdAt: new Date(),
      updatedAt: new Date(),
      content: { entityId: OWNER, timezone: 'UTC' },
      version: 1,
    });
    const { seen, handler } = collector();
    await stack.subscribe(handler);

    await stack.patchContent('_config', { timezone: 'Europe/London' });

    expect(seen.map((c) => [c.recordId, c.ops])).toEqual([['_config', ['patch']]]);
    // Addressable only by ID, so a query still cannot see it.
    const queried = await stack.query({});
    expect(queried.records.map((r) => r.id)).not.toContain('_config');
  });

  test('a grant is an ordinary record write, which is what expires cached authority', async () => {
    const { seen, handler } = collector();
    await stack.subscribe(handler, { filter: { typeId: '_grant@1' } });

    await stack.grant({ kind: 'entity', entityId: AUTHOR }, [
      { actions: ['read-any'], typeId: NOTE },
    ]);

    expect(seen.map((c) => [c.kind, c.ops])).toEqual([['created', ['create']]]);
  });

  test('migrateAll fans out — one event per migrated record, no batch frame', async () => {
    await stack.defineType(NOTE_V2, 'Note', { text: { kind: 'text', required: true } });
    stack.registerMigration({ from: NOTE, to: NOTE_V2, migrate: (c) => c });
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await stack.create(NOTE, { text: `n${i}` })).id);
    const { seen, handler } = collector();
    await stack.subscribe(handler, { filter: { typeId: NOTE } });

    await stack.migrateAll('com.example.test/note');

    expect(seen.map((c) => c.ops)).toEqual([['migrate'], ['migrate'], ['migrate']]);
    expect(seen.map((c) => c.recordId).sort()).toEqual([...ids].sort());
  });
});

// -------------------------------------------------------
// Unlisted records — the one exception to "every record emits", because
// unfiltered query() excludes them too. See docs/spec/events.md
// § The unlisted transition.
// -------------------------------------------------------

describe('an unlisted record is invisible to a default subscriber, even unscoped', () => {
  test('created unlisted produces no event by default', async () => {
    const { seen, handler } = collector();
    await stack.subscribe(handler, { filter: { typeId: NOTE } });

    await stack.create(NOTE, { text: 'draft' }, { unlisted: true });

    expect(seen).toEqual([]);
  });

  test('includeUnlisted: true — even on an unscoped Stack — opts back in', async () => {
    const { seen, handler } = collector();
    await stack.subscribe(handler, { filter: { typeId: NOTE }, includeUnlisted: true });

    await stack.create(NOTE, { text: 'draft' }, { unlisted: true });

    expect(seen.map((c) => c.ops)).toEqual([['create']]);
  });

  test('the unlist transition emits kind "deleted" despite the post-change state', async () => {
    const note = await stack.create(NOTE, { text: 'was listed' });
    const { seen, handler } = collector();
    await stack.subscribe(handler, { filter: { typeId: NOTE } });

    await stack.mutate(note.id, { unlisted: true });

    expect(seen.map((c) => [c.kind, c.ops])).toEqual([['deleted', ['unlist']]]);
  });

  test('the list transition emits kind "changed", an upsert like undelete', async () => {
    const note = await stack.create(NOTE, { text: 'draft' }, { unlisted: true });
    const { seen, handler } = collector();
    await stack.subscribe(handler, { filter: { typeId: NOTE } });

    await stack.mutate(note.id, { unlisted: false });

    expect(seen.map((c) => [c.kind, c.ops])).toEqual([['changed', ['list']]]);
  });

  test('a hard delete of a still-unlisted record is not announced either', async () => {
    const note = await stack.create(NOTE, { text: 'draft' }, { unlisted: true });
    const { seen, handler } = collector();
    await stack.subscribe(handler, { filter: { typeId: NOTE } });

    await stack.delete(note.id, { hard: true });

    expect(seen).toEqual([]);
  });
});

// -------------------------------------------------------
// Attribution
// -------------------------------------------------------

describe('actor names who performed the change', () => {
  test('an unscoped write names nobody, and absence is not the author', async () => {
    const { seen, handler } = collector();
    await stack.subscribe(handler, { filter: { typeId: NOTE } });

    const { id } = await stack.create(NOTE, { text: 'hello' });
    await stack.patchContent(id, { text: 'edited' });

    expect(seen.map((c) => c.ops)).toEqual([['create'], ['patch']]);
    expect(seen.every((c) => c.actor === undefined)).toBe(true);
  });

  test('the actor moves with each write while the author stays put', async () => {
    await stack.grant({ kind: 'authenticated' }, [
      { actions: ['create', 'read-any', 'update-any'], typeId: NOTE },
    ]);
    const note = await stack.asEntity(AUTHOR).create(NOTE, { text: 'hello' });
    const { seen, handler } = collector();
    await stack.subscribe(handler, { filter: { typeId: NOTE }, includeRecords: true });

    await stack.asEntity(EDITOR).patchContent(note.id, { text: 'edited' });

    expect(seen[0]!.actor).toEqual({ subjectId: EDITOR });
    // The author rides the record, never the envelope.
    expect(seen[0]!.record!.createdBy?.subjectId).toBe(AUTHOR);
  });

  // associate()/dissociate() never bump, so they never restamp
  // record.updatedBy — the actor for their event has to travel as an
  // explicit opt instead of being read off the record. See
  // docs/spec/versioning.md § Version history.
  test('associate()/dissociate() name the acting identity in the event even though they never restamp the record', async () => {
    await stack.grant({ kind: 'authenticated' }, [
      { actions: ['create', 'read-any', 'update-any'], typeId: NOTE },
    ]);
    const note = await stack.asEntity(AUTHOR).create(NOTE, { text: 'hello' });
    const { seen, handler } = collector();
    await stack.subscribe(handler, { filter: { typeId: NOTE }, includeRecords: true });

    await stack.asEntity(EDITOR).associate(note.id, { kind: 'tag', label: 'x' });
    await stack.asEntity(EDITOR).dissociate(note.id, { kind: 'tag', label: 'x' });

    expect(seen[0]!.actor).toEqual({ subjectId: EDITOR });
    expect(seen[1]!.actor).toEqual({ subjectId: EDITOR });
    // The record itself was never restamped — no version-bumping write has
    // touched updatedBy since creation, so it still reads the author.
    expect(seen[1]!.record!.updatedBy?.subjectId).toBe(AUTHOR);
  });

  // An actorless associate()/dissociate() must not fall back to
  // record.updatedBy: that field reports whoever's last *bumping* write
  // this is, which can be a stranger to the association change. Absence
  // means unknown, never "the last editor".
  test('an actorless associate()/dissociate() names nobody, even after an unrelated bumping edit', async () => {
    await stack.grant({ kind: 'authenticated' }, [
      { actions: ['create', 'read-any', 'update-any'], typeId: NOTE },
    ]);
    const note = await stack.asEntity(AUTHOR).create(NOTE, { text: 'hello' });
    await stack.asEntity(EDITOR).patchContent(note.id, { text: 'edited' });

    const { seen, handler } = collector();
    await stack.subscribe(handler, { filter: { typeId: NOTE }, includeRecords: true });

    await stack.associate(note.id, { kind: 'tag', label: 'x' });
    await stack.dissociate(note.id, { kind: 'tag', label: 'x' });

    expect(seen[0]!.actor).toBeUndefined();
    expect(seen[1]!.actor).toBeUndefined();
  });

  test('a delegated write names the principal beside the subject', async () => {
    await stack.grant({ kind: 'authenticated' }, [
      { actions: ['create', 'read-any', 'update-any'], typeId: NOTE },
    ]);
    await stack.grant({ kind: 'entity', entityId: APP }, [
      { actions: ['create', 'read-any', 'update-any'], typeId: NOTE },
    ]);
    const note = await stack.asEntity(AUTHOR).create(NOTE, { text: 'hello' });
    const { seen, handler } = collector();
    await stack.subscribe(handler, { filter: { typeId: NOTE } });

    await stack
      .asActor({ principalId: APP, subjectId: EDITOR })
      .patchContent(note.id, { text: 'edited' });

    expect(seen[0]!.actor).toEqual({ subjectId: EDITOR, principalId: APP });
  });

  test('a purge names the requester, which a destroyed record cannot', async () => {
    const note = await stack.create(NOTE, { text: 'hello' });
    const { seen, handler } = collector();
    await stack.subscribe(handler, { filter: { typeId: NOTE } });

    await stack.asEntity(OWNER).delete(note.id, { hard: true });

    expect(seen[0]).toMatchObject({ kind: 'purged', actor: { subjectId: OWNER } });
  });

  test('appId rides a create and never a later version', async () => {
    await stack.grant({ kind: 'authenticated' }, [
      { actions: ['create', 'read-any', 'update-any'], typeId: NOTE },
    ]);
    const { seen, handler } = collector();
    await stack.subscribe(handler, { filter: { typeId: NOTE } });

    const note = await stack.create(
      NOTE,
      { text: 'hello' },
      { createdBy: { subjectId: AUTHOR }, appId: 'com.example.app' },
    );
    await stack.asEntity(EDITOR).patchContent(note.id, { text: 'edited' });

    expect(seen[0]!.actor).toEqual({ subjectId: AUTHOR, appId: 'com.example.app' });
    // The creating app describes the record, not this change.
    expect(seen[1]!.actor).toEqual({ subjectId: EDITOR });
  });
});

// -------------------------------------------------------
// associationsAdded / associationsRemoved
// -------------------------------------------------------

// Associations are never snapshotted (see docs/spec/versioning.md §
// Version history), so these two fields are the only record, anywhere, of
// what an associate()/dissociate() call actually moved. Both report only
// what is true now: `associationsAdded` the association as it now stands,
// `associationsRemoved` the identity of what's now gone — never a value
// that used to be there. See docs/spec/events.md § The event shape.
describe('associationsAdded/associationsRemoved report the current change', () => {
  const twoUploads = async () => {
    const data = new Uint8Array([1, 2, 3]);
    const first = await stack.putAttachment(data, 'image/png', 'original.png');
    const second = await stack.putAttachment(data, 'image/png', 'copy.png');
    return { first, second, fileId: first.content.fileId };
  };

  test('a fresh associate() reports the new association added, nothing removed', async () => {
    const note = await stack.create(NOTE, { text: 'hello' });
    const { seen, handler } = collector();
    await stack.subscribe(handler, { filter: { typeId: NOTE } });

    await stack.associate(note.id, { kind: 'tag', label: 'starred' });

    expect(seen[0]!.associationsAdded).toEqual([{ kind: 'tag', label: 'starred' }]);
    expect(seen[0]!.associationsRemoved).toBeUndefined();
  });

  test('dissociate() reports the removed association by identity, nothing added', async () => {
    const note = await stack.create(NOTE, { text: 'hello' });
    await stack.associate(note.id, { kind: 'tag', label: 'starred' });
    const { seen, handler } = collector();
    await stack.subscribe(handler, { filter: { typeId: NOTE } });

    await stack.dissociate(note.id, { kind: 'tag', label: 'starred' });

    expect(seen[0]!.associationsRemoved).toEqual([{ kind: 'tag', label: 'starred' }]);
    expect(seen[0]!.associationsAdded).toBeUndefined();
  });

  // The whole point of this pair: a re-point is lossy (nothing snapshots
  // associations any more), so the old attachmentRecordId must not surface
  // anywhere in the event — not as "removed", not tucked into "added".
  test('re-pointing an attachment reports only the new pointer; the old one appears nowhere', async () => {
    const { first, second, fileId } = await twoUploads();
    const note = await stack.create(NOTE, { text: 'hello' });
    await stack.associate(note.id, {
      kind: 'attachment',
      label: 'embed',
      fileId,
      attachmentRecordId: first.id,
    });
    const { seen, handler } = collector();
    await stack.subscribe(handler, { filter: { typeId: NOTE } });

    await stack.associate(note.id, {
      kind: 'attachment',
      label: 'embed',
      fileId,
      attachmentRecordId: second.id,
    });

    expect(seen[0]!.associationsAdded).toEqual([
      { kind: 'attachment', label: 'embed', fileId, attachmentRecordId: second.id },
    ]);
    expect(seen[0]!.associationsRemoved).toBeUndefined();
    expect(JSON.stringify(seen[0])).not.toContain(first.id);
  });

  test('clearing a stored pointer reports the identity-only association as added', async () => {
    const { first, fileId } = await twoUploads();
    const note = await stack.create(NOTE, { text: 'hello' });
    await stack.associate(note.id, {
      kind: 'attachment',
      label: 'embed',
      fileId,
      attachmentRecordId: first.id,
    });
    const { seen, handler } = collector();
    await stack.subscribe(handler, { filter: { typeId: NOTE } });

    await stack.associate(note.id, { kind: 'attachment', label: 'embed', fileId });

    expect(seen[0]!.associationsAdded).toEqual([{ kind: 'attachment', label: 'embed', fileId }]);
  });

  test('dissociating a pointed attachment never repeats attachmentRecordId', async () => {
    const { first, fileId } = await twoUploads();
    const note = await stack.create(NOTE, { text: 'hello' });
    await stack.associate(note.id, {
      kind: 'attachment',
      label: 'embed',
      fileId,
      attachmentRecordId: first.id,
    });
    const { seen, handler } = collector();
    await stack.subscribe(handler, { filter: { typeId: NOTE } });

    await stack.dissociate(note.id, { kind: 'attachment', label: 'embed', fileId });

    expect(seen[0]!.associationsRemoved).toEqual([{ kind: 'attachment', label: 'embed', fileId }]);
  });

  test('a mutate() change set swapping one tag for another reports both lists', async () => {
    const note = await stack.create(NOTE, { text: 'hello' });
    await stack.associate(note.id, { kind: 'tag', label: 'draft' });
    const { seen, handler } = collector();
    await stack.subscribe(handler, { filter: { typeId: NOTE } });

    await stack.mutate(note.id, { associations: [{ kind: 'tag', label: 'published' }] });

    expect(seen[0]!.ops).toEqual(['associate', 'dissociate']);
    expect(seen[0]!.associationsAdded).toEqual([{ kind: 'tag', label: 'published' }]);
    expect(seen[0]!.associationsRemoved).toEqual([{ kind: 'tag', label: 'draft' }]);
  });

  test('a mutate() change set combining associations with a bumping aspect reports both', async () => {
    const note = await stack.create(NOTE, { text: 'hello' });
    const { seen, handler } = collector();
    await stack.subscribe(handler, { filter: { typeId: NOTE } });

    await stack.mutate(note.id, {
      contentPatch: { text: 'edited' },
      associations: [{ kind: 'tag', label: 'starred' }],
    });

    expect(seen[0]!.ops).toEqual(['patch', 'associate']);
    expect(seen[0]!.associationsAdded).toEqual([{ kind: 'tag', label: 'starred' }]);
    expect(seen[0]!.version).toBe(2);
  });

  test('neither field is present on ops that carry no association change', async () => {
    const { seen, handler } = collector();
    await stack.subscribe(handler, { filter: { typeId: NOTE } });

    const note = await stack.create(NOTE, { text: 'hello' });
    await stack.patchContent(note.id, { text: 'edited' });

    for (const change of seen) {
      expect(change.associationsAdded).toBeUndefined();
      expect(change.associationsRemoved).toBeUndefined();
    }
  });
});

// -------------------------------------------------------
// Purged frames
// -------------------------------------------------------

describe('a purged frame carries nothing about the record', () => {
  test('no record body, whatever the subscriber asked for', async () => {
    const note = await stack.create(NOTE, { text: 'secret' }, { parentId: undefined });
    const { seen, handler } = collector();
    await stack.subscribe(handler, { filter: { typeId: NOTE }, includeRecords: true });

    await stack.delete(note.id, { hard: true });

    expect(seen[0]!.record).toBeUndefined();
  });

  test('no parentId, which a soft delete of the same record would carry', async () => {
    const parent = await stack.create(NOTE, { text: 'parent' });
    const soft = await stack.create(NOTE, { text: 'child' }, { parentId: parent.id });
    const hard = await stack.create(NOTE, { text: 'child' }, { parentId: parent.id });
    const { seen, handler } = collector();
    await stack.subscribe(handler, { filter: { typeId: NOTE } });

    await stack.delete(soft.id);
    await stack.delete(hard.id, { hard: true });

    expect(seen[0]).toMatchObject({ kind: 'deleted', parentId: parent.id });
    expect(seen[1]!.kind).toBe('purged');
    expect(seen[1]!.parentId).toBeUndefined();
  });

  test('no author, so no durable note of whose record was erased', async () => {
    await stack.grant({ kind: 'authenticated' }, [
      { actions: ['create', 'read-any'], typeId: NOTE },
    ]);
    const note = await stack.asEntity(AUTHOR).create(NOTE, { text: 'hello' });
    const { seen, handler } = collector();
    await stack.subscribe(handler, { filter: { typeId: NOTE }, includeRecords: true });

    await stack.asEntity(OWNER).delete(note.id, { hard: true });

    const frame = seen[0]!;
    expect(frame.record).toBeUndefined();
    expect(JSON.stringify(frame)).not.toContain(AUTHOR);
  });
});

// -------------------------------------------------------
// Filters
// -------------------------------------------------------

describe('filtering is exact', () => {
  test('typeId matches exactly, as it does in query()', async () => {
    await stack.defineType(NOTE_V2, 'Note', { text: { kind: 'text', required: true } });
    const { seen, handler } = collector();
    await stack.subscribe(handler, { filter: { typeId: NOTE } });

    await stack.create(NOTE, { text: 'this version' });
    await stack.create(NOTE_V2, { text: 'later version' });

    expect(seen.map((c) => c.typeId)).toEqual([NOTE]);
  });

  test('baseId matches the whole family, so a version bump orphans nothing', async () => {
    await stack.defineType(NOTE_V2, 'Note', { text: { kind: 'text', required: true } });
    const { seen, handler } = collector();
    await stack.subscribe(handler, { filter: { baseId: 'com.example.test/note' } });

    await stack.create(NOTE, { text: 'a' });
    await stack.create(NOTE_V2, { text: 'later version' });
    await stack.create(OTHER, { text: 'other family' });

    expect(seen.map((c) => c.typeId)).toEqual([NOTE, NOTE_V2]);
  });

  test('one filter selects the same records in query() and subscribe()', async () => {
    await stack.defineType(NOTE_V2, 'Note', { text: { kind: 'text', required: true } });
    const filter = { typeId: NOTE };
    const { seen, handler } = collector();
    await stack.subscribe(handler, { filter });

    await stack.create(NOTE, { text: 'a' });
    await stack.create(NOTE_V2, { text: 'b' });

    const { records } = await stack.query({ filter });
    expect(seen.map((c) => c.recordId)).toEqual(records.map((r) => r.id));
  });

  test('a migration reaches subscribers of the type it left and the type it entered', async () => {
    await stack.defineType(NOTE_V2, 'Note', { text: { kind: 'text', required: true } });
    const note = await stack.create(NOTE, { text: 'a' });
    const left = collector();
    const entered = collector();
    const unrelated = collector();
    await stack.subscribe(left.handler, { filter: { typeId: NOTE } });
    await stack.subscribe(entered.handler, { filter: { typeId: NOTE_V2 } });
    await stack.subscribe(unrelated.handler, { filter: { typeId: OTHER } });

    await stack.commitMigration(note.id, NOTE_V2, { text: 'a' });

    expect(left.seen.map((c) => c.typeId)).toEqual([NOTE_V2]);
    expect(entered.seen.map((c) => c.typeId)).toEqual([NOTE_V2]);
    expect(unrelated.seen).toHaveLength(0);
  });

  test('a migration across families reaches both families', async () => {
    const note = await stack.create(NOTE, { text: 'a' });
    const left = collector();
    await stack.subscribe(left.handler, { filter: { baseId: 'com.example.test/note' } });

    await stack.commitMigration(note.id, OTHER, { text: 'a' });

    expect(left.seen.map((c) => c.typeId)).toEqual([OTHER]);
  });

  test('a restore that changes the type reaches both types', async () => {
    await stack.defineType(NOTE_V2, 'Note', { text: { kind: 'text', required: true } });
    const note = await stack.create(NOTE, { text: 'a' });
    await stack.commitMigration(note.id, NOTE_V2, { text: 'a' });
    const left = collector();
    await stack.subscribe(left.handler, { filter: { typeId: NOTE_V2 } });

    await stack.restoreVersion(note.id, 1);

    expect(left.seen.map((c) => [c.ops, c.typeId])).toEqual([[['restore'], NOTE]]);
  });

  test('a write that keeps the type reaches only that type', async () => {
    await stack.defineType(NOTE_V2, 'Note', { text: { kind: 'text', required: true } });
    const note = await stack.create(NOTE, { text: 'a' });
    await stack.patchContent(note.id, { text: 'b' });
    const other = collector();
    await stack.subscribe(other.handler, { filter: { typeId: NOTE_V2 } });

    await stack.restoreVersion(note.id, 1);

    expect(other.seen).toHaveLength(0);
  });

  test('a filter accepts a list of types', async () => {
    const { seen, handler } = collector();
    await stack.subscribe(handler, { filter: { typeId: [NOTE, OTHER] } });

    await stack.create(NOTE, { text: 'a' });
    await stack.create(OTHER, { text: 'b' });

    expect(seen).toHaveLength(2);
  });

  test('kinds narrows to the branches a consumer handles', async () => {
    const { seen, handler } = collector();
    await stack.subscribe(handler, { filter: { typeId: NOTE, kinds: ['deleted', 'purged'] } });

    const note = await stack.create(NOTE, { text: 'a' });
    await stack.patchContent(note.id, { text: 'b' });
    await stack.delete(note.id);

    expect(seen.map((c) => c.kind)).toEqual(['deleted']);
  });

  test('parentId reads the record, so it still filters a purge', async () => {
    const parent = await stack.create(NOTE, { text: 'parent' });
    const child = await stack.create(NOTE, { text: 'child' }, { parentId: parent.id });
    const orphan = await stack.create(NOTE, { text: 'orphan' });
    const { seen, handler } = collector();
    await stack.subscribe(handler, { filter: { parentId: parent.id } });

    await stack.delete(child.id, { hard: true });
    await stack.delete(orphan.id, { hard: true });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.recordId).toBe(child.id);
  });

  test('parentId: null selects root records', async () => {
    const parent = await stack.create(NOTE, { text: 'parent' });
    const { seen, handler } = collector();
    await stack.subscribe(handler, { filter: { typeId: NOTE, parentId: null } });

    await stack.create(NOTE, { text: 'child' }, { parentId: parent.id });
    const root = await stack.create(NOTE, { text: 'root' });

    expect(seen.map((c) => c.recordId)).toEqual([root.id]);
  });

  test('a reparent reaches the container the record left', async () => {
    const from = await stack.create(NOTE, { text: 'from' });
    const to = await stack.create(NOTE, { text: 'to' });
    const note = await stack.create(NOTE, { text: 'note' }, { parentId: from.id });
    const { seen, handler } = collector();
    await stack.subscribe(handler, { filter: { parentId: from.id } });

    await stack.mutate(note.id, { parentId: to.id });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.ops).toEqual(['reparent']);
    // The destination, so a subscriber comparing it to its own filter
    // reads this as a departure.
    expect(seen[0]!.parentId).toBe(to.id);
  });

  test('a reparent reaches the container the record arrived in', async () => {
    const from = await stack.create(NOTE, { text: 'from' });
    const to = await stack.create(NOTE, { text: 'to' });
    const note = await stack.create(NOTE, { text: 'note' }, { parentId: from.id });
    const { seen, handler } = collector();
    await stack.subscribe(handler, { filter: { parentId: to.id } });

    await stack.mutate(note.id, { parentId: to.id });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.parentId).toBe(to.id);
  });

  test('a reparent between two other containers reaches neither', async () => {
    const watched = await stack.create(NOTE, { text: 'watched' });
    const from = await stack.create(NOTE, { text: 'from' });
    const to = await stack.create(NOTE, { text: 'to' });
    const note = await stack.create(NOTE, { text: 'note' }, { parentId: from.id });
    const { seen, handler } = collector();
    await stack.subscribe(handler, { filter: { parentId: watched.id } });

    await stack.mutate(note.id, { parentId: to.id });

    expect(seen).toHaveLength(0);
  });

  test('a move to the root reaches a parentId: null subscription', async () => {
    const from = await stack.create(NOTE, { text: 'from' });
    const note = await stack.create(NOTE, { text: 'note' }, { parentId: from.id });
    const { seen, handler } = collector();
    await stack.subscribe(handler, { filter: { typeId: NOTE, parentId: null } });

    await stack.mutate(note.id, { parentId: null });

    expect(seen.map((c) => c.recordId)).toEqual([note.id]);
  });

  test('a move off the root reaches a parentId: null subscription', async () => {
    const to = await stack.create(NOTE, { text: 'to' });
    const note = await stack.create(NOTE, { text: 'note' });
    const { seen, handler } = collector();
    await stack.subscribe(handler, { filter: { typeId: NOTE, parentId: null } });

    await stack.mutate(note.id, { parentId: to.id });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.recordId).toBe(note.id);
    expect(seen[0]!.parentId).toBe(to.id);
  });

  // A reparented record is still there and still readable — only its
  // container moved — so the frame is an upsert, not a "drop your copy".
  test('a reparent is kind changed, not deleted', async () => {
    const to = await stack.create(NOTE, { text: 'to' });
    const note = await stack.create(NOTE, { text: 'note' });
    const { seen, handler } = collector();
    await stack.subscribe(handler);

    await stack.mutate(note.id, { parentId: to.id });

    expect(seen.at(-1)).toMatchObject({ kind: 'changed', ops: ['reparent'] });
  });

  // `reparent` is the only op matched against two containers. A restore
  // settles content alone, so the container the snapshot was taken in is
  // not a side of anything — only the one the record is in now hears it.
  test('a restore reaches only the container the record is in, whatever the snapshot said', async () => {
    const from = await stack.create(NOTE, { text: 'from' });
    const to = await stack.create(NOTE, { text: 'to' });
    const note = await stack.create(NOTE, { text: 'note' }, { parentId: from.id });
    await stack.patchContent(note.id, { text: 'edited' });
    await stack.mutate(note.id, { parentId: to.id });
    const origin = collector();
    const destination = collector();
    await stack.subscribe(origin.handler, { filter: { parentId: from.id } });
    await stack.subscribe(destination.handler, { filter: { parentId: to.id } });

    await stack.restoreVersion(note.id, 1);

    expect(origin.seen).toHaveLength(0);
    expect(destination.seen).toHaveLength(1);
    expect(destination.seen[0]!.ops).toEqual(['restore']);
    expect(destination.seen[0]!.parentId).toBe(to.id);
  });

  test('a restore that leaves the record where it is reaches only its container', async () => {
    const from = await stack.create(NOTE, { text: 'from' });
    const to = await stack.create(NOTE, { text: 'to' });
    const note = await stack.create(NOTE, { text: 'note' }, { parentId: to.id });
    await stack.patchContent(note.id, { text: 'edited' });
    const { seen, handler } = collector();
    await stack.subscribe(handler, { filter: { parentId: from.id } });

    await stack.restoreVersion(note.id, 1);

    expect(seen).toHaveLength(0);
  });

  test('createdBy filters on the record author, not the actor', async () => {
    await stack.grant({ kind: 'authenticated' }, [
      { actions: ['create', 'read-any', 'update-any'], typeId: NOTE },
    ]);
    const authored = await stack.asEntity(AUTHOR).create(NOTE, { text: 'a' });
    await stack.asEntity(EDITOR).create(NOTE, { text: 'b' });
    const { seen, handler } = collector();
    await stack.subscribe(handler, { filter: { createdBy: { subjectId: AUTHOR } } });

    // Edited by someone else: the author is what the filter reads.
    await stack.asEntity(EDITOR).patchContent(authored.id, { text: 'edited' });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.actor).toEqual({ subjectId: EDITOR });
  });

  test('createdBy matches a list of authors and the principal behind them', async () => {
    await stack.grant({ kind: 'authenticated' }, [
      { actions: ['create', 'read-any'], typeId: NOTE },
    ]);
    await stack.grant({ kind: 'entity', entityId: APP }, [
      { actions: ['create', 'read-any'], typeId: NOTE },
    ]);
    const { seen, handler } = collector();
    await stack.subscribe(handler, {
      filter: { createdBy: { subjectId: [AUTHOR, EDITOR], principalId: APP } },
    });

    await stack.asActor({ subjectId: AUTHOR, principalId: APP }).create(NOTE, { text: 'a' });
    await stack.asActor({ subjectId: EDITOR, principalId: APP }).create(NOTE, { text: 'b' });
    await stack.asEntity(AUTHOR).create(NOTE, { text: 'acting as itself' });

    expect(seen).toHaveLength(2);
  });
});

// -------------------------------------------------------
// The record payload
// -------------------------------------------------------

describe('the record body is an optional payload', () => {
  test('absent unless asked for', async () => {
    const { seen, handler } = collector();
    await stack.subscribe(handler, { filter: { typeId: NOTE } });

    await stack.create(NOTE, { text: 'hello' });

    expect(seen[0]!.record).toBeUndefined();
  });

  test('present, and current as of the change, when asked for', async () => {
    const { seen, handler } = collector();
    await stack.subscribe(handler, { filter: { typeId: NOTE }, includeRecords: true });

    const note = await stack.create(NOTE, { text: 'hello' });
    await stack.patchContent(note.id, { text: 'edited' });

    expect(seen[1]!.record).toMatchObject({ id: note.id, version: 2 });
    expect((seen[1]!.record as StackRecord).content).toEqual({ text: 'edited' });
  });
});

// -------------------------------------------------------
// Subscription lifecycle
// -------------------------------------------------------

describe('subscriptions', () => {
  test('unsubscribe stops delivery', async () => {
    const { seen, handler } = collector();
    const unsubscribe = await stack.subscribe(handler, { filter: { typeId: NOTE } });

    await stack.create(NOTE, { text: 'before' });
    unsubscribe();
    await stack.create(NOTE, { text: 'after' });

    expect(seen).toHaveLength(1);
  });

  test('unsubscribing twice is not an error', async () => {
    const unsubscribe = await stack.subscribe(() => {});
    unsubscribe();
    expect(() => unsubscribe()).not.toThrow();
  });

  test('a closed stack has no stream to join', async () => {
    const { handler } = collector();
    await stack.subscribe(handler);
    await stack.close();

    await expect(stack.subscribe(handler)).rejects.toThrow();
    await expect(stack.create(NOTE, { text: 'after close' })).rejects.toThrow();
  });

  test('each subscriber gets its own filtered view of the same write', async () => {
    const notes = collector();
    const memos = collector();
    await stack.subscribe(notes.handler, { filter: { typeId: NOTE } });
    await stack.subscribe(memos.handler, { filter: { typeId: OTHER } });

    await stack.create(NOTE, { text: 'a' });
    await stack.create(OTHER, { text: 'b' });

    expect(notes.seen).toHaveLength(1);
    expect(memos.seen).toHaveLength(1);
  });

  test('subscribing during an emission does not deliver that emission', async () => {
    const late = collector();
    let subscribed = false;
    await stack.subscribe(
      () => {
        if (subscribed) return;
        subscribed = true;
        void stack.subscribe(late.handler, { filter: { typeId: NOTE } });
      },
      { filter: { typeId: NOTE } },
    );

    const first = await stack.create(NOTE, { text: 'first' });
    const second = await stack.create(NOTE, { text: 'second' });

    // The late subscriber joined during the first write's emission, so it
    // sees the second write only — never the one that created it.
    expect(late.seen.map((c) => c.recordId)).toEqual([second.id]);
    expect(late.seen.map((c) => c.recordId)).not.toContain(first.id);
  });

  test('a handler that unsubscribes another one stops its delivery', async () => {
    const second = collector();
    const unsubscribeSecond = { fn: undefined as (() => void) | undefined };
    await stack.subscribe(() => unsubscribeSecond.fn?.(), { filter: { typeId: NOTE } });
    unsubscribeSecond.fn = await stack.subscribe(second.handler, { filter: { typeId: NOTE } });

    await stack.create(NOTE, { text: 'hello' });

    expect(second.seen).toEqual([]);
  });
});

// -------------------------------------------------------
// Handlers never block, delay, or fail a write
// -------------------------------------------------------

describe('handlers cannot fail the write they are told about', () => {
  test('a throwing handler routes to onError and the write still resolves', async () => {
    const errors: unknown[] = [];
    await stack.subscribe(
      () => {
        throw new Error('handler exploded');
      },
      { filter: { typeId: NOTE }, onError: (err) => void errors.push(err) },
    );

    const note = await stack.create(NOTE, { text: 'hello' });

    expect(note.version).toBe(1);
    expect((errors[0] as Error).message).toBe('handler exploded');
    expect(await stack.get(note.id)).not.toBeNull();
  });

  test('one throwing handler does not rob the next of its event', async () => {
    const errors: unknown[] = [];
    const later = collector();
    await stack.subscribe(
      () => {
        throw new Error('first');
      },
      { filter: { typeId: NOTE }, onError: (err) => void errors.push(err) },
    );
    await stack.subscribe(later.handler, { filter: { typeId: NOTE } });

    await stack.create(NOTE, { text: 'hello' });

    expect(errors).toHaveLength(1);
    expect(later.seen).toHaveLength(1);
  });

  test('an async handler is not awaited', async () => {
    let resolved = false;
    await stack.subscribe(
      async () => {
        await new Promise((r) => setTimeout(r, 10));
        resolved = true;
      },
      { filter: { typeId: NOTE } },
    );

    await stack.create(NOTE, { text: 'hello' });

    // The write settled without waiting for the handler's deferred half.
    expect(resolved).toBe(false);
  });

  test('a handler that writes does not deadlock or lose its own event', async () => {
    const { seen, handler } = collector();
    let wrote = false;
    await stack.subscribe(
      (change) => {
        handler(change);
        if (!wrote) {
          wrote = true;
          void stack.create(OTHER, { text: 'from a handler' });
        }
      },
      { filter: { typeId: [NOTE, OTHER] } },
    );

    await stack.create(NOTE, { text: 'hello' });
    await new Promise((r) => setTimeout(r, 0));

    expect(seen.map((c) => c.typeId)).toEqual([NOTE, OTHER]);
  });
});
