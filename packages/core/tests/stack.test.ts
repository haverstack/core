import { describe, test, expect, beforeEach } from 'vitest';
import {
  Stack,
  StackValidationError,
  StackMigrationError,
  StackNotFoundError,
  StackConflictError,
} from '../src/stack.js';
import { generateId, crockford32Encode } from '../src/id.js';
import { MemoryAdapter } from '../src/testing.js';

// -------------------------------------------------------
// Test setup
// -------------------------------------------------------

// Builds a well-formed 12-char id with a specific timestamp prefix, bypassing
// generateId()'s own monotonic-clock clamp (which would otherwise pull an
// "ancient" test timestamp forward to the real current time).
const idWithTimestamp = (ms: number): string => `${crockford32Encode(ms).padStart(9, '0')}000`;

const NOTE_V1 = 'com.example.test/note@1';
const NOTE_V2 = 'com.example.test/note@2';
const NOTE_V3 = 'com.example.test/note@3';

let adapter: MemoryAdapter;
let stack: Stack;

beforeEach(async () => {
  adapter = new MemoryAdapter({ ownerEntityId: 'owner-123', timezone: 'UTC' });
  stack = await Stack.create(adapter);

  await stack.defineType(NOTE_V1, 'Note', {
    text: { kind: 'text', required: true },
  });
});

// -------------------------------------------------------
// Stack.create
// -------------------------------------------------------

describe('Stack.create', () => {
  test('reads ownerEntityId from adapter', async () => {
    expect(stack.ownerEntityId).toBe('owner-123');
  });

  test('reads timezone from adapter', async () => {
    expect(stack.timezone).toBe('UTC');
  });

  test('throws if adapter has no ownerEntityId', async () => {
    const emptyAdapter = new MemoryAdapter();
    await expect(Stack.create(emptyAdapter)).rejects.toThrow(
      'Stack misconfiguration: adapter has no ownerEntityId',
    );
  });

  test('timezone defaults to UTC when not specified', async () => {
    const adapter = new MemoryAdapter({ ownerEntityId: 'entity-without-timezone' });
    const s = await Stack.create(adapter);
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
// create — client-supplied id (#55)
// -------------------------------------------------------

describe('create — client-supplied id', () => {
  test('accepts a well-formed client-supplied id', async () => {
    const id = generateId();
    const record = await stack.create(NOTE_V1, { text: 'hello' }, { id });
    expect(record.id).toBe(id);
  });

  test('generates an id when none is supplied', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    expect(record.id).toBeTruthy();
  });

  test('rejects an id with the wrong length', async () => {
    await expect(stack.create(NOTE_V1, { text: 'hello' }, { id: 'too-short' })).rejects.toThrow(
      StackValidationError,
    );
  });

  test('rejects an id with characters outside the Crockford charset', async () => {
    await expect(stack.create(NOTE_V1, { text: 'hello' }, { id: 'UPPERCASE123' })).rejects.toThrow(
      StackValidationError,
    );
  });

  test('rejects an id using the reserved "_" prefix', async () => {
    await expect(
      stack.create(NOTE_V1, { text: 'hello' }, { id: '_' + generateId().slice(1) }),
    ).rejects.toThrow(StackValidationError);
  });

  test('rejects a duplicate id with StackConflictError', async () => {
    const id = generateId();
    await stack.create(NOTE_V1, { text: 'first' }, { id });
    await expect(stack.create(NOTE_V1, { text: 'second' }, { id })).rejects.toThrow(
      StackConflictError,
    );
  });

  test('unscoped Stack.create() does not apply a timestamp-skew check', async () => {
    const ancientId = idWithTimestamp(new Date('2000-01-01').valueOf());
    const record = await stack.create(NOTE_V1, { text: 'hello' }, { id: ancientId });
    expect(record.id).toBe(ancientId);
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
// Records at rest: get()/query() are stored-version by default,
// migrateAll() is the only thing that ever changes disk state.
// -------------------------------------------------------

describe('records at rest', () => {
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

  test('get() returns the record exactly as stored, no implicit migration', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    const fetched = await stack.get(record.id);
    expect(fetched?.typeId).toBe(NOTE_V1);
    expect((fetched?.content as Record<string, unknown>).title).toBeUndefined();
  });

  test('query() returns records exactly as stored, no implicit migration', async () => {
    await stack.create(NOTE_V1, { text: 'hello' });
    const result = await stack.query({ filter: { typeId: NOTE_V1 } });
    expect(result.records[0]?.typeId).toBe(NOTE_V1);
  });

  test("update() validates against the record's own current typeId, never migrates it", async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    const updated = await stack.update(record.id, { text: 'updated' });
    expect(updated.typeId).toBe(NOTE_V1);
    const raw = await adapter.getRecord(record.id);
    expect(raw?.typeId).toBe(NOTE_V1); // still v1 on disk — update() never migrates
    expect((raw?.content as Record<string, unknown>).text).toBe('updated');
  });

  test("update() validates only against v1's schema — a v2-only field passes through unchecked, and the record stays at v1", async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    // "title" isn't declared in v1's schema, so validateContent() doesn't
    // check it (additive fields are ignored, not rejected) — but this is
    // still a v1 record; only migrateAll() can move it to v2.
    const updated = await stack.update(record.id, { title: 'not part of v1' });
    expect(updated.typeId).toBe(NOTE_V1);
    const raw = await adapter.getRecord(record.id);
    expect(raw?.typeId).toBe(NOTE_V1);
  });
});

describe('query — baseId filter', () => {
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
  });

  test('matches records across every version of the family, including not-yet-migrated ones', async () => {
    const v1 = await stack.create(NOTE_V1, { text: 'old' });
    const v2 = await stack.create(NOTE_V2, { text: 'new', title: 'hi' });

    const result = await stack.query({ filter: { baseId: 'com.example.test/note' } });

    const ids = result.records.map((r) => r.id).sort();
    expect(ids).toEqual([v1.id, v2.id].sort());
  });

  test('returns empty results for an unknown baseId rather than throwing', async () => {
    const result = await stack.query({ filter: { baseId: 'com.example.test/nonexistent' } });
    expect(result).toEqual({ records: [], cursor: null, total: 0 });
  });

  test('intersects with typeId when both are given', async () => {
    await stack.create(NOTE_V1, { text: 'old' });
    const v2 = await stack.create(NOTE_V2, { text: 'new', title: 'hi' });

    const result = await stack.query({
      filter: { baseId: 'com.example.test/note', typeId: NOTE_V2 },
    });

    expect(result.records.map((r) => r.id)).toEqual([v2.id]);
  });

  test('accepts an array of baseIds', async () => {
    await stack.defineType('com.example.test/other@1', 'Other', {
      text: { kind: 'text', required: true },
    });
    const note = await stack.create(NOTE_V1, { text: 'note' });
    const other = await stack.create('com.example.test/other@1', { text: 'other' });

    const result = await stack.query({
      filter: { baseId: ['com.example.test/note', 'com.example.test/other'] },
    });

    const ids = result.records.map((r) => r.id).sort();
    expect(ids).toEqual([note.id, other.id].sort());
  });
});

describe("presentAt: 'latest' (explicit in-memory migration)", () => {
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

  test("get({ presentAt: 'latest' }) returns migrated content in memory", async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    const fetched = await stack.get(record.id, { presentAt: 'latest' });
    expect(fetched?.typeId).toBe(NOTE_V2);
    expect((fetched?.content as Record<string, unknown>).title).toBe('');
  });

  test("get({ presentAt: 'latest' }) does not write migrated content to disk", async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.get(record.id, { presentAt: 'latest' });
    const raw = await adapter.getRecord(record.id);
    expect(raw?.typeId).toBe(NOTE_V1); // still v1 on disk
  });

  test("query({ presentAt: 'latest' }) migrates every result in memory", async () => {
    await stack.create(NOTE_V1, { text: 'hello' });
    const result = await stack.query({ filter: { typeId: NOTE_V1 }, presentAt: 'latest' });
    expect(result.records[0]?.typeId).toBe(NOTE_V2);
    expect((result.records[0]?.content as Record<string, unknown>).title).toBe('');
    // Still not written to disk.
    const raw = await adapter.getRecord(result.records[0]!.id);
    expect(raw?.typeId).toBe(NOTE_V1);
  });

  test('a single-version type with no migration history is trivially "latest" — no throw', async () => {
    const unmigratableType = 'com.example.test/other@1';
    await stack.defineType(unmigratableType, 'Other', {
      text: { kind: 'text', required: true },
    });
    const record = await stack.create(unmigratableType, { text: 'hello' });
    const fetched = await stack.get(record.id, { presentAt: 'latest' });
    expect(fetched?.typeId).toBe(unmigratableType);
  });

  test('stale-writer signal: a record newer than what this app instance has defined throws', async () => {
    // stackA is fully up to date: knows v1 and v2, and writes a v2 record.
    const stackA = await Stack.create(adapter);
    await stackA.defineType(NOTE_V1, 'Note', { text: { kind: 'text', required: true } });
    await stackA.defineType(
      NOTE_V2,
      'Note',
      { text: { kind: 'text', required: true }, title: { kind: 'string' } },
      { migratesFrom: NOTE_V1 },
    );
    const record = await stackA.create(NOTE_V2, { text: 'hello', title: 'hi' });

    // stackB simulates a stale binary sharing the same storage — its own
    // startup code only ever defineType()'d v1, so it has no idea v2 exists.
    const stackB = await Stack.create(adapter);
    await stackB.defineType(NOTE_V1, 'Note', { text: { kind: 'text', required: true } });

    await expect(stackB.get(record.id, { presentAt: 'latest' })).rejects.toThrow(
      StackMigrationError,
    );
    // Reading it as stored (the default) still works fine even for the stale app.
    const fetched = await stackB.get(record.id);
    expect(fetched?.typeId).toBe(NOTE_V2);
  });

  test('registration gap: an older record with no migration path to a type this app has defined throws', async () => {
    const gapAdapter = new MemoryAdapter({ ownerEntityId: 'owner-123', timezone: 'UTC' });
    const gapStack = await Stack.create(gapAdapter);
    await gapStack.defineType(NOTE_V1, 'Note', { text: { kind: 'text', required: true } });
    await gapStack.defineType(
      NOTE_V2,
      'Note',
      { text: { kind: 'text', required: true }, title: { kind: 'string' } },
      { migratesFrom: NOTE_V1 },
    );
    // Note: no registerMigration() call — this app knows v2 exists but has
    // no path to reach it from a v1 record.
    const record = await gapStack.create(NOTE_V1, { text: 'hello' });

    await expect(gapStack.get(record.id, { presentAt: 'latest' })).rejects.toThrow(
      StackMigrationError,
    );
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
    const fetched = await stack.get(record.id, { presentAt: 'latest' });
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

  test('sweeps soft-deleted records too, so undelete returns them healed', async () => {
    const record = await stack.create(NOTE_V1, { text: 'stale' });
    await stack.delete(record.id);

    const result = await stack.migrateAll('com.example.test/note');

    expect(result.migrated).toBe(1);
    const undeleted = await stack.undelete(record.id);
    expect(undeleted.typeId).toBe(NOTE_V2);
    expect(undeleted.content).toEqual({ text: 'stale', title: '' });
  });

  test('snapshots previous content to version history before migrating', async () => {
    const record = await stack.create(NOTE_V1, { text: 'original' });
    await stack.migrateAll('com.example.test/note');
    const versions = await stack.getVersions(record.id);
    expect(versions.length).toBe(1);
    expect(versions[0].content).toEqual({ text: 'original' });
    expect(versions[0].typeId).toBe(NOTE_V1);
  });

  test('aborts immediately if a migration function produces invalid content, leaving that record unmigrated', async () => {
    // Fresh stack so this test can register its own (deliberately buggy)
    // migration instead of the valid one from the outer beforeEach.
    const buggyAdapter = new MemoryAdapter({ ownerEntityId: 'owner-123', timezone: 'UTC' });
    const buggyStack = await Stack.create(buggyAdapter);
    await buggyStack.defineType(NOTE_V1, 'Note', { text: { kind: 'text', required: true } });
    await buggyStack.defineType(
      NOTE_V2,
      'Note',
      { text: { kind: 'text', required: true }, title: { kind: 'string' } },
      { migratesFrom: NOTE_V1 },
    );
    buggyStack.registerMigration({
      from: NOTE_V1,
      to: NOTE_V2,
      // Buggy migration: drops the required "text" field instead of carrying it forward.
      migrate: () => ({ title: '' }),
    });

    const record = await buggyStack.create(NOTE_V1, { text: 'original' });
    await expect(buggyStack.migrateAll('com.example.test/note')).rejects.toThrow(
      StackValidationError,
    );

    const raw = await buggyAdapter.getRecord(record.id);
    expect(raw?.typeId).toBe(NOTE_V1); // never committed
    expect(await buggyStack.getVersions(record.id)).toEqual([]); // no snapshot either
  });
});

// -------------------------------------------------------
// restoreVersion — typeId and validation (#62)
// -------------------------------------------------------

describe('restoreVersion — typeId and validation', () => {
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

  test('restores the snapshot’s own typeId, leaving a stale record that migrateAll() subsequently heals', async () => {
    const record = await stack.create(NOTE_V1, { text: 'original' });
    await stack.migrateAll('com.example.test/note'); // now @2, snapshot v1 is @1-shaped
    expect((await stack.get(record.id))?.typeId).toBe(NOTE_V2);

    const restored = await stack.restoreVersion(record.id, 1);

    // Restoring the pre-migration snapshot brings its typeId back too —
    // the record is legitimately stale at @1, not mislabeled @2.
    expect(restored.typeId).toBe(NOTE_V1);
    expect(restored.content).toEqual({ text: 'original' });

    const healed = await stack.migrateAll('com.example.test/note');
    expect(healed.migrated).toBe(1);
    expect((await stack.get(record.id))?.typeId).toBe(NOTE_V2);
  });

  test('rejects a drifted/invalid snapshot with StackValidationError instead of restoring it', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    // Simulate schema drift or adapter corruption: a stored snapshot whose
    // content no longer satisfies its own claimed type's schema.
    await adapter.saveVersion(record.id, {
      version: 1,
      typeId: NOTE_V1,
      content: {}, // missing required "text"
      updatedAt: new Date(),
    });

    await expect(stack.restoreVersion(record.id, 1)).rejects.toThrow(StackValidationError);
    expect((await stack.get(record.id))?.content).toEqual({ text: 'hello' }); // untouched
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

  test('restoreVersion restores associations captured in the snapshot', async () => {
    const record = await stack.create(NOTE_V1, { text: 'original' });
    await stack.associate(record.id, { kind: 'tag', label: 'favourite' }); // v2
    await stack.update(record.id, { text: 'changed' }); // v3, snapshots v2 (assoc: [favourite])
    await stack.dissociate(record.id, { kind: 'tag', label: 'favourite' }); // v4, assoc now []
    const restored = await stack.restoreVersion(record.id, 2); // v5
    expect(restored.content).toEqual({ text: 'original' });
    expect(restored.associations).toEqual([{ kind: 'tag', label: 'favourite' }]);
  });

  test('restoreVersion never restores permissions, even when the snapshot has them', async () => {
    const record = await stack.create(NOTE_V1, { text: 'original' });
    await stack.setPermissions(record.id, [{ access: 'public' }]); // v2
    await stack.update(record.id, { text: 'changed' }); // v3, snapshots v2 (permissions: [public])
    await stack.setPermissions(record.id, []); // v4, private again
    const restored = await stack.restoreVersion(record.id, 2); // v5
    expect(restored.content).toEqual({ text: 'original' });
    expect(restored.permissions).toEqual([]);
  });

  test('version snapshot captures associations and permissions when present', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.associate(record.id, { kind: 'tag', label: 'x' }); // v2, snapshots v1
    await stack.setPermissions(record.id, [{ access: 'public' }]); // v3, snapshots v2
    await stack.update(record.id, { text: 'changed' }); // v4, snapshots v3
    const versions = await stack.getVersions(record.id);
    const v3snap = versions.find((v) => v.version === 3);
    expect(v3snap?.associations).toEqual([{ kind: 'tag', label: 'x' }]);
    expect(v3snap?.permissions).toEqual([{ access: 'public' }]);
  });
});

// -------------------------------------------------------
// Versioning rule — mixed mutations
// -------------------------------------------------------

describe('versioning rule — mixed mutations', () => {
  test('version increments by exactly one per real mutation, across mixed operation types', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' }); // v1
    await stack.update(record.id, { text: 'v2' }); // v2
    await stack.associate(record.id, { kind: 'tag', label: 'x' }); // v3
    await stack.setPermissions(record.id, [{ access: 'public' }]); // v4
    await stack.dissociate(record.id, { kind: 'tag', label: 'x' }); // v5
    await stack.delete(record.id); // v6
    const undeleted = await stack.undelete(record.id); // v7

    expect(undeleted.version).toBe(7);
    const versionNumbers = (await stack.getVersions(record.id))
      .map((v) => v.version)
      .sort((a, b) => a - b);
    expect(versionNumbers).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test('no-op mutations never bump version or add a snapshot', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' }); // v1
    await stack.associate(record.id, { kind: 'tag', label: 'x' }); // v2
    await stack.associate(record.id, { kind: 'tag', label: 'x' }); // no-op
    await stack.dissociate(record.id, { kind: 'tag', label: 'gone' }); // no-op
    await stack.setPermissions(record.id, []); // no-op (already private)
    const updated = await adapter.getRecord(record.id);
    expect(updated?.version).toBe(2);
    expect(await stack.getVersions(record.id)).toHaveLength(1);
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

  test('soft delete bumps version and snapshots the prior state', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.delete(record.id);
    const deleted = await adapter.getRecord(record.id);
    expect(deleted?.version).toBe(2);
    expect(await stack.getVersions(record.id)).toHaveLength(1);
  });

  test('soft-deleting an already-deleted record is a no-op — no version bump', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.delete(record.id);
    await stack.delete(record.id);
    const deleted = await adapter.getRecord(record.id);
    expect(deleted?.version).toBe(2);
    expect(await stack.getVersions(record.id)).toHaveLength(1);
  });

  test('throws StackNotFoundError for a missing record (soft delete)', async () => {
    await expect(stack.delete('nonexistent')).rejects.toThrow(StackNotFoundError);
  });
});

// -------------------------------------------------------
// undelete
// -------------------------------------------------------

describe('undelete', () => {
  test('reverses a soft delete', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.delete(record.id);
    const undeleted = await stack.undelete(record.id);
    expect(undeleted.deletedAt).toBeUndefined();
    expect((await adapter.getRecord(record.id))?.deletedAt).toBeUndefined();
  });

  test('is idempotent — undeleting a non-deleted record returns it unchanged', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    const result = await stack.undelete(record.id);
    expect(result).toEqual(record);
  });

  test('a second undelete call is also a no-op success', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.delete(record.id);
    await stack.undelete(record.id);
    const result = await stack.undelete(record.id);
    expect(result.deletedAt).toBeUndefined();
  });

  test('throws StackNotFoundError for a hard-deleted (missing) record', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.delete(record.id, { hard: true });
    await expect(stack.undelete(record.id)).rejects.toThrow(StackNotFoundError);
  });

  test('throws StackNotFoundError for a record that never existed', async () => {
    await expect(stack.undelete('nonexistent')).rejects.toThrow(StackNotFoundError);
  });

  test('undeleted record is included in default queries again', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.delete(record.id);
    await stack.undelete(record.id);
    const result = await stack.query({ filter: { typeId: NOTE_V1 } });
    expect(result.records.find((r) => r.id === record.id)).toBeDefined();
  });

  test('bumps version and snapshots the deleted state', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' }); // v1
    await stack.delete(record.id); // v2
    const undeleted = await stack.undelete(record.id); // v3
    expect(undeleted.version).toBe(3);
    expect(await stack.getVersions(record.id)).toHaveLength(2);
  });

  test('idempotent no-op undelete does not bump version', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.undelete(record.id);
    const result = await adapter.getRecord(record.id);
    expect(result?.version).toBe(1);
    expect(await stack.getVersions(record.id)).toHaveLength(0);
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

  test('_attachment@1 type is available immediately after Stack.create()', async () => {
    expect(await stack.getType('_attachment@1')).not.toBeNull();
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

  test('associate bumps version and snapshots the prior state', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.associate(record.id, { kind: 'tag', label: 'favourite' });
    const updated = await adapter.getRecord(record.id);
    expect(updated?.version).toBe(2);
    const versions = await stack.getVersions(record.id);
    expect(versions).toHaveLength(1);
    expect(versions[0].version).toBe(1);
    expect(versions[0].associations ?? []).toEqual([]);
  });

  test('associate is a no-op for a duplicate association — no version bump', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.associate(record.id, { kind: 'tag', label: 'favourite' });
    await stack.associate(record.id, { kind: 'tag', label: 'favourite' });
    const updated = await adapter.getRecord(record.id);
    expect(updated?.version).toBe(2);
    expect(await stack.getVersions(record.id)).toHaveLength(1);
  });

  test('associate throws StackNotFoundError for a missing record', async () => {
    await expect(stack.associate('nonexistent', { kind: 'tag', label: 'x' })).rejects.toThrow(
      StackNotFoundError,
    );
  });

  test('dissociate bumps version and snapshots the prior state', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.associate(record.id, { kind: 'tag', label: 'favourite' });
    await stack.dissociate(record.id, { kind: 'tag', label: 'favourite' });
    const updated = await adapter.getRecord(record.id);
    expect(updated?.version).toBe(3);
    expect(await stack.getVersions(record.id)).toHaveLength(2);
  });

  test('dissociate is a no-op when the association is not present — no version bump', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.dissociate(record.id, { kind: 'tag', label: 'nonexistent' });
    const updated = await adapter.getRecord(record.id);
    expect(updated?.version).toBe(1);
    expect(await stack.getVersions(record.id)).toHaveLength(0);
  });

  test('dissociate throws StackNotFoundError for a missing record', async () => {
    await expect(stack.dissociate('nonexistent', { kind: 'tag', label: 'x' })).rejects.toThrow(
      StackNotFoundError,
    );
  });
});

// -------------------------------------------------------
// setPermissions
// -------------------------------------------------------

describe('setPermissions', () => {
  test('bumps version and snapshots the prior state', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.setPermissions(record.id, [{ access: 'public' }]);
    const updated = await adapter.getRecord(record.id);
    expect(updated?.version).toBe(2);
    expect(updated?.permissions).toEqual([{ access: 'public' }]);
    const versions = await stack.getVersions(record.id);
    expect(versions).toHaveLength(1);
    expect(versions[0].permissions ?? []).toEqual([]);
  });

  test('is a no-op for a deep-equal permission set — no version bump', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.setPermissions(record.id, [{ access: 'public' }]);
    await stack.setPermissions(record.id, [{ access: 'public' }]);
    const updated = await adapter.getRecord(record.id);
    expect(updated?.version).toBe(2);
    expect(await stack.getVersions(record.id)).toHaveLength(1);
  });

  test('setting empty permissions on an already-private record is a no-op', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.setPermissions(record.id, []);
    const updated = await adapter.getRecord(record.id);
    expect(updated?.version).toBe(1);
  });

  test('throws StackNotFoundError for a missing record', async () => {
    await expect(stack.setPermissions('nonexistent', [{ access: 'public' }])).rejects.toThrow(
      StackNotFoundError,
    );
  });
});

// -------------------------------------------------------
// putAttachment
// -------------------------------------------------------

describe('putAttachment', () => {
  test('stores bytes and returns fileId', async () => {
    const data = new Uint8Array([1, 2, 3]);
    const fileId = await stack.putAttachment(data, 'image/png');
    expect(typeof fileId).toBe('string');
  });

  test('creates _attachment@1 record with metadata', async () => {
    const data = new Uint8Array([1, 2, 3]);
    await stack.putAttachment(data, 'image/png', 'photo.png');
    const result = await stack.query({ filter: { typeId: '_attachment@1' } });
    expect(result.records).toHaveLength(1);
    const content = result.records[0].content as Record<string, unknown>;
    expect(content.mimeType).toBe('image/png');
    expect(content.size).toBe(3);
    expect(content.filename).toBe('photo.png');
  });

  test('attachment record has no entityId (owner-attributed)', async () => {
    const data = new Uint8Array([1, 2, 3]);
    await stack.putAttachment(data, 'image/png');
    const result = await stack.query({ filter: { typeId: '_attachment@1' } });
    expect(result.records[0].entityId).toBeUndefined();
  });
});

// -------------------------------------------------------
// deleteAttachment
// -------------------------------------------------------

describe('deleteAttachment', () => {
  test('throws StackConflictError when a record still references the file (fallback path)', async () => {
    const data = new Uint8Array([1, 2, 3]);
    const fileId = await stack.putAttachment(data, 'image/png');
    const note = await stack.create(NOTE_V1, { text: 'hi' });
    await stack.associate(note.id, {
      kind: 'attachment',
      label: 'cover',
      fileId,
      mimeType: 'image/png',
    });

    await expect(stack.deleteAttachment(fileId)).rejects.toThrow(StackConflictError);
  });

  test('deletes the _attachment@1 metadata record when unreferenced (fallback path)', async () => {
    const data = new Uint8Array([1, 2, 3]);
    const fileId = await stack.putAttachment(data, 'image/png');

    await stack.deleteAttachment(fileId);

    const result = await stack.query({ filter: { typeId: '_attachment@1' } });
    expect(result.records).toHaveLength(0);
  });

  test('throws StackNotFoundError when neither metadata nor bytes exist', async () => {
    class NoBytesAdapter extends MemoryAdapter {
      async getAttachment(_fileId: string): Promise<Uint8Array> {
        throw new Error('not found');
      }
    }
    const noBytesStack = await Stack.create(
      new NoBytesAdapter({ ownerEntityId: 'owner-123', timezone: 'UTC' }),
    );

    await expect(noBytesStack.deleteAttachment('nonexistent-file')).rejects.toThrow(
      StackNotFoundError,
    );
  });

  // #50: the fallback's metadata scan used to take a single unbounded
  // query() page, so on adapters without contentFieldQuery — where matching
  // happens in memory — metadata beyond page one was never found, leaving
  // it orphaned once the bytes were deleted.
  test('leaves no orphaned metadata when the matching record is beyond the first page (>50 records)', async () => {
    const targetFileId = 'target-file-abc';
    for (let i = 0; i < 55; i++) {
      await stack.create('_attachment@1', {
        fileId: `filler-${i}`,
        mimeType: 'image/png',
        size: 1,
      });
    }
    const target = await stack.create('_attachment@1', {
      fileId: targetFileId,
      mimeType: 'image/png',
      size: 1,
    });

    await stack.deleteAttachment(targetFileId);

    expect(await stack.get(target.id)).toBeNull();
    const remaining = await stack.query({ filter: { typeId: '_attachment@1' }, limit: 1000 });
    expect(
      remaining.records.some((r) => (r.content as Record<string, unknown>).fileId === targetFileId),
    ).toBe(false);
  });

  // #63: a fileId held in a file-ref content field is a real reference —
  // deleteAttachment()'s 409 check must see it, not just attachment associations.
  test('throws StackConflictError when only a file-ref content field references the file (fallback path)', async () => {
    const attachmentTypeId = 'com.example.test/photo-note@1';
    await stack.defineType(attachmentTypeId, 'Photo note', {
      coverFileId: { kind: 'file-ref', required: true },
    });

    const data = new Uint8Array([1, 2, 3]);
    const fileId = await stack.putAttachment(data, 'image/png');
    await stack.create(attachmentTypeId, { coverFileId: fileId });

    await expect(stack.deleteAttachment(fileId)).rejects.toThrow(StackConflictError);
  });

  test('a plain string field holding a fileId conveys no delete protection', async () => {
    const attachmentTypeId = 'com.example.test/photo-note-plain@1';
    await stack.defineType(attachmentTypeId, 'Photo note (plain)', {
      coverFileId: { kind: 'string', required: true },
    });

    const data = new Uint8Array([1, 2, 3]);
    const fileId = await stack.putAttachment(data, 'image/png');
    await stack.create(attachmentTypeId, { coverFileId: fileId });

    await expect(stack.deleteAttachment(fileId)).resolves.toBeUndefined();
  });

  test('prefers the adapter atomic path over the fallback when the adapter implements it', async () => {
    const calls: string[] = [];
    class AtomicAdapter extends MemoryAdapter {
      async deleteUnreferencedAttachmentRecords(
        fileId: string,
        metadataTypeId: string,
      ): Promise<string[]> {
        calls.push('atomic');
        const toDelete = [...this.records.values()].filter(
          (r) =>
            r.typeId === metadataTypeId && (r.content as Record<string, unknown>).fileId === fileId,
        );
        for (const r of toDelete) {
          this.records.delete(r.id);
          this.order.splice(this.order.indexOf(r.id), 1);
        }
        return toDelete.map((r) => r.id);
      }
    }
    const atomicStack = await Stack.create(
      new AtomicAdapter({ ownerEntityId: 'owner-123', timezone: 'UTC' }),
    );
    await atomicStack.defineType(NOTE_V1, 'Note', { text: { kind: 'text', required: true } });

    const fileId = await atomicStack.putAttachment(new Uint8Array([9]), 'image/png');
    await atomicStack.deleteAttachment(fileId);

    expect(calls).toEqual(['atomic']);
  });
});
