import { describe, test, expect } from 'vitest';
import { copyStack } from '../src/adapter/copy.js';
import { Stack } from '../src/stack/stack.js';
import { InvalidAdapterError, OwnerMismatchError, StackConflictError } from '../src/errors.js';
import { MemoryAdapter } from '../src/testing.js';
import type { StackAdapter } from '../src/types/index.js';

const OWNER = 'did:key:owner';
const NOTE = 'com.example.test/note@1';

const fresh = (ownerEntityId = OWNER, timezone: string | undefined = 'UTC') =>
  MemoryAdapter.open({ ownerEntityId, timezone });

async function sourceWith(notes: number): Promise<MemoryAdapter> {
  const adapter = await fresh();
  const stack = await Stack.open(adapter);
  await stack.defineType({ id: NOTE, name: 'Note', schema: { text: { kind: 'text' } } });
  for (let i = 0; i < notes; i++) await stack.create(NOTE, { text: `note ${i}` });
  return adapter;
}

describe('copyStack', () => {
  test('carries every page of records, not just the first', async () => {
    const source = await sourceWith(250);
    const target = await fresh();
    await copyStack(source, target);
    expect([...target.records.keys()].sort()).toEqual([...source.records.keys()].sort());
  });

  test('carries the bytes attachment records name, and not bytes no record names', async () => {
    const source = await sourceWith(0);
    const stack = await Stack.open(source);
    const named = await stack.putAttachment(new Uint8Array([1, 2, 3]), { mimeType: 'image/png' });
    const orphan = await source.putBlob(new Uint8Array([9, 9, 9]));
    const target = await fresh();
    await copyStack(source, target);
    expect(await target.getBlob(named.content.fileId)).toEqual(new Uint8Array([1, 2, 3]));
    expect(target.blobs.has(orphan)).toBe(false);
  });

  test('refuses a target with no importRecord(), writing nothing', async () => {
    const source = await sourceWith(1);
    const target: StackAdapter = await fresh();
    Object.defineProperty(target, 'importRecord', { value: undefined });
    await expect(copyStack(source, target)).rejects.toThrow(InvalidAdapterError);
    expect(await target.listTypes()).toEqual([]);
  });

  test('refuses a target owned by someone else', async () => {
    const source = await sourceWith(1);
    await expect(copyStack(source, await fresh('did:key:someone-else'))).rejects.toThrow(
      OwnerMismatchError,
    );
  });

  test('refuses a target that already holds records', async () => {
    const source = await sourceWith(1);
    const target = await sourceWith(1);
    await expect(copyStack(source, target)).rejects.toThrow(StackConflictError);
  });

  test('accepts a target Stack.open() has seeded with system types alone', async () => {
    const source = await sourceWith(1);
    const target = await fresh();
    await Stack.open(target);
    await copyStack(source, target);
    expect(target.records.size).toBe(source.records.size);
  });
});
