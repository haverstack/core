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
import { StackQueryError } from './errors.js';
import { bumpsVersion } from './record-changes.js';

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
  /**
   * The container a move took the record out of, `null` for the root.
   * Emitter-side only, like `record`: it exists so a `parentId` filter can
   * answer for the origin as well as the destination, and no frame carries
   * it — a subscriber compares the frame's `parentId` to its own filter to
   * tell an arrival from a departure. Present on `reparent`, and on a
   * `restore` that put a different container back; absent wherever the
   * record did not move. See docs/spec/events.md § The reparent transition.
   */
  previousParentId?: string | null;
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
    // A move is announced to both containers it concerns: the record's
    // post-change state answers for the destination, and the origin has
    // only `previousParentId` to be found by. Which ops move a record is
    // the emitter's to say — a null origin is a move off the root, not an
    // absent one. See docs/spec/events.md § The reparent transition.
    const origin = emitted.previousParentId === undefined ? parentId : emitted.previousParentId;
    if (parentId !== filter.parentId && origin !== filter.parentId) return false;
  }

  if (filter.entityId !== undefined && record.entityId !== filter.entityId) return false;

  return true;
}

/**
 * Whether an emission passes the unlisted-enumeration boundary for one
 * subscription. Unlisted records are excluded from the feed by default,
 * exactly as they are from an unfiltered `query()` — with one exception:
 * the `unlist` transition itself must still reach a subscriber lacking
 * `includeUnlisted`, despite its post-change record (`unlistedAt` now set)
 * otherwise failing this very check. Without that exception a subscriber
 * who already knows the record would never be told to drop it. Every other
 * transition (create-unlisted, an edit while already unlisted, a purge of
 * a record that was never listed, the `list` transition itself) needs no
 * special-casing: it falls out of checking the record's current state.
 * See docs/spec/events.md § The unlisted transition.
 */
export function passesUnlistedBoundary(emitted: EmittedChange, includeUnlisted?: boolean): boolean {
  if (includeUnlisted) return true;
  if (emitted.change.ops.includes('unlist')) return true;
  return !emitted.record.unlistedAt;
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
    if (!passesUnlistedBoundary(emission, this.opts.includeUnlisted)) return;
    this.deliver(emission);
  }
}

/**
 * Assemble what the emitter knows about one mutation.
 *
 * The actor is read off the record for every version-bumping op, because
 * `updatedBy`/`updatedVia` were stamped by that same write and so agree
 * with what was persisted by construction. `associate`/`dissociate` don't
 * bump, so they stamp nothing on the record either — their actor travels
 * as `opts.actor` instead, the same way hard delete's does, since reading
 * the record would report whoever's *last version-bumping write* this is,
 * not who just changed the association. Hard delete stamps nothing and
 * leaves nothing to read, so its actor is the requester, passed in. A
 * purge also drops `parentId` and the create-time `appId`: the frame says
 * that a record of some type was destroyed, and nothing further about
 * whose it was. See docs/spec/events.md § Purged records carry nothing.
 */
export function buildEmission(
  ops: ChangeOp | ChangeOp[],
  record: StackRecord,
  opts: { actor?: ChangeActor; at?: Date; previousParentId?: string | null } = {},
): EmittedChange {
  const list = Array.isArray(ops) ? ops : [ops];
  if (list.length === 0) {
    throw new Error('buildEmission: a change reports at least one op');
  }
  const kind = resolveKind(list);

  if (kind === 'purged') {
    return {
      record,
      change: {
        kind,
        ops: list,
        recordId: record.id,
        typeId: record.typeId,
        version: record.version,
        updatedAt: opts.at ?? new Date(),
        ...(opts.actor && { actor: opts.actor }),
      },
    };
  }

  // A non-bumping write (associate/dissociate) never stamped the record,
  // so `record.updatedBy` reports whoever's last *bumping* write this is,
  // not who just changed the association — only opts.actor is trustworthy.
  const actor = bumpsVersion(list) ? (opts.actor ?? actorOf(record, kind)) : opts.actor;
  return {
    record,
    ...(opts.previousParentId !== undefined && { previousParentId: opts.previousParentId }),
    change: {
      kind,
      ops: list,
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
/**
 * The kind a set of ops resolves to: the most conservative entry wins.
 * `unlist` beats everything a change set can carry beside it, because a
 * subscriber holding the record still has to drop it — announcing an
 * edit bundled with an unlist as an upsert would leave a stale copy
 * behind. Nothing else competes: `created` and `purged` name whole-record
 * transitions that are always emitted alone, so a multi-op set is always
 * `changed` unless it unlists.
 * See docs/spec/events.md § The event shape.
 */
function resolveKind(ops: ChangeOp[]): ChangeKind {
  if (ops.includes('unlist')) return 'deleted';
  if (ops.length === 1) return CHANGE_KINDS[ops[0]!];
  return 'changed';
}

export const CHANGE_KINDS: Record<ChangeOp, ChangeKind> = {
  create: 'created',
  patch: 'changed',
  associate: 'changed',
  dissociate: 'changed',
  permissions: 'changed',
  migrate: 'changed',
  restore: 'changed',
  undelete: 'changed',
  delete: 'deleted',
  'hard-delete': 'purged',
  list: 'changed',
  unlist: 'deleted',
  reparent: 'changed',
};

/**
 * A resume cursor is opaque, but not arbitrary: it travels in an SSE `id:`
 * field, so a value spanning a line would truncate the frame carrying it.
 * Same charset and same reason as the auth nonce — see
 * docs/spec/change-feed.md § Frames.
 */
const SEQ_FORMAT = /^[A-Za-z0-9_-]+$/;

/**
 * `since` only means something where a relay exists: a stack with no
 * third party whose writes could have been missed has no cursor it could
 * ever have minted. Silently starting from the present would let the
 * caller believe it resumed when it did not, so a stack that cannot honor
 * `since` refuses it rather than ignoring it.
 *
 * Its shape is checked here rather than left to the adapter, so that a
 * malformed cursor is the same error whoever is underneath — the posture
 * query() already takes with a filter no adapter declared. The value stays
 * opaque: this asks whether it is framable, never what it means. See
 * docs/spec/events.md § Subscribing.
 */
export function assertSinceUsable(since: string | undefined, relaysChanges: boolean): void {
  if (since === undefined) return;
  if (!relaysChanges) {
    throw new StackQueryError(
      'subscribe() was passed `since`, but this stack relays no changes from elsewhere and so ' +
        'has no cursor it could ever have minted. Omit `since` — or, for a stack that relays ' +
        'from a server, use the seq off a previously delivered RecordChange.',
    );
  }
  if (!SEQ_FORMAT.test(since)) {
    throw new StackQueryError(
      `subscribe() was passed the resume cursor "${since}", which is not a valid seq: a cursor ` +
        'carries unreserved base64url characters only, because it travels in a frame id. Use ' +
        'the seq off a previously delivered RecordChange, unaltered.',
    );
  }
}
