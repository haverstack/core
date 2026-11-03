import { describe, test, expect } from 'vitest';
import { trackWrites } from '../src/adapter/head.js';

/** A store whose write waits until the test lets it land. */
class SlowStore {
  writes = 0;
  release: (() => void) | undefined;
  readonly head = trackWrites(this);

  async putBlob(): Promise<string> {
    await new Promise<void>((resolve) => (this.release = resolve));
    this.writes++;
    return 'f';
  }

  async deleteBlob(): Promise<void> {
    throw new Error('refused');
  }

  async getBlob(): Promise<Uint8Array> {
    return new Uint8Array();
  }
}

// A head promises that two equal reads saw nothing written between them.
// See docs/spec/portability.md § Copying a stack.
describe('trackWrites', () => {
  test('a head stands still while nothing is written', async () => {
    const store = new SlowStore();
    await store.getBlob();
    expect(store.head.read()).toBe(store.head.read());
  });

  test('a head read while a write is in flight matches no other', async () => {
    const store = new SlowStore();
    const before = store.head.read();
    const writing = store.putBlob();
    const during = [store.head.read(), store.head.read()];
    store.release!();
    await writing;
    const after = store.head.read();

    expect(new Set([before, ...during, after]).size).toBe(4);
    expect(store.head.read()).toBe(after);
  });

  test('a refused write moves the head too', async () => {
    const store = new SlowStore();
    const before = store.head.read();
    await expect(store.deleteBlob()).rejects.toThrow('refused');
    expect(store.head.read()).not.toBe(before);
  });

  test('the wrapped method keeps its own `this` and result', async () => {
    const store = new SlowStore();
    const writing = store.putBlob();
    store.release!();
    expect(await writing).toBe('f');
    expect(store.writes).toBe(1);
  });
});
