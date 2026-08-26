/**
 * Stack — Change Events
 * -------------------------------------------------------
 * The emitter behind StackClient.subscribe(): a subscriber registry, the
 * filter predicate, and the projection that turns what the emitter knows
 * into what a subscriber is allowed to see.
 *
 * The split between those last two is the point of this module. Emission
 * always carries the record — a permission filter has nothing to decide
 * with otherwise, and on a hard delete there is nothing left to fetch —
 * while the frame handed to a handler is projected from it. So the rule
 * that a purge discloses neither the record nor its provenance is a
 * property of one function here, not a convention every emission site has
 * to remember. See docs/spec/events.md.
 */

import type {
  ChangeActor,
  ChangeFilter,
  ChangeKind,
  ChangeOp,
  RecordChange,
  StackRecord,
  SubscribeOptions,
  Unsubscribe,
} from './types.js';

/**
 * What the emitter knows: the envelope, plus the record it describes.
 * `record` is the filtering input and is never delivered unprojected —
 * emitted() is the only way out.
 */
export type EmittedChange = {
  change: Omit<RecordChange, 'record'>;
  /**
   * The record as of the change; for `purged`, as it stood immediately
   * before destruction. Present for every emission, including the ones
   * whose frames must not carry it.
   */
  record: StackRecord;
};

/** The `baseId@version` split, as grants and query filters read it. */
const baseIdOf = (typeId: string): string => typeId.split('@')[0]!;

/**
 * Whether an emission matches a subscription's filter. Reads the record
 * for the fields the envelope deliberately omits, so `entityId` filters on
 * the author and `purged` frames stay filterable without carrying either.
 */
export function matchesFilter(emitted: EmittedChange, filter?: ChangeFilter): boolean {
  if (!filter) return true;
  const { change, record } = emitted;

  if (filter.kinds && !filter.kinds.includes(change.kind)) return false;

  if (filter.typeId !== undefined) {
    const wanted = Array.isArray(filter.typeId) ? filter.typeId : [filter.typeId];
    const family = baseIdOf(change.typeId);
    if (!wanted.some((t) => baseIdOf(t) === family)) return false;
  }

  if (filter.parentId !== undefined) {
    const parentId = record.parentId ?? null;
    if (parentId !== filter.parentId) return false;
  }

  if (filter.entityId !== undefined && record.entityId !== filter.entityId) return false;

  return true;
}

/**
 * The frame a subscriber receives. A `purged` frame never carries the
 * record, whatever was asked for: hard delete is the erasure primitive,
 * and a frame that shipped the body — or the author — of a record the
 * stack has just destroyed would hand every subscriber a permanent copy of
 * the thing being erased. See docs/spec/events.md § Purged records carry
 * nothing.
 *
 * The record rides by reference, shared across every frame projected from
 * one emission: handlers are contractually read-only over it, and copying
 * per subscriber would charge every consumer for a defect none of them
 * have. See docs/spec/events.md § The event shape.
 */
export function emitted(emission: EmittedChange, includeRecords: boolean): RecordChange {
  const { change, record } = emission;
  if (change.kind === 'purged' || !includeRecords) return { ...change };
  return { ...change, record };
}

/**
 * One subscription's delivery. Subclassed rather than parameterized
 * because the two deliveries differ in kind: an unscoped subscriber is
 * handed the frame inline, while a scoped one has an async permission
 * decision to make first.
 */
export abstract class Subscription {
  private closed = false;

  constructor(
    protected readonly handler: (change: RecordChange) => void,
    protected readonly opts: SubscribeOptions,
  ) {}

  /** Called by the emitter for every change, filtered or not. */
  abstract accept(emission: EmittedChange): void;

  get isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    this.closed = true;
  }

  /**
   * Hand a frame to the handler. A handler that throws cannot fail the
   * write it is being told about — the write is already durable — so the
   * error goes to onError, or is rethrown asynchronously so that it
   * surfaces as an unhandled error rather than vanishing.
   */
  protected deliver(emission: EmittedChange): void {
    if (this.closed) return;
    try {
      this.handler(emitted(emission, this.opts.includeRecords === true));
    } catch (err) {
      this.reportError(err);
    }
  }

  protected reportError(err: unknown): void {
    reportError(err, this.opts);
  }
}

/**
 * Where a handler's error goes. Without an onError it is rethrown
 * asynchronously so that it surfaces as an unhandled error rather than
 * vanishing — never into the call stack of the mutation that produced the
 * event, which is already durable. See docs/spec/events.md § Handlers.
 */
function reportError(err: unknown, opts: SubscribeOptions): void {
  if (opts.onError) {
    try {
      opts.onError(err);
    } catch {
      // An onError that throws has nowhere left to report to. Losing it is
      // better than letting it escape into a mutation's call stack.
    }
    return;
  }
  queueMicrotask(() => {
    throw err;
  });
}

/**
 * Delivery for frames that originate elsewhere. A relayed frame arrives
 * already projected and already scoped by the authority that opened the
 * feed, so nothing here filters it again: the emitter that produced it saw
 * the record, and this one never will — a purge in particular leaves
 * nothing to decide with. See docs/spec/events.md § Where events come from.
 *
 * It is delivered to one subscriber rather than through the emitter,
 * because a relay is opened per subscription and carries that
 * subscription's filter. Handing it to the registry would give every other
 * subscriber a copy of a stream it did not ask for.
 */
export class RelayDelivery {
  private closed = false;

  constructor(
    private readonly handler: (change: RecordChange) => void,
    private readonly opts: SubscribeOptions,
  ) {}

  deliver(change: RecordChange): void {
    if (this.closed) return;
    try {
      this.handler(change);
    } catch (err) {
      reportError(err, this.opts);
    }
  }

  close(): void {
    this.closed = true;
  }
}

/**
 * Delivery with no permission boundary: `Stack` is the unscoped layer, so
 * a subscriber there already reaches every record by other means.
 */
class UnscopedSubscription extends Subscription {
  accept(emission: EmittedChange): void {
    if (!matchesFilter(emission, this.opts.filter)) return;
    this.deliver(emission);
  }
}

/**
 * Assemble what the emitter knows about one mutation.
 *
 * The actor is read off the record for every version-bumping op, because
 * `updatedBy`/`updatedVia` were stamped by that same write and so agree
 * with what was persisted by construction. Hard delete stamps nothing and
 * leaves nothing to read, so its actor is the requester, passed in. A
 * purge also drops `parentId` and the create-time `appId`: the frame says
 * that a record of some type was destroyed, and nothing further about
 * whose it was. See docs/spec/events.md § Purged records carry nothing.
 */
export function buildEmission(
  op: ChangeOp,
  record: StackRecord,
  opts: { actor?: ChangeActor; at?: Date } = {},
): EmittedChange {
  const kind = CHANGE_KINDS[op];

  if (kind === 'purged') {
    return {
      record,
      change: {
        kind,
        op,
        recordId: record.id,
        typeId: record.typeId,
        version: record.version,
        updatedAt: opts.at ?? new Date(),
        ...(opts.actor && { actor: opts.actor }),
      },
    };
  }

  const actor = actorOf(record, kind);
  return {
    record,
    change: {
      kind,
      op,
      recordId: record.id,
      typeId: record.typeId,
      version: record.version,
      updatedAt: record.updatedAt,
      ...(record.parentId !== undefined && { parentId: record.parentId }),
      ...(actor && { actor }),
    },
  };
}

/**
 * The acting identity a stored record reports. `appId` rides along only on
 * a create, the one mutation where the record's app and the acting app are
 * the same fact — on any later version it is the *creating* app, which
 * describes the record rather than the change.
 */
function actorOf(record: StackRecord, kind: ChangeKind): ChangeActor | undefined {
  if (!record.updatedBy) return undefined;
  return {
    entityId: record.updatedBy,
    ...(record.updatedVia !== undefined && { principalId: record.updatedVia }),
    ...(kind === 'created' && record.appId !== undefined && { appId: record.appId }),
  };
}

/**
 * The subscriber registry. One per `Stack`; `ScopedStack` filters the same
 * stream rather than opening its own, so a scoped view can never observe a
 * change the stack did not emit.
 */
export class ChangeEmitter {
  private readonly subscriptions = new Set<Subscription>();

  emit(emission: EmittedChange): void {
    // Snapshotted: a handler may subscribe or unsubscribe while this loop
    // runs, and neither should be seen by the emission already in flight.
    for (const subscription of [...this.subscriptions]) {
      if (!subscription.isClosed) subscription.accept(emission);
    }
  }

  add(subscription: Subscription): Unsubscribe {
    this.subscriptions.add(subscription);
    return () => {
      subscription.close();
      this.subscriptions.delete(subscription);
    };
  }

  subscribe(handler: (change: RecordChange) => void, opts: SubscribeOptions): Unsubscribe {
    return this.add(new UnscopedSubscription(handler, opts));
  }

  /** Ends every subscription — a closed stack emits nothing further. */
  closeAll(): void {
    for (const subscription of this.subscriptions) subscription.close();
    this.subscriptions.clear();
  }
}

/** The kind each op produces. See docs/spec/events.md § The event shape. */
export const CHANGE_KINDS: Record<ChangeOp, ChangeKind> = {
  create: 'created',
  update: 'changed',
  associate: 'changed',
  dissociate: 'changed',
  permissions: 'changed',
  migrate: 'changed',
  restore: 'changed',
  undelete: 'changed',
  delete: 'deleted',
  'hard-delete': 'purged',
};
