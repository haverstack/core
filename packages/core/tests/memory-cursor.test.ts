/**
 * MemoryAdapter's pagination cursor is the reference double adapter
 * authors read to understand the contract, so its codec has to hold the
 * same edges the real ones do: a sort field that isn't Latin-1 must
 * survive the round trip, a key that arrives from the wire must be
 * well-formed for the order it claims, and a page resumes after the record
 * its cursor names however the matched set moved in between.
 */
import { describe, test, expect, beforeEach } from 'vitest';
import { MemoryAdapter } from '../src/testing.js';
import { StackBadRequestError } from '../src/errors.js';
import type { StackRecord } from '../src/types/index.js';

const makeRecord = (id: string, priority: number): StackRecord => ({
  id,
  typeId: 'note@1',
  createdAt: new Date(),
  updatedAt: new Date(),
  content: { priority },
  version: 1,
});

let adapter: MemoryAdapter;

beforeEach(async () => {
  adapter = await MemoryAdapter.open({ ownerEntityId: 'did:key:test' });
  for (let i = 0; i < 6; i++) await adapter.createRecord(makeRecord(`r${i}`, i));
});

describe('MemoryAdapter cursors', () => {
  test('round-trips a sort on a content field whose name is not Latin-1', async () => {
    const sort = { contentField: '名前', direction: 'asc' as const };

    // btoa() on the raw descriptor would throw InvalidCharacterError here
    // — a DOMException, not a StackError, out of a valid query.
    const first = await adapter.queryRecords({ limit: 2, sort });
    expect(first.cursor).toBeTruthy();

    const second = await adapter.queryRecords({ limit: 2, cursor: first.cursor!, sort });
    expect(second.records.map((r) => r.id)).not.toEqual(first.records.map((r) => r.id));
  });

  test('refuses a cursor whose key does not fit the order it names', async () => {
    const forged = btoa(
      JSON.stringify({
        d: JSON.stringify([null, 'createdAt', 'desc']),
        k: { value: { kind: 'text', text: 'x', key: 'x' }, id: 'r1' },
      }),
    );
    await expect(adapter.queryRecords({ limit: 3, cursor: forged })).rejects.toThrow(
      StackBadRequestError,
    );
  });

  test('resumes after the record the cursor names, whatever was inserted ahead of it', async () => {
    const sort = { field: 'createdAt', direction: 'asc' } as const;
    const first = await adapter.queryRecords({ limit: 2, sort });
    await adapter.createRecord({ ...makeRecord('r-early', 9), createdAt: new Date(0) });
    const second = await adapter.queryRecords({ limit: 2, cursor: first.cursor!, sort });
    const all = (await adapter.queryRecords({ limit: 100, sort })).records.map((r) => r.id);
    const after = all.indexOf(first.records[1]!.id);
    expect(second.records.map((r) => r.id)).toEqual(all.slice(after + 1, after + 3));
  });

  test('still refuses a cursor minted under a different sort', async () => {
    const first = await adapter.queryRecords({
      limit: 2,
      sort: { field: 'createdAt', direction: 'desc' },
    });
    await expect(
      adapter.queryRecords({
        limit: 2,
        cursor: first.cursor!,
        sort: { field: 'updatedAt', direction: 'desc' },
      }),
    ).rejects.toThrow(StackBadRequestError);
  });

  test('replays an unsorted cursor under the equivalent explicit createdAt desc sort', async () => {
    const first = await adapter.queryRecords({ limit: 2 });
    const second = await adapter.queryRecords({
      limit: 2,
      cursor: first.cursor!,
      sort: { field: 'createdAt', direction: 'desc' },
    });
    expect(second.records.map((r) => r.id)).not.toEqual(first.records.map((r) => r.id));
  });

  test('refuses a named sort that carries no direction', async () => {
    await expect(adapter.queryRecords({ sort: { field: 'updatedAt' } })).rejects.toThrow(
      StackBadRequestError,
    );
  });
});
