import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { NativeSQLiteRecordAdapter } from '../src/index.js';
import { StackQueryError } from '@haverstack/core';
import type { StackQuery, StackRecord, StackType } from '@haverstack/core';

// -------------------------------------------------------
// Test helpers
// -------------------------------------------------------

let testDir: string;
let adapter: NativeSQLiteRecordAdapter;

const ARTICLE = 'com.example.test/article@1';
const RANKED = 'com.example.test/ranked@1';

const type = (id: string, schema: StackType['schema']): StackType => ({
  id,
  baseId: id.split('@')[0],
  version: 1,
  name: 'Test',
  schema,
  schemaHash: `hash-${id}`,
  createdAt: new Date(),
});

let seq = 0;
const makeRecord = (typeId: string, content: Record<string, unknown>): StackRecord => ({
  id: `rec-${String(seq++).padStart(4, '0')}`,
  typeId,
  createdAt: new Date(),
  updatedAt: new Date(),
  content,
  version: 1,
});

const create = async (typeId: string, content: Record<string, unknown>): Promise<StackRecord> =>
  adapter.createRecord(makeRecord(typeId, content));

/** Every record the query matches, followed to the last page. */
const pagedTitles = async (query: StackQuery): Promise<string[]> => {
  const titles: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await adapter.queryRecords({ ...query, ...(cursor && { cursor }) });
    titles.push(...page.records.map((r) => r.content.title as string));
    cursor = page.cursor ?? undefined;
  } while (cursor);
  return titles;
};

const titles = async (query: StackQuery): Promise<string[]> =>
  (await adapter.queryRecords(query)).records.map((r) => r.content.title as string);

beforeEach(async () => {
  testDir = join(tmpdir(), `sort-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  adapter = await NativeSQLiteRecordAdapter.initialize({
    path: join(testDir, 'test.db'),
    entityId: 'entity-123',
  });
  await adapter.saveType(
    type(ARTICLE, {
      title: { kind: 'string', required: true },
      publishedAt: { kind: 'date' },
      order: { kind: 'number' },
      tags: { kind: 'array', items: { kind: 'string' } },
    }),
  );
  await adapter.saveType(
    type(RANKED, { title: { kind: 'string', required: true }, order: { kind: 'string' } }),
  );
});

afterEach(async () => {
  await adapter.close?.();
  rmSync(testDir, { recursive: true, force: true });
});

// -------------------------------------------------------
// Ordering
// -------------------------------------------------------

describe('sorting by a content field', () => {
  test('orders a date field as an instant, not as its stored string', async () => {
    await create(ARTICLE, { title: 'b', publishedAt: '2021-06-01T00:00:00Z' });
    await create(ARTICLE, { title: 'a', publishedAt: '2020-12-31T23:00:00-05:00' });
    await create(ARTICLE, { title: 'c', publishedAt: '2021-01-01T00:00:00Z' });

    expect(await titles({ sort: { contentField: 'publishedAt', direction: 'asc' } })).toEqual([
      'c',
      'a',
      'b',
    ]);
  });

  test('orders a number field numerically', async () => {
    for (const order of [10, 9, 100]) await create(ARTICLE, { title: `n${order}`, order });

    expect(await titles({ sort: { contentField: 'order', direction: 'asc' } })).toEqual([
      'n9',
      'n10',
      'n100',
    ]);
  });

  test('orders text by a case- and accent-folded key', async () => {
    for (const title of ['Zebra', 'apple', 'Émile']) await create(ARTICLE, { title });

    expect(await titles({ sort: { contentField: 'title', direction: 'asc' } })).toEqual([
      'apple',
      'Émile',
      'Zebra',
    ]);
    expect(await titles({ sort: { contentField: 'title', direction: 'desc' } })).toEqual([
      'Zebra',
      'Émile',
      'apple',
    ]);
  });

  test('a record with no value at the field sorts last in both directions', async () => {
    await create(ARTICLE, { title: 'dated', publishedAt: '2021-01-01T00:00:00Z' });
    await create(ARTICLE, { title: 'undated' });
    await create(ARTICLE, { title: 'older', publishedAt: '2020-01-01T00:00:00Z' });

    expect(await titles({ sort: { contentField: 'publishedAt', direction: 'asc' } })).toEqual([
      'older',
      'dated',
      'undated',
    ]);
    expect(await titles({ sort: { contentField: 'publishedAt', direction: 'desc' } })).toEqual([
      'dated',
      'older',
      'undated',
    ]);
  });

  test('numbers precede text where two types spell one field differently', async () => {
    await create(RANKED, { title: 'text', order: 'aaa' });
    await create(ARTICLE, { title: 'number', order: 2 });
    await create(ARTICLE, { title: 'none' });

    expect(await titles({ sort: { contentField: 'order', direction: 'asc' } })).toEqual([
      'number',
      'text',
      'none',
    ]);
    expect(await titles({ sort: { contentField: 'order', direction: 'desc' } })).toEqual([
      'text',
      'number',
      'none',
    ]);
  });

  test('a value inside an array orders nothing — sorting stops at depth 1', async () => {
    await create(ARTICLE, { title: 'listed', tags: ['a'] });
    await create(ARTICLE, { title: 'plain' });

    // Both records carry no *top-level scalar* at `tags`, so neither is
    // ordered by it and the id tiebreak decides.
    expect(await titles({ sort: { contentField: 'tags', direction: 'asc' } })).toEqual([
      'listed',
      'plain',
    ]);
  });

  test('total counts records, not joined index rows', async () => {
    for (const title of ['a', 'b', 'c']) await create(ARTICLE, { title, order: 1 });

    const result = await adapter.queryRecords({ sort: { contentField: 'order' } });
    expect(result.total).toBe(3);
    expect(result.records).toHaveLength(3);
  });
});

// -------------------------------------------------------
// Pagination
// -------------------------------------------------------

describe('paginating a content sort', () => {
  test('a page boundary inside each partition resumes where it left off', async () => {
    await create(ARTICLE, { title: 'num-1', order: 1 });
    await create(ARTICLE, { title: 'num-2', order: 2 });
    await create(RANKED, { title: 'text-a', order: 'a' });
    await create(RANKED, { title: 'text-b', order: 'b' });
    await create(ARTICLE, { title: 'absent-1' });
    await create(ARTICLE, { title: 'absent-2' });

    // Absent values trail either way; among them the id tiebreak turns
    // over with the direction, as it does for every other sort.
    const ordered = ['num-1', 'num-2', 'text-a', 'text-b', 'absent-1', 'absent-2'];
    for (const limit of [1, 2, 3]) {
      expect(
        await pagedTitles({ sort: { contentField: 'order', direction: 'asc' }, limit }),
      ).toEqual(ordered);
    }
    for (const limit of [1, 2, 3]) {
      expect(
        await pagedTitles({ sort: { contentField: 'order', direction: 'desc' }, limit }),
      ).toEqual(['text-b', 'text-a', 'num-2', 'num-1', 'absent-2', 'absent-1']);
    }
  });

  test('two values that fold together page in a stable order', async () => {
    for (const title of ['Emile', 'Émile', 'emile']) await create(ARTICLE, { title });

    const paged = await pagedTitles({
      sort: { contentField: 'title', direction: 'asc' },
      limit: 1,
    });
    expect(paged).toEqual(await titles({ sort: { contentField: 'title', direction: 'asc' } }));
    expect(paged).toHaveLength(3);
  });

  test('a cursor from another sort is refused rather than resumed', async () => {
    await create(ARTICLE, { title: 'a', order: 1 });
    await create(ARTICLE, { title: 'b', order: 2 });

    const page = await adapter.queryRecords({ sort: { contentField: 'order' }, limit: 1 });
    const cursor = page.cursor as string;

    await expect(adapter.queryRecords({ sort: { contentField: 'title' }, cursor })).rejects.toThrow(
      StackQueryError,
    );
    await expect(adapter.queryRecords({ sort: { field: 'createdAt' }, cursor })).rejects.toThrow(
      StackQueryError,
    );
    await expect(adapter.queryRecords({ cursor })).rejects.toThrow(StackQueryError);
  });

  test('a native cursor is refused by a content sort', async () => {
    await create(ARTICLE, { title: 'a' });
    await create(ARTICLE, { title: 'b' });

    const page = await adapter.queryRecords({ sort: { field: 'createdAt' }, limit: 1 });
    await expect(
      adapter.queryRecords({ sort: { contentField: 'title' }, cursor: page.cursor as string }),
    ).rejects.toThrow(StackQueryError);
  });
});

// -------------------------------------------------------
// Index maintenance
// -------------------------------------------------------

describe('the sort index tracks the record', () => {
  test('a content write reorders the record', async () => {
    const first = await create(ARTICLE, { title: 'first', order: 1 });
    await create(ARTICLE, { title: 'second', order: 2 });

    await adapter.patchContent(first.id, { order: 3 });
    expect(await titles({ sort: { contentField: 'order', direction: 'asc' } })).toEqual([
      'second',
      'first',
    ]);
  });

  test('clearing a field moves the record to the end', async () => {
    const dated = await create(ARTICLE, { title: 'dated', publishedAt: '2021-01-01T00:00:00Z' });
    await create(ARTICLE, { title: 'older', publishedAt: '2020-01-01T00:00:00Z' });

    await adapter.patchContent(dated.id, { publishedAt: null });
    expect(await titles({ sort: { contentField: 'publishedAt', direction: 'asc' } })).toEqual([
      'older',
      'dated',
    ]);
  });

  test('a migration reindexes against the type it moved to', async () => {
    await adapter.saveType(
      type('com.example.test/article@2', {
        title: { kind: 'string', required: true },
        order: { kind: 'string' },
      }),
    );
    const record = await create(ARTICLE, { title: 'moved', order: 2 });
    await create(RANKED, { title: 'text', order: 'a' });

    await adapter.commitMigration(record.id, 'com.example.test/article@2', {
      title: 'moved',
      order: 'b',
    });

    // `order` is text on the type it migrated to, so it now sorts among
    // the text values rather than ahead of them.
    expect(await titles({ sort: { contentField: 'order', direction: 'asc' } })).toEqual([
      'text',
      'moved',
    ]);
  });

  test('a purged record leaves no index rows behind', async () => {
    const record = await create(ARTICLE, { title: 'gone', order: 1 });
    await adapter.deleteRecord(record.id, { hard: true });

    const rows = adapter.db
      .prepare('SELECT COUNT(*) AS n FROM content_sort WHERE record_id = ?')
      .get(record.id) as { n: number };
    expect(rows.n).toBe(0);
  });

  test('a record written before its type was cached is still indexed', async () => {
    // The write path reads the schema straight from storage when a typeId
    // hasn't come through saveType() in this process — e.g. right after
    // open().
    await create(ARTICLE, { title: 'b', order: 2 });
    await adapter.close?.();
    adapter = await NativeSQLiteRecordAdapter.open({
      path: join(testDir, 'test.db'),
    });
    await create(ARTICLE, { title: 'a', order: 1 });

    expect(await titles({ sort: { contentField: 'order', direction: 'asc' } })).toEqual(['a', 'b']);
  });
});
