import { describe, test, expect, beforeEach } from 'vitest';
import { Stack } from '../src/stack.js';
import {
  StackConflictError,
  StackNotFoundError,
  StackPermissionError,
  StackValidationError,
} from '../src/errors.js';
import { MemoryAdapter } from '../src/testing.js';
import { isPlanEmpty } from '../src/install.js';
import type { AppManifest } from '../src/install.js';
import type { AppContent, GrantContent, InstallContent, StackRecord } from '../src/types.js';

const OWNER = 'did:key:owner';
const APP_DID = 'did:key:notes-app';
const OTHER_DID = 'did:key:other-app';
const PERSON = 'did:key:person';

const NOTE_1 = 'com.example.notes/note@1';
const NOTE_2 = 'com.example.notes/note@2';
const TAG_1 = 'com.example.tags/tag@1';
const COMMONS_NOTE = 'org.haverstack/note@1';

const manifest = (overrides: Partial<AppManifest> = {}): AppManifest => ({
  appId: 'com.example.notes',
  name: 'Notes',
  version: '1.0.0',
  types: [{ id: NOTE_1, name: 'Note', schema: { text: { kind: 'text' } } }],
  requests: [{ baseId: 'com.example.notes/note', actions: ['create', 'read-any'] }],
  ...overrides,
});

const NOTE_2_TYPE = {
  id: NOTE_2,
  name: 'Note',
  schema: { text: { kind: 'text' }, pinned: { kind: 'boolean' } },
  migratesFrom: NOTE_1,
} as const;

const MIGRATING = [
  { baseId: 'com.example.notes/note', actions: ['read-any', 'update-any'] },
] as AppManifest['requests'];

let stack: Stack;

async function install(m: AppManifest, did = APP_DID) {
  return stack.installApp(await stack.planInstall(m, { did }));
}

async function linkedGrants(record: StackRecord): Promise<GrantContent[]> {
  const out: GrantContent[] = [];
  for (const a of record.associations ?? []) {
    if (a.kind !== 'relationship' || a.label !== 'install.grant' || a.target.kind !== 'record') {
      continue;
    }
    const grant = await stack.get(a.target.recordId);
    if (grant) out.push(grant.content as GrantContent);
  }
  return out;
}

beforeEach(async () => {
  stack = await Stack.open(await MemoryAdapter.open({ ownerEntityId: OWNER }));
});

describe('installApp()', () => {
  test('defines the types, registers the key and grants exactly the requests', async () => {
    const record = await install(manifest());

    expect(await stack.getType(NOTE_1)).not.toBeNull();
    expect(record.typeId).toBe('_install@1');
    expect(record.content).toEqual({
      appId: 'com.example.notes',
      name: 'Notes',
      version: '1.0.0',
      defines: [NOTE_1],
      requests: [{ baseId: 'com.example.notes/note', actions: ['create', 'read-any'] }],
    });

    const card = (await stack.query({ filter: { baseId: '_app' } })).records[0]!;
    expect(card.content).toMatchObject({ appId: 'com.example.notes', did: APP_DID });

    expect(await linkedGrants(record)).toEqual([
      {
        baseId: 'com.example.notes/note',
        actions: ['create', 'read-any'],
        grantee: { kind: 'entity', entityId: APP_DID },
      },
    ]);
    expect(await stack.listTypeGrants()).toHaveLength(1);
  });

  test('re-applying the same manifest changes nothing', async () => {
    const first = await install(manifest());
    const plan = await stack.planInstall(manifest(), { did: APP_DID });
    expect(plan).toMatchObject({
      newFamilies: [],
      newVersions: [],
      requestsAdded: [],
      requestsRemoved: [],
      newKey: false,
    });
    const second = await stack.installApp(plan);
    expect(second.id).toBe(first.id);
    expect(await stack.listTypeGrants()).toHaveLength(1);
  });

  test('an upgrade adds approved versions and brings grants to the new requests', async () => {
    const first = await install(manifest());
    const next = manifest({ version: '2.0.0', types: [NOTE_2_TYPE], requests: MIGRATING });
    const plan = await stack.planInstall(next, { did: APP_DID });
    expect(plan.newVersions).toEqual([NOTE_2]);
    expect(plan.newFamilies).toEqual([]);
    expect(plan.requestsAdded).toEqual(MIGRATING);
    expect(plan.requestsRemoved).toEqual(manifest().requests);

    const upgraded = await stack.installApp(plan);
    expect(upgraded.content.defines).toEqual([NOTE_1, NOTE_2]);
    expect((await linkedGrants(upgraded)).map((g) => g.actions)).toEqual([
      ['read-any', 'update-any'],
    ]);
    expect(await stack.listTypeGrants()).toHaveLength(1);
    expect((await stack.getVersions(first.id)).length).toBeGreaterThan(0);
  });

  test('a second key gets the same grants, and an upgrade reaches every linked key', async () => {
    await install(manifest());
    const plan = await stack.planInstall(manifest(), { did: OTHER_DID });
    expect(plan.newKey).toBe(true);
    await stack.installApp(plan);
    expect(
      (await stack.listTypeGrants()).map(
        (g) => (g.content.grantee as { entityId: string }).entityId,
      ),
    ).toEqual(expect.arrayContaining([APP_DID, OTHER_DID]));

    await install(manifest({ requests: [] }));
    expect(await stack.listTypeGrants()).toHaveLength(0);
  });

  test('refuses a plan the stack has moved on from', async () => {
    const plan = await stack.planInstall(manifest(), { did: APP_DID });
    await install(manifest());
    await expect(stack.installApp(plan)).rejects.toThrow(StackConflictError);
  });

  test('a key registered to another app is refused', async () => {
    await stack.create('_app@1', { appId: 'com.example.other', name: 'Other', did: APP_DID });
    await expect(stack.planInstall(manifest(), { did: APP_DID })).rejects.toThrow(
      StackConflictError,
    );
  });

  test('system types can be neither defined nor requested when ungrantable', async () => {
    await expect(
      stack.planInstall(manifest({ types: [{ id: '_entity@2', name: 'Entity', schema: {} }] }), {
        did: APP_DID,
      }),
    ).rejects.toThrow(StackValidationError);
    await expect(
      stack.planInstall(manifest({ requests: [{ baseId: '_install', actions: ['create'] }] }), {
        did: APP_DID,
      }),
    ).rejects.toThrow(StackValidationError);
  });

  test('requests outside the app’s own namespace name the family’s owner', async () => {
    const plan = await stack.planInstall(
      manifest({
        requests: [
          { baseId: 'com.example.notes/note', actions: ['create'] },
          { baseId: 'com.example.tags/tag', actions: ['read-any'] },
          { baseId: 'org.haverstack/note', actions: ['read-any'] },
          { baseId: '_entity', actions: ['read-any'] },
        ],
      }),
      { did: APP_DID },
    );
    expect(plan.foreignRequests).toEqual([
      { baseId: 'com.example.tags/tag', actions: ['read-any'], owner: 'com.example.tags' },
      { baseId: 'org.haverstack/note', actions: ['read-any'], owner: 'commons' },
      { baseId: '_entity', actions: ['read-any'], owner: 'system' },
    ]);
  });

  test('another app’s family can be used through a request, never defined', async () => {
    await install(
      manifest({
        appId: 'com.example.tags',
        name: 'Tags',
        types: [{ id: TAG_1, name: 'Tag', schema: { label: { kind: 'string' } } }],
        requests: [],
      }),
      OTHER_DID,
    );
    await expect(
      stack.planInstall(manifest({ types: [{ id: TAG_1, name: 'Tag', schema: {} }] }), {
        did: APP_DID,
      }),
    ).rejects.toThrow(StackValidationError);

    const record = await install(
      manifest({ requests: [{ baseId: 'com.example.tags/tag', actions: ['read-any'] }] }),
    );
    expect(await linkedGrants(record)).toEqual([
      {
        baseId: 'com.example.tags/tag',
        actions: ['read-any'],
        grantee: { kind: 'entity', entityId: APP_DID },
      },
    ]);
  });

  test('commons types are defined by an install but never claimed', async () => {
    const record = await install(
      manifest({
        types: [
          ...manifest().types,
          { id: COMMONS_NOTE, name: 'Note', schema: { body: { kind: 'text' } } },
        ],
      }),
    );
    expect(await stack.getType(COMMONS_NOTE)).not.toBeNull();
    expect(record.content.defines).toEqual([NOTE_1]);
  });
});

describe('what an installed app sees', () => {
  test('each linked key can read its own install, and no one else can', async () => {
    const record = await install(manifest());
    expect((await stack.asEntity(APP_DID).get(record.id))?.content).toEqual(record.content);
    expect(
      (await stack.asEntity(APP_DID).query({ filter: { baseId: '_install' } })).records,
    ).toHaveLength(1);
    expect(await stack.asEntity(PERSON).get(record.id)).toBeNull();
  });

  test('a plan is empty only once its key is installed and nothing would change', async () => {
    expect(isPlanEmpty(await stack.planInstall(manifest(), { did: APP_DID }))).toBe(false);
    await install(manifest());
    expect(isPlanEmpty(await stack.planInstall(manifest(), { did: APP_DID }))).toBe(true);
    expect(isPlanEmpty(await stack.planInstall(manifest(), { did: OTHER_DID }))).toBe(false);
    expect(isPlanEmpty(await stack.planInstall(manifest({ requests: [] }), { did: APP_DID }))).toBe(
      false,
    );
    await stack.uninstallApp('com.example.notes');
    expect(isPlanEmpty(await stack.planInstall(manifest(), { did: APP_DID }))).toBe(false);
  });
});

describe('the _install record', () => {
  test('defines names only families in the install’s own namespace', async () => {
    for (const id of [NOTE_2, COMMONS_NOTE, '_grant@1']) {
      await expect(
        stack.create<InstallContent>('_install@1', {
          appId: 'com.example.rival',
          name: 'Rival',
          defines: [id],
          requests: [],
        }),
      ).rejects.toThrow(StackValidationError);
    }
  });

  test('one install answers for each appId, and appId is immutable', async () => {
    const record = await install(manifest());
    await expect(
      stack.create<InstallContent>('_install@1', {
        appId: 'com.example.notes',
        name: 'Notes again',
        defines: [],
        requests: [],
      }),
    ).rejects.toThrow(StackConflictError);
    await expect(stack.patchContent(record.id, { appId: 'com.example.other' })).rejects.toThrow(
      StackValidationError,
    );
  });

  test('cannot be granted, and only the owner acting alone writes one', async () => {
    await expect(
      stack.grantType('_install', {
        actions: ['create'],
        grantee: { kind: 'entity', entityId: PERSON },
      }),
    ).rejects.toThrow(StackValidationError);

    const record = await install(manifest());
    await stack.grantAccess(
      record.id,
      (['read', 'write'] as const).map((label) => ({
        kind: 'permission' as const,
        label,
        grantee: { kind: 'entity' as const, entityId: PERSON },
      })),
    );
    await expect(
      stack.asEntity(PERSON).patchContent(record.id, { name: 'Renamed' }),
    ).rejects.toThrow(StackPermissionError);
  });
});

describe('uninstallApp()', () => {
  test('withdraws the grants, keeps the card, and a later install restores it', async () => {
    const record = await install(manifest());
    const removed = await stack.uninstallApp('com.example.notes');
    expect(removed.deletedAt).toBeDefined();
    expect(await stack.listTypeGrants()).toHaveLength(0);
    expect((await stack.query({ filter: { baseId: '_app' } })).records).toHaveLength(1);

    const again = await install(manifest());
    expect(again.id).toBe(record.id);
    expect(again.deletedAt).toBeUndefined();
    expect(await stack.listTypeGrants()).toHaveLength(1);
  });

  test('an unknown appId is not found', async () => {
    await expect(stack.uninstallApp('com.example.none')).rejects.toThrow(StackNotFoundError);
  });
});

describe('commitMigration() for an installed app', () => {
  async function installForMigration(requests = MIGRATING) {
    await install(manifest({ types: [manifest().types[0]!, NOTE_2_TYPE], requests }));
    return stack.create(NOTE_1, { text: 'hello' });
  }

  test('the app may migrate within its own families to an approved version', async () => {
    const note = await installForMigration();
    const migrated = await stack
      .asEntity(APP_DID)
      .commitMigration(note.id, NOTE_2, { text: 'hello', pinned: false });
    expect(migrated.typeId).toBe(NOTE_2);
    expect(migrated.updatedBy).toEqual({ subjectId: APP_DID });
  });

  test('update-any has to be requested', async () => {
    const note = await installForMigration([
      { baseId: 'com.example.notes/note', actions: ['read-any', 'update-own'] },
    ]);
    await expect(
      stack.asEntity(APP_DID).commitMigration(note.id, NOTE_2, { text: 'hello' }),
    ).rejects.toThrow(StackPermissionError);
  });

  test('a version the owner has not approved is refused', async () => {
    const note = await installForMigration();
    await stack.defineType({ id: 'com.example.notes/note@3', name: 'Note', schema: {} });
    await expect(
      stack.asEntity(APP_DID).commitMigration(note.id, 'com.example.notes/note@3', {}),
    ).rejects.toThrow(StackPermissionError);
  });

  test('a family the install does not claim is refused', async () => {
    const note = await installForMigration();
    await stack.defineType({ id: 'org.example/other@1', name: 'Other', schema: {} });
    await stack.grantType('org.example/other', {
      actions: ['read-any', 'update-any'],
      grantee: { kind: 'entity', entityId: APP_DID },
    });
    await expect(
      stack.asEntity(APP_DID).commitMigration(note.id, 'org.example/other@1', {}),
    ).rejects.toThrow(StackPermissionError);
  });

  test('a commons family is never the app’s to migrate', async () => {
    await install(
      manifest({
        types: [
          { id: COMMONS_NOTE, name: 'Note', schema: { body: { kind: 'text' } } },
          { id: 'org.haverstack/note@2', name: 'Note', schema: { body: { kind: 'text' } } },
        ],
        requests: [{ baseId: 'org.haverstack/note', actions: ['read-any', 'update-any'] }],
      }),
    );
    const note = await stack.create(COMMONS_NOTE, { body: 'hi' });
    await expect(
      stack.asEntity(APP_DID).commitMigration(note.id, 'org.haverstack/note@2', { body: 'hi' }),
    ).rejects.toThrow(StackPermissionError);
  });

  test('the app acting for someone else, or a key not linked to the install, is refused', async () => {
    const note = await installForMigration();
    await expect(
      stack
        .asActor({ principalId: APP_DID, subjectId: PERSON })
        .commitMigration(note.id, NOTE_2, { text: 'hello' }),
    ).rejects.toThrow(StackPermissionError);
    await stack.grantType('com.example.notes/note', {
      actions: ['read-any', 'update-any'],
      grantee: { kind: 'entity', entityId: OTHER_DID },
    });
    await expect(
      stack.asEntity(OTHER_DID).commitMigration(note.id, NOTE_2, { text: 'hello' }),
    ).rejects.toThrow(StackPermissionError);
  });

  test('an uninstalled app may no longer migrate', async () => {
    const note = await installForMigration();
    await stack.uninstallApp('com.example.notes');
    await stack.grantType('com.example.notes/note', {
      actions: ['read-any', 'update-any'],
      grantee: { kind: 'entity', entityId: APP_DID },
    });
    await expect(
      stack.asEntity(APP_DID).commitMigration(note.id, NOTE_2, { text: 'hello' }),
    ).rejects.toThrow(StackPermissionError);
  });
});

describe("migrateAll({ sweep: 'listed' })", () => {
  test('migrates live, listed records and counts the deleted ones it passed over', async () => {
    await stack.defineType(manifest().types[0]!);
    await stack.defineType(NOTE_2_TYPE);
    stack.registerMigration({
      from: NOTE_1,
      to: NOTE_2,
      migrate: (c) => ({ ...c, pinned: false }),
    });
    const live = await stack.create(NOTE_1, { text: 'a' });
    const deleted = await stack.create(NOTE_1, { text: 'b' });
    await stack.delete(deleted.id);
    const unlisted = await stack.create(NOTE_1, { text: 'c' }, { unlisted: true });

    expect(await stack.migrateAll('com.example.notes/note', { sweep: 'listed' })).toEqual({
      migrated: 1,
      skipped: 1,
    });
    expect((await stack.get(live.id))!.typeId).toBe(NOTE_2);
    expect((await stack.get(deleted.id, { includeDeleted: true }))!.typeId).toBe(NOTE_1);
    expect((await stack.get(unlisted.id))!.typeId).toBe(NOTE_1);

    expect(await stack.migrateAll('com.example.notes/note')).toEqual({ migrated: 2, skipped: 0 });
  });
});

describe('the _app card an install registers', () => {
  test('is the owner’s, carrying the manifest’s name', async () => {
    await install(manifest());
    const card = (await stack.query({ filter: { baseId: '_app' } })).records[0]!;
    expect((card.content as AppContent).name).toBe('Notes');
    expect(card.createdBy).toBeUndefined();
  });
});
