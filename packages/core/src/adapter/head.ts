/**
 * Write heads
 * -------------------------------------------------------
 * A head says where a store's writes stand, so a reader that takes one
 * before and one after learns whether anything was written between. A
 * local store's writer is the process that owns it, so that process can
 * count its own writes; the count starts in a random epoch, so a store
 * reopened (or a server restarted) never repeats a head it reported
 * before. See docs/spec/portability.md § Copying a stack.
 */

/** Counts one store's writes, for its `head()`. */
export class WriteHead {
  private readonly epoch = crypto.randomUUID();
  private writes = 0;

  /** Call on every write. Before it runs is safe: a head may move when nothing changed. */
  moved(): void {
    this.writes++;
  }

  read(): string {
    return `${this.epoch}.${this.writes}`;
  }
}

/** The head of a store made of two halves: it moves when either does. */
export function combinedHead(record: string, blob: string): string {
  return `${record}/${blob}`;
}
