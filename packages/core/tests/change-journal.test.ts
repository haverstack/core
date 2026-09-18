import { describe, test, expect, beforeEach } from 'vitest';
import { Stack } from '../src/stack.js';
import type { StackClient } from '../src/stack.js';
import { MemoryAdapter } from '../src/testing.js';
import { StackPermissionError, StackQueryError } from '../src/errors.js';
import type { RecordChange, RecordJournalEntry } from '../src/types.js';

const NOTE = 'com.example.test/note@1';
const NOTE_V2 = 'com.example.test/note@2';
const FOLDER = 'com.example.test/folder@1';
const OWNER = 'did:key:zOwner';
const EDITOR = 'did:key:zEditor';
const READER = 'did:key:zReader';
let adapter: MemoryAdapter;
let stack: Stack;

beforeEach(async () => {
  adapter = new MemoryAdapter({ ownerEntityId: OWNER, timezone: 'UTC' });
  stack = await Stack.create(adapter);
  await stack.defineType(NOTE, 'Note', { text: { kind: 'text', required: true } });
  await stack.defineType(FOLDER, 'Folder', { name: { kind: 'string', required: true } });
});

// -------------------------------------------------------
// What the journal records
// -------------------------------------------------------

describe('every emitting write appends exactly one entry', () => {
  test('one entry per call, in call order, densely numbered', async () => {
    const note = await stack.create(NOTE, { text: 'hello' });
    await stack.patchContent(note.id, { text: 'edited' });
    await stack.associate(note.id, { kind: 'tag', label: 'starred' });
    await stack.dissociate(note.id, { kind: 'tag', label: 'starred' });
    await stack.mutate(note.id, { permissions: [{ access: 'public' }] });
    await stack.delete(note.id);
    await stack.undelete(note.id);

    const log = await stack.getJournal(note.id);
    expect(log.map((e) => e.ops)).toEqual([
      ['create'],
      ['patch'],
      ['associate'],
      ['dissociate'],
      ['permissions'],
      ['delete'],
      ['undelete'],
    ]);
    expect(log.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  test('a no-op writes nothing, exactly as it emits nothing', async () => {
    const note = await stack.create(NOTE, { text: 'hello' });
    await stack.associate(note.id, { kind: 'tag', label: 'starred' });
    const before = await stack.getJournal(note.id);

    await stack.associate(note.id, { kind: 'tag', label: 'starred' });
    await stack.dissociate(note.id, { kind: 'tag', label: 'absent' });
    await stack.patchContent(note.id, { text: 'hello' });

    expect(await stack.getJournal(note.id)).toEqual(before);
  });

  test('a change set is one entry naming every aspect it moved', async () => {
    const folder = await stack.create(FOLDER, { name: 'inbox' });
    const note = await stack.create(NOTE, { text: 'hello' });

    await stack.mutate(note.id, {
      contentPatch: { text: 'edited' },
      parentId: folder.id,
      associations: [{ kind: 'tag', label: 'starred' }],
    });

    const log = await stack.getJournal(note.id);
    expect(log).toHaveLength(2);
    expect(log[1]!.ops.sort()).toEqual(['associate', 'patch', 'reparent']);
    expect(log[1]!.kind).toBe('changed');
    expect(log[1]!.parentId).toBe(folder.id);
    expect(log[1]!.previousParentId).toBeNull();
  });
});

// -------------------------------------------------------
// The association delta — the gap this tier exists to close
// -------------------------------------------------------

describe('association history survives without a subscriber', () => {
  const twoUploads = async () => {
    const data = new Uint8Array([1, 2, 3]);
    const first = await stack.putAttachment(data, 'image/png', 'original.png');
    const second = await stack.putAttachment(data, 'image/png', 'copy.png');
    return { first, second, fileId: first.content.fileId };
  };

  test('an association set is reconstructible from the log alone', async () => {
    const note = await stack.create(NOTE, { text: 'hello' });
    await stack.associate(note.id, { kind: 'tag', label: 'starred' });
    await stack.associate(note.id, { kind: 'tag', label: 'urgent' });
    await stack.dissociate(note.id, { kind: 'tag', label: 'starred' });
    await stack.associate(note.id, { kind: 'tag', label: 'later' });

    // Replay forward from an empty set; the result must be what the record
    // actually holds. Nothing was listening while any of this happened.
    const labels = new Set<string>();
    for (const entry of await stack.getJournal(note.id)) {
      for (const a of entry.associationsAdded ?? []) labels.add(a.label);
      for (const a of entry.associationsRemoved ?? []) labels.delete(a.label);
    }

    const current = await stack.get(note.id);
    expect([...labels].sort()).toEqual((current!.associations ?? []).map((a) => a.label).sort());
    expect([...labels].sort()).toEqual(['later', 'urgent']);
  });

  test('a re-pointed attachment annotation is retained as the value it replaced', async () => {
    const { first, second, fileId } = await twoUploads();
    const note = await stack.create(NOTE, { text: 'hello' });

    await stack.associate(note.id, {
      kind: 'attachment',
      label: 'cover',
      fileId,
      attachmentRecordId: first.id,
    });
    await stack.associate(note.id, {
      kind: 'attachment',
      label: 'cover',
      fileId,
      attachmentRecordId: second.id,
    });

    const log = await stack.getJournal(note.id);
    const repoint = log.at(-1)!;
    expect(repoint.ops).toEqual(['associate']);
    // The new value, as the feed reports it...
    expect(repoint.associationsAdded?.[0]).toMatchObject({ attachmentRecordId: second.id });
    // ...and the old one, which nothing else anywhere retains.
    expect(repoint.associationsReplaced?.[0]).toMatchObject({ attachmentRecordId: first.id });
  });

  test('a removal names identity only, never the annotation it carried', async () => {
    const { first, fileId } = await twoUploads();
    const note = await stack.create(NOTE, { text: 'hello' });
    await stack.associate(note.id, {
      kind: 'attachment',
      label: 'cover',
      fileId,
      attachmentRecordId: first.id,
    });
    await stack.dissociate(note.id, { kind: 'attachment', label: 'cover', fileId });

    const removed = (await stack.getJournal(note.id)).at(-1)!.associationsRemoved![0]!;
    expect(removed).toEqual({ kind: 'attachment', label: 'cover', fileId });
  });

  test('an association change is journaled without moving the record version', async () => {
    const note = await stack.create(NOTE, { text: 'hello' });
    await stack.associate(note.id, { kind: 'tag', label: 'starred' });

    const log = await stack.getJournal(note.id);
    expect(log).toHaveLength(2);
    expect(log[1]!.version).toBe(1);
    expect((await stack.get(note.id))!.version).toBe(1);
    // Nothing snapshotted: the version tier is untouched by this write.
    expect(await stack.getVersions(note.id)).toHaveLength(0);
  });
});

// -------------------------------------------------------
// Undo
// -------------------------------------------------------

describe('an association change is reversible from the log alone', () => {
  const twoUploads = async () => {
    const data = new Uint8Array([1, 2, 3]);
    const first = await stack.putAttachment(data, 'image/png', 'original.png');
    const second = await stack.putAttachment(data, 'image/png', 'copy.png');
    return { first, second, fileId: first.content.fileId };
  };

  /**
   * Apply the inverse of one entry. The point of the tier: an inverse
   * exists for every association op, but deriving *which* one takes the
   * prior state, and until this log there was nowhere to read it from
   * once the write had landed.
   */
  const invert = async (recordId: string, e: RecordJournalEntry) => {
    for (const added of e.associationsAdded ?? []) {
      const replaced = (e.associationsReplaced ?? []).find(
        (r) => r.kind === added.kind && r.label === added.label,
      );
      // A re-point inverts by pointing back, not by dropping the reference.
      if (replaced) await stack.associate(recordId, replaced);
      else await stack.dissociate(recordId, added);
    }
    for (const removed of e.associationsRemoved ?? []) {
      await stack.associate(recordId, removed);
    }
  };

  test('a swap is undone by replaying its entry backwards', async () => {
    const note = await stack.create(NOTE, { text: 'hello' });
    await stack.associate(note.id, { kind: 'tag', label: 'keep' });
    await stack.associate(note.id, { kind: 'tag', label: 'draft' });
    const before = (await stack.get(note.id))!.associations!.map((a) => a.label).sort();

    await stack.mutate(note.id, {
      associations: [
        { kind: 'tag', label: 'keep' },
        { kind: 'tag', label: 'published' },
      ],
    });

    const swap = (await stack.getJournal(note.id)).at(-1)!;
    expect(swap.ops.sort()).toEqual(['associate', 'dissociate']);
    await invert(note.id, swap);

    expect((await stack.get(note.id))!.associations!.map((a) => a.label).sort()).toEqual(before);
  });

  test('a re-pointed attachment is put back to the pointer it replaced', async () => {
    const { first, second, fileId } = await twoUploads();
    const note = await stack.create(NOTE, { text: 'hello' });
    await stack.associate(note.id, {
      kind: 'attachment',
      label: 'cover',
      fileId,
      attachmentRecordId: first.id,
    });
    await stack.associate(note.id, {
      kind: 'attachment',
      label: 'cover',
      fileId,
      attachmentRecordId: second.id,
    });

    await invert(note.id, (await stack.getJournal(note.id)).at(-1)!);

    const cover = (await stack.get(note.id))!.associations!.find((a) => a.label === 'cover')!;
    expect(cover).toMatchObject({ attachmentRecordId: first.id });
  });
});

// -------------------------------------------------------
// Erasure
// -------------------------------------------------------

describe('a hard delete leaves no journal behind', () => {
  test('the log goes with the record, as the version history does', async () => {
    const note = await stack.create(NOTE, { text: 'secret' });
    await stack.associate(note.id, { kind: 'tag', label: 'sensitive' });
    await stack.patchContent(note.id, { text: 'still secret' });
    expect(await stack.getJournal(note.id)).toHaveLength(3);

    await stack.delete(note.id, { hard: true });

    expect(await stack.getJournal(note.id)).toEqual([]);
    expect(await stack.getVersions(note.id)).toEqual([]);
  });

  test('a soft delete keeps it — the tombstone is recoverable', async () => {
    const note = await stack.create(NOTE, { text: 'hello' });
    await stack.associate(note.id, { kind: 'tag', label: 'starred' });
    await stack.delete(note.id);

    const log = await stack.getJournal(note.id);
    expect(log.map((e) => e.ops.join())).toEqual(['create', 'associate', 'delete']);
  });
});

// -------------------------------------------------------
// Attribution
// -------------------------------------------------------

describe('every entry names who made the change', () => {
  test('an association change attributes the actor that made it', async () => {
    await stack.defineType(NOTE_V2, 'Note', { text: { kind: 'text', required: true } });
    const note = await stack.create(NOTE, { text: 'hello' }, { entityId: OWNER });

    await stack.associate(
      note.id,
      { kind: 'tag', label: 'starred' },
      { updatedBy: EDITOR, updatedVia: OWNER },
    );

    const entry = (await stack.getJournal(note.id)).at(-1)!;
    expect(entry.actor).toEqual({ entityId: EDITOR, principalId: OWNER });
  });

  test('a create names its author and the app that wrote it', async () => {
    const note = await stack.create(NOTE, { text: 'hello' }, { entityId: OWNER, appId: 'app-1' });
    const entry = (await stack.getJournal(note.id))[0]!;
    expect(entry.actor).toMatchObject({ entityId: OWNER, appId: 'app-1' });
  });
});

// -------------------------------------------------------
// The entry set is the event set
// -------------------------------------------------------

describe('the journal and the feed report the same change', () => {
  test('every emitting write appends an entry naming the same ops, kind and actor', async () => {
    const seen: RecordChange[] = [];
    const unsubscribe = await stack.subscribe((change) => seen.push(change));

    const note = await stack.create(NOTE, { text: 'hello' }, { entityId: OWNER });
    const folder = await stack.create(FOLDER, { name: 'box' }, { entityId: OWNER });
    await stack.patchContent(note.id, { text: 'edited' }, { updatedBy: OWNER });
    await stack.mutate(
      note.id,
      { parentId: folder.id, permissions: [{ access: 'public' }] },
      { updatedBy: OWNER },
    );
    await stack.associate(note.id, { kind: 'tag', label: 'starred' }, { updatedBy: EDITOR });
    await stack.dissociate(note.id, { kind: 'tag', label: 'starred' }, { updatedBy: EDITOR });
    await stack.delete(note.id, { updatedBy: OWNER });
    await stack.undelete(note.id, { updatedBy: OWNER });
    unsubscribe();

    const log = await stack.getJournal(note.id);
    const forNote = seen.filter((c) => c.recordId === note.id);
    // create, patch, the change set, associate, dissociate, delete, undelete
    expect(log).toHaveLength(7);
    expect(forNote).toHaveLength(log.length);
    for (const [i, entry] of log.entries()) {
      const change = forNote[i]!;
      expect(entry.ops).toEqual(change.ops);
      expect(entry.kind).toBe(change.kind);
      expect(entry.actor).toEqual(change.actor);
      expect(entry.version).toBe(change.version);
      expect(entry.typeId).toBe(change.typeId);
      expect(entry.parentId).toBe(change.parentId);
    }
  });

  test('a no-op appends nothing, for the same reason it emits nothing', async () => {
    const note = await stack.create(NOTE, { text: 'hello' });
    const seen: RecordChange[] = [];
    const unsubscribe = await stack.subscribe((change) => seen.push(change));

    await stack.patchContent(note.id, { text: 'hello' });
    await stack.associate(note.id, { kind: 'tag', label: 'x' });
    await stack.associate(note.id, { kind: 'tag', label: 'x' });
    await stack.mutate(note.id, { permissions: [] });
    unsubscribe();

    // One associate moved something; nothing else did.
    expect(seen).toHaveLength(1);
    expect((await stack.getJournal(note.id)).slice(1)).toHaveLength(1);
  });

  test('the association deltas on the frame are the ones the entry keeps', async () => {
    const note = await stack.create(NOTE, { text: 'hello' });
    const seen: RecordChange[] = [];
    const unsubscribe = await stack.subscribe((change) => seen.push(change));

    await stack.mutate(note.id, {
      associations: [
        { kind: 'tag', label: 'added' },
        { kind: 'tag', label: 'kept' },
      ],
    });
    await stack.mutate(note.id, { associations: [{ kind: 'tag', label: 'kept' }] });
    unsubscribe();

    const log = (await stack.getJournal(note.id)).slice(1);
    expect(log).toHaveLength(2);
    expect(log[0]!.associationsAdded).toEqual(seen[0]!.associationsAdded);
    expect(log[1]!.associationsRemoved).toEqual(seen[1]!.associationsRemoved);
  });
});

// -------------------------------------------------------
// Reading the log
// -------------------------------------------------------

describe('the read surface', () => {
  test('sinceSeq resumes after an entry already seen', async () => {
    const note = await stack.create(NOTE, { text: 'hello' });
    await stack.associate(note.id, { kind: 'tag', label: 'a' });
    await stack.associate(note.id, { kind: 'tag', label: 'b' });

    const tail = await stack.getJournal(note.id, { sinceSeq: 1 });
    expect(tail.map((e) => e.seq)).toEqual([2, 3]);
    expect(await stack.getJournal(note.id, { sinceSeq: 3 })).toEqual([]);
  });

  test('limit bounds a page from the oldest end', async () => {
    const note = await stack.create(NOTE, { text: 'hello' });
    await stack.associate(note.id, { kind: 'tag', label: 'a' });
    await stack.associate(note.id, { kind: 'tag', label: 'b' });

    expect((await stack.getJournal(note.id, { limit: 2 })).map((e) => e.seq)).toEqual([1, 2]);
  });

  test('a record that never changed reads as an empty log, not a refusal', async () => {
    // The distinction the required adapter method exists to keep: every
    // adapter answers this, so an empty answer always means "nothing
    // changed" rather than "this stack does not remember". An adapter with
    // no journal to read refuses instead, in its own vocabulary.
    expect(await stack.getJournal('1hk153x00001')).toEqual([]);
  });
});

// -------------------------------------------------------
// Permission
// -------------------------------------------------------

describe('the journal is gated on the mutate surface, like version history', () => {
  test('a reader is refused; a write-holder is not', async () => {
    const note = await stack.create(
      NOTE,
      { text: 'hello' },
      {
        entityId: OWNER,
        permissions: [
          { access: 'entity', entityId: READER, read: true, write: false },
          { access: 'entity', entityId: EDITOR, read: true, write: true },
        ],
      },
    );
    await stack.associate(note.id, { kind: 'tag', label: 'starred' });

    const asReader = stack.asEntity(READER);
    const asEditor = stack.asEntity(EDITOR);

    // The reader can see the record and its associations as they stand...
    expect(await asReader.get(note.id)).not.toBeNull();
    // ...but not the trail of how they got that way.
    await expect(asReader.getJournal(note.id)).rejects.toThrow(StackPermissionError);
    expect((await asEditor.getJournal(note.id)).map((e) => e.ops.join())).toEqual([
      'create',
      'associate',
    ]);
  });
});

// -------------------------------------------------------
// The query window
// -------------------------------------------------------

describe('JournalQuery is validated at the surface', () => {
  // A negative limit used to diverge rather than fail: slice(0, -1) drops
  // the newest entry, while SQLite reads a negative LIMIT as "no ceiling"
  // and returns the whole log. Neither answers the call, and the
  // disagreement only shows up when a stack changes adapters.
  test.each([
    ['limit', { limit: -1 }],
    ['limit', { limit: 1.5 }],
    ['sinceSeq', { sinceSeq: -1 }],
    ['sinceSeq', { sinceSeq: 2.5 }],
  ])('refuses a non-integer or negative %s', async (_key, query) => {
    const note = await stack.create(NOTE, { text: 'hello' });
    await expect(stack.getJournal(note.id, query)).rejects.toThrow(StackQueryError);
  });

  test('limit 0 is a real window, not an invalid one', async () => {
    const note = await stack.create(NOTE, { text: 'hello' });
    await stack.patchContent(note.id, { text: 'edited' });
    expect(await stack.getJournal(note.id, { limit: 0 })).toEqual([]);
    expect(await stack.getJournal(note.id, { limit: 1 })).toHaveLength(1);
  });

  test('omitting limit reads the whole log — no ceiling is imposed', async () => {
    const note = await stack.create(NOTE, { text: 'hello' });
    for (let i = 0; i < 30; i++) await stack.patchContent(note.id, { text: `edit ${i}` });
    expect(await stack.getJournal(note.id)).toHaveLength(31);
  });

  test('the scoped surface is held to the same rule', async () => {
    const note = await stack.create(NOTE, { text: 'hello' }, { entityId: OWNER });
    await expect(stack.asEntity(OWNER).getJournal(note.id, { limit: -1 })).rejects.toThrow(
      StackQueryError,
    );
  });
});

// -------------------------------------------------------
// The app-facing contract
// -------------------------------------------------------

describe('getJournal is on StackClient', () => {
  // Stack and ScopedStack both implement it; the interface is what plugin
  // and extension code is typed against, so an omission there is a TS2339
  // rather than the adapter's own refusal naming what is missing.
  test('reachable through a StackClient-typed reference', async () => {
    const note = await stack.create(NOTE, { text: 'hello' });
    const viaInterface: StackClient = stack;
    const scopedViaInterface: StackClient = stack.asEntity(OWNER);

    expect((await viaInterface.getJournal(note.id)).map((e) => e.ops.join())).toEqual(['create']);
    expect(await scopedViaInterface.getJournal(note.id, { limit: 1 })).toHaveLength(1);
  });
});
