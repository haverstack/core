import { describe, expect, test } from 'vitest';
import { MemoryAdapter } from '../src/testing.js';

describe('MemoryAdapter blobs', () => {
  test('a Buffer passed to putBlob is copied, and getBlob returns a plain Uint8Array', async () => {
    const adapter = await MemoryAdapter.open({ ownerEntityId: 'owner' });
    const input = Buffer.from('caller keeps this');
    const original = new Uint8Array(input);
    const fileId = await adapter.putBlob(input);
    input.fill(0);

    const out = await adapter.getBlob(fileId);
    expect(Object.getPrototypeOf(out)).toBe(Uint8Array.prototype);
    expect(out).toEqual(original);
    out.fill(0);
    expect(await adapter.getBlob(fileId)).toEqual(original);
  });
});
