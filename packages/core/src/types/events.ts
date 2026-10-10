/**
 * Change events: what `subscribe()` delivers and the options it takes.
 */

import type { DataAssociation } from './associations.js';
import type { RecordId, TypeId, AppId, Actor } from './ids.js';
import type { RecordFilter } from './query.js';
import type { StackRecord } from './records.js';

/**
 * The coarse branch every subscriber makes, closed at four values. A
 * handler covering exactly these is complete, not merely adequate:
 * `changed` is an upsert signal carrying nine distinct verbs.
 * See docs/spec/events.md § The event shape.
 */
export type ChangeKind = 'created' | 'changed' | 'removed' | 'purged';

/**
 * The precise verb behind a ChangeKind, for consumers that distinguish a
 * reshare from an edit. Each is named after the call that produced it; see
 * docs/spec/events.md § The event shape for the three that aren't a method
 * name. `associate`, `dissociate`, `reshare`, `reparent`, `unlist` and
 * `list` don't bump; see docs/spec/versioning.md § Version history.
 */
export type ChangeOp =
  | 'create'
  | 'patch'
  | 'associate'
  | 'dissociate'
  | 'reshare'
  | 'migrate'
  | 'restore'
  | 'delete'
  | 'undelete'
  | 'purge'
  /**
   * Emitted even though the record's post-change state (`unlistedAt` now
   * set) would otherwise be excluded by the same filter it announces —
   * subscribers who already know the record need telling to drop it. See
   * docs/spec/events.md § The unlisted transition.
   */
  | 'unlist'
  /** The publish moment — mechanically an upsert, like `undelete`. */
  | 'list'
  /**
   * A move between containers. Matched by a `parentId` filter naming
   * *either* side of the move, so a subscriber watching the old container
   * learns the record left it — the record's post-change state alone
   * would answer only for the destination. See docs/spec/events.md
   * § The reparent transition.
   */
  | 'reparent';

/**
 * Who performed a change — never who authored the record. Absent from a
 * RecordChange entirely when unknown, which means a write by an unscoped
 * `Stack`: absence is a fact of its own and never stands in for the
 * author. See docs/spec/events.md § Attribution.
 */
export type ChangeActor = Actor & {
  /** Self-reported at create, never a trust input. See AppId. */
  appId?: AppId;
};

/**
 * One change to one record. The envelope describes the change; the record
 * describes the record, so nothing of the record's own provenance appears
 * here — a consumer that wants it asks for `record`.
 * See docs/spec/events.md § The event shape.
 */
export type RecordChange = {
  kind: ChangeKind;
  /**
   * Every aspect this version moved, diffed against prior state rather
   * than read off the request. Never empty; multi-entry only for mutate().
   * See docs/spec/events.md § The event shape.
   */
  ops: ChangeOp[];
  recordId: RecordId;
  /** As stored at the moment of the change. */
  typeId: TypeId;
  /**
   * The version this change produced; on `purged`, the version destroyed.
   * Unchanged from the record's prior version on every op that doesn't
   * bump — see ChangeOp.
   */
  version: number;
  /**
   * As persisted by this change; on `purged`, when the delete ran.
   * Unchanged from the record's prior `updatedAt` on every op that
   * doesn't bump.
   */
  updatedAt: Date;
  parentId?: RecordId;
  actor?: ChangeActor;
  /**
   * Associations now present that weren't before — current annotation
   * included, so a re-point appears here under its new
   * `attachmentRecordId`. Present whenever `ops` includes `associate`, on
   * the same "as of this change" convention as every other field here.
   */
  associationsAdded?: DataAssociation[];
  /**
   * Associations no longer present, identity only — kind and label, plus
   * `fileId` for an attachment — present whenever `ops` includes
   * `dissociate`. An attachment's `attachmentRecordId` is never repeated
   * here, the same way a `purged` frame never carries what it destroyed.
   */
  associationsRemoved?: DataAssociation[];
  /**
   * The record as of this change — present only when asked for and
   * available, never on `purged`. Shared with every other subscriber on
   * this emission, so a handler that needs to alter it copies first.
   */
  record?: StackRecord;
  /**
   * Resume cursor, minted by a server. Local changes carry none, this
   * stack's own writes included — so a consumer holding a cursor keeps
   * the last one that was present rather than the last change's.
   */
  cursor?: string;
};

/**
 * Applied by the emitter, exactly: a filtered subscription never receives
 * an event outside its filter, so filtering again is redundant rather than
 * defensive. Every key means what it means on `RecordFilter`, so one value
 * can drive both `query()` and `subscribe()`. See docs/spec/events.md
 * § Subscribing.
 */
export type ChangeFilter = Pick<RecordFilter, 'typeId' | 'baseId' | 'parentId' | 'createdBy'> & {
  kinds?: ChangeKind[];
};

/** Ends a subscription. Safe to call more than once. */
export type Unsubscribe = () => void;

/**
 * What a subscriber asks for, and what `Stack` forwards unchanged to an
 * adapter's `subscribeChanges()` relay — the relay honors every key.
 * See docs/spec/events.md § Subscribing and § Where events come from.
 */
export type SubscribeOptions = {
  filter?: ChangeFilter;
  /** Ask the emitter to include `record`. Honored when it can; never assume it. */
  includeRecords?: boolean;
  /**
   * Receive events for unlisted records too. Owner-only under
   * `ScopedStack`, same authority as `RecordFilter.includeUnlisted`.
   * See docs/spec/unlisted.md.
   */
  includeUnlisted?: boolean;
  /**
   * Resume from this cursor — the last `cursor` that was *present* on a
   * delivered `RecordChange`. Refused with `StackBadRequestError` on a
   * stack with no relay, which has no cursor it could have minted.
   * See docs/spec/events.md § Subscribing.
   */
  since?: string;
  /**
   * Where a throwing handler's error goes, and on a relaying stack a
   * connection the relay could not restore. Without one a handler error is
   * rethrown asynchronously; it never reaches the mutation's caller.
   */
  onError?: (err: unknown) => void;
  /**
   * A gap opened that resumption could not close: reconcile by query.
   * Never fires on a local stack. Can fire on the first connection when
   * the far end will not honor `since`.
   */
  onReset?: () => void;
};
