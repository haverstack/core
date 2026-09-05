/**
 * Targeted subset, not a 1:1 port of record-adapter-sqlite's suite — that
 * suite already proves SharedSqlRecordLogic's correctness once. What's
 * unique to this adapter and worth proving again, against the real
 * Workers runtime (@cloudflare/vitest-pool-workers), not `environment:
 * 'node'`: the executor's translation of get/all/run onto SqlStorage's
 * cursor API, FK/unique constraint mapping, FTS5, cursor-codec pagination,
 * and — the one thing the #161 spike found couldn't be assumed — that
 * exec.transaction() reaching ctx.storage.transactionSync() actually
 * rolls back a rejected mutation's partial writes (see the
 * mid-transaction-failure test below), since DO SQLite has no raw
 * BEGIN/COMMIT/ROLLBACK to fall back on if that wiring were wrong.
 */
import { env } from 'cloudflare:test';
import { describe, test, expect } from 'vitest';
import type {
  StackRecord,
  StackQuery,
  QueryResult,
  Association,
  RecordVersion,
  StackType,
} from '@haverstack/core';
import type { AdapterCapabilities } from '@haverstack/core/adapter';

/**
 * A Durable Object is a separate JS realm from the test file's own — even
 * colocated, an RPC call across that boundary reconstructs a thrown Error
 * as a generic object carrying the same enumerable properties (message,
 * name, code, and any custom fields like recordId), but NOT the original
 * class's prototype chain. `instanceof StackConflictError` fails on the
 * far side of that boundary even though the error is genuinely a
 * StackConflictError inside the DO; `.code` (StackError's discriminant,
 * see packages/core/src/stack.ts) is what survives and what these tests
 * assert on instead. record-adapter-sqlite's tests never hit this because
 * everything there runs in one process.
 */

/**
 * Cloudflare's automatic RPC type inference for a DurableObjectStub
 * collapses to `never` for several of TestRecordAdapterDO's methods —
 * StackRecord/QueryResult/Association are ordinary data types and the
 * runtime call works correctly (see the assertions below), but the
 * recursive type transformation the RPC types apply to a class with this
 * many methods and this much optional/union structure in their signatures
 * doesn't resolve. Declaring the stub's shape explicitly sidesteps that
 * inference rather than fighting it.
 */
type TestStub = {
  getCapabilities(): Promise<AdapterCapabilities>;
  getOwnerEntityId(): Promise<string>;
  createRecord(record: StackRecord): Promise<StackRecord>;
  getRecord(id: string): Promise<StackRecord | null>;
  patchContent(
    id: string,
    patch: Record<string, unknown | null>,
    opts?: Record<string, unknown>,
  ): Promise<StackRecord>;
  deleteRecord(
    id: string,
    opts?: { hard?: boolean } & Record<string, unknown>,
  ): Promise<StackRecord | null>;
  queryRecords(query: StackQuery): Promise<QueryResult>;
  getVersions(id: string): Promise<RecordVersion[]>;
  associate(
    recordId: string,
    association: Association,
    opts?: Record<string, unknown>,
  ): Promise<StackRecord>;
  dissociate(
    recordId: string,
    association: Association,
    opts?: Record<string, unknown>,
  ): Promise<StackRecord>;
  commitMigration(
    id: string,
    toTypeId: string,
    content: Record<string, unknown>,
    opts?: Record<string, unknown>,
  ): Promise<StackRecord>;
  saveType(type: StackType): Promise<void>;
};

const getStub = (): TestStub => {
  const id = env.TEST_DO.idFromName(`do-${Math.random().toString(36).slice(2)}`);
  return env.TEST_DO.get(id) as unknown as TestStub;
};

const NOTE_TYPE_V1 = 'com.example.test/note@1';

const makeRecord = (overrides: Partial<StackRecord> = {}): StackRecord => ({
  id: `rec-${Math.random().toString(36).slice(2)}`,
  typeId: NOTE_TYPE_V1,
  createdAt: new Date(),
  updatedAt: new Date(),
  content: { text: 'Hello world' },
  version: 1,
  ...overrides,
});

describe('construction', () => {
  test('declares capabilities matching record-adapter-sqlite', async () => {
    const stub = getStub();
    const capabilities = await stub.getCapabilities();
    expect(capabilities).toEqual({
      filter: {
        content: 'path',
        contentPresent: true,
        search: true,
      },
      sort: {
        fields: ['createdAt', 'updatedAt', 'version'],
        contentField: true,
      },
      limits: {
        attachmentBytes: null,
        contentBytes: null,
      },
    });
  });

  test('sets ownerEntityId from create() options', async () => {
    const stub = getStub();
    expect(await stub.getOwnerEntityId()).toBe('entity-test');
  });
});

describe('records — CRUD', () => {
  test('createRecord and getRecord roundtrip, with Date fields intact across the RPC boundary', async () => {
    const stub = getStub();
    const record = makeRecord({ content: { text: 'Hello' } });
    await stub.createRecord(record);
    const retrieved = await stub.getRecord(record.id);
    expect(retrieved?.id).toBe(record.id);
    expect(retrieved?.content).toEqual({ text: 'Hello' });
    expect(retrieved?.createdAt).toBeInstanceOf(Date);
    expect(retrieved?.updatedAt).toBeInstanceOf(Date);
  });

  test('getRecord returns null for unknown id', async () => {
    const stub = getStub();
    expect(await stub.getRecord('nonexistent')).toBeNull();
  });

  test('createRecord throws StackConflictError on a duplicate id (unique constraint mapping)', async () => {
    const stub = getStub();
    const record = makeRecord();
    await stub.createRecord(record);
    const err = await stub
      .createRecord({ ...record, content: { text: 'second' } })
      .catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe('conflict');
  });

  test('patchContent changes content and bumps version', async () => {
    const stub = getStub();
    const record = makeRecord();
    await stub.createRecord(record);
    const updated = await stub.patchContent(record.id, { text: 'Updated' });
    expect(updated.content).toEqual({ text: 'Updated' });
    expect(updated.version).toBe(2);
  });

  test('hard deleteRecord removes the record entirely', async () => {
    const stub = getStub();
    const record = makeRecord();
    await stub.createRecord(record);
    await stub.deleteRecord(record.id, { hard: true });
    expect(await stub.getRecord(record.id)).toBeNull();
  });
});

describe('expectedVersion / transactional rollback', () => {
  test('patchContent throws StackVersionConflictError and changes nothing when stale', async () => {
    const stub = getStub();
    const record = await stub.createRecord(makeRecord());
    await stub.patchContent(record.id, { text: 'first' }); // -> v2

    const err = await stub
      .patchContent(record.id, { text: 'second' }, { expectedVersion: 1 })
      .catch((e: unknown) => e);
    expect(
      (
        err as {
          code?: string;
          recordId?: string;
          expectedVersion?: number;
          actualVersion?: number;
        }
      ).code,
    ).toBe('version_conflict');
    expect((err as { recordId?: string }).recordId).toBe(record.id);
    expect((err as { expectedVersion?: number }).expectedVersion).toBe(1);
    expect((err as { actualVersion?: number }).actualVersion).toBe(2);

    const current = await stub.getRecord(record.id);
    expect(current?.version).toBe(2);
    expect(current?.content).toEqual({ text: 'first' });
  });

  /**
   * Guards the FTS index against a rejected patch, but note what it does
   * NOT prove: patchContent validates expectedVersion *before* opening
   * exec.transaction(), so this case throws ahead of the first write and
   * passes even if transaction() provides no atomicity at all. Rollback
   * itself is covered by the mid-transaction-failure test above, which
   * reaches a failure inside the callback.
   */
  /**
   * The rollback test with a failure that actually occurs *inside* the
   * transaction callback. patchContent's expectedVersion check runs before
   * exec.transaction() is ever entered, so a stale-version patch throws
   * before the first write and proves nothing about atomicity.
   *
   * associate({ snapshot, expectedVersion }) is the shape that does reach
   * it: snapshotBeforeMutation() writes a real row into `versions`, and
   * bumpVersion()'s CAS then fails on the stale expectedVersion and throws
   * — both inside the same transaction callback. If transactionSync() did
   * not roll back, that orphan version row would survive a mutation that
   * reported failure.
   */
  test('a mid-transaction failure rolls back writes already made in the same transaction', async () => {
    const stub = getStub();
    const record = makeRecord();
    await stub.createRecord(record);
    expect(await stub.getVersions(record.id)).toEqual([]);

    const snapshot = {
      version: 1,
      typeId: record.typeId,
      content: record.content,
      updatedAt: new Date(),
    };

    // snapshotBeforeMutation writes a versions row, then bumpVersion's CAS
    // rejects the stale expectedVersion and throws inside the transaction.
    const err = await stub
      .associate(record.id, { kind: 'tag', label: 'starred' }, { snapshot, expectedVersion: 999 })
      .catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe('version_conflict');

    // The versions row written before the throw must not have survived.
    expect(await stub.getVersions(record.id)).toEqual([]);
    const after = await stub.getRecord(record.id);
    expect(after?.version).toBe(1);
    expect(after?.associations).toBeUndefined();
  });

  test('a rejected patchContent leaves the FTS index consistent with stored content', async () => {
    const stub = getStub();
    const record = await stub.createRecord(
      makeRecord({ content: { text: 'searchable original' } }),
    );
    await stub
      .patchContent(record.id, { text: 'rejected update' }, { expectedVersion: 999 })
      .catch(() => {});

    const stillFindsOriginal = await stub.queryRecords({ filter: { search: 'original' } });
    expect(stillFindsOriginal.records.map((r) => r.id)).toEqual([record.id]);
    const doesNotFindRejected = await stub.queryRecords({ filter: { search: 'rejected' } });
    expect(doesNotFindRejected.records).toEqual([]);
  });
});

describe('records — queries', () => {
  test('filters by content field', async () => {
    const stub = getStub();
    await stub.createRecord(makeRecord({ id: 'r1', content: { text: 'alpha', priority: 1 } }));
    await stub.createRecord(makeRecord({ id: 'r2', content: { text: 'beta', priority: 2 } }));
    const result = await stub.queryRecords({ filter: { content: { priority: 1 } } });
    expect(result.records.map((r) => r.id)).toEqual(['r1']);
  });

  // json_each / json_array traversal against the real DO SQLite build,
  // which is where an engine difference would show up rather than in
  // sqlite-shared's own tests.
  test('filters by a nested content path, through an array of objects', async () => {
    const stub = getStub();
    await stub.createRecord(
      makeRecord({
        id: 'r1',
        content: { text: 'ada', emails: [{ value: 'ada@example.com', label: 'home' }] },
      }),
    );
    await stub.createRecord(
      makeRecord({
        id: 'r2',
        content: { text: 'grace', emails: [{ value: 'grace@example.com', label: 'home' }] },
      }),
    );
    const result = await stub.queryRecords({
      filter: { content: { 'emails.value': 'grace@example.com' } },
    });
    expect(result.records.map((r) => r.id)).toEqual(['r2']);
  });

  test('a nested path reaching no value matches a null filter', async () => {
    const stub = getStub();
    await stub.createRecord(makeRecord({ id: 'r1', content: { text: 'no address' } }));
    await stub.createRecord(
      makeRecord({ id: 'r2', content: { text: 'has one', address: { city: 'Porto' } } }),
    );
    const result = await stub.queryRecords({ filter: { content: { 'address.city': null } } });
    expect(result.records.map((r) => r.id)).toEqual(['r1']);
  });

  // The segment cap is sized against SQLite's join limit, and this build
  // is where a difference in that limit would surface. The longest legal
  // path has to execute, not merely be accepted.
  test('a path at the segment cap executes; one past it is refused', async () => {
    const stub = getStub();
    await stub.createRecord(makeRecord({ id: 'r1', content: { text: 'shallow' } }));
    const deepest = Array.from({ length: 32 }, (_, i) => `s${i}`).join('.');

    const miss = await stub.queryRecords({ filter: { content: { [deepest]: 'x' } } });
    expect(miss.records).toEqual([]);
    const absent = await stub.queryRecords({ filter: { content: { [deepest]: null } } });
    expect(absent.records.map((r) => r.id)).toEqual(['r1']);
    const err = await stub
      .queryRecords({ filter: { content: { [`${deepest}.s32`]: 'x' } } })
      .catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe('bad_request');
  });

  test('a scalar filter value never matches an object at the path', async () => {
    const stub = getStub();
    await stub.createRecord(makeRecord({ id: 'r1', content: { text: 'a', a: { b: { k: 'v' } } } }));

    const result = await stub.queryRecords({ filter: { content: { 'a.b': '{"k":"v"}' } } });
    expect(result.records).toEqual([]);
  });

  test('full-text search (FTS5)', async () => {
    const stub = getStub();
    await stub.createRecord(makeRecord({ id: 'r1', content: { text: 'SQLite is great' } }));
    await stub.createRecord(makeRecord({ id: 'r2', content: { text: 'Postgres is also great' } }));
    const result = await stub.queryRecords({ filter: { search: 'SQLite' } });
    expect(result.records.map((r) => r.id)).toEqual(['r1']);
  });

  test('cursor pagination returns correct pages', async () => {
    const stub = getStub();
    for (let i = 0; i < 5; i++) {
      await stub.createRecord(
        makeRecord({ id: `r${i}`, createdAt: new Date(Date.now() + i * 1000) }),
      );
    }
    const page1 = await stub.queryRecords({
      sort: { field: 'createdAt', direction: 'asc' },
      limit: 3,
    });
    expect(page1.records.length).toBe(3);
    expect(page1.cursor).not.toBeNull();
    expect(page1.total).toBe(5);

    const page2 = await stub.queryRecords({
      sort: { field: 'createdAt', direction: 'asc' },
      limit: 3,
      cursor: page1.cursor!,
    });
    expect(page2.records.length).toBe(2);
    expect(page2.cursor).toBeNull();
  });

  test('malformed cursor throws StackQueryError', async () => {
    const stub = getStub();
    await stub.createRecord(makeRecord({ id: 'r1' }));
    const err = await stub.queryRecords({ cursor: '!!!not-a-cursor!!!' }).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe('bad_request');
  });
});

// The sort index's ORDER BY carries a LEFT JOIN and a CASE-ranked
// partition term, and its keyset resumes across those partitions — all of
// it executed by this build rather than by node:sqlite.
describe('records — sorting by a content field', () => {
  const SORTED_TYPE = 'com.example.test/sorted@1';

  const withSortedType = async (stub: TestStub) => {
    await stub.saveType({
      id: SORTED_TYPE,
      baseId: 'com.example.test/sorted',
      version: 1,
      name: 'Sorted',
      schema: { title: { kind: 'string' }, priority: { kind: 'number' } },
      schemaHash: 'sorted-hash',
      createdAt: new Date(),
    });
  };

  test('orders by a content field, absent values last', async () => {
    const stub = getStub();
    await withSortedType(stub);
    await stub.createRecord(
      makeRecord({ id: 'r1', typeId: SORTED_TYPE, content: { title: 'b', priority: 2 } }),
    );
    await stub.createRecord(
      makeRecord({ id: 'r2', typeId: SORTED_TYPE, content: { title: 'a', priority: 1 } }),
    );
    await stub.createRecord(
      makeRecord({ id: 'r3', typeId: SORTED_TYPE, content: { title: 'none' } }),
    );

    const asc = await stub.queryRecords({ sort: { contentField: 'priority', direction: 'asc' } });
    expect(asc.records.map((r) => r.id)).toEqual(['r2', 'r1', 'r3']);
    const desc = await stub.queryRecords({ sort: { contentField: 'priority', direction: 'desc' } });
    expect(desc.records.map((r) => r.id)).toEqual(['r1', 'r2', 'r3']);
  });

  test('orders text by the folded key, and pages across the partitions', async () => {
    const stub = getStub();
    await withSortedType(stub);
    await stub.createRecord(
      makeRecord({ id: 'r1', typeId: SORTED_TYPE, content: { title: 'Zebra' } }),
    );
    await stub.createRecord(
      makeRecord({ id: 'r2', typeId: SORTED_TYPE, content: { title: 'apple' } }),
    );
    await stub.createRecord(makeRecord({ id: 'r3', typeId: SORTED_TYPE, content: {} }));

    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page: QueryResult = await stub.queryRecords({
        sort: { contentField: 'title', direction: 'asc' },
        limit: 1,
        ...(cursor && { cursor }),
      });
      ids.push(...page.records.map((r) => r.id));
      cursor = page.cursor ?? undefined;
    } while (cursor);

    expect(ids).toEqual(['r2', 'r1', 'r3']);
  });
});

describe('associations', () => {
  test('associate adds a tag, dissociate removes it, both bump version', async () => {
    const stub = getStub();
    const record = makeRecord();
    await stub.createRecord(record);
    await stub.associate(record.id, { kind: 'tag', label: 'starred' });
    const withTag = await stub.getRecord(record.id);
    expect(withTag?.associations?.some((a) => a.kind === 'tag' && a.label === 'starred')).toBe(
      true,
    );
    expect(withTag?.version).toBe(2);

    await stub.dissociate(record.id, { kind: 'tag', label: 'starred' });
    const withoutTag = await stub.getRecord(record.id);
    expect(withoutTag?.associations).toBeUndefined();
  });

  test('associate on a nonexistent record throws StackNotFoundError (FK constraint mapping) instead of creating an orphan row', async () => {
    const stub = getStub();
    const err = await stub
      .associate('nonexistent', { kind: 'tag', label: 'starred' })
      .catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe('not_found');
  });
});

describe('commitMigration', () => {
  test('changes typeId and content together, and bumps version', async () => {
    const stub = getStub();
    const record = makeRecord({ typeId: NOTE_TYPE_V1 });
    await stub.createRecord(record);

    const migrated = await stub.commitMigration(record.id, 'com.example.test/note@2', {
      text: 'Hello world',
      pinned: false,
    });
    expect(migrated.typeId).toBe('com.example.test/note@2');
    expect(migrated.content).toEqual({ text: 'Hello world', pinned: false });
    expect(migrated.version).toBe(2);
  });
});
