/**
 * MemoryAdapter's pagination cursor is the reference double adapter
 * authors read to understand the contract, so its codec has to hold the
 * same edges the real ones do: a sort field that isn't Latin-1 must
 * survive the round trip, and an offset that arrives from the wire must
 * be rejected when it is out of range rather than silently re-slicing
 * the result set from the other end.
 */
import { describe, test, expect, beforeEach } from 'vitest';
import { MemoryAdapter } from '../src/testing.js';
import { StackBadRequestError } from '../src/errors.js';
import type { StackRecord } from '../src/types.js';

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
  adapter = new MemoryAdapter();
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

  test('refuses a cursor carrying a negative offset', async () => {
    const forged = btoa(JSON.stringify({ d: JSON.stringify([null, 'createdAt', 'desc']), o: -3 }));

    // Left unchecked this slices from the tail and returns the last
    // records as "page 2"; cursors reach the adapter straight off the
    // wire, so nothing upstream would have caught it.
    await expect(adapter.queryRecords({ limit: 3, cursor: forged })).rejects.toThrow(
      StackBadRequestError,
    );
  });

  test('still refuses a cursor minted under a different sort', async () => {
    const first = await adapter.queryRecords({ limit: 2, sort: { field: 'createdAt' } });
    await expect(
      adapter.queryRecords({ limit: 2, cursor: first.cursor!, sort: { field: 'updatedAt' } }),
    ).rejects.toThrow(StackBadRequestError);
  });
});
