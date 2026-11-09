/**
 * Write heads
 * -------------------------------------------------------
 * A head says where a store's writes stand, so a reader that takes one
 * before and one after learns whether anything was written between. A
 * local store's writer is the process that owns it, so that process can
 * count its own writes: trackWrites() wraps every write method an adapter
 * has, so no method has to remember to. The count starts in a random
 * epoch, so a store reopened (or a server restarted) never returns to a
 * head it reported before. See docs/spec/portability.md § Copying a stack.
 */

import type { StoreWriteMethod } from '../types/index.js';

/**
 * Every write method, keyed so a method added to StackAdapter fails
 * typecheck here until it is listed or named a read.
 */
const WRITE_METHODS: Record<StoreWriteMethod, true> = {
  createRecord: true,
  importRecord: true,
  patchContent: true,
  deleteRecord: true,
  undeleteRecord: true,
  setParent: true,
  setUnlisted: true,
  editAssociations: true,
  setAssociations: true,
  editAccess: true,
  setAccess: true,
  restoreVersion: true,
  commitMigration: true,
  saveType: true,
  deleteUnreferencedAttachmentRecords: true,
  putBlob: true,
  deleteBlob: true,
  putAttachmentWithMetadata: true,
};

/** One store's writes, counted for its `head()`. */
class WriteHead {
  private readonly epoch = crypto.randomUUID();
  private settled = 0;
  private inFlight = 0;
  private busyReads = 0;

  /**
   * A write in flight may land on either side of a read, so a head read
   * meanwhile matches no other head; one read after it settles differs from
   * every head read before.
   */
  read(): string {
    if (this.inFlight) return `${this.epoch}.${this.settled}.${++this.busyReads}`;
    return `${this.epoch}.${this.settled}`;
  }

  async track<T>(write: () => Promise<T>): Promise<T> {
    this.inFlight++;
    try {
      return await write();
    } finally {
      this.inFlight--;
      this.settled++;
    }
  }
}

/** The head a `head()` reports. */
export type { WriteHead };

/**
 * Wrap every write method `adapter` has so it moves the returned head, and
 * return that head for the adapter's `head()` to read. Call once, from the
 * adapter's own constructor: it wraps the methods present then, so a write
 * method assigned as a field after that call goes uncounted (the
 * conformance suite's head tests catch one).
 */
export function trackWrites(adapter: object): WriteHead {
  const head = new WriteHead();
  const members = adapter as Record<string, unknown>;
  for (const name of Object.keys(WRITE_METHODS)) {
    const write = members[name];
    if (typeof write !== 'function') continue;
    members[name] = (...args: unknown[]) =>
      head.track(() => (write as (...a: unknown[]) => Promise<unknown>).apply(adapter, args));
  }
  return head;
}

/** The head of a store made of two halves: it moves when either does. */
export function combinedHead(record: string, blob: string): string {
  return `${record}/${blob}`;
}
