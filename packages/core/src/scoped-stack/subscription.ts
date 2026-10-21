/**
 * The scoped change feed
 * -------------------------------------------------------
 * How a ScopedStack narrows the stack's change stream to what one
 * requester may read: canRead per event, decided in order, from an
 * authority snapshot held for the life of the subscription.
 * See docs/spec/events.md § Permission scoping.
 */

import { baseIdOf } from '../schema.js';
import { Subscription, matchesFilter, passesUnlistedBoundary } from '../stack/changes.js';
import type { EmittedChange } from '../stack/changes.js';
import { presentDeleted } from '../record-changes.js';
import type { RecordChange, StackRecord, SubscribeOptions } from '../types/index.js';
import type { AuthoritySnapshot } from './authority-snapshot.js';

/**
 * A ScopedStack's delivery: canRead per event, from an authority snapshot
 * held for the subscription's life and cleared by any event that moves it.
 * Deliveries are serialized, since the async decision could otherwise
 * reorder changes, and the filter fails closed. See docs/spec/events.md § Permission scoping.
 */
export class ScopedSubscription extends Subscription {
  /** Tail of the delivery chain — see the class comment. */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly snapshot: AuthoritySnapshot,
    private readonly canRead: (
      record: StackRecord,
      snapshot: AuthoritySnapshot,
    ) => Promise<boolean>,
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
   * A held snapshot outlives the write that revokes it unless something
   * clears it. Both writes that can move it — a `_grant` record, or a
   * `_group` roster — arrive here as ordinary events, which is what makes
   * it safe to hold at all; a change that did not emit would strand it.
   */
  private invalidateFor(emission: EmittedChange): void {
    this.snapshot.invalidateFor(baseIdOf(emission.change.typeId));
  }

  private async filterAndDeliver(emission: EmittedChange): Promise<void> {
    if (this.isClosed) return;
    if (!passesUnlistedBoundary(emission, this.opts.includeUnlisted)) return;
    try {
      if (!(await this.canRead(emission.record, this.snapshot))) return;
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
