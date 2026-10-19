/**
 * The scoped change feed
 * -------------------------------------------------------
 * How a ScopedStack narrows the stack's change stream to what one
 * requester may read: canRead per event, decided in order, from authority
 * reads held for the life of the subscription.
 * See docs/spec/events.md § Permission scoping.
 */

import { baseIdOf } from '../schema.js';
import { Subscription, matchesFilter, passesUnlistedBoundary } from '../stack/changes.js';
import type { EmittedChange } from '../stack/changes.js';
import { presentDeleted } from '../record-changes.js';
import type { RecordChange, StackRecord, SubscribeOptions } from '../types/index.js';
import type { AuthorityReads } from './authority-reads.js';

/**
 * A ScopedStack's delivery: canRead per event, from authority reads held for
 * the subscription's life and dropped whenever an event changes them. Deliveries are serialized,
 * since the async decision could otherwise reorder changes, and the filter
 * fails closed. See docs/spec/events.md § Permission scoping.
 */
export class ScopedSubscription extends Subscription {
  /** Tail of the delivery chain — see the class comment. */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly reads: AuthorityReads,
    private readonly canRead: (record: StackRecord, reads: AuthorityReads) => Promise<boolean>,
    handler: (change: RecordChange) => void,
    opts: SubscribeOptions,
  ) {
    super(handler, opts);
  }

  accept(emission: EmittedChange): void {
    // Invalidation reads every emission, including the ones this
    // subscriber may not see: a revocation the subscriber cannot read is
    // exactly the one that must still expire its cache.
    this.invalidateFor(emission);
    if (!matchesFilter(emission, this.opts.filter)) return;
    this.queue = this.queue.then(() => this.filterAndDeliver(emission));
  }

  /**
   * A held grant set outlives the write that revokes it unless something
   * drops it. Both writes that can change canRead's answer — a `_grant`
   * record, or a `_group` roster — arrive here as ordinary events, which
   * is what makes the cache safe to hold at all. A future authority change
   * that did not emit would silently strand it.
   */
  private invalidateFor(emission: EmittedChange): void {
    this.reads.invalidateFor(baseIdOf(emission.change.typeId));
  }

  private async filterAndDeliver(emission: EmittedChange): Promise<void> {
    if (this.isClosed) return;
    if (!passesUnlistedBoundary(emission, this.opts.includeUnlisted)) return;
    try {
      if (!(await this.canRead(emission.record, this.reads))) return;
    } catch (err) {
      // Fail closed: an undecided permission question is not a yes.
      this.reportError(err);
      return;
    }
    // After the permission decision, which needs the whole record: a frame
    // carrying a deleted record's body would be a read channel around the
    // tombstone. See docs/spec/events.md § Soft-deleted records reach the
    // feed as tombstones.
    this.deliver(this.project(emission));
  }

  private project(emission: EmittedChange): EmittedChange {
    const record = presentDeleted(emission.record);
    return record === emission.record ? emission : { ...emission, record };
  }
}
