import { describe, test, expect, beforeEach } from 'vitest';
import { Stack } from '../src/stack.js';
import { MemoryAdapter } from '../src/testing.js';

// -------------------------------------------------------
// Test setup
// -------------------------------------------------------

const NOTE = 'com.example.test/note@1';
const OWNER = 'owner-123';
const AUTHOR = 'did:key:zAuthor';
const EDITOR = 'did:key:zEditor';
const APP = 'did:key:zApp';

let adapter: MemoryAdapter;
let stack: Stack;

beforeEach(async () => {
  adapter = new MemoryAdapter({ ownerEntityId: OWNER, timezone: 'UTC' });
  stack = await Stack.create(adapter);
  await stack.defineType(NOTE, 'Note', { text: { kind: 'text', required: true } });
  await stack.grant(null, [
    {
      actions: ['create', 'read-any', 'update-any', 'delete-any'],
      typeId: NOTE,
    },
  ]);
  await stack.grant(APP, [
    {
      actions: ['create', 'read-any', 'update-any', 'delete-any'],
      typeId: NOTE,
    },
  ]);
});

// -------------------------------------------------------
// The actor moves; the author does not
// -------------------------------------------------------

describe('attribution — updatedBy tracks the actor', () => {
  test('create stamps the author as the actor of version 1', async () => {
    const record = await stack.asEntity(AUTHOR).create(NOTE, { text: 'v1' });
    expect(record.entityId).toBe(AUTHOR);
    expect(record.updatedBy).toBe(AUTHOR);
    expect(record.updatedVia).toBeUndefined();
  });

  test('a delegated create names both halves at version 1', async () => {
    const record = await stack.asEntity(APP, { onBehalfOf: AUTHOR }).create(NOTE, { text: 'v1' });
    expect(record.entityId).toBe(AUTHOR);
    expect(record.updatedBy).toBe(AUTHOR);
    expect(record.principalId).toBe(APP);
    expect(record.updatedVia).toBe(APP);
  });

  test('a non-author update moves updatedBy but never entityId', async () => {
    const created = await stack.asEntity(AUTHOR).create(NOTE, { text: 'v1' });
    await stack.asEntity(EDITOR).update(created.id, { text: 'v2' });

    const record = await stack.get(created.id);
    expect(record?.entityId).toBe(AUTHOR);
    expect(record?.updatedBy).toBe(EDITOR);
  });

  test('every mutating verb restamps the actor', async () => {
    const created = await stack.asEntity(AUTHOR).create(NOTE, { text: 'v1' });
    const view = stack.asEntity(EDITOR);

    await view.update(created.id, { text: 'v2' });
    expect((await stack.get(created.id))?.updatedBy).toBe(EDITOR);

    await view.associate(created.id, { kind: 'tag', label: 'x' });
    expect((await stack.get(created.id))?.updatedBy).toBe(EDITOR);

    await view.dissociate(created.id, { kind: 'tag', label: 'x' });
    expect((await stack.get(created.id))?.updatedBy).toBe(EDITOR);

    await view.delete(created.id);
    expect((await stack.get(created.id))?.updatedBy).toBe(EDITOR);

    await view.undelete(created.id);
    expect((await stack.get(created.id))?.updatedBy).toBe(EDITOR);
  });

  // Resharing is owner-or-creator-only and never delegated, so the creator
  // is the only non-owner who can perform it — but it still restamps, which
  // is what makes "who widened access to this" answerable at all.
  test('setPermissions records who reshared', async () => {
    const created = await stack.asEntity(AUTHOR).create(NOTE, { text: 'v1' });
    await stack.asEntity(EDITOR).update(created.id, { text: 'v2' });
    expect((await stack.get(created.id))?.updatedBy).toBe(EDITOR);

    await stack.asEntity(AUTHOR).setPermissions(created.id, [{ access: 'public' }]);

    expect((await stack.get(created.id))?.updatedBy).toBe(AUTHOR);
  });

  test('a delegated write records both halves', async () => {
    const created = await stack.asEntity(AUTHOR).create(NOTE, { text: 'v1' });
    await stack.asEntity(APP, { onBehalfOf: EDITOR }).update(created.id, { text: 'v2' });

    const record = await stack.get(created.id);
    expect(record?.updatedBy).toBe(EDITOR);
    expect(record?.updatedVia).toBe(APP);
  });

  test('an undelegated write names no principal', async () => {
    const created = await stack.asEntity(AUTHOR).create(NOTE, { text: 'v1' });
    await stack.asEntity(EDITOR).update(created.id, { text: 'v2' });
    expect((await stack.get(created.id))?.updatedVia).toBeUndefined();
  });

  // An unscoped Stack has no requester to name. Carrying the previous actor
  // forward would attribute the write to whoever last touched the record.
  test('an unscoped write clears the actor rather than inheriting it', async () => {
    const created = await stack.asEntity(AUTHOR).create(NOTE, { text: 'v1' });
    expect((await stack.get(created.id))?.updatedBy).toBe(AUTHOR);

    await stack.update(created.id, { text: 'v2' });

    const record = await stack.get(created.id);
    expect(record?.updatedBy).toBeUndefined();
    expect(record?.updatedVia).toBeUndefined();
    expect(record?.entityId).toBe(AUTHOR);
  });

  test('an unscoped create names no actor at all', async () => {
    const record = await stack.create(NOTE, { text: 'v1' });
    expect(record.entityId).toBeUndefined();
    expect(record.updatedBy).toBeUndefined();
  });
});

// -------------------------------------------------------
// The requester names itself
// -------------------------------------------------------

describe('attribution — not caller-assertable', () => {
  // A scoped requester is named by making the request. Honouring an actor
  // it described in the options would make attribution self-reported, which
  // is the property principalId already exists to deny.
  test('a scoped caller cannot supply its own updatedBy', async () => {
    const created = await stack.asEntity(AUTHOR).create(NOTE, { text: 'v1' });

    await stack
      .asEntity(EDITOR)
      .update(created.id, { text: 'v2' }, { updatedBy: AUTHOR, updatedVia: APP } as never);

    const record = await stack.get(created.id);
    expect(record?.updatedBy).toBe(EDITOR);
    expect(record?.updatedVia).toBeUndefined();
  });
});

// -------------------------------------------------------
// Version history
// -------------------------------------------------------

describe('attribution — version history', () => {
  test('each version carries the actor that produced it', async () => {
    const created = await stack.asEntity(AUTHOR).create(NOTE, { text: 'v1' });
    await stack.asEntity(EDITOR).update(created.id, { text: 'v2' });
    await stack.asEntity(APP, { onBehalfOf: AUTHOR }).update(created.id, { text: 'v3' });

    const versions = await stack.getVersions(created.id);
    const byVersion = new Map(versions.map((v) => [v.version, v]));

    // v1 was the create, v2 the editor's update; v3 is the live record.
    expect(byVersion.get(1)?.updatedBy).toBe(AUTHOR);
    expect(byVersion.get(2)?.updatedBy).toBe(EDITOR);

    const live = await stack.get(created.id);
    expect(live?.updatedBy).toBe(AUTHOR);
    expect(live?.updatedVia).toBe(APP);
  });

  test('a version snapshot keeps author and actor as separate facts', async () => {
    const created = await stack.asEntity(AUTHOR).create(NOTE, { text: 'v1' });
    await stack.asEntity(EDITOR).update(created.id, { text: 'v2' });
    await stack.asEntity(EDITOR).update(created.id, { text: 'v3' });

    const v2 = (await stack.getVersions(created.id)).find((v) => v.version === 2);
    expect(v2?.entityId).toBe(AUTHOR);
    expect(v2?.updatedBy).toBe(EDITOR);
  });
});

// -------------------------------------------------------
// restoreVersion
// -------------------------------------------------------

describe('attribution — restoreVersion', () => {
  // A rollback is a write by whoever performs it. Restoring the stamp along
  // with the content would credit the restored version's actor for it.
  test('stamps the restorer, not the restored version’s actor', async () => {
    const created = await stack.asEntity(AUTHOR).create(NOTE, { text: 'v1' });
    await stack.asEntity(EDITOR).update(created.id, { text: 'v2' });

    await stack.asEntity(APP, { onBehalfOf: EDITOR }).restoreVersion(created.id, 1);

    const record = await stack.get(created.id);
    expect(record?.content.text).toBe('v1');
    expect(record?.updatedBy).toBe(EDITOR);
    expect(record?.updatedVia).toBe(APP);
  });

  test('restoring never moves the author', async () => {
    const created = await stack.asEntity(AUTHOR).create(NOTE, { text: 'v1' });
    await stack.asEntity(EDITOR).update(created.id, { text: 'v2' });
    await stack.asEntity(EDITOR).restoreVersion(created.id, 1);

    expect((await stack.get(created.id))?.entityId).toBe(AUTHOR);
  });
});

// -------------------------------------------------------
// The actor is not a permission input
// -------------------------------------------------------

describe('attribution — separate from authorship checks', () => {
  // `-own` grants resolve against the author, so an editor restamping
  // updatedBy must not hand them a record they only touched.
  test('updatedBy does not satisfy an -own grant', async () => {
    const created = await stack.asEntity(AUTHOR).create(NOTE, { text: 'v1' });
    await stack.asEntity(EDITOR).update(created.id, { text: 'v2' });

    const ownOnly = new MemoryAdapter({ ownerEntityId: OWNER, timezone: 'UTC' });
    const s2 = await Stack.create(ownOnly);
    await s2.defineType(NOTE, 'Note', { text: { kind: 'text', required: true } });
    await s2.grant(null, [{ actions: ['create', 'read-own'], typeId: NOTE }]);

    const authored = await s2.asEntity(AUTHOR).create(NOTE, { text: 'a' });
    // EDITOR can neither read nor restamp it: read-own resolves on entityId.
    expect(await s2.asEntity(EDITOR).get(authored.id)).toBeNull();
    expect((await s2.get(authored.id))?.updatedBy).toBe(AUTHOR);
  });
});
