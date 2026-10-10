/**
 * The scoped change feed
 * -------------------------------------------------------
 * How a ScopedStack narrows the stack's change stream to what one
 * requester may read: canRead per event, decided in order, with the
 * authority lookups it needs cached for the life of the subscription.
 * See docs/spec/events.md § Permission scoping.
 */

import { baseIdOf } from '../schema.js';
import { Subscription, matchesFilter, passesUnlistedBoundary } from '../stack/changes.js';
import type { EmittedChange } from '../stack/changes.js';
import { presentDeleted } from '../record-changes.js';
import { SYSTEM_TYPES } from '../types/index.js';
import type { GroupRole, RecordChange, StackRecord, SubscribeOptions } from '../types/index.js';

/**
 * The authority lookups canRead needs, held for the life of one
 * subscription. A subscription is long-lived where a query is not, so the
 * cache is only safe because every write that can change canRead's answer
 * arrives as an event that drops it — see ScopedSubscription.
 */
export class FeedAuthorityCache {
  private grantRecords: StackRecord[] | null = null;
  /**
   * Bumped by every invalidation, so a load that was already in flight can
   * tell that its result is stale before seating it.
   */
  private generation = 0;
  /** Roster roles, memoized per group, as ScopedStack.query() does per query. */
  roles = new Map<string, GroupRole | null>();

  /** Every `_grant` record, refilled through `load` after an invalidation. */
  async grants(load: () => Promise<StackRecord[]>): Promise<StackRecord[]> {
    if (this.grantRecords !== null) return this.grantRecords;
    const generation = this.generation;
    const loaded = await load();
    // An invalidation during the load already dropped the set these
    // replace, so seating them would outlive the write that expired them
    // and no later event would drop them again. The event being decided
    // precedes that write, so it is still decided on what was loaded.
    if (this.generation === generation) this.grantRecords = loaded;
    return loaded;
  }

  invalidateFor(typeFamily: string): void {
    if (typeFamily === SYSTEM_TYPES.GRANT) {
      this.grantRecords = null;
      this.generation++;
    }
    if (typeFamily === SYSTEM_TYPES.GROUP) this.roles = new Map();
  }
}

/**
 * A ScopedStack's delivery: canRead per event, its grant and roster lookups
 * cached until anything feeding them changes. Deliveries are serialized,
 * since the async decision could otherwise reorder changes, and the filter
 * fails closed. See docs/spec/events.md § Permission scoping.
 */
export class ScopedSubscription extends Subscription {
  private readonly cache = new FeedAuthorityCache();
  /** Tail of the delivery chain — see the class comment. */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly canRead: (record: StackRecord, cache: FeedAuthorityCache) => Promise<boolean>,
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
   * A cached grant set outlives the write that revokes it unless something
   * drops it. Both writes that can change canRead's answer — a `_grant`
   * record, or a `_group` roster — arrive here as ordinary events, which
   * is what makes the cache safe to hold at all. A future authority change
   * that did not emit would silently strand it.
   */
  private invalidateFor(emission: EmittedChange): void {
    this.cache.invalidateFor(baseIdOf(emission.change.typeId));
  }

  private async filterAndDeliver(emission: EmittedChange): Promise<void> {
    if (this.isClosed) return;
    if (!passesUnlistedBoundary(emission, this.opts.includeUnlisted)) return;
    try {
      if (!(await this.canRead(emission.record, this.cache))) return;
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
