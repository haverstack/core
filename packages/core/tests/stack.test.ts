import { describe, test, expect, beforeEach } from 'vitest';
import { Stack, StackValidationError, StackMigrationError } from '../src/stack.js';
import { MemoryAdapter } from '../src/testing.js';

// -------------------------------------------------------
// Test setup
// -------------------------------------------------------

const NOTE_V1 = 'com.example.test/note@1';
const NOTE_V2 = 'com.example.test/note@2';
const NOTE_V3 = 'com.example.test/note@3';

let adapter: MemoryAdapter;
let stack: Stack;

beforeEach(async () => {
  adapter = new MemoryAdapter({ entity_id: 'owner-123', timezone: 'UTC' });
  stack = await Stack.create(adapter);

  await stack.defineType(NOTE_V1, 'Note', {
    text: { kind: 'text', required: true },
  });
});

// -------------------------------------------------------
// Stack.create
// -------------------------------------------------------

describe('Stack.create', () => {
  test('reads ownerEntityId from adapter config', async () => {
    expect(stack.ownerEntityId).toBe('owner-123');
  });

  test('reads timezone from adapter config', async () => {
    expect(stack.timezone).toBe('UTC');
  });

  test('ownerEntityId is null if not set in config', async () => {
    const emptyAdapter = new MemoryAdapter();
    const s = await Stack.create(emptyAdapter);
    expect(s.ownerEntityId).toBeNull();
  });

  test('timezone defaults to UTC if not set in config', async () => {
    const emptyAdapter = new MemoryAdapter();
    const s = await Stack.create(emptyAdapter);
    expect(s.timezone).toBe('UTC');
  });
});

// -------------------------------------------------------
// defineType
// -------------------------------------------------------

describe('defineType', () => {
  test('saves the type to the adapter', async () => {
    const type = await stack.getType(NOTE_V1);
    expect(type).not.toBeNull();
    expect(type?.name).toBe('Note');
  });

  test('computes and stores a schemaHash', async () => {
    const type = await stack.getType(NOTE_V1);
    expect(type?.schemaHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('throws for invalid TypeId format', async () => {
    await expect(stack.defineType('no-version', 'Bad', {})).rejects.toThrow();
  });

  test('stores migratesFrom when provided', async () => {
    await stack.defineType(
      NOTE_V2,
      'Note',
      {
        text: { kind: 'text', required: true },
        title: { kind: 'string' },
      },
      { migratesFrom: NOTE_V1 },
    );
    const type = await stack.getType(NOTE_V2);
    expect(type?.migratesFrom).toBe(NOTE_V1);
  });
});

// -------------------------------------------------------
// create
// -------------------------------------------------------

describe('create', () => {
  test('creates a record with correct fields', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    expect(record.id).toBeTruthy();
    expect(record.typeId).toBe(NOTE_V1);
    expect(record.content).toEqual({ text: 'hello' });
    expect(record.version).toBe(1);
  });

  test('does not set entityId when none is supplied (owner-created records are implicitly owner-owned)', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    expect(record.entityId).toBeUndefined();
  });

  test('allows overriding entityId via options', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' }, { entityId: 'other-456' });
    expect(record.entityId).toBe('other-456');
  });

  test('sets parentId when provided', async () => {
    const parent = await stack.create(NOTE_V1, { text: 'parent' });
    const child = await stack.create(NOTE_V1, { text: 'child' }, { parentId: parent.id });
    expect(child.parentId).toBe(parent.id);
  });

  test('throws StackValidationError for invalid content', async () => {
    await expect(stack.create(NOTE_V1, { text: 42 as unknown as string })).rejects.toThrow(
      StackValidationError,
    );
  });

  test('throws for missing required field', async () => {
    await expect(stack.create(NOTE_V1, {} as { text: string })).rejects.toThrow(
      StackValidationError,
    );
  });

  test('throws for unknown typeId', async () => {
    await expect(stack.create('com.example.test/unknown@1', { text: 'hello' })).rejects.toThrow();
  });
});

// -------------------------------------------------------
// update — merge patch
// -------------------------------------------------------

describe('update', () => {
  test('merges partial content with existing', async () => {
    await stack.defineType(NOTE_V2, 'Note', {
      text: { kind: 'text', required: true },
      title: { kind: 'string' },
    });
    const record = await stack.create(NOTE_V2, { text: 'hello', title: 'My Note' });
    const updated = await stack.update(record.id, { title: 'Updated' });
    expect(updated.content).toEqual({ text: 'hello', title: 'Updated' });
  });

  test('null value removes an optional field', async () => {
    await stack.defineType(NOTE_V2, 'Note', {
      text: { kind: 'text', required: true },
      title: { kind: 'string' },
    });
    const record = await stack.create(NOTE_V2, { text: 'hello', title: 'My Note' });
    const updated = await stack.update(record.id, { title: null });
    expect((updated.content as Record<string, unknown>).title).toBeUndefined();
  });

  test('null on required field fails validation', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await expect(stack.update(record.id, { text: null })).rejects.toThrow(StackValidationError);
  });

  test('increments version number', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    const updated = await stack.update(record.id, { text: 'world' });
    expect(updated.version).toBe(2);
  });

  test('snapshots previous content to version history', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.update(record.id, { text: 'world' });
    const versions = await stack.getVersions(record.id);
    expect(versions.length).toBe(1);
    expect(versions[0].content).toEqual({ text: 'hello' });
    expect(versions[0].version).toBe(1);
  });

  test('throws for unknown record', async () => {
    await expect(stack.update('nonexistent', { text: 'hello' })).rejects.toThrow();
  });
});

// -------------------------------------------------------
// Lazy migration
// -------------------------------------------------------

describe('lazy migration', () => {
  beforeEach(async () => {
    await stack.defineType(
      NOTE_V2,
      'Note',
      {
        text: { kind: 'text', required: true },
        title: { kind: 'string' },
      },
      { migratesFrom: NOTE_V1 },
    );

    stack.registerMigration({
      from: NOTE_V1,
      to: NOTE_V2,
      migrate: (content) => ({ ...content, title: '' }),
    });
  });

  test('get() returns migrated content in memory', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    const fetched = await stack.get(record.id);
    expect(fetched?.typeId).toBe(NOTE_V2);
    expect((fetched?.content as Record<string, unknown>).title).toBe('');
  });

  test('get() does not write migrated content to disk', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.get(record.id);
    const raw = await adapter.getRecord(record.id);
    expect(raw?.typeId).toBe(NOTE_V1); // still v1 on disk
  });

  test('get({ migrate: false }) returns raw stored record', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    const raw = await stack.get(record.id, { migrate: false });
    expect(raw?.typeId).toBe(NOTE_V1);
    expect((raw?.content as Record<string, unknown>).title).toBeUndefined();
  });

  test('update() commits migration to disk', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.update(record.id, { title: 'My Title' });
    const raw = await adapter.getRecord(record.id);
    expect(raw?.typeId).toBe(NOTE_V2);
    expect((raw?.content as Record<string, unknown>).title).toBe('My Title');
  });

  test('update() merges patch against migrated content', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.update(record.id, {}); // empty patch, just commits migration
    const raw = await adapter.getRecord(record.id);
    expect((raw?.content as Record<string, unknown>).title).toBe(''); // migration default
  });

  test('warns when no migration path exists', async () => {
    const unmigratableType = 'com.example.test/other@1';
    await stack.defineType(unmigratableType, 'Other', {
      text: { kind: 'text', required: true },
    });
    const record = await stack.create(unmigratableType, { text: 'hello' });
    // Should not throw — just warn and return raw
    const fetched = await stack.get(record.id);
    expect(fetched?.typeId).toBe(unmigratableType);
  });

  test('chained migration: v1 → v2 → v3', async () => {
    await stack.defineType(
      NOTE_V3,
      'Note',
      {
        text: { kind: 'text', required: true },
        title: { kind: 'string' },
        pinned: { kind: 'boolean' },
      },
      { migratesFrom: NOTE_V2 },
    );

    stack.registerMigration({
      from: NOTE_V2,
      to: NOTE_V3,
      migrate: (content) => ({ ...content, pinned: false }),
    });

    const record = await stack.create(NOTE_V1, { text: 'hello' });
    const fetched = await stack.get(record.id);
    expect(fetched?.typeId).toBe(NOTE_V3);
    expect((fetched?.content as Record<string, unknown>).title).toBe('');
    expect((fetched?.content as Record<string, unknown>).pinned).toBe(false);
  });
});

// -------------------------------------------------------
// registerMigration
// -------------------------------------------------------

describe('registerMigration', () => {
  test('throws if a migration from the same typeId is already registered', async () => {
    stack.registerMigration({ from: NOTE_V1, to: NOTE_V2, migrate: (c) => c });
    expect(() =>
      stack.registerMigration({ from: NOTE_V1, to: NOTE_V2, migrate: (c) => c }),
    ).toThrow(StackMigrationError);
  });
});

// -------------------------------------------------------
// migrateAll
// -------------------------------------------------------

describe('migrateAll', () => {
  beforeEach(async () => {
    await stack.defineType(
      NOTE_V2,
      'Note',
      {
        text: { kind: 'text', required: true },
        title: { kind: 'string' },
      },
      { migratesFrom: NOTE_V1 },
    );

    stack.registerMigration({
      from: NOTE_V1,
      to: NOTE_V2,
      migrate: (content) => ({ ...content, title: '' }),
    });
  });

  test('throws StackMigrationError for an unknown baseTypeId', async () => {
    await expect(stack.migrateAll('com.example.test/noot')).rejects.toThrow(StackMigrationError);
  });

  test('throws with a message that includes the bad baseTypeId', async () => {
    await expect(stack.migrateAll('com.example.test/noot')).rejects.toThrow(
      'com.example.test/noot',
    );
  });

  test('migrates all outdated records and returns the count', async () => {
    const r1 = await stack.create(NOTE_V1, { text: 'alpha' });
    const r2 = await stack.create(NOTE_V1, { text: 'beta' });

    const result = await stack.migrateAll('com.example.test/note');

    expect(result.migrated).toBe(2);
    expect((await adapter.getRecord(r1.id))?.typeId).toBe(NOTE_V2);
    expect((await adapter.getRecord(r2.id))?.typeId).toBe(NOTE_V2);
  });

  test('returns migrated: 0 when all records are already at the latest version', async () => {
    await stack.create(NOTE_V2, { text: 'already current', title: 'hi' });

    const result = await stack.migrateAll('com.example.test/note');

    expect(result.migrated).toBe(0);
  });

  test('snapshots previous content to version history before migrating', async () => {
    const record = await stack.create(NOTE_V1, { text: 'original' });
    await stack.migrateAll('com.example.test/note');
    const versions = await stack.getVersions(record.id);
    expect(versions.length).toBe(1);
    expect(versions[0].content).toEqual({ text: 'original' });
  });
});

// -------------------------------------------------------
// Versions
// -------------------------------------------------------

describe('versions', () => {
  test('getVersions returns empty array for new record', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    expect(await stack.getVersions(record.id)).toEqual([]);
  });

  test('getVersions returns history after updates', async () => {
    const record = await stack.create(NOTE_V1, { text: 'v1' });
    await stack.update(record.id, { text: 'v2' });
    await stack.update(record.id, { text: 'v3' });
    const versions = await stack.getVersions(record.id);
    expect(versions.length).toBe(2);
  });

  test('restoreVersion creates a new version with old content', async () => {
    const record = await stack.create(NOTE_V1, { text: 'original' });
    await stack.update(record.id, { text: 'changed' });
    const restored = await stack.restoreVersion(record.id, 1);
    expect(restored.content).toEqual({ text: 'original' });
    expect(restored.version).toBe(3); // v1 original, v2 changed, v3 restored
  });

  test('restoreVersion does not rewrite history', async () => {
    const record = await stack.create(NOTE_V1, { text: 'original' });
    await stack.update(record.id, { text: 'changed' });
    await stack.restoreVersion(record.id, 1);
    const versions = await stack.getVersions(record.id);
    expect(versions.length).toBe(2); // v1 and v2 snapshots preserved
  });

  test('restoreVersion throws for unknown version', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await expect(stack.restoreVersion(record.id, 99)).rejects.toThrow();
  });
});

// -------------------------------------------------------
// delete
// -------------------------------------------------------

describe('delete', () => {
  test('soft delete sets deletedAt', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.delete(record.id);
    const deleted = await adapter.getRecord(record.id);
    expect(deleted?.deletedAt).toBeInstanceOf(Date);
  });

  test('soft-deleted records are excluded from queries by default', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.delete(record.id);
    const result = await stack.query({ filter: { typeId: NOTE_V1 } });
    expect(result.records.find((r) => r.id === record.id)).toBeUndefined();
  });

  test('soft-deleted records appear with includeDeleted', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.delete(record.id);
    const result = await stack.query({ filter: { typeId: NOTE_V1, includeDeleted: true } });
    expect(result.records.find((r) => r.id === record.id)).toBeDefined();
  });

  test('hard delete removes the record entirely', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.delete(record.id, { hard: true });
    expect(await adapter.getRecord(record.id)).toBeNull();
  });
});

// -------------------------------------------------------
// flush / close lifecycle
// -------------------------------------------------------

describe('flush / close', () => {
  test('flush() delegates to adapter.flush() when implemented', async () => {
    let flushed = false;
    adapter.flush = async () => {
      flushed = true;
    };
    await stack.flush();
    expect(flushed).toBe(true);
  });

  test('flush() is a no-op when adapter does not implement flush', async () => {
    await expect(stack.flush()).resolves.toBeUndefined();
  });

  test('close() delegates to adapter.close() when implemented', async () => {
    let closed = false;
    adapter.close = async () => {
      closed = true;
    };
    await stack.close();
    expect(closed).toBe(true);
  });

  test('close() is a no-op when adapter does not implement close', async () => {
    await expect(stack.close()).resolves.toBeUndefined();
  });
});

// -------------------------------------------------------
// grant
// -------------------------------------------------------

describe('grant', () => {
  test('creates a grant record for the given entity and type', async () => {
    const records = await stack.grant('entity-abc', [{ actions: ['create'], typeId: NOTE_V1 }]);
    expect(records).toHaveLength(1);
    expect(records[0].entityId).toBe('entity-abc');
    expect(records[0].content).toEqual({ typeId: NOTE_V1, actions: ['create'] });
  });

  test('null entityId creates a default grant (no entityId on the record)', async () => {
    const records = await stack.grant(null, [{ actions: ['create'], typeId: NOTE_V1 }]);
    expect(records[0].entityId).toBeUndefined();
  });

  test('creates multiple grant records in one call', async () => {
    await stack.defineType(NOTE_V2, 'Note v2', {
      text: { kind: 'text', required: true },
      title: { kind: 'string' },
    });
    const records = await stack.grant('entity-abc', [
      { actions: ['create'], typeId: NOTE_V1 },
      { actions: ['create'], typeId: NOTE_V2 },
    ]);
    expect(records).toHaveLength(2);
  });

  test('_grant@1 type is available immediately after Stack.create()', async () => {
    expect(await stack.getType('_grant@1')).not.toBeNull();
  });
});

// -------------------------------------------------------
// associate / dissociate
// -------------------------------------------------------

describe('associate / dissociate', () => {
  test('associate adds a tag', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.associate(record.id, { kind: 'tag', label: 'favourite' });
    const updated = await adapter.getRecord(record.id);
    expect(updated?.associations?.some((a) => a.kind === 'tag' && a.label === 'favourite')).toBe(
      true,
    );
  });

  test('dissociate removes a tag', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.associate(record.id, { kind: 'tag', label: 'favourite' });
    await stack.dissociate(record.id, { kind: 'tag', label: 'favourite' });
    const updated = await adapter.getRecord(record.id);
    expect(updated?.associations?.some((a) => a.label === 'favourite')).toBe(false);
  });
});
