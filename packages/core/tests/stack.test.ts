import { describe, test, expect, beforeEach, vi } from 'vitest';
import {
  Stack,
  StackError,
  StackValidationError,
  StackMigrationError,
  StackPermissionError,
  StackNotFoundError,
  StackConflictError,
  StackVersionConflictError,
  StackSchemaDriftError,
  StackQueryError,
  StackPayloadTooLargeError,
  StackClosedError,
} from '../src/stack.js';
import { generateId, crockford32Encode, IdGenerationError } from '../src/id.js';
import { InvalidDidError } from '../src/did.js';
import { MemoryAdapter, IncapableMemoryAdapter } from '../src/testing.js';
import { firstRecordedAttachment } from '../src/attachment-download.js';
import type { AttachmentContent, BlobFileInfo, StackAdapter, StackRecord } from '../src/types.js';

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

  // timezone is optional passthrough metadata, nothing more — no
  // default, since defaulting to a real timezone would claim knowledge the
  // stack doesn't have.
  test('timezone is undefined when not specified — no default', async () => {
    const adapter = new MemoryAdapter({ ownerEntityId: 'entity-without-timezone' });
    const s = await Stack.create(adapter);
    expect(s.timezone).toBeUndefined();
  });

  describe('ownerProfile', () => {
    test('does nothing when omitted', async () => {
      const emptyAdapter = new MemoryAdapter({ ownerEntityId: 'did:key:owner' });
      const s = await Stack.create(emptyAdapter);
      const { records } = await s.query({ filter: { typeId: '_entity@1' } });
      expect(records).toHaveLength(0);
    });

    test('creates the owner _entity record on first init', async () => {
      const emptyAdapter = new MemoryAdapter({ ownerEntityId: 'did:key:owner' });
      const s = await Stack.create(emptyAdapter, {
        ownerProfile: { name: 'Jane Smith', handle: 'janesmith' },
      });

      const { records } = await s.query({ filter: { typeId: '_entity@1' } });
      expect(records).toHaveLength(1);
      expect(records[0].content).toEqual({
        did: 'did:key:owner',
        name: 'Jane Smith',
        handle: 'janesmith',
      });
    });

    test('omits handle when not provided', async () => {
      const emptyAdapter = new MemoryAdapter({ ownerEntityId: 'did:key:owner' });
      const s = await Stack.create(emptyAdapter, { ownerProfile: { name: 'Jane Smith' } });
      const { records } = await s.query({ filter: { typeId: '_entity@1' } });
      expect(records[0].content).toEqual({ did: 'did:key:owner', name: 'Jane Smith' });
    });

    test('is idempotent across reopen — does not duplicate the owner record', async () => {
      const emptyAdapter = new MemoryAdapter({ ownerEntityId: 'did:key:owner' });
      await Stack.create(emptyAdapter, { ownerProfile: { name: 'Jane Smith' } });
      // Simulate a later run against the same (still-open) adapter/data.
      const reopened = await Stack.create(emptyAdapter, { ownerProfile: { name: 'Jane Smith' } });

      const { records } = await reopened.query({ filter: { typeId: '_entity@1' } });
      expect(records).toHaveLength(1);
    });

    test('does not overwrite an existing owner record with different content', async () => {
      const emptyAdapter = new MemoryAdapter({ ownerEntityId: 'did:key:owner' });
      await Stack.create(emptyAdapter, { ownerProfile: { name: 'Original Name' } });
      const reopened = await Stack.create(emptyAdapter, { ownerProfile: { name: 'New Name' } });

      const { records } = await reopened.query({ filter: { typeId: '_entity@1' } });
      expect(records).toHaveLength(1);
      expect(records[0].content).toMatchObject({ name: 'Original Name' });
    });

    // A soft-deleted card still reserves the owner's did, so the bootstrap
    // treats it as present rather than minting a second card the binding
    // rules would refuse — reopening stays possible either way.
    test('treats a soft-deleted owner record as existing', async () => {
      const emptyAdapter = new MemoryAdapter({ ownerEntityId: 'did:key:owner' });
      const s = await Stack.create(emptyAdapter, { ownerProfile: { name: 'Jane Smith' } });
      const { records } = await s.query({ filter: { typeId: '_entity@1' } });
      await s.delete(records[0].id);

      const reopened = await Stack.create(emptyAdapter, { ownerProfile: { name: 'Jane Smith' } });

      const all = await reopened.query({
        filter: { typeId: '_entity@1', includeDeleted: true },
      });
      expect(all.records).toHaveLength(1);
      expect(all.records[0].deletedAt).toBeDefined();
    });

    // The bootstrap probe and the binding rules must agree about what
    // "already exists" means on every axis, version included: uniqueness is
    // checked across the whole `_entity` family, so a probe that looked only
    // at `_entity@1` would mint a card the rules then refuse.
    test('treats an owner record migrated to a later type version as existing', async () => {
      const emptyAdapter = new MemoryAdapter({ ownerEntityId: 'did:key:owner' });
      const s = await Stack.create(emptyAdapter, { ownerProfile: { name: 'Jane Smith' } });
      await s.defineType('_entity@2', 'Entity', {
        did: { kind: 'string', required: true },
        name: { kind: 'string', required: true },
        handle: { kind: 'string' },
        pronouns: { kind: 'string' },
      });
      s.registerMigration({ from: '_entity@1', to: '_entity@2', migrate: (c) => ({ ...c }) });
      await s.migrateAll('_entity');

      const reopened = await Stack.create(emptyAdapter, { ownerProfile: { name: 'Jane Smith' } });

      const { records } = await reopened.query({ filter: { baseId: '_entity' } });
      expect(records).toHaveLength(1);
      expect(records[0].typeId).toBe('_entity@2');
    });

    test('leaves the created record unauthored (no entityId), matching owner-attributed convention', async () => {
      const emptyAdapter = new MemoryAdapter({ ownerEntityId: 'did:key:owner' });
      const s = await Stack.create(emptyAdapter, { ownerProfile: { name: 'Jane Smith' } });
      const { records } = await s.query({ filter: { typeId: '_entity@1' } });
      expect(records[0].entityId).toBeUndefined();
    });

    // The idempotency check cursor-walks every `_entity@1` record, so an
    // owner card past page one (>50 `_entity` records, e.g. an address
    // book) is still found and Stack.create({ ownerProfile }) stays a
    // no-op rather than minting a duplicate.
    test('does not duplicate the owner record when it exists past the first query page (regression)', async () => {
      const emptyAdapter = new MemoryAdapter({ ownerEntityId: 'did:key:owner' });
      const s0 = await Stack.create(emptyAdapter);
      for (let i = 0; i < 55; i++) {
        await s0.create('_entity@1', { did: `did:key:filler-${i}`, name: `Filler ${i}` });
      }
      // The owner's own card, created directly (not through ensureOwnerEntity),
      // lands after the filler records in insertion order — past page one.
      await s0.create('_entity@1', { did: 'did:key:owner', name: 'Original Name' });

      await Stack.create(emptyAdapter, { ownerProfile: { name: 'New Name' } });

      const { records } = await s0.query({
        filter: { typeId: '_entity@1' },
        limit: 100,
      });
      const ownerRecords = records.filter(
        (r) => (r.content as Record<string, unknown>).did === 'did:key:owner',
      );
      expect(ownerRecords).toHaveLength(1);
      expect(ownerRecords[0].content).toMatchObject({ name: 'Original Name' });
    });
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

  // -------------------------------------------------------
  // Schema drift detection
  // -------------------------------------------------------

  test('redefining with an identical schema is a no-op — createdAt does not churn', async () => {
    const before = await stack.getType(NOTE_V1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await stack.defineType(NOTE_V1, 'Note', { text: { kind: 'text', required: true } });
    const after = await stack.getType(NOTE_V1);
    expect(after?.createdAt.getTime()).toBe(before?.createdAt.getTime());
  });

  test('a name-only change persists, preserving createdAt', async () => {
    const before = await stack.getType(NOTE_V1);
    await stack.defineType(NOTE_V1, 'Renamed Note', {
      text: { kind: 'text', required: true },
    });
    const after = await stack.getType(NOTE_V1);
    expect(after?.name).toBe('Renamed Note');
    expect(after?.createdAt.getTime()).toBe(before?.createdAt.getTime());
  });

  test('adding a new optional field in place is accepted, preserving createdAt', async () => {
    const before = await stack.getType(NOTE_V1);
    await stack.defineType(NOTE_V1, 'Note', {
      text: { kind: 'text', required: true },
      title: { kind: 'string' },
    });
    const after = await stack.getType(NOTE_V1);
    expect(after?.schema.title).toEqual({ kind: 'string' });
    expect(after?.createdAt.getTime()).toBe(before?.createdAt.getTime());
    expect(after?.schemaHash).not.toBe(before?.schemaHash);
  });

  test('adding a new optional field nested inside an existing object is accepted', async () => {
    const nested = 'com.example.test/nested@1';
    await stack.defineType(nested, 'Nested', {
      author: { kind: 'object', required: true, properties: { name: { kind: 'string' } } },
    });
    await stack.defineType(nested, 'Nested', {
      author: {
        kind: 'object',
        required: true,
        properties: { name: { kind: 'string' }, email: { kind: 'string' } },
      },
    });
    const type = await stack.getType(nested);
    expect((type?.schema.author as { properties: unknown }).properties).toHaveProperty('email');
  });

  test('adding a new required field is rejected with StackSchemaDriftError', async () => {
    await expect(
      stack.defineType(NOTE_V1, 'Note', {
        text: { kind: 'text', required: true },
        title: { kind: 'string', required: true },
      }),
    ).rejects.toThrow(StackSchemaDriftError);
  });

  test('removing a field is rejected with StackSchemaDriftError', async () => {
    await stack.defineType(NOTE_V2, 'Note', {
      text: { kind: 'text', required: true },
      title: { kind: 'string' },
    });
    await expect(
      stack.defineType(NOTE_V2, 'Note', { text: { kind: 'text', required: true } }),
    ).rejects.toThrow(StackSchemaDriftError);
  });

  test('changing a field kind is rejected with StackSchemaDriftError, even text/string', async () => {
    await expect(
      stack.defineType(NOTE_V1, 'Note', { text: { kind: 'string', required: true } }),
    ).rejects.toThrow(StackSchemaDriftError);
  });

  test('flipping an existing field required is rejected with StackSchemaDriftError', async () => {
    await expect(stack.defineType(NOTE_V1, 'Note', { text: { kind: 'text' } })).rejects.toThrow(
      StackSchemaDriftError,
    );
  });

  test('StackSchemaDriftError names the specific violation', async () => {
    try {
      await stack.defineType(NOTE_V1, 'Note', {
        text: { kind: 'text', required: true },
        title: { kind: 'string', required: true },
      });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(StackSchemaDriftError);
      const err = e as StackSchemaDriftError;
      expect(err.typeId).toBe(NOTE_V1);
      expect(err.violations).toEqual([
        { path: 'title', message: 'new field is required; new fields must be optional' },
      ]);
      expect(err.message).toContain('title');
      expect(err.message).toContain('Bump the version');
    }
  });

  test('an illegal redefinition does not overwrite the stored type', async () => {
    const before = await stack.getType(NOTE_V1);
    await expect(
      stack.defineType(NOTE_V1, 'Note', {
        text: { kind: 'text', required: true },
        title: { kind: 'string', required: true },
      }),
    ).rejects.toThrow(StackSchemaDriftError);
    const after = await stack.getType(NOTE_V1);
    expect(after).toEqual(before);
  });

  test('repeated seedSystemTypes()-style redefinition across Stack.create() calls stays idempotent', async () => {
    // Simulates the every-open churn this issue closes: a second Stack
    // instance (e.g. a fresh process reopening the same adapter) redefines
    // the same types on the same underlying storage.
    const before = await stack.getType(NOTE_V1);
    const stackB = await Stack.create(adapter);
    await stackB.defineType(NOTE_V1, 'Note', { text: { kind: 'text', required: true } });
    const after = await stackB.getType(NOTE_V1);
    expect(after?.createdAt.getTime()).toBe(before?.createdAt.getTime());
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
// create — _group admin bootstrap
// -------------------------------------------------------

describe('create — _group admin bootstrap', () => {
  test('owner-created group via plain Stack.create stamps the owner as first admin', async () => {
    const group = await stack.create('_group@1', { name: 'New Group' });
    expect(group.associations).toEqual([
      { kind: 'relationship', label: 'admin', recordId: 'owner-123' },
    ]);
  });

  test('stamps the supplied entityId, not the owner, when one is provided', async () => {
    const group = await stack.create('_group@1', { name: 'New Group' }, { entityId: 'other-456' });
    expect(group.associations).toEqual([
      { kind: 'relationship', label: 'admin', recordId: 'other-456' },
    ]);
  });

  test('does not duplicate an explicitly supplied admin association', async () => {
    const group = await stack.create(
      '_group@1',
      { name: 'New Group' },
      { associations: [{ kind: 'relationship', label: 'admin', recordId: 'owner-123' }] },
    );
    const adminAssociations = (group.associations ?? []).filter(
      (a) => a.kind === 'relationship' && a.label === 'admin' && a.recordId === 'owner-123',
    );
    expect(adminAssociations).toHaveLength(1);
  });

  test('does not stamp non-group records', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    expect(record.associations).toBeUndefined();
  });
});

// -------------------------------------------------------
// create — client-supplied id
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
      StackQueryError,
    );
  });

  test('rejects an id with characters outside the Crockford charset', async () => {
    await expect(stack.create(NOTE_V1, { text: 'hello' }, { id: 'UPPERCASE123' })).rejects.toThrow(
      StackQueryError,
    );
  });

  test('rejects an id using the reserved "_" prefix', async () => {
    await expect(
      stack.create(NOTE_V1, { text: 'hello' }, { id: '_' + generateId().slice(1) }),
    ).rejects.toThrow(StackQueryError);
  });

  test('rejects a duplicate id with StackConflictError', async () => {
    const id = generateId();
    await stack.create(NOTE_V1, { text: 'first' }, { id });
    await expect(stack.create(NOTE_V1, { text: 'second' }, { id })).rejects.toThrow(
      StackConflictError,
    );
  });

  test('MemoryAdapter.createRecord itself rejects a duplicate id — not just Stack’s callers', async () => {
    const first = await stack.create(NOTE_V1, { text: 'first' });
    await expect(adapter.createRecord({ ...first, content: { text: 'second' } })).rejects.toThrow(
      StackConflictError,
    );
    // The rejected create must not have mutated storage: no overwrite, no
    // dangling duplicate `order` entry (which would corrupt pagination).
    expect((await adapter.getRecord(first.id))?.content).toEqual({ text: 'first' });
    expect(adapter.order.filter((recordId) => recordId === first.id)).toHaveLength(1);
  });

  test('unscoped Stack.create() does not apply a timestamp-skew check', async () => {
    const ancientId = idWithTimestamp(new Date('2000-01-01').valueOf());
    const record = await stack.create(NOTE_V1, { text: 'hello' }, { id: ancientId });
    expect(record.id).toBe(ancientId);
  });
});

// -------------------------------------------------------
// Type cache — create()/update()/etc. shouldn't pay a getType()
// round trip on every write for a value that can't change.
// -------------------------------------------------------

describe('type cache', () => {
  // A type saved straight through the adapter, bypassing stack.defineType()
  // (and its cache write) so the first getTypeCached() call is a genuine
  // cache miss — the scenario a real app hits on first use of a type an
  // earlier process already defined.
  const COLD_TYPE_ID = 'com.example.test/cold@1';
  const seedColdType = async (): Promise<void> => {
    await adapter.saveType({
      id: COLD_TYPE_ID,
      baseId: 'com.example.test/cold',
      version: 1,
      name: 'Cold',
      schema: { text: { kind: 'text', required: true } },
      schemaHash: 'irrelevant-for-this-test',
      createdAt: new Date(),
    });
  };

  test('create() x N against a not-yet-cached type calls adapter.getType() exactly once', async () => {
    await seedColdType();
    const getTypeSpy = vi.spyOn(adapter, 'getType');

    await stack.create(COLD_TYPE_ID, { text: 'one' });
    await stack.create(COLD_TYPE_ID, { text: 'two' });
    await stack.create(COLD_TYPE_ID, { text: 'three' });

    expect(getTypeSpy).toHaveBeenCalledTimes(1);
  });

  test('defineType() populates the cache — a later create() never calls adapter.getType()', async () => {
    await stack.defineType(NOTE_V2, 'Note', { text: { kind: 'text', required: true } });
    const getTypeSpy = vi.spyOn(adapter, 'getType');

    await stack.create(NOTE_V2, { text: 'hello' });

    expect(getTypeSpy).not.toHaveBeenCalled();
  });

  test('update() reuses the type cached by an earlier create() — no getType() round trip', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    const getTypeSpy = vi.spyOn(adapter, 'getType');

    await stack.update(record.id, { text: 'updated' });

    expect(getTypeSpy).not.toHaveBeenCalled();
  });
});

// -------------------------------------------------------
// content filter null semantics — MemoryAdapter's own
// implementation, mirroring the SQL adapters' shared buildWhereClause fix.
// -------------------------------------------------------

describe('query — content filter null semantics', () => {
  test('a null content filter matches records where the field is absent', async () => {
    await stack.create(NOTE_V1, { text: 'no priority set' });
    await stack.create(NOTE_V1, { text: 'has one', priority: 1 });
    const result = await stack.query({ filter: { content: { priority: null } } });
    expect(result.records).toHaveLength(1);
    expect(result.records[0].content.text).toBe('no priority set');
  });

  test('a null content filter matches records where the field is stored as null', async () => {
    await stack.create(NOTE_V1, { text: 'explicit null', priority: null });
    await stack.create(NOTE_V1, { text: 'has one', priority: 1 });
    const result = await stack.query({ filter: { content: { priority: null } } });
    expect(result.records).toHaveLength(1);
    expect(result.records[0].content.text).toBe('explicit null');
  });
});

// -------------------------------------------------------
// query() fails loud rather than silently widening: a filter
// Stack can't honor against this adapter's declared capabilities must
// throw before dispatching, not quietly return the unfiltered superset.
// -------------------------------------------------------

describe('query — capability fail-loud', () => {
  test('filter.search against an adapter without fullTextSearch throws, not returns everything', async () => {
    await stack.create(NOTE_V1, { text: 'findable' });
    await expect(stack.query({ filter: { search: 'findable' } })).rejects.toThrow(StackQueryError);
  });

  test('filter.content against an adapter without contentFieldQuery throws, not returns everything', async () => {
    const incapableStack = await Stack.create(
      new IncapableMemoryAdapter({ ownerEntityId: 'owner-123', timezone: 'UTC' }),
    );
    await incapableStack.defineType(NOTE_V1, 'Note', { text: { kind: 'text', required: true } });
    await incapableStack.create(NOTE_V1, { text: 'has priority', priority: 1 });

    await expect(incapableStack.query({ filter: { content: { priority: 1 } } })).rejects.toThrow(
      StackQueryError,
    );
  });

  test('a query with neither filter still works against an incapable adapter', async () => {
    const incapableStack = await Stack.create(
      new IncapableMemoryAdapter({ ownerEntityId: 'owner-123', timezone: 'UTC' }),
    );
    await incapableStack.defineType(NOTE_V1, 'Note', { text: { kind: 'text', required: true } });
    await incapableStack.create(NOTE_V1, { text: 'plain' });

    const result = await incapableStack.query({ filter: { typeId: NOTE_V1 } });
    expect(result.records).toHaveLength(1);
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

  test("an orphan snapshot at a record's current version does not block migrateAll from healing it", async () => {
    const record = await stack.create(NOTE_V1, { text: 'original' }); // v1
    // Simulate a migrateAll() interrupted between its snapshot and its
    // commitMigration() call, leaving an orphan row at v1.
    await adapter.saveVersion(record.id, {
      version: 1,
      typeId: NOTE_V1,
      content: { text: 'original' },
      updatedAt: record.updatedAt,
    });

    const result = await stack.migrateAll('com.example.test/note');
    expect(result.migrated).toBe(1);
    expect((await adapter.getRecord(record.id))?.typeId).toBe(NOTE_V2);
  });

  // migrateAll() and commitMigration() share one checked write path: a
  // migration function is app code, but so is the app calling
  // commitMigration(), and neither is entitled to move a DID binding or
  // slip a reserved key past validation.
  test('aborts when a migration function would move a DID binding', async () => {
    await stack.defineType(
      '_entity@2',
      'Entity',
      {
        did: { kind: 'string', required: true },
        name: { kind: 'string', required: true },
      },
      { migratesFrom: '_entity@1' },
    );
    stack.registerMigration({
      from: '_entity@1',
      to: '_entity@2',
      migrate: (content) => ({ ...content, did: 'did:key:zHijacked' }),
    });
    const card = await stack.create('_entity@1', { did: 'did:key:zAlice', name: 'Alice' });

    await expect(stack.migrateAll('_entity')).rejects.toThrow(StackValidationError);
    expect((await adapter.getRecord(card.id))?.content).toEqual({
      did: 'did:key:zAlice',
      name: 'Alice',
    });
  });

  test('aborts when a migration function emits a reserved content key', async () => {
    await stack.defineType(
      NOTE_V3,
      'Note',
      { text: { kind: 'text', required: true }, title: { kind: 'string' } },
      { migratesFrom: NOTE_V2 },
    );
    stack.registerMigration({
      from: NOTE_V2,
      to: NOTE_V3,
      migrate: (content) => ({ ...content, ['__proto__']: 'polluted' }),
    });
    await stack.create(NOTE_V2, { text: 'hi', title: '' });

    await expect(stack.migrateAll('com.example.test/note')).rejects.toThrow(StackValidationError);
  });

  test('still carries an unchanged DID binding through a migration', async () => {
    await stack.defineType(
      '_entity@2',
      'Entity',
      {
        did: { kind: 'string', required: true },
        name: { kind: 'string', required: true },
        pronouns: { kind: 'string' },
      },
      { migratesFrom: '_entity@1' },
    );
    stack.registerMigration({
      from: '_entity@1',
      to: '_entity@2',
      migrate: (content) => ({ ...content, pronouns: 'they/them' }),
    });
    const card = await stack.create('_entity@1', { did: 'did:key:zAlice', name: 'Alice' });

    const result = await stack.migrateAll('_entity');
    expect(result.migrated).toBe(1);
    expect((await adapter.getRecord(card.id))?.typeId).toBe('_entity@2');
  });
});

// -------------------------------------------------------
// Stack.commitMigration
// -------------------------------------------------------

describe('Stack.commitMigration', () => {
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

  test('changes typeId and content together, bumping version', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });

    const migrated = await stack.commitMigration(record.id, NOTE_V2, {
      text: 'hello',
      title: 'pinned',
    });

    expect(migrated.typeId).toBe(NOTE_V2);
    expect(migrated.content).toEqual({ text: 'hello', title: 'pinned' });
    expect(migrated.version).toBe(2);
    expect((await adapter.getRecord(record.id))?.typeId).toBe(NOTE_V2);
  });

  test('snapshots the pre-migration typeId and content to version history', async () => {
    const record = await stack.create(NOTE_V1, { text: 'original' });
    await stack.commitMigration(record.id, NOTE_V2, { text: 'original', title: '' });

    const versions = await stack.getVersions(record.id);
    expect(versions.length).toBe(1);
    expect(versions[0].typeId).toBe(NOTE_V1);
    expect(versions[0].content).toEqual({ text: 'original' });
  });

  test('validates content against toTypeId’s schema', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });

    await expect(
      stack.commitMigration(record.id, NOTE_V2, { title: 'missing text' }),
    ).rejects.toThrow(StackValidationError);
    expect((await adapter.getRecord(record.id))?.typeId).toBe(NOTE_V1); // never committed
  });

  test('throws for an unregistered toTypeId', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });

    await expect(
      stack.commitMigration(record.id, 'com.example.test/note@99', { text: 'hello' }),
    ).rejects.toThrow('Unknown type');
  });

  test('throws StackNotFoundError for a missing record', async () => {
    await expect(
      stack.commitMigration(generateId(), NOTE_V2, { text: 'hello', title: '' }),
    ).rejects.toThrow(StackNotFoundError);
  });
});

// -------------------------------------------------------
// Stack.commitMigration — integrity checks
//
// Migrate writes a full content replacement under a new typeId, so it is
// create-shaped at the destination and update-shaped over the record as it
// stands. These cover the checks it owes on both counts — without them,
// migrate is a second write path to state create()/update() refuse.
// -------------------------------------------------------

describe('Stack.commitMigration — binding fields', () => {
  test('refuses moving an _entity card onto another did', async () => {
    const card = await stack.create('_entity@1', { did: 'did:key:zAlice', name: 'Alice' });

    await expect(
      stack.commitMigration(card.id, '_entity@1', { did: 'did:key:zBob', name: 'Alice' }),
    ).rejects.toThrow(StackValidationError);
    expect((await adapter.getRecord(card.id))?.content).toEqual({
      did: 'did:key:zAlice',
      name: 'Alice',
    });
  });

  test('refuses shedding a did by migrating out of the family', async () => {
    const card = await stack.create('_entity@1', { did: 'did:key:zAlice', name: 'Alice' });

    await expect(stack.commitMigration(card.id, NOTE_V1, { text: 'shed' })).rejects.toThrow(
      StackValidationError,
    );
  });

  test('refuses a did another _entity card already claims', async () => {
    await stack.create('_entity@1', { did: 'did:key:zAlice', name: 'Alice' });
    const bare = await stack.create('_entity@1', { did: '', name: 'Unbound' });

    await expect(
      stack.commitMigration(bare.id, '_entity@1', { did: 'did:key:zAlice', name: 'Unbound' }),
    ).rejects.toThrow(StackConflictError);
  });

  test('allows a migration that carries the same did through', async () => {
    await stack.defineType('_entity@2', 'Entity', {
      did: { kind: 'string', required: true },
      name: { kind: 'string', required: true },
      pronouns: { kind: 'string' },
    });
    const card = await stack.create('_entity@1', { did: 'did:key:zAlice', name: 'Alice' });

    const migrated = await stack.commitMigration(card.id, '_entity@2', {
      did: 'did:key:zAlice',
      name: 'Alice',
      pronouns: 'they/them',
    });
    expect(migrated.typeId).toBe('_entity@2');
  });
});

describe('Stack.commitMigration — _attachment protections', () => {
  test('refuses repointing fileId', async () => {
    const a = await stack.putAttachment(new Uint8Array([9]), 'text/plain', 'a.txt');

    await expect(
      stack.commitMigration(a.id, '_attachment@1', {
        fileId: 'other-hash',
        mimeType: 'text/plain',
        size: 1,
      }),
    ).rejects.toThrow(StackValidationError);
    expect((await adapter.getRecord(a.id))?.content).toEqual(a.content);
  });

  test('refuses rewriting mimeType and size', async () => {
    const a = await stack.putAttachment(new Uint8Array([9]), 'text/plain', 'a.txt');

    await expect(
      stack.commitMigration(a.id, '_attachment@1', {
        fileId: a.content.fileId,
        mimeType: 'image/png',
        size: 999,
      }),
    ).rejects.toThrow(StackValidationError);
  });

  test('allows a migration that carries the immutable fields through', async () => {
    await stack.defineType('_attachment@2', 'Attachment', {
      fileId: { kind: 'string', required: true },
      mimeType: { kind: 'string', required: true },
      size: { kind: 'number', required: true },
      filename: { kind: 'string' },
      caption: { kind: 'string' },
    });
    const a = await stack.putAttachment(new Uint8Array([9]), 'text/plain', 'a.txt');

    const migrated = await stack.commitMigration(a.id, '_attachment@2', {
      fileId: a.content.fileId,
      mimeType: 'text/plain',
      size: 1,
      caption: 'hi',
    });
    expect(migrated.typeId).toBe('_attachment@2');
  });

  test('applies the mimeType-establishment check when arriving from outside the family', async () => {
    const a = await stack.putAttachment(new Uint8Array([9]), 'text/plain', 'a.txt');
    const note = await stack.create(NOTE_V1, { text: 'decoy' });

    await expect(
      stack.commitMigration(note.id, '_attachment@1', {
        fileId: a.content.fileId,
        mimeType: 'image/png',
        size: 1,
      }),
    ).rejects.toThrow(StackValidationError);
  });
});

describe('Stack.commitMigration — _group', () => {
  test('refuses migrating a record into _group, whose admin roster is stamped at creation', async () => {
    const note = await stack.create(NOTE_V1, { text: 'x' });

    await expect(
      stack.commitMigration(note.id, '_group@1', { name: 'Ghost Group' }),
    ).rejects.toThrow(StackConflictError);
  });

  test('allows a _group record to migrate between versions, keeping its roster', async () => {
    await stack.defineType('_group@2', 'Group', {
      name: { kind: 'string', required: true },
      handle: { kind: 'string' },
      stackUrl: { kind: 'string' },
      topic: { kind: 'string' },
    });
    const group = await stack.create('_group@1', { name: 'Real Group' });

    const migrated = await stack.commitMigration(group.id, '_group@2', {
      name: 'Real Group',
      topic: 'books',
    });
    expect(migrated.typeId).toBe('_group@2');
    expect(migrated.associations).toEqual(group.associations);
  });
});

// -------------------------------------------------------
// restoreVersion — typeId and validation
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

  test('restoreVersion removes an association that did not exist at the target version, even though the target had none at all', async () => {
    const record = await stack.create(NOTE_V1, { text: 'original' }); // v1, no associations
    await stack.associate(record.id, { kind: 'tag', label: 'favourite' }); // v2, snapshots v1
    const restored = await stack.restoreVersion(record.id, 1); // v3
    expect(restored.content).toEqual({ text: 'original' });
    expect(restored.associations).toBeUndefined();

    const raw = await adapter.getRecord(record.id);
    expect(raw?.associations).toBeUndefined();
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
// ifVersion (opt-in optimistic concurrency)
// -------------------------------------------------------

describe('ifVersion', () => {
  test('update() applies when ifVersion matches, and bumps as normal', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' }); // v1
    const updated = await stack.update(record.id, { text: 'v2' }, { ifVersion: 1 });
    expect(updated.version).toBe(2);
    expect(updated.content.text).toBe('v2');
  });

  test('update() throws StackVersionConflictError when ifVersion is stale, and changes nothing', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' }); // v1
    await stack.update(record.id, { text: 'v2' }); // v2, no ifVersion — moves the record on

    const err = await stack
      .update(record.id, { text: 'v3' }, { ifVersion: 1 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StackVersionConflictError);
    expect((err as StackVersionConflictError).recordId).toBe(record.id);
    expect((err as StackVersionConflictError).expectedVersion).toBe(1);
    expect((err as StackVersionConflictError).actualVersion).toBe(2);

    const current = await stack.get(record.id);
    expect(current?.version).toBe(2);
    expect(current?.content.text).toBe('v2');
  });

  test('omitting ifVersion keeps last-writer-wins behavior', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' }); // v1
    await stack.update(record.id, { text: 'from A' }); // v2
    const updated = await stack.update(record.id, { text: 'from B' }); // v3, no precondition
    expect(updated.version).toBe(3);
    expect(updated.content.text).toBe('from B');
  });

  test('associate()/dissociate()/setPermissions() enforce ifVersion', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' }); // v1
    await stack.update(record.id, { text: 'v2' }); // v2

    await expect(
      stack.associate(record.id, { kind: 'tag', label: 'x' }, { ifVersion: 1 }),
    ).rejects.toThrow(StackVersionConflictError);
    await expect(
      stack.setPermissions(record.id, [{ access: 'public' }], { ifVersion: 1 }),
    ).rejects.toThrow(StackVersionConflictError);

    await stack.associate(record.id, { kind: 'tag', label: 'x' }, { ifVersion: 2 }); // v3
    await expect(
      stack.dissociate(record.id, { kind: 'tag', label: 'x' }, { ifVersion: 2 }),
    ).rejects.toThrow(StackVersionConflictError);
    await stack.dissociate(record.id, { kind: 'tag', label: 'x' }, { ifVersion: 3 }); // v4

    expect((await stack.get(record.id))?.version).toBe(4);
  });

  test('delete() (soft) and undelete() enforce ifVersion', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' }); // v1
    await stack.update(record.id, { text: 'v2' }); // v2

    await expect(stack.delete(record.id, { ifVersion: 1 })).rejects.toThrow(
      StackVersionConflictError,
    );
    await stack.delete(record.id, { ifVersion: 2 }); // v3, soft-deleted

    await expect(stack.undelete(record.id, { ifVersion: 1 })).rejects.toThrow(
      StackVersionConflictError,
    );
    const undeleted = await stack.undelete(record.id, { ifVersion: 3 }); // v4
    expect(undeleted.version).toBe(4);
    expect(undeleted.deletedAt).toBeUndefined();
  });

  test('delete() (hard) enforces ifVersion atomically at the adapter', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' }); // v1
    await stack.update(record.id, { text: 'v2' }); // v2

    await expect(stack.delete(record.id, { hard: true, ifVersion: 1 })).rejects.toThrow(
      StackVersionConflictError,
    );
    // A rejected hard delete must leave the record fully intact.
    expect(await stack.get(record.id)).not.toBeNull();

    await stack.delete(record.id, { hard: true, ifVersion: 2 });
    expect(await stack.get(record.id)).toBeNull();
  });

  test('restoreVersion() enforces ifVersion', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' }); // v1
    await stack.update(record.id, { text: 'v2' }); // v2
    await stack.update(record.id, { text: 'v3' }); // v3

    await expect(stack.restoreVersion(record.id, 1, { ifVersion: 1 })).rejects.toThrow(
      StackVersionConflictError,
    );
    const restored = await stack.restoreVersion(record.id, 1, { ifVersion: 3 }); // v4
    expect(restored.version).toBe(4);
    expect(restored.content.text).toBe('hello');
  });

  test('commitMigration() enforces ifVersion', async () => {
    await stack.defineType(
      NOTE_V2,
      'Note',
      { text: { kind: 'text', required: true }, title: { kind: 'string' } },
      { migratesFrom: NOTE_V1 },
    );
    const record = await stack.create(NOTE_V1, { text: 'hello' }); // v1
    await stack.update(record.id, { text: 'v2' }); // v2

    await expect(
      stack.commitMigration(record.id, NOTE_V2, { text: 'v2', title: '' }, { ifVersion: 1 }),
    ).rejects.toThrow(StackVersionConflictError);
    // A rejected migration must leave the record at its current type.
    expect((await adapter.getRecord(record.id))?.typeId).toBe(NOTE_V1);

    const migrated = await stack.commitMigration(
      record.id,
      NOTE_V2,
      { text: 'v2', title: 'ok' },
      { ifVersion: 2 },
    ); // v3
    expect(migrated.version).toBe(3);
    expect(migrated.typeId).toBe(NOTE_V2);
  });

  test('ifVersion on a nonexistent record throws StackNotFoundError, not StackVersionConflictError', async () => {
    await expect(stack.update('nonexistent', { text: 'x' }, { ifVersion: 1 })).rejects.toThrow(
      StackNotFoundError,
    );
    await expect(
      stack.commitMigration('nonexistent', NOTE_V1, { text: 'x' }, { ifVersion: 1 }),
    ).rejects.toThrow(StackNotFoundError);
  });
});

// -------------------------------------------------------
// Orphan version row recovery
// -------------------------------------------------------

describe('orphan version row recovery', () => {
  test("a pre-existing orphan snapshot at the record's current version does not permanently block update()", async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' }); // v1
    // Simulate an interrupted write: the v1 snapshot committed, but the
    // mutation that should have bumped past it never did — an orphan row
    // sitting at the record's own current version.
    await adapter.saveVersion(record.id, {
      version: 1,
      typeId: NOTE_V1,
      content: { text: 'hello' },
      updatedAt: record.updatedAt,
    });

    const updated = await stack.update(record.id, { text: 'v2' });
    expect(updated.version).toBe(2);
    expect(updated.content.text).toBe('v2');

    // The orphan is healed (overwritten), not duplicated.
    const versions = await stack.getVersions(record.id);
    expect(versions).toHaveLength(1);
    expect(versions[0].version).toBe(1);
  });

  test('an orphan does not block associate()/dissociate()/setPermissions()/delete()/undelete()/restoreVersion()', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' }); // v1
    await stack.update(record.id, { text: 'v2' }); // v2, snapshots v1

    await adapter.saveVersion(record.id, {
      version: 2,
      typeId: NOTE_V1,
      content: { text: 'v2' },
      updatedAt: new Date(),
    }); // orphan sitting at the record's current version (2)

    await stack.associate(record.id, { kind: 'tag', label: 'x' }); // v3
    expect((await stack.get(record.id))?.version).toBe(3);
  });

  test('genuinely concurrent last-writer-wins updates: the loser is still rejected with no partial apply', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' }); // v1
    const staleRead = await stack.get(record.id);

    // Writer A completes first, moving the record to v2.
    await stack.update(record.id, { text: 'from A' });

    // Writer B built its mutation from the same stale v1 read and tries to
    // snapshot v1 again — but the record has since moved to v2, so this is
    // a genuine conflict (not a recoverable orphan: the row it collides
    // with is v1's real, already-superseded history entry) and must be
    // rejected before any part of B's mutation applies.
    await expect(
      adapter.patchContent(
        record.id,
        { text: 'from B' },
        {
          snapshot: {
            version: 1,
            typeId: NOTE_V1,
            content: { text: 'hello' },
            updatedAt: staleRead!.updatedAt,
          },
        },
      ),
    ).rejects.toThrow(StackConflictError);

    const current = await stack.get(record.id);
    expect(current?.content.text).toBe('from A');
    expect(current?.version).toBe(2);
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

  test('a hard delete of a record that is not there is silent', async () => {
    await expect(
      stack.delete('01hzzzzzzzzzzzzzzzzzzzzzzz', { hard: true }),
    ).resolves.toBeUndefined();
  });

  test('a hard delete under a precondition reports a record that is not there', async () => {
    // The precondition cannot be satisfied by a record that does not
    // exist, so the call reports that rather than succeeding vacuously.
    await expect(
      stack.delete('01hzzzzzzzzzzzzzzzzzzzzzzz', { hard: true, ifVersion: 1 }),
    ).rejects.toThrow(StackNotFoundError);
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
// _config protections
// -------------------------------------------------------

describe('_config protections', () => {
  const CONFIG_ID = '_config';
  const CONFIG_TYPE = '_config@1';

  // MemoryAdapter never materializes a _config record on its own (ownerEntityId
  // is a plain constructor field) — the guards under test operate on whatever
  // record exists at id "_config", so tests seed one directly.
  async function seedConfig(entityId = 'owner-123', timezone = 'UTC') {
    return adapter.createRecord({
      id: CONFIG_ID,
      typeId: CONFIG_TYPE,
      createdAt: new Date(),
      updatedAt: new Date(),
      content: { entityId, timezone },
      version: 1,
    });
  }

  test('update() rejects a change to entityId', async () => {
    await seedConfig();
    await expect(stack.update(CONFIG_ID, { entityId: 'someone-else' })).rejects.toThrow(
      StackConflictError,
    );
    expect((await adapter.getRecord(CONFIG_ID))?.content.entityId).toBe('owner-123');
  });

  test('update() allows changing timezone', async () => {
    await seedConfig();
    const updated = await stack.update(CONFIG_ID, { timezone: 'America/New_York' });
    expect((updated.content as Record<string, unknown>).timezone).toBe('America/New_York');
  });

  test('setting entityId to its current value is a no-op, not an error', async () => {
    await seedConfig('owner-123');
    await expect(stack.update(CONFIG_ID, { entityId: 'owner-123' })).resolves.toBeDefined();
  });

  test('soft delete is rejected', async () => {
    await seedConfig();
    await expect(stack.delete(CONFIG_ID)).rejects.toThrow(StackConflictError);
    expect(await adapter.getRecord(CONFIG_ID)).not.toBeNull();
  });

  test('hard delete is rejected', async () => {
    await seedConfig();
    await expect(stack.delete(CONFIG_ID, { hard: true })).rejects.toThrow(StackConflictError);
    expect(await adapter.getRecord(CONFIG_ID)).not.toBeNull();
  });

  test('restoreVersion() rejects a snapshot with a different entityId', async () => {
    await seedConfig('owner-123');
    // Simulates a snapshot that predates this guard, or a bypassed
    // direct-adapter write — either way, a stored version whose entityId
    // disagrees with the live record's must not be restorable.
    await adapter.saveVersion(CONFIG_ID, {
      version: 1,
      typeId: CONFIG_TYPE,
      content: { entityId: 'someone-else', timezone: 'UTC' },
      updatedAt: new Date(),
    });
    await expect(stack.restoreVersion(CONFIG_ID, 1)).rejects.toThrow(StackConflictError);
  });

  test('restoreVersion() allows a snapshot with the same entityId', async () => {
    await seedConfig('owner-123', 'UTC');
    await stack.update(CONFIG_ID, { timezone: 'America/New_York' });
    const restored = await stack.restoreVersion(CONFIG_ID, 1);
    expect((restored.content as Record<string, unknown>).timezone).toBe('UTC');
  });

  test('generic query excludes _config', async () => {
    await seedConfig();
    const result = await stack.query({ filter: { typeId: CONFIG_TYPE } });
    expect(result.records).toHaveLength(0);
  });

  test('_config is still addressable directly by ID', async () => {
    await seedConfig();
    expect(await stack.get(CONFIG_ID)).not.toBeNull();
  });

  test('ScopedStack delegation: the owner cannot change entityId via scoped update either', async () => {
    await seedConfig('owner-123');
    await expect(
      stack.asEntity('owner-123').update(CONFIG_ID, { entityId: 'someone-else' }),
    ).rejects.toThrow(StackConflictError);
  });

  test('ScopedStack delegation: the owner cannot delete _config via scoped delete either', async () => {
    await seedConfig('owner-123');
    await expect(stack.asEntity('owner-123').delete(CONFIG_ID)).rejects.toThrow(StackConflictError);
  });

  test('commitMigration() rejects a change to entityId', async () => {
    await seedConfig('owner-123');
    await stack.defineType('_config@2', 'Config', {
      entityId: { kind: 'string', required: true },
      timezone: { kind: 'string' },
    });

    await expect(
      stack.commitMigration(CONFIG_ID, '_config@2', { entityId: 'someone-else' }),
    ).rejects.toThrow(StackConflictError);
    expect((await adapter.getRecord(CONFIG_ID))?.typeId).toBe(CONFIG_TYPE); // never committed
  });

  test('commitMigration() allows the same entityId', async () => {
    await seedConfig('owner-123');
    await stack.defineType('_config@2', 'Config', {
      entityId: { kind: 'string', required: true },
      timezone: { kind: 'string' },
    });

    const migrated = await stack.commitMigration(CONFIG_ID, '_config@2', {
      entityId: 'owner-123',
      timezone: 'America/New_York',
    });
    expect(migrated.typeId).toBe('_config@2');
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

  test('close() flushes before releasing resources', async () => {
    const calls: string[] = [];
    adapter.flush = async () => {
      calls.push('flush');
    };
    adapter.close = async () => {
      calls.push('close');
    };
    await stack.close();
    expect(calls).toEqual(['flush', 'close']);
  });

  test('close() releases resources even when the flush fails, then propagates', async () => {
    let closed = false;
    adapter.flush = async () => {
      throw new Error('disk full');
    };
    adapter.close = async () => {
      closed = true;
    };
    await expect(stack.close()).rejects.toThrow('disk full');
    expect(closed).toBe(true);
  });

  test('close() is idempotent — the adapter is never closed twice', async () => {
    let closes = 0;
    adapter.close = async () => {
      closes += 1;
    };
    await stack.close();
    await stack.close();
    expect(closes).toBe(1);
  });
});

describe('use after close', () => {
  beforeEach(async () => {
    await stack.close();
  });

  test('reads throw StackClosedError', async () => {
    await expect(stack.get('1hk153x0a00b')).rejects.toBeInstanceOf(StackClosedError);
    await expect(stack.query()).rejects.toBeInstanceOf(StackClosedError);
    await expect(stack.listTypes()).rejects.toBeInstanceOf(StackClosedError);
  });

  test('writes throw StackClosedError', async () => {
    await expect(stack.create(NOTE_V1, { text: 'x' })).rejects.toBeInstanceOf(StackClosedError);
    await expect(stack.update('1hk153x0a00b', { text: 'x' })).rejects.toBeInstanceOf(
      StackClosedError,
    );
    await expect(stack.delete('1hk153x0a00b')).rejects.toBeInstanceOf(StackClosedError);
  });

  test('flush() throws, since flushing is work — only close() is idempotent', async () => {
    await expect(stack.flush()).rejects.toBeInstanceOf(StackClosedError);
    await expect(stack.close()).resolves.toBeUndefined();
  });

  test('attachment uploads throw StackClosedError', async () => {
    await expect(stack.putAttachment(new Uint8Array([1]), 'text/plain')).rejects.toBeInstanceOf(
      StackClosedError,
    );
  });

  test('identity getters still read — they touch no storage', () => {
    expect(stack.ownerEntityId).toBe('owner-123');
    expect(stack.features).toBeDefined();
  });

  test('StackClosedError stays outside the wire taxonomy', () => {
    expect(new StackClosedError()).not.toBeInstanceOf(StackError);
  });
});

describe('use after close — scoped views', () => {
  test('a view taken before close writes no attachment bytes after it', async () => {
    const scoped = stack.asEntity('owner-123');
    await stack.close();

    await expect(scoped.putAttachment(new Uint8Array([1]), 'text/plain')).rejects.toBeInstanceOf(
      StackClosedError,
    );
    expect(await adapter.listFiles!()).toHaveLength(0);
  });

  test('asEntity() itself refuses once closed', async () => {
    await stack.close();
    expect(() => stack.asEntity('owner-123')).toThrow(StackClosedError);
  });
});

// -------------------------------------------------------
// grant
// -------------------------------------------------------

describe('grant', () => {
  test('creates a grant record for the given entity and type', async () => {
    const records = await stack.grant('entity-abc', [{ actions: ['create'], typeId: NOTE_V1 }]);
    expect(records).toHaveLength(1);
    // The grantee lives in content, not record.entityId — entityId means
    // "author", and the owner (who called grant()) authored this record.
    expect(records[0].entityId).toBeUndefined();
    expect(records[0].content).toEqual({
      typeId: NOTE_V1,
      actions: ['create'],
      granteeEntityId: 'entity-abc',
    });
  });

  test('null entityId creates a default grant (no granteeEntityId in content)', async () => {
    const records = await stack.grant(null, [{ actions: ['create'], typeId: NOTE_V1 }]);
    expect(records[0].entityId).toBeUndefined();
    expect(records[0].content).toEqual({ typeId: NOTE_V1, actions: ['create'] });
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

  // The grantee lives in content.granteeEntityId, not record.entityId,
  // which means "author" everywhere else — so "everything Alice authored"
  // queries don't pick up grants that merely name her.
  test('an authorship query does not pick up grants naming that entity', async () => {
    await stack.grant('entity-abc', [{ actions: ['create'], typeId: NOTE_V1 }]);
    const result = await stack.query({ filter: { entityId: 'entity-abc' } });
    expect(result.records).toHaveLength(0);
  });

  test('a grant record still resolves through ScopedStack for its named grantee', async () => {
    await stack.grant('entity-abc', [{ actions: ['create'], typeId: NOTE_V1 }]);
    const record = await stack.asEntity('entity-abc').create(NOTE_V1, { text: 'hi' });
    expect(record.content.text).toBe('hi');
  });

  // an unrecognized action string would otherwise be stored
  // silently and simply never match at check time (hasGrant).
  test('rejects an unknown grant action', async () => {
    await expect(
      stack.grant('entity-abc', [{ actions: ['read-all' as never], typeId: NOTE_V1 }]),
    ).rejects.toThrow(StackValidationError);
  });

  test('does not create any records when one grant in a batch has an unknown action', async () => {
    await expect(
      stack.grant('entity-abc', [
        { actions: ['create'], typeId: NOTE_V1 },
        { actions: ['read-all' as never], typeId: NOTE_V1 },
      ]),
    ).rejects.toThrow(StackValidationError);
    const grants = await stack.listGrants();
    expect(grants).toHaveLength(0);
  });

  // typeId must be a well-formed bare baseId or versioned TypeId.
  test('rejects an empty typeId', async () => {
    await expect(stack.grant('entity-abc', [{ actions: ['create'], typeId: '' }])).rejects.toThrow(
      StackValidationError,
    );
  });

  test('rejects a malformed versioned typeId', async () => {
    await expect(
      stack.grant('entity-abc', [{ actions: ['create'], typeId: 'com.example.test/note@abc' }]),
    ).rejects.toThrow(StackValidationError);
  });

  test('accepts a bare baseId (no version suffix)', async () => {
    const records = await stack.grant('entity-abc', [
      { actions: ['create'], typeId: 'com.example.test/note' },
    ]);
    expect(records).toHaveLength(1);
  });

  // grants on _grant/_config/_app are refused outright; other reserved
  // types (_attachment, _entity, _group) stay grantable.
  test('rejects a grant targeting _grant@1', async () => {
    await expect(
      stack.grant('entity-abc', [{ actions: ['create'], typeId: '_grant@1' }]),
    ).rejects.toThrow(StackValidationError);
  });

  test('rejects a grant targeting _config@1', async () => {
    await expect(
      stack.grant('entity-abc', [{ actions: ['update-any'], typeId: '_config@1' }]),
    ).rejects.toThrow(StackValidationError);
  });

  // The _app registry is what resolves a principalId to a name, so only
  // the owner writes cards to it.
  test('rejects a grant targeting _app@1', async () => {
    await expect(
      stack.grant('entity-abc', [{ actions: ['create'], typeId: '_app@1' }]),
    ).rejects.toThrow(StackValidationError);
  });

  test('rejects a default (any-authenticated) grant targeting _grant@1', async () => {
    await expect(stack.grant(null, [{ actions: ['create'], typeId: '_grant@1' }])).rejects.toThrow(
      StackValidationError,
    );
  });

  test('still allows a grant targeting _attachment@1', async () => {
    const records = await stack.grant('entity-abc', [
      { actions: ['create'], typeId: '_attachment@1' },
    ]);
    expect(records).toHaveLength(1);
  });

  test('creates a group-targeted grant record', async () => {
    const records = await stack.grant({ groupId: 'group-abc' }, [
      { actions: ['read-any'], typeId: NOTE_V1 },
    ]);
    expect(records).toHaveLength(1);
    expect(records[0].content).toEqual({
      typeId: NOTE_V1,
      actions: ['read-any'],
      granteeGroupId: 'group-abc',
    });
  });

  test('rejects a group-targeted grant on _grant@1', async () => {
    await expect(
      stack.grant({ groupId: 'group-abc' }, [{ actions: ['create'], typeId: '_grant@1' }]),
    ).rejects.toThrow(StackValidationError);
  });

  // An empty or absent target names nobody, and both are falsy — a grantee
  // test written against truthiness would read the stored record as a
  // default grant and hand the type to every authenticated entity. null is
  // the only way to say "default".
  test('rejects a group target with an empty groupId', async () => {
    await expect(
      stack.grant({ groupId: '' }, [{ actions: ['read-any'], typeId: NOTE_V1 }]),
    ).rejects.toThrow(StackQueryError);
    expect(await stack.listGrants()).toHaveLength(0);
  });

  test('rejects a group target with a missing groupId', async () => {
    await expect(
      stack.grant({ groupId: undefined as unknown as string }, [
        { actions: ['read-any'], typeId: NOTE_V1 },
      ]),
    ).rejects.toThrow(StackQueryError);
    expect(await stack.listGrants()).toHaveLength(0);
  });

  test('rejects an empty entityId target', async () => {
    await expect(stack.grant('', [{ actions: ['read-any'], typeId: NOTE_V1 }])).rejects.toThrow(
      StackQueryError,
    );
    expect(await stack.listGrants()).toHaveLength(0);
  });
});

// -------------------------------------------------------
// listGrants
// -------------------------------------------------------

describe('listGrants', () => {
  test('omitting entityId returns every grant record', async () => {
    await stack.grant('entity-abc', [{ actions: ['create'], typeId: NOTE_V1 }]);
    await stack.grant(null, [{ actions: ['read-any'], typeId: NOTE_V1 }]);
    const grants = await stack.listGrants();
    expect(grants).toHaveLength(2);
  });

  test('entityId: null returns only default grants', async () => {
    await stack.grant('entity-abc', [{ actions: ['create'], typeId: NOTE_V1 }]);
    await stack.grant(null, [{ actions: ['read-any'], typeId: NOTE_V1 }]);
    const grants = await stack.listGrants(null);
    expect(grants).toHaveLength(1);
    expect(grants[0].content).toMatchObject({ actions: ['read-any'] });
  });

  test('a specific entityId returns grants naming it plus every default grant', async () => {
    await stack.grant('entity-abc', [{ actions: ['create'], typeId: NOTE_V1 }]);
    await stack.grant('entity-xyz', [{ actions: ['delete-own'], typeId: NOTE_V1 }]);
    await stack.grant(null, [{ actions: ['read-any'], typeId: NOTE_V1 }]);

    const grants = await stack.listGrants('entity-abc');
    expect(grants).toHaveLength(2);
    const actionSets = grants.map((g) => (g.content as { actions: string[] }).actions);
    expect(actionSets).toContainEqual(['create']);
    expect(actionSets).toContainEqual(['read-any']);
  });

  test('a groupId target returns grants naming that exact group', async () => {
    await stack.grant({ groupId: 'group-abc' }, [{ actions: ['create'], typeId: NOTE_V1 }]);
    await stack.grant({ groupId: 'group-xyz' }, [{ actions: ['read-any'], typeId: NOTE_V1 }]);
    await stack.grant('entity-abc', [{ actions: ['update-own'], typeId: NOTE_V1 }]);

    const grants = await stack.listGrants({ groupId: 'group-abc' });
    expect(grants).toHaveLength(1);
    expect(grants[0].content).toMatchObject({ actions: ['create'] });
  });

  test('an entityId target also returns grants naming a group the entity belongs to', async () => {
    const group = await stack.create('_group@1', { name: 'Editors' });
    await stack.associate(group.id, {
      kind: 'relationship',
      label: 'member',
      recordId: 'entity-abc',
    });
    await stack.grant({ groupId: group.id }, [{ actions: ['read-any'], typeId: NOTE_V1 }]);
    await stack.grant('entity-xyz', [{ actions: ['delete-own'], typeId: NOTE_V1 }]);

    const grants = await stack.listGrants('entity-abc');
    expect(grants).toHaveLength(1);
    expect(grants[0].content).toMatchObject({ actions: ['read-any'] });
  });

  // listGrants() documents itself as using the same resolution the access
  // checks use, so it shares grantCoversGrantee() with them. A listing that
  // claimed a grant applied where an access check denied it would be worse
  // than no listing at all.
  test('a grant naming a record outside the _group family is not reported as applying', async () => {
    const notAGroup = await stack.create(NOTE_V1, { text: 'not a group' });
    await stack.associate(notAGroup.id, {
      kind: 'relationship',
      label: 'member',
      recordId: 'entity-abc',
    });
    await stack.grant({ groupId: notAGroup.id }, [{ actions: ['read-any'], typeId: NOTE_V1 }]);

    expect(await stack.listGrants('entity-abc')).toHaveLength(0);
  });

  test('a group target naming no group is refused rather than over-reporting', async () => {
    await stack.grant('entity-abc', [{ actions: ['create'], typeId: NOTE_V1 }]);
    await expect(stack.listGrants({ groupId: '' })).rejects.toThrow(StackQueryError);
  });

  test('an entityId target does not return a group grant for a group the entity does not belong to', async () => {
    const group = await stack.create('_group@1', { name: 'Editors' });
    await stack.associate(group.id, {
      kind: 'relationship',
      label: 'member',
      recordId: 'entity-xyz',
    });
    await stack.grant({ groupId: group.id }, [{ actions: ['read-any'], typeId: NOTE_V1 }]);

    expect(await stack.listGrants('entity-abc')).toHaveLength(0);
  });
});

// -------------------------------------------------------
// revoke
// -------------------------------------------------------

describe('revoke', () => {
  test('deletes the grant record matching entityId, typeId, and actions', async () => {
    await stack.grant('entity-abc', [{ actions: ['create'], typeId: NOTE_V1 }]);
    await stack.revoke('entity-abc', [{ actions: ['create'], typeId: NOTE_V1 }]);
    const grants = await stack.listGrants('entity-abc');
    expect(grants).toHaveLength(0);
  });

  test('revocation is a soft delete — the owner can undelete it like any other mutation', async () => {
    const [granted] = await stack.grant('entity-abc', [{ actions: ['create'], typeId: NOTE_V1 }]);
    await stack.revoke('entity-abc', [{ actions: ['create'], typeId: NOTE_V1 }]);
    expect(await stack.listGrants('entity-abc')).toHaveLength(0);

    await stack.undelete(granted.id);
    expect(await stack.listGrants('entity-abc')).toHaveLength(1);
  });

  test('does not affect a grant for a different entity or a default grant', async () => {
    await stack.grant('entity-abc', [{ actions: ['create'], typeId: NOTE_V1 }]);
    await stack.grant(null, [{ actions: ['create'], typeId: NOTE_V1 }]);
    await stack.revoke('entity-xyz', [{ actions: ['create'], typeId: NOTE_V1 }]);
    expect(await stack.listGrants()).toHaveLength(2);
  });

  test('does not affect a grant for the same entity with a different action set', async () => {
    await stack.grant('entity-abc', [{ actions: ['create', 'read-own'], typeId: NOTE_V1 }]);
    await stack.revoke('entity-abc', [{ actions: ['create'], typeId: NOTE_V1 }]);
    expect(await stack.listGrants('entity-abc')).toHaveLength(1);
  });

  test('matches by baseId, covering every version of the type family', async () => {
    await stack.defineType(NOTE_V2, 'Note v2', {
      text: { kind: 'text', required: true },
      title: { kind: 'string' },
    });
    await stack.grant('entity-abc', [{ actions: ['create'], typeId: NOTE_V1 }]);
    await stack.revoke('entity-abc', [{ actions: ['create'], typeId: NOTE_V2 }]);
    expect(await stack.listGrants('entity-abc')).toHaveLength(0);
  });

  test('null entityId revokes a default grant', async () => {
    await stack.grant(null, [{ actions: ['create'], typeId: NOTE_V1 }]);
    await stack.revoke(null, [{ actions: ['create'], typeId: NOTE_V1 }]);
    expect(await stack.listGrants(null)).toHaveLength(0);
  });

  test('a groupId target revokes the grant matching that exact group', async () => {
    await stack.grant({ groupId: 'group-abc' }, [{ actions: ['create'], typeId: NOTE_V1 }]);
    await stack.revoke({ groupId: 'group-abc' }, [{ actions: ['create'], typeId: NOTE_V1 }]);
    expect(await stack.listGrants({ groupId: 'group-abc' })).toHaveLength(0);
  });

  test('a groupId target does not affect a grant for a different group or an entity', async () => {
    await stack.grant({ groupId: 'group-abc' }, [{ actions: ['create'], typeId: NOTE_V1 }]);
    await stack.grant({ groupId: 'group-xyz' }, [{ actions: ['create'], typeId: NOTE_V1 }]);
    await stack.grant('entity-abc', [{ actions: ['create'], typeId: NOTE_V1 }]);
    await stack.revoke({ groupId: 'group-abc' }, [{ actions: ['create'], typeId: NOTE_V1 }]);
    expect(await stack.listGrants()).toHaveLength(2);
  });

  // A target naming no group must not match the absent granteeGroupId on
  // every entity-targeted and default grant, which is what an unguarded
  // `undefined === undefined` comparison would do.
  test('a group target naming no group is refused, leaving other grants standing', async () => {
    await stack.grant('entity-abc', [{ actions: ['create'], typeId: NOTE_V1 }]);
    await stack.grant(null, [{ actions: ['create'], typeId: NOTE_V1 }]);

    await expect(
      stack.revoke({ groupId: undefined as unknown as string }, [
        { actions: ['create'], typeId: NOTE_V1 },
      ]),
    ).rejects.toThrow(StackQueryError);
    expect(await stack.listGrants()).toHaveLength(2);
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
    // Dissociating the only association leaves the key omitted entirely
    // (associations: undefined), mirroring the SQL adapters' rowToRecord
    // rather than a bare `[]` — matching the SQL adapters' rowToRecord.
    expect(updated?.associations).toBeUndefined();
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

  test('adding role: "admin" to a group entry persists and bumps version', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.setPermissions(record.id, [
      { access: 'group', groupId: 'group-1', read: true, write: true },
    ]); // v2
    await stack.setPermissions(record.id, [
      { access: 'group', groupId: 'group-1', role: 'admin', read: true, write: true },
    ]); // v3
    const updated = await adapter.getRecord(record.id);
    expect(updated?.version).toBe(3);
    expect(updated?.permissions).toEqual([
      { access: 'group', groupId: 'group-1', role: 'admin', read: true, write: true },
    ]);
  });

  test('removing role: "admin" from a group entry persists and bumps version', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.setPermissions(record.id, [
      { access: 'group', groupId: 'group-1', role: 'admin', read: true, write: true },
    ]); // v2
    await stack.setPermissions(record.id, [
      { access: 'group', groupId: 'group-1', read: true, write: true },
    ]); // v3
    const updated = await adapter.getRecord(record.id);
    expect(updated?.version).toBe(3);
    expect(updated?.permissions).toEqual([
      { access: 'group', groupId: 'group-1', read: true, write: true },
    ]);
  });

  test('a genuinely-identical group entry (matching role) still no-ops', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hello' });
    await stack.setPermissions(record.id, [
      { access: 'group', groupId: 'group-1', role: 'admin', read: true, write: true },
    ]); // v2
    await stack.setPermissions(record.id, [
      { access: 'group', groupId: 'group-1', role: 'admin', read: true, write: true },
    ]);
    const updated = await adapter.getRecord(record.id);
    expect(updated?.version).toBe(2);
    expect(await stack.getVersions(record.id)).toHaveLength(1);
  });
});

// -------------------------------------------------------
// putAttachment
// -------------------------------------------------------

describe('putAttachment', () => {
  test('stores bytes and returns fileId', async () => {
    const data = new Uint8Array([1, 2, 3]);
    const {
      content: { fileId },
    } = await stack.putAttachment(data, 'image/png');
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
// Reserved content keys: __proto__/constructor/prototype name object
// machinery, not fields. Rejected on both write paths so the two agree —
// a merge patch to one of them would otherwise vanish silently while the
// same key through create() stored as an ordinary property.
// -------------------------------------------------------

describe('reserved content keys', () => {
  const withKey = (key: string, value: unknown): Record<string, unknown> =>
    JSON.parse(`{"text": "hi", "${key}": ${JSON.stringify(value)}}`) as Record<string, unknown>;

  test.each(['__proto__', 'constructor', 'prototype'])(
    'create() rejects a top-level %s content key',
    async (key) => {
      await expect(stack.create(NOTE_V1, withKey(key, 'x'))).rejects.toThrow(StackValidationError);
    },
  );

  test.each(['__proto__', 'constructor', 'prototype'])(
    'update() rejects a %s patch key',
    async (key) => {
      const record = await stack.create(NOTE_V1, { text: 'hi' });

      await expect(stack.update(record.id, withKey(key, 'x'))).rejects.toThrow(
        StackValidationError,
      );
      // Rejected outright, so the rest of the patch doesn't land either.
      expect((await stack.get(record.id))?.content).toEqual({ text: 'hi' });
    },
  );

  test.each(['__proto__', 'constructor', 'prototype'])(
    'commitMigration() rejects a %s content key',
    async (key) => {
      const record = await stack.create(NOTE_V1, { text: 'hi' });

      await expect(stack.commitMigration(record.id, NOTE_V1, withKey(key, 'x'))).rejects.toThrow(
        StackValidationError,
      );
    },
  );

  test('ordinary undeclared fields still pass — permitted by design', async () => {
    const record = await stack.create(NOTE_V1, { text: 'hi', extra: 'kept' });

    expect(record.content).toEqual({ text: 'hi', extra: 'kept' });
  });

  test('a nested __proto__ is left alone — it round-trips as an inert own property', async () => {
    const content = JSON.parse('{"text": "hi", "meta": {"__proto__": {"x": 1}}}') as Record<
      string,
      unknown
    >;

    await expect(stack.create(NOTE_V1, content)).resolves.toBeDefined();
  });
});

// -------------------------------------------------------
// maxContentBytes pre-check: the content half of the attachment
// ceiling below. Local adapters declare null; a server declares its
// request-size limit so apps can fail before the round trip.
// -------------------------------------------------------

describe('maxContentBytes pre-check', () => {
  const withContentCeiling = (maxContentBytes: number): StackAdapter =>
    Object.assign(new MemoryAdapter({ ownerEntityId: 'owner-123', timezone: 'UTC' }), {
      capabilities: {
        fullTextSearch: false,
        contentFieldQuery: true,
        sortableFields: ['createdAt', 'updatedAt', 'version'],
        maxAttachmentBytes: null,
        maxContentBytes,
      },
    });

  const openLimited = async (maxContentBytes: number): Promise<Stack> => {
    const limited = await Stack.create(withContentCeiling(maxContentBytes));
    await limited.defineType(NOTE_V1, 'Note', { text: { kind: 'text', required: true } });
    return limited;
  };

  test('create() throws StackPayloadTooLargeError before writing', async () => {
    const limitedStack = await openLimited(64);

    await expect(limitedStack.create(NOTE_V1, { text: 'x'.repeat(200) })).rejects.toThrow(
      StackPayloadTooLargeError,
    );
    expect((await limitedStack.query({ filter: { typeId: NOTE_V1 } })).records).toHaveLength(0);
  });

  test('update() measures the patch, not the merged record', async () => {
    const limitedStack = await openLimited(64);
    const record = await limitedStack.create(NOTE_V1, { text: 'small' });

    // A small patch against a record near the ceiling is not oversized —
    // the patch is what travels.
    await expect(limitedStack.update(record.id, { text: 'also small' })).resolves.toBeDefined();
    await expect(limitedStack.update(record.id, { text: 'x'.repeat(200) })).rejects.toThrow(
      StackPayloadTooLargeError,
    );
  });

  test('null maxContentBytes never throws, regardless of size', async () => {
    await expect(stack.create(NOTE_V1, { text: 'x'.repeat(100000) })).resolves.toBeDefined();
  });
});

// -------------------------------------------------------
// putAttachment — maxAttachmentBytes pre-check: fails fast before any
// bytes reach the adapter. Local adapters declare null, so these tests
// fake a finite ceiling via Object.assign over a MemoryAdapter instance.
// -------------------------------------------------------

describe('putAttachment — maxAttachmentBytes pre-check', () => {
  const withCeiling = (maxAttachmentBytes: number): StackAdapter =>
    Object.assign(new MemoryAdapter({ ownerEntityId: 'owner-123', timezone: 'UTC' }), {
      capabilities: {
        fullTextSearch: false,
        contentFieldQuery: false,
        sortableFields: ['createdAt', 'updatedAt', 'version'],
        maxAttachmentBytes,
        maxContentBytes: null,
      },
    });

  test('throws StackPayloadTooLargeError without touching the adapter', async () => {
    const limitedAdapter = withCeiling(2);
    const putAttachmentSpy = vi.spyOn(limitedAdapter, 'putAttachment');
    const limitedStack = await Stack.create(limitedAdapter);

    await expect(
      limitedStack.putAttachment(new Uint8Array([1, 2, 3]), 'image/png'),
    ).rejects.toThrow(StackPayloadTooLargeError);
    expect(putAttachmentSpy).not.toHaveBeenCalled();
  });

  test('allows an upload at exactly the ceiling', async () => {
    const limitedAdapter = withCeiling(3);
    const limitedStack = await Stack.create(limitedAdapter);

    await expect(
      limitedStack.putAttachment(new Uint8Array([1, 2, 3]), 'image/png'),
    ).resolves.toMatchObject({ typeId: '_attachment@1' });
  });

  test('null maxAttachmentBytes never throws, regardless of size', async () => {
    const data = new Uint8Array(1000);
    await expect(stack.putAttachment(data, 'image/png')).resolves.toMatchObject({
      typeId: '_attachment@1',
    });
  });
});

// -------------------------------------------------------
// putAttachment — atomic path: with putAttachmentWithMetadata() present,
// Stack.putAttachment() delegates the whole operation and must not also
// make its own create() call (double-create). The fallback path is
// exercised by every other test in the describe block above.
// -------------------------------------------------------

describe('putAttachment — atomic adapter path', () => {
  test('delegates to putAttachmentWithMetadata() when present, skipping its own create() call', async () => {
    const data = new Uint8Array([1, 2, 3]);
    const fabricatedRecord: StackRecord = {
      id: generateId(),
      typeId: '_attachment@1',
      createdAt: new Date(),
      updatedAt: new Date(),
      content: { fileId: 'atomic-file-id', mimeType: 'image/png', size: 3, filename: 'photo.png' },
      version: 1,
    };
    const atomicAdapter: StackAdapter = Object.assign(
      new MemoryAdapter({ ownerEntityId: 'owner-123', timezone: 'UTC' }),
      { putAttachmentWithMetadata: vi.fn().mockResolvedValue(fabricatedRecord) },
    );
    const atomicStack = await Stack.create(atomicAdapter);
    const createSpy = vi.spyOn(atomicStack, 'create');

    const {
      content: { fileId },
    } = await atomicStack.putAttachment(data, 'image/png', 'photo.png');

    expect(fileId).toBe('atomic-file-id');
    expect(atomicAdapter.putAttachmentWithMetadata).toHaveBeenCalledWith(
      data,
      'image/png',
      'photo.png',
      undefined,
    );
    expect(createSpy).not.toHaveBeenCalled();
  });

  test('falls back to its own create() call when the adapter lacks the capability', async () => {
    const data = new Uint8Array([1, 2, 3]);
    const createSpy = vi.spyOn(stack, 'create');

    await stack.putAttachment(data, 'image/png', 'photo.png');

    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  test('the returned record is the one in storage, on the atomic path', async () => {
    const fabricatedRecord: StackRecord = {
      id: generateId(),
      typeId: '_attachment@1',
      createdAt: new Date(),
      updatedAt: new Date(),
      content: { fileId: 'atomic-file-id', mimeType: 'image/png', size: 3 },
      version: 1,
    };
    const atomicAdapter: StackAdapter = Object.assign(
      new MemoryAdapter({ ownerEntityId: 'owner-123', timezone: 'UTC' }),
      { putAttachmentWithMetadata: vi.fn().mockResolvedValue(fabricatedRecord) },
    );
    const atomicStack = await Stack.create(atomicAdapter);

    const record = await atomicStack.putAttachment(new Uint8Array([1, 2, 3]), 'image/png');

    expect(record.id).toBe(fabricatedRecord.id);
    expect(record.content.fileId).toBe('atomic-file-id');
  });
});

// -------------------------------------------------------
// putAttachment returns the _attachment@1 record, matching what
// POST /attachments returns on the wire. The metadata record's id is the
// point: filename is the one mutable field, and setting it later needs an
// id the caller would otherwise have to go query for.
// -------------------------------------------------------

describe('putAttachment — returned record', () => {
  test('returns the metadata record, not just the fileId', async () => {
    const data = new Uint8Array([1, 2, 3]);

    const record = await stack.putAttachment(data, 'image/png', 'photo.png');

    expect(record.typeId).toBe('_attachment@1');
    expect(record.content).toEqual({
      fileId: expect.any(String),
      mimeType: 'image/png',
      size: 3,
      filename: 'photo.png',
    });
    expect(await stack.get(record.id)).toMatchObject({ id: record.id });
  });

  test('the returned id sets filename later without a lookup', async () => {
    const record = await stack.putAttachment(new Uint8Array([1, 2, 3]), 'image/png');

    const renamed = await stack.update(record.id, { filename: 'renamed.png' });

    expect((renamed.content as AttachmentContent).filename).toBe('renamed.png');
  });
});

// -------------------------------------------------------
// _attachment@1 mimeType invariant: first-recorded wins for serving,
// a conflicting later upload is rejected rather than silently coexisting.
// -------------------------------------------------------

describe('_attachment@1 mimeType conflict on create', () => {
  test('second upload of identical bytes with a matching mimeType succeeds', async () => {
    const data = new Uint8Array([1, 2, 3]);
    const {
      content: { fileId: fileId1 },
    } = await stack.putAttachment(data, 'image/png', 'first.png');
    const {
      content: { fileId: fileId2 },
    } = await stack.putAttachment(data, 'image/png', 'second.png');

    expect(fileId2).toBe(fileId1);
    const result = await stack.query({ filter: { typeId: '_attachment@1' } });
    expect(result.records).toHaveLength(2);
  });

  test('second upload of identical bytes with a conflicting mimeType is rejected', async () => {
    const data = new Uint8Array([1, 2, 3]);
    await stack.putAttachment(data, 'text/markdown');

    await expect(stack.putAttachment(data, 'text/plain')).rejects.toThrow(StackValidationError);

    // The rejected upload's metadata record must not have been created.
    const result = await stack.query({ filter: { typeId: '_attachment@1' } });
    expect(result.records).toHaveLength(1);
  });

  // Anti-oracle: the established mimeType must never appear in the
  // conflict message — naming it would confirm the fileId's existing
  // content type to a caller who only guessed the fileId, reintroducing the
  // confirmation-oracle the anti-oracle rule exists to prevent.
  test('the conflict message never names the established mimeType', async () => {
    const data = new Uint8Array([1, 2, 3]);
    await stack.putAttachment(data, 'text/markdown');

    let error: StackValidationError | undefined;
    try {
      await stack.putAttachment(data, 'text/plain');
    } catch (e) {
      error = e as StackValidationError;
    }
    expect(error).toBeInstanceOf(StackValidationError);
    const message = JSON.stringify(error?.errors);
    expect(message).not.toContain('text/markdown');
    expect(message).not.toContain('text/plain');
  });

  // forces contentFieldQuery: false so this exercises the
  // cursor-walk fallback the test name describes, rather than the fast
  // content-filtered query a compliant local adapter (MemoryAdapter's
  // real-world default) would take.
  test('conflict is detected even when the established record is beyond the first query page (>50 records, fallback path)', async () => {
    const incapableStack = await Stack.create(
      new IncapableMemoryAdapter({ ownerEntityId: 'owner-123', timezone: 'UTC' }),
    );
    for (let i = 0; i < 55; i++) {
      await incapableStack.create('_attachment@1', {
        fileId: `filler-${i}`,
        mimeType: 'image/png',
        size: 1,
      });
    }
    const data = new Uint8Array([9, 9, 9]);
    await incapableStack.putAttachment(data, 'text/markdown');

    await expect(incapableStack.putAttachment(data, 'text/plain')).rejects.toThrow(
      StackValidationError,
    );
  });

  test('a soft-deleted earlier record still establishes the mimeType', async () => {
    const data = new Uint8Array([1, 2, 3]);
    await stack.putAttachment(data, 'text/markdown');
    const [metaRecord] = (await stack.query({ filter: { typeId: '_attachment@1' } })).records;
    await stack.delete(metaRecord.id);

    await expect(stack.putAttachment(data, 'text/plain')).rejects.toThrow(StackValidationError);
  });

  // The check is check-then-create with no storage-level uniqueness behind
  // it, so on a concurrent server two conflicting first uploads can both
  // land — written here straight through the adapter, which is what that
  // race leaves behind. What must survive it is agreement: core's conflict
  // check and a server resolving Content-Type both read the established
  // type off the same record.
  test('when two conflicting records coexist, first-recorded still names one winner', async () => {
    const data = new Uint8Array([1, 2, 3]);
    const fileId = await adapter.putAttachment(data);
    const sameInstant = new Date('2024-01-01T00:00:00.000Z');
    const racer = (id: string, mimeType: string): StackRecord => ({
      id,
      typeId: '_attachment@1',
      createdAt: sameInstant,
      updatedAt: sameInstant,
      content: { fileId, mimeType, size: 3 },
      version: 1,
    });
    // Created out of id order, so a scan-order-dependent pick would
    // disagree with the tiebreak.
    await adapter.createRecord(racer('1hk153x00002', 'text/html'));
    await adapter.createRecord(racer('1hk153x00001', 'image/png'));

    const established = firstRecordedAttachment(
      (await stack.query({ filter: { typeId: '_attachment@1' } })).records,
    );
    expect(established?.id).toBe('1hk153x00001');
    expect((established?.content as AttachmentContent).mimeType).toBe('image/png');

    // Core's write-time check reads the same winner: a third upload
    // matching it is accepted, one matching the loser is not.
    await expect(stack.putAttachment(data, 'text/html')).rejects.toThrow(StackValidationError);
    await expect(stack.putAttachment(data, 'image/png')).resolves.toBeDefined();
  });

  test('two different uploaders of identical bytes each get their own filename under a matching mimeType', async () => {
    const data = new Uint8Array([1, 2, 3]);
    const fileId = await adapter.putAttachment(data);
    await stack.create(
      '_attachment@1',
      { fileId, mimeType: 'image/png', size: 3, filename: 'alice.png' },
      { entityId: 'entity-alice' },
    );
    await stack.create(
      '_attachment@1',
      { fileId, mimeType: 'image/png', size: 3, filename: 'bob.png' },
      { entityId: 'entity-bob' },
    );

    const result = await stack.query({ filter: { typeId: '_attachment@1' } });
    expect(result.records).toHaveLength(2);
    expect(
      result.records.every((r) => (r.content as Record<string, unknown>).mimeType === 'image/png'),
    ).toBe(true);
    expect(
      result.records.map((r) => (r.content as Record<string, unknown>).filename).sort(),
    ).toEqual(['alice.png', 'bob.png']);
  });
});

// -------------------------------------------------------
// _attachment@1 immutable fields on update: filename is the only
// field that may change after a metadata record is created.
// -------------------------------------------------------

describe('_attachment@1 immutable fields on update', () => {
  test('filename may be changed', async () => {
    const data = new Uint8Array([1, 2, 3]);
    await stack.putAttachment(data, 'image/png', 'old.png');
    const [record] = (await stack.query({ filter: { typeId: '_attachment@1' } })).records;

    const updated = await stack.update(record.id, { filename: 'new.png' });

    expect((updated.content as Record<string, unknown>).filename).toBe('new.png');
  });

  test('changing mimeType is rejected, even to the same value', async () => {
    const data = new Uint8Array([1, 2, 3]);
    await stack.putAttachment(data, 'image/png');
    const [record] = (await stack.query({ filter: { typeId: '_attachment@1' } })).records;

    await expect(stack.update(record.id, { mimeType: 'image/jpeg' })).rejects.toThrow(
      StackValidationError,
    );
    await expect(stack.update(record.id, { mimeType: 'image/png' })).rejects.toThrow(
      StackValidationError,
    );
  });

  test('changing fileId is rejected', async () => {
    const data = new Uint8Array([1, 2, 3]);
    await stack.putAttachment(data, 'image/png');
    const [record] = (await stack.query({ filter: { typeId: '_attachment@1' } })).records;

    await expect(stack.update(record.id, { fileId: 'some-other-file' })).rejects.toThrow(
      StackValidationError,
    );
  });

  test('changing size is rejected', async () => {
    const data = new Uint8Array([1, 2, 3]);
    await stack.putAttachment(data, 'image/png');
    const [record] = (await stack.query({ filter: { typeId: '_attachment@1' } })).records;

    await expect(stack.update(record.id, { size: 999 })).rejects.toThrow(StackValidationError);
  });

  test('setting fileId or size to their current value is a no-op, not an error', async () => {
    const data = new Uint8Array([1, 2, 3]);
    await stack.putAttachment(data, 'image/png');
    const [record] = (await stack.query({ filter: { typeId: '_attachment@1' } })).records;
    const content = record.content as Record<string, unknown>;

    await expect(
      stack.update(record.id, { fileId: content.fileId, size: content.size }),
    ).resolves.toBeDefined();
  });
});

// -------------------------------------------------------
// deleteAttachment
// -------------------------------------------------------

describe('deleteAttachment', () => {
  test('throws StackConflictError when a record still references the file (fallback path)', async () => {
    const data = new Uint8Array([1, 2, 3]);
    const {
      content: { fileId },
    } = await stack.putAttachment(data, 'image/png');
    const note = await stack.create(NOTE_V1, { text: 'hi' });
    await stack.associate(note.id, {
      kind: 'attachment',
      label: 'cover',
      fileId,
    });

    await expect(stack.deleteAttachment(fileId)).rejects.toThrow(StackConflictError);
  });

  // a soft-deleted record is recoverable via undelete() — deleting the
  // file it still references now would leave that reference dangling the
  // moment the record comes back.
  test('throws StackConflictError when only a soft-deleted record still references the file', async () => {
    const data = new Uint8Array([1, 2, 3]);
    const {
      content: { fileId },
    } = await stack.putAttachment(data, 'image/png');
    const note = await stack.create(NOTE_V1, { text: 'hi' });
    await stack.associate(note.id, {
      kind: 'attachment',
      label: 'cover',
      fileId,
    });
    await stack.delete(note.id);

    await expect(stack.deleteAttachment(fileId)).rejects.toThrow(StackConflictError);
  });

  test('hard-deletes a soft-deleted _attachment@1 metadata record too (fallback path)', async () => {
    const data = new Uint8Array([1, 2, 3]);
    const {
      content: { fileId },
    } = await stack.putAttachment(data, 'image/png');
    const [metaRecord] = (await stack.query({ filter: { typeId: '_attachment@1' } })).records;
    await stack.delete(metaRecord.id);

    await stack.deleteAttachment(fileId);

    const result = await stack.query({ filter: { typeId: '_attachment@1', includeDeleted: true } });
    expect(result.records).toHaveLength(0);
  });

  test('deletes the _attachment@1 metadata record when unreferenced (fallback path)', async () => {
    const data = new Uint8Array([1, 2, 3]);
    const {
      content: { fileId },
    } = await stack.putAttachment(data, 'image/png');

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

  // The fallback's metadata scan cursor-walks, so metadata past page one
  // is deleted too rather than orphaned. IncapableMemoryAdapter forces the
  // in-memory fallback the test name describes.
  test('leaves no orphaned metadata when the matching record is beyond the first page (>50 records)', async () => {
    const incapableStack = await Stack.create(
      new IncapableMemoryAdapter({ ownerEntityId: 'owner-123', timezone: 'UTC' }),
    );
    const targetFileId = 'target-file-abc';
    for (let i = 0; i < 55; i++) {
      await incapableStack.create('_attachment@1', {
        fileId: `filler-${i}`,
        mimeType: 'image/png',
        size: 1,
      });
    }
    const target = await incapableStack.create('_attachment@1', {
      fileId: targetFileId,
      mimeType: 'image/png',
      size: 1,
    });

    await incapableStack.deleteAttachment(targetFileId);

    expect(await incapableStack.get(target.id)).toBeNull();
    const remaining = await incapableStack.query({
      filter: { typeId: '_attachment@1' },
      limit: 1000,
    });
    expect(
      remaining.records.some((r) => (r.content as Record<string, unknown>).fileId === targetFileId),
    ).toBe(false);
  });

  // a fileId held in a file-ref content field is a real reference —
  // deleteAttachment()'s 409 check must see it, not just attachment associations.
  test('throws StackConflictError when only a file-ref content field references the file (fallback path)', async () => {
    const attachmentTypeId = 'com.example.test/photo-note@1';
    await stack.defineType(attachmentTypeId, 'Photo note', {
      coverFileId: { kind: 'file-ref', required: true },
    });

    const data = new Uint8Array([1, 2, 3]);
    const {
      content: { fileId },
    } = await stack.putAttachment(data, 'image/png');
    await stack.create(attachmentTypeId, { coverFileId: fileId });

    await expect(stack.deleteAttachment(fileId)).rejects.toThrow(StackConflictError);
  });

  test('a plain string field holding a fileId conveys no delete protection', async () => {
    const attachmentTypeId = 'com.example.test/photo-note-plain@1';
    await stack.defineType(attachmentTypeId, 'Photo note (plain)', {
      coverFileId: { kind: 'string', required: true },
    });

    const data = new Uint8Array([1, 2, 3]);
    const {
      content: { fileId },
    } = await stack.putAttachment(data, 'image/png');
    await stack.create(attachmentTypeId, { coverFileId: fileId });

    await expect(stack.deleteAttachment(fileId)).resolves.toBeUndefined();
  });

  test('prefers the adapter atomic path over the fallback when the adapter implements it', async () => {
    const calls: string[] = [];
    class AtomicAdapter extends MemoryAdapter {
      async deleteUnreferencedAttachmentRecords(
        fileId: string,
        metadataTypeId: string,
      ): Promise<StackRecord[]> {
        calls.push('atomic');
        const toDelete = [...this.records.values()].filter(
          (r) =>
            r.typeId === metadataTypeId && (r.content as Record<string, unknown>).fileId === fileId,
        );
        for (const r of toDelete) {
          this.records.delete(r.id);
          this.order.splice(this.order.indexOf(r.id), 1);
        }
        return toDelete;
      }
    }
    const atomicStack = await Stack.create(
      new AtomicAdapter({ ownerEntityId: 'owner-123', timezone: 'UTC' }),
    );
    await atomicStack.defineType(NOTE_V1, 'Note', { text: { kind: 'text', required: true } });

    const {
      content: { fileId },
    } = await atomicStack.putAttachment(new Uint8Array([9]), 'image/png');
    await atomicStack.deleteAttachment(fileId);

    expect(calls).toEqual(['atomic']);
  });
});

// -------------------------------------------------------
// collectAttachmentGarbage
// -------------------------------------------------------

describe('collectAttachmentGarbage', () => {
  test('collects a file whose only referencing record was hard-deleted', async () => {
    const {
      content: { fileId },
    } = await stack.putAttachment(new Uint8Array([1]), 'image/png');
    const note = await stack.create(NOTE_V1, { text: 'hi' });
    await stack.associate(note.id, {
      kind: 'attachment',
      label: 'cover',
      fileId,
    });
    await stack.delete(note.id, { hard: true });

    const result = await stack.collectAttachmentGarbage({ graceMs: 0 });

    expect(result.deleted).toEqual([fileId]);
    const meta = await stack.query({ filter: { typeId: '_attachment@1', includeDeleted: true } });
    expect(meta.records).toHaveLength(0);
  });

  test('does not collect a file referenced by a live record', async () => {
    const {
      content: { fileId },
    } = await stack.putAttachment(new Uint8Array([1]), 'image/png');
    const note = await stack.create(NOTE_V1, { text: 'hi' });
    await stack.associate(note.id, {
      kind: 'attachment',
      label: 'cover',
      fileId,
    });

    const result = await stack.collectAttachmentGarbage({ graceMs: 0 });

    expect(result.deleted).toEqual([]);
  });

  // Soft-deleted records are recoverable via undelete()
  // and must find their attachments intact — so they still count as references.
  test('does not collect a file referenced only by a soft-deleted record', async () => {
    const {
      content: { fileId },
    } = await stack.putAttachment(new Uint8Array([1]), 'image/png');
    const note = await stack.create(NOTE_V1, { text: 'hi' });
    await stack.associate(note.id, {
      kind: 'attachment',
      label: 'cover',
      fileId,
    });
    await stack.delete(note.id);

    const result = await stack.collectAttachmentGarbage({ graceMs: 0 });

    expect(result.deleted).toEqual([]);
  });

  // a file-ref content field is a real reference too, same as an
  // attachment Association.
  test('does not collect a file referenced only via a file-ref content field', async () => {
    const photoType = 'com.example.test/photo-note@1';
    await stack.defineType(photoType, 'Photo note', {
      coverFileId: { kind: 'file-ref', required: true },
    });
    const {
      content: { fileId },
    } = await stack.putAttachment(new Uint8Array([1]), 'image/png');
    await stack.create(photoType, { coverFileId: fileId });

    const result = await stack.collectAttachmentGarbage({ graceMs: 0 });

    expect(result.deleted).toEqual([]);
  });

  test('default grace period protects a fresh unreferenced upload', async () => {
    await stack.putAttachment(new Uint8Array([1]), 'image/png');

    const result = await stack.collectAttachmentGarbage();

    expect(result.deleted).toEqual([]);
    const meta = await stack.query({ filter: { typeId: '_attachment@1' } });
    expect(meta.records).toHaveLength(1);
  });

  test('graceMs: 0 collects an unreferenced upload immediately', async () => {
    const {
      content: { fileId },
    } = await stack.putAttachment(new Uint8Array([1]), 'image/png');

    const result = await stack.collectAttachmentGarbage({ graceMs: 0 });

    expect(result.deleted).toEqual([fileId]);
  });

  test('reports reclaimedBytes summed across deleted files', async () => {
    const {
      content: { fileId: fileId1 },
    } = await stack.putAttachment(new Uint8Array([1, 2, 3]), 'image/png');
    const {
      content: { fileId: fileId2 },
    } = await stack.putAttachment(new Uint8Array([1, 2, 3, 4, 5]), 'image/png');

    const result = await stack.collectAttachmentGarbage({ graceMs: 0 });

    expect(result.deleted.sort()).toEqual([fileId1, fileId2].sort());
    expect(result.reclaimedBytes).toBe(8);
  });

  test('dryRun reports what would be deleted without deleting anything', async () => {
    const {
      content: { fileId },
    } = await stack.putAttachment(new Uint8Array([1, 2, 3]), 'image/png');

    const result = await stack.collectAttachmentGarbage({ graceMs: 0, dryRun: true });

    expect(result.deleted).toEqual([fileId]);
    expect(result.reclaimedBytes).toBe(3);
    const meta = await stack.query({ filter: { typeId: '_attachment@1' } });
    expect(meta.records).toHaveLength(1);
  });

  // Bytes with no metadata record (a putAttachment() that stored bytes but
  // crashed before creating _attachment@1 — simulated here by writing
  // through the adapter directly, since no Stack method produces this
  // state on purpose) are only discoverable via StackBlobAdapter.listFiles().
  test('collects a bare-bytes orphan discovered via listFiles()', async () => {
    const fileId = await adapter.putAttachment(new Uint8Array([9, 9, 9]));

    const result = await stack.collectAttachmentGarbage({ graceMs: 0 });

    expect(result.deleted).toEqual([fileId]);
    expect(result.reclaimedBytes).toBe(3);
  });

  test('adapter without listFiles() still collects metadata-tracked orphans', async () => {
    class NoListFilesAdapter extends MemoryAdapter {
      override listFiles: (() => Promise<BlobFileInfo[]>) | undefined = undefined;
    }
    const noListFilesStack = await Stack.create(
      new NoListFilesAdapter({ ownerEntityId: 'owner-123', timezone: 'UTC' }),
    );
    const {
      content: { fileId },
    } = await noListFilesStack.putAttachment(new Uint8Array([1]), 'image/png');

    const result = await noListFilesStack.collectAttachmentGarbage({ graceMs: 0 });

    expect(result.deleted).toEqual([fileId]);
  });

  test('adapter without listFiles() cannot find bare-bytes orphans', async () => {
    class NoListFilesAdapter extends MemoryAdapter {
      override listFiles: (() => Promise<BlobFileInfo[]>) | undefined = undefined;
    }
    const noListFilesAdapter = new NoListFilesAdapter({
      ownerEntityId: 'owner-123',
      timezone: 'UTC',
    });
    const noListFilesStack = await Stack.create(noListFilesAdapter);
    await noListFilesAdapter.putAttachment(new Uint8Array([9, 9, 9]));

    const result = await noListFilesStack.collectAttachmentGarbage({ graceMs: 0 });

    expect(result.deleted).toEqual([]);
  });

  // A concurrent associate() landing between the sweep's own scan and its
  // per-file deleteAttachment() call would make that call throw
  // StackConflictError — the sweep must skip that one file, not abort, and
  // must keep collecting everything else it already found.
  test('a file whose delete call races is skipped, not thrown, and the rest of the sweep still completes', async () => {
    const {
      content: { fileId: racedFileId },
    } = await stack.putAttachment(new Uint8Array([1]), 'image/png');
    const {
      content: { fileId: okFileId },
    } = await stack.putAttachment(new Uint8Array([2, 2]), 'image/png');

    const realDeleteAttachment = stack.deleteAttachment.bind(stack);
    stack.deleteAttachment = async (fileId: string) => {
      if (fileId === racedFileId) throw new StackConflictError('simulated race');
      return realDeleteAttachment(fileId);
    };

    const result = await stack.collectAttachmentGarbage({ graceMs: 0 });

    expect(result.deleted).toEqual([okFileId]);
    expect(result.reclaimedBytes).toBe(2);
  });
});

// -------------------------------------------------------
// Error taxonomy
// -------------------------------------------------------

// One instance per member, constructed with the minimum each requires.
const everyStackError = (): StackError[] => [
  new StackValidationError([{ path: 'text', message: 'expected string' }]),
  new StackMigrationError('no migration path'),
  new StackPermissionError(),
  new StackNotFoundError('Record "1hk153x0a00b" not found.'),
  new StackConflictError('Attachment is still referenced.'),
  new StackVersionConflictError('Version mismatch.', '1hk153x0a00b', 3, 5),
  new StackQueryError('Undecodable pagination cursor.'),
  new StackSchemaDriftError(NOTE_V1, [{ path: 'text', message: 'type changed' }]),
  new StackPayloadTooLargeError('Attachment exceeds the limit.'),
];

describe('error taxonomy', () => {
  test('every Stack-domain error descends from StackError and from Error', () => {
    for (const err of everyStackError()) {
      expect(err, err.name).toBeInstanceOf(StackError);
      expect(err, err.name).toBeInstanceOf(Error);
    }
  });

  test('each class exposes the same code as an instance property and a static', () => {
    const statics = [
      StackValidationError,
      StackMigrationError,
      StackPermissionError,
      StackNotFoundError,
      StackConflictError,
      StackVersionConflictError,
      StackQueryError,
      StackSchemaDriftError,
      StackPayloadTooLargeError,
    ];
    const instances = everyStackError();
    for (const [i, cls] of statics.entries()) {
      expect(instances[i].code, cls.name).toBe(cls.code);
    }
  });

  test('codes are distinct, so a code identifies exactly one class', () => {
    const codes = everyStackError().map((e) => e.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  test('a version conflict is a sibling of a plain conflict, never a subtype', () => {
    const version = new StackVersionConflictError('mismatch', '1hk153x0a00b', 3, 5);
    expect(version).not.toBeInstanceOf(StackConflictError);
    expect(new StackConflictError('blocked')).not.toBeInstanceOf(StackVersionConflictError);
  });

  test('a schema drift is a sibling of a plain conflict, never a subtype', () => {
    const drift = new StackSchemaDriftError(NOTE_V1, [{ path: 'text', message: 'type changed' }]);
    expect(drift).not.toBeInstanceOf(StackConflictError);
  });

  test('errors with no wire representation stay outside the taxonomy', () => {
    expect(new IdGenerationError('clock went backwards')).not.toBeInstanceOf(StackError);
    expect(new InvalidDidError('malformed did:key')).not.toBeInstanceOf(StackError);
    expect(new Error('ordinary bug')).not.toBeInstanceOf(StackError);
  });

  test('errors thrown by real operations are catchable as StackError', async () => {
    await expect(stack.create(NOTE_V1, { text: 42 })).rejects.toBeInstanceOf(StackError);
    await expect(stack.get('1hk153x0a00b')).resolves.toBeNull();
    await expect(stack.update('1hk153x0a00b', { text: 'x' })).rejects.toBeInstanceOf(StackError);
  });
});

// -------------------------------------------------------
// _app registry integrity
// -------------------------------------------------------

// A card's did is what resolves a record's principalId to a name, so two
// cards claiming one DID would make that lookup ambiguous — and ambiguity
// is all an impersonating card needs.
describe('_app.did bindings', () => {
  const APP_DID = 'did:key:z6MkNotesApp';

  test('rejects a second _app record claiming a DID already in use', async () => {
    await stack.create('_app@1', {
      appId: 'com.example.notes',
      name: 'My Notes App',
      did: APP_DID,
    });
    await expect(
      stack.create('_app@1', { appId: 'com.example.impostor', name: 'Impostor', did: APP_DID }),
    ).rejects.toThrow(StackConflictError);
  });

  test('rejects an update that moves a card onto a DID already in use', async () => {
    await stack.create('_app@1', {
      appId: 'com.example.notes',
      name: 'My Notes App',
      did: APP_DID,
    });
    const other = await stack.create('_app@1', { appId: 'com.example.other', name: 'Other App' });
    await expect(stack.update(other.id, { did: APP_DID })).rejects.toThrow(StackConflictError);
  });

  test('a card may keep its own DID across an unrelated update', async () => {
    const app = await stack.create('_app@1', {
      appId: 'com.example.notes',
      name: 'My Notes App',
      did: APP_DID,
    });
    const updated = await stack.update(app.id, { version: '2.0.0' });
    expect((updated.content as { did?: string }).did).toBe(APP_DID);
  });

  test('cards without a DID do not collide with each other', async () => {
    await stack.create('_app@1', { appId: 'com.example.one', name: 'One' });
    const two = await stack.create('_app@1', { appId: 'com.example.two', name: 'Two' });
    expect(two.id).toBeTruthy();
  });

  test('rejects an update that moves a card off the DID it holds', async () => {
    const app = await stack.create('_app@1', {
      appId: 'com.example.notes',
      name: 'My Notes App',
      did: APP_DID,
    });
    await expect(stack.update(app.id, { did: 'did:key:z6MkMoved' })).rejects.toThrow(
      StackValidationError,
    );
  });

  test('rejects an update that clears the DID a card holds', async () => {
    const app = await stack.create('_app@1', {
      appId: 'com.example.notes',
      name: 'My Notes App',
      did: APP_DID,
    });
    await expect(stack.update(app.id, { did: null })).rejects.toThrow(StackValidationError);
  });

  test('a card carrying no DID may adopt one', async () => {
    const app = await stack.create('_app@1', {
      appId: 'com.example.later',
      name: 'Key Comes Later',
    });
    const updated = await stack.update(app.id, { did: APP_DID });
    expect((updated.content as { did?: string }).did).toBe(APP_DID);
  });

  test('a card that adopted a DID cannot be rolled back off it', async () => {
    const app = await stack.create('_app@1', {
      appId: 'com.example.later',
      name: 'Key Comes Later',
    });
    await stack.update(app.id, { did: APP_DID });

    await expect(stack.restoreVersion(app.id, 1)).rejects.toThrow(StackValidationError);
  });

  test('a card may be restored onto the DID it already holds', async () => {
    const app = await stack.create('_app@1', {
      appId: 'com.example.notes',
      name: 'My Notes App',
      did: APP_DID,
    });
    await stack.update(app.id, { version: '2.0.0' });

    const restored = await stack.restoreVersion(app.id, 1);
    expect((restored.content as { did?: string }).did).toBe(APP_DID);
  });
});

// -------------------------------------------------------
// Binding fields beyond _app.did
// -------------------------------------------------------

// appId is the other half of the attribution lookup: principalId resolves
// to a card by did, and that card's appId is what a record's own appId is
// checked against. Both halves bind, so both are unique and permanent.
describe('_app.appId bindings', () => {
  const APP_DID = 'did:key:z6MkNotesApp';

  // appId is immutable but not unique: nothing resolves a card by it, and
  // requiring it while forbidding a second card holding it would make the
  // replacement card key rotation calls for unwritable.
  test('a second card may claim the same appId under a different did', async () => {
    await stack.create('_app@1', {
      appId: 'com.example.notes',
      name: 'My Notes App',
      did: APP_DID,
    });
    const rotated = await stack.create('_app@1', {
      appId: 'com.example.notes',
      name: 'My Notes App',
      did: 'did:key:z6MkNotesAppRotated',
    });
    expect((rotated.content as { appId: string }).appId).toBe('com.example.notes');
  });

  test('the did on those cards is still unique', async () => {
    await stack.create('_app@1', {
      appId: 'com.example.notes',
      name: 'My Notes App',
      did: APP_DID,
    });
    await expect(
      stack.create('_app@1', { appId: 'com.example.other', name: 'Impostor', did: APP_DID }),
    ).rejects.toThrow(StackConflictError);
  });

  test('rejects an update that moves a card off the appId it holds', async () => {
    const app = await stack.create('_app@1', { appId: 'com.example.notes', name: 'My Notes App' });
    await expect(stack.update(app.id, { appId: 'com.example.bank' })).rejects.toThrow(
      StackValidationError,
    );
  });

  test('display fields stay writable while the bindings hold', async () => {
    const app = await stack.create('_app@1', {
      appId: 'com.example.notes',
      name: 'My Notes App',
      did: APP_DID,
    });
    const updated = await stack.update(app.id, { name: 'Renamed', version: '2.0.0' });
    expect(updated.content).toMatchObject({
      appId: 'com.example.notes',
      name: 'Renamed',
      did: APP_DID,
    });
  });

  test('the card names the software it describes, not the software that wrote it', async () => {
    // An admin console registering a third-party app is the ordinary case:
    // record.appId names the console, content.appId names what is registered.
    const card = await stack.create(
      '_app@1',
      { appId: 'com.example.notes', name: 'My Notes App', did: APP_DID },
      { appId: 'com.example.console' },
    );
    expect(card.appId).toBe('com.example.console');
    expect((card.content as { appId: string }).appId).toBe('com.example.notes');
  });
});

// entityId resolves through _entity.did exactly as principalId resolves
// through _app.did, so the binding rules are the same ones — a petname card
// that could be repointed would carry the owner's chosen name onto a key
// someone else holds.
describe('_entity.did bindings', () => {
  const ALICE = 'did:key:z6MkAlice';
  const MALLORY = 'did:key:z6MkMallory';

  test('rejects a second card claiming a DID already in use', async () => {
    await stack.create('_entity@1', { did: ALICE, name: 'Alice' });
    await expect(
      stack.create('_entity@1', { did: ALICE, name: 'Alice (verified)' }),
    ).rejects.toThrow(StackConflictError);
  });

  test('rejects an update that repoints a card at another key', async () => {
    const alice = await stack.create('_entity@1', { did: ALICE, name: 'Alice' });
    await expect(stack.update(alice.id, { did: MALLORY })).rejects.toThrow(StackValidationError);
  });

  test('a card may be relabelled without touching its binding', async () => {
    const alice = await stack.create('_entity@1', { did: ALICE, name: 'Alice' });
    const updated = await stack.update(alice.id, { name: 'Alice Smith', handle: 'alice' });
    expect(updated.content).toMatchObject({ did: ALICE, name: 'Alice Smith', handle: 'alice' });
  });

  test('a rollback that would move the binding is refused', async () => {
    const alice = await stack.create('_entity@1', { did: ALICE, name: 'Alice' });
    await stack.update(alice.id, { name: 'Alice Smith' });
    // v1 holds the same did, so this rollback is a relabel and is allowed.
    const restored = await stack.restoreVersion(alice.id, 1);
    expect((restored.content as { did: string }).did).toBe(ALICE);
  });

  // Without contentFieldQuery the check cursor-walks the family and stops at
  // the first clash, so a colliding card past page one must still be found —
  // short-circuiting is what keeps the walk bounded, not a narrower scan.
  test('finds a clash past page one on an adapter without contentFieldQuery', async () => {
    const incapable = await Stack.create(
      new IncapableMemoryAdapter({ ownerEntityId: 'owner-123', timezone: 'UTC' }),
    );
    for (let i = 0; i < 60; i++) {
      await incapable.create('_entity@1', { did: `did:key:filler${i}`, name: `Filler ${i}` });
    }
    await incapable.create('_entity@1', { did: ALICE, name: 'Alice' });

    await expect(
      incapable.create('_entity@1', { did: ALICE, name: 'Alice (impostor)' }),
    ).rejects.toThrow(StackConflictError);
  });
});

// grant() refuses these families, but a _grant record is an ordinary Record
// and an unscoped Stack can mint one regardless. The rule holds at the point
// of use, so provenance cannot launder it.
describe('ungrantable families are refused at evaluation', () => {
  const MALLORY = 'did:key:z6MkMallory';

  test('a hand-minted grant on _app confers nothing', async () => {
    await stack.create('_grant@1', { typeId: '_app@1', actions: ['create', 'read-any'] });

    await expect(
      stack.asEntity(MALLORY).create('_app@1', { appId: 'com.example.evil', name: 'Evil' }),
    ).rejects.toThrow(StackPermissionError);
  });

  test('a hand-minted grant on _grant confers nothing', async () => {
    await stack.create('_grant@1', { typeId: '_grant@1', actions: ['create'] });

    await expect(
      stack.asEntity(MALLORY).create('_grant@1', { typeId: NOTE_V1, actions: ['read-any'] }),
    ).rejects.toThrow(StackPermissionError);
  });
});
