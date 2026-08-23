# Change events

Apps observe record changes by subscribing, rather than by polling `query()`. A subscription reports **that** something changed; `query()` and `get()` report **what** it now is.

**A change event is the observable side of the versioning one-rule.** Every mutation that snapshots prior state and bumps `version` emits exactly one event; hard delete, the one exception to that rule, is the one exception here too — it emits, carries no snapshot, and ends the record's stream. See [Versioning § Version history](./versioning.md#version-history).

Two things follow immediately:

- **The event set is closed and already enumerated.** It is the same exhaustive list [Wire format § Versions](./wire-format.md#versions) gives for endpoints that bump `version`, plus create and hard delete. Nothing is a judgement call.
- **A no-op mutation emits nothing.** Re-adding an association that is already present, setting a deep-equal permission set, deleting an already-deleted record — these bump no version, so they fire no event. A subscriber never sees a phantom change.

## What a feed is not

**A feed is a change notification, not a replication log.** It answers "something you can read changed"; it does not promise that a subscriber can reconstruct stack state from events alone. Three things make the stronger promise unavailable at this price:

- Permission changes move records into and out of a subscriber's view, and a revocation is deliberately invisible (see [Known limitations](#known-limitations)).
- Hard delete destroys history, so no reconcile-by-query can discover it afterwards.
- History is gated on the mutate surface rather than read access, so a stream rich enough to replay would route around [History access](./versioning.md#history-access).

So the pattern is **notify-then-reconcile**: the feed says _when_ to run a `query()`, and the query — already permission-filtered, already paginated — says _what_.

## The event shape

```ts
type ChangeKind = 'created' | 'changed' | 'deleted' | 'purged';

type ChangeOp =
  | 'create'
  | 'update'
  | 'associate'
  | 'dissociate'
  | 'permissions'
  | 'migrate'
  | 'restore'
  | 'delete'
  | 'undelete'
  | 'hard-delete';

type RecordChange = {
  kind: ChangeKind;
  op: ChangeOp;
  recordId: RecordId;
  typeId: TypeId; // as stored at the moment of the change
  version: number; // the version this change produced
  updatedAt: Date; // as persisted by this change
  parentId?: RecordId;
  actor?: ChangeActor;
  record?: StackRecord;
  seq?: string; // resume cursor, on a resumable feed only
};
```

`kind` and `op` map deterministically:

| `kind`    | `op`                                                                                 |
| --------- | ------------------------------------------------------------------------------------ |
| `created` | `create`                                                                             |
| `changed` | `update`, `associate`, `dissociate`, `permissions`, `migrate`, `restore`, `undelete` |
| `deleted` | `delete` (soft)                                                                      |
| `purged`  | `hard-delete`                                                                        |

**Two discriminators at different altitudes, not per-verb events.** `kind` is the coarse branch every consumer must make, and it is closed at four values: a subscriber that handles exactly `created`/`changed`/`deleted`/`purged` is _correct_, not merely adequate. `changed` is an **upsert** signal, never "you have seen this before" — a subscriber can receive `changed` for a record it has never seen, because gaining access arrives that way. `op` is the precise verb, for audit logs and sync engines that care whether a permission change or a content edit produced this version.

Named events per verb (`record:create`, `record:update`, `record:delete`) were rejected: a subscriber wiring three of them silently misses the other seven verbs, and the bug is invisible until an index drifts from the records it describes.

**The stub is the contract; the record body is an optional payload.** A subscriber is guaranteed identity, type, version, `parentId` and `actor` — enough to route an event without a fetch. `record` is present when the emitter has it and the subscriber asked for it (`includeRecords`), absent otherwise, and never required for correctness. A subscriber needing guaranteed-current state re-reads; `record` is that read's cache and may already be stale when it is handled.

Permission-wise the two are equivalent: **a subscriber who may not read a record receives no event about it at all**, so there is no case where the envelope is deliverable and the body is not. The body is a bandwidth decision, not an access one.

## Attribution

**The envelope describes the change; the record describes the record.** `actor` is who performed the change, and it is the only identity the envelope carries:

```ts
type ChangeActor = {
  entityId: EntityId; // the subject
  principalId?: EntityId; // the principal, when delegated
  appId?: AppId; // self-reported at create, never a trust input
};
```

The record's own provenance — `entityId`, `appId`, `principalId` as stored — is deliberately **not** in the envelope. Those fields mean _author_, frozen at creation, and a `RecordChange` carrying a field named `entityId` reads as "the entity behind this change", which is a different fact. A consumer that wants the record's fields asks for `record`, where they describe what they actually describe.

**`actor` is absent when unknown**, which means a write by an unscoped `Stack` — it has no requester to name. **Absent means unknown; it never means "the author"**, and a consumer must not substitute one for the other.

**Where it comes from.** For every mutation that bumps a version, the record carries it: `updatedBy` and `updatedVia` are stamped in the same write (see [Data model § Authorship and attribution](./data-model.md#authorship-and-attribution)), so reading them back after the write matches what was persisted by construction. **Hard delete is the exception, and the only one.** It destroys the record and bumps no version, so nothing is stamped and there is nothing left to read — a `purged` frame's actor comes from the request that performed the delete. That verb is owner-acting-alone and refuses delegation, so the actor there is always the owner, with no principal beside it.

`appId` rides a `created` frame only. It is self-reported at create and never recorded per mutation, so on any later version the record's `appId` is the _creating_ app — record provenance, not this change's actor.

**Attribution is record-level, not history-grade.** [Prior state is excluded](#prior-state-is-not-in-the-envelope) because history is gated on the mutate surface while a feed's gate is plain `canRead`. That argument is about prior _content_ — the revision someone deliberately edited out. Knowing that a record changed, and who changed it, reveals nothing about what was removed; and identity is already record-level, since `entityId` sits on the record where every reader sees it. "Who wrote version 7" is the same class of fact as "who wrote version 1".

## Purged records carry nothing

**A `purged` frame carries `kind`, `op`, `recordId`, `typeId`, `version`, `updatedAt` and `actor` — nothing else.** No `parentId`, no record provenance, and `record` is never present, whatever the subscriber asked for.

Hard delete is the erasure primitive: it destroys the record and its version history, and the reason to reach for it over soft delete is that no trace should remain (see [Versioning § Deletion](./versioning.md#deletion)).

The hazard is not disclosure at emission, which is already bounded — a subscriber who cannot read a record receives no event, so anyone holding a purge frame was entitled to its author anyway. **The hazard is durability.** A frame naming the author would hand every subscriber a permanent, un-erasable note — "this DID had a record here, and it was destroyed" — written into their logs at the moment the stack finished erasing its own copy. The stack cannot un-emit. An erasure primitive that seeds durable records of what was erased defeats itself.

What follows is worth keeping deliberately: **a purge event tells you to forget something you already knew, and tells someone who never knew it nothing.** `recordId` is opaque, so a subscriber holding the record can evict it and one that never held it learns nothing it could act on.

Filtering is unaffected: the emitter holds the record it destroyed, so a subscription filtered by `parentId` or `entityId` still receives exactly the purges that match. Those fields decide delivery without appearing in what is delivered.

## Prior state is not in the envelope

There is no `previous`. Prior state is already a first-class, addressable thing: `getVersion(id, version - 1)`. Shipping it inside an event would route around [History access](./versioning.md#history-access), which gates history on the **mutate surface** precisely so that sharing a record after editing something out does not hand every current reader the pre-edit revision. A feed's gate is plain `canRead`, so putting `previous` in the envelope would make every reader a history reader, in the one code path nobody would think to audit. A consumer needing a diff holds the mutate surface, and fetches the version.

## Handlers

**Handlers never block, delay, or fail a write.**

- **The write is durable before any handler runs.** A handler cannot veto, amend, or roll back what it is being told about.
- **A throwing handler cannot fail the write**, because there is nothing left to fail. The error goes to the subscription's `onError`; with no `onError` it is rethrown asynchronously so that it surfaces as an unhandled error rather than vanishing. It never reaches the caller of `create()`/`update()`.
- **Handlers are invoked after the adapter write resolves and before the mutating method's promise settles.** So `await stack.update(...)` guarantees subscribers have been _notified_, and guarantees nothing about work they deferred.

**An `async` handler is permitted; it is simply not awaited.** The handler type is `(change: RecordChange) => void`, and a `void` return means the value is ignored, not that the function must be synchronous. Passing an `async` function is the normal way to defer work: it runs to its first `await`, yields, and the emitter moves on. What it does not buy is ordering or completion.

**What "never delays a write" does and does not promise.** It is a guarantee about the emitter: no handler's returned promise is awaited, so a subscriber cannot extend a write by deferring work. It is not a guarantee against a handler's _synchronous_ body. Handlers run inline on the caller's thread, and a record adapter backed by `node:sqlite` has just run its write synchronously on that same thread ([Adapters § Adapter backends](./adapters.md#adapter-backends)), so a handler doing heavy synchronous work extends that occupied window. Handlers should return promptly and defer anything substantial.

An indexer that must not miss a write does not get that from a blocking hook — it gets it from a resumable cursor and idempotent application. A blocking hook buys a world where every subscriber is a latency and failure dependency of every write.

A pre-commit _validation_ hook is a different feature, with permission-bypass hazards of its own, and is not part of this one.

## Where events come from

**`Stack` emits; adapters do not** — except to relay a feed that originates elsewhere. Emission lives in the invariant layer for the same reason validation, `_config` protection and ID rules do: every adapter inherits it and none can forget it. Local adapters implement nothing.

The one adapter-side hook is the inverse direction:

```ts
// StackRecordAdapter, optional
subscribeChanges?(
  opts: { filter?: ChangeFilter; since?: string },
  handler: (change: RecordChange) => void,
): Promise<() => void>;
```

An optional method checked for truthiness at the call site, per [Adapters § Adapter capabilities](./adapters.md#adapter-capabilities) — never a boolean in `capabilities`. A remote adapter implements it; local adapters do not, and their absence is not a gap: [a stack's storage has exactly one owning process](./adapters.md#concurrency--storage-ownership), so locally there is no third party whose writes could have been missed. **Resumption is meaningful only in the multi-writer topology.**

**Every record emits, including the ones a query hides.** `_config` is [addressable only by ID](../spec.md#the-_config-record) and never returned by `query()`, but a change to it is a change like any other and reports as one — it is owner-only by permission and ungrantable, so the exclusion query() makes for addressability reasons is not a permission rule to mirror here. `_grant` and `_group` writes emit as ordinary record events too, which is load-bearing: they are what expires a cached authority decision (see [Permission scoping](#permission-scoping)).

**Records only, in v1.** An `_attachment@1` record _is_ a record, so attachment metadata rides the feed already; bare blob writes with no accompanying record emit nothing, as they are invisible to `query()` too. `defineType()` writes a type, not a record, and type events are deferred.

## Subscribing

```ts
type Unsubscribe = () => void;

type SubscribeOptions = {
  filter?: ChangeFilter;
  includeRecords?: boolean;
  onError?: (err: unknown) => void;
  onReset?: () => void;
};

type ChangeFilter = {
  typeId?: TypeId | TypeId[]; // matched by baseId, as grants are
  parentId?: RecordId | null;
  entityId?: EntityId; // the record's author, not the actor
  kinds?: ChangeKind[];
};

interface StackClient {
  subscribe(handler: (change: RecordChange) => void, opts?: SubscribeOptions): Promise<Unsubscribe>;
}
```

- **It lives on `StackClient`**, so both `Stack` and `ScopedStack` implement it, and plugin code written against `StackClient` gets reactivity without learning the backend.
- **`subscribe()` is async and resolves when the subscription is live** — immediately for a local stack, after a server's ready signal for a remote one. This makes the no-gap startup pattern the natural one: `await subscribe()`, _then_ `query()` for initial state, and let the consumer's own version comparison absorb the overlap. A synchronous `subscribe()` would leave every remote consumer to discover that race alone.
- **It returns an unsubscribe function**, not `off(name, handler)`: handler identity is a bad key once closures are involved.
- **`typeId` matches by `baseId`**, exactly as [grants do](./access-control.md#type-level-grants), so a type version bump never silently orphans a subscription.
- **Filtering is exact, not advisory.** A filtered subscription never receives an event outside its filter; a consumer that filters again is doing redundant work, not defensive work.
- **`onReset` is the one control signal an app must handle.** A reconnect that resumes cleanly is the adapter's business and the app never hears about it; `onReset` means a gap opened that resumption could not close, and reconciling by query is the repair — the same work as startup. It never fires on a local stack, which has one writing process and so no gap to open.

## Permission scoping

**A scoped feed is the events that scope may read, and nothing else.** The predicate is literally `canRead` applied per event — no second vocabulary, no feed-specific ACL. `ScopedStack.subscribe()` filters `Stack`'s stream, so scoping needs no adapter cooperation.

- **A record a subscriber cannot read produces no event**, not an empty or redacted one. Event existence is itself a disclosure — the same reasoning that makes `ScopedStack.query()`'s `total` always `null`.
- **A `purged` record is evaluated at mutation time**, on the record as it stood, because after the write there is nothing left to check.
- **The check fails closed.** A permission decision that cannot be made is not a yes: the event is dropped and the error goes to `onError`.
- **Delivery is serialized per subscription.** The permission check is asynchronous, so without a queue two changes to one record could be decided out of order and delivered newest-first, breaking the ordering guarantee below.

**Authority is cached per subscription, and expired by the stream itself.** `canRead` resolves grants, and re-resolving them per event would be a `_grant` scan for every change the stack makes. A subscription therefore prefetches grants once and memoizes group-roster roles — and drops both when a `_grant` or `_group` event passes through it, _before_ that event is filtered, so a subscriber that cannot read the revocation still has its cache expired by it.

**This is only sound because every authority-changing write emits.** `_grant` and `_group` writes are ordinary record mutations and reach the emitter like any other. A future change that altered either without emitting would strand every cached decision, so that invariant belongs to this section as much as to [Where events come from](#where-events-come-from).

## Delivery

- **At-least-once.** Duplicates are legal and expected. The dedupe key is `(recordId, version, kind)` — `kind` is in the key because a `changed` at v7 and a `purged` at v7 are different events about the same version.
- **Per record, order is guaranteed**, and it is `version` order, which a consumer can verify itself. Max-version-wins is a sound reducer.
- **Across records, no causal ordering is promised.** Core has no multi-record transaction, so there is nothing to be ordered _about_.
- **Nothing is silently skipped.** An emitter that cannot honor a resume cursor says so, rather than resuming from wherever it can.

`seq` is an opaque resume cursor minted by a server, never computed with by a client — the same posture as query [pagination cursors](./data-model.md#sorting-and-pagination). Ordering and durability are storage concerns, and local events carry no `seq` at all.

## Known limitations

- **Losing access is invisible.** When a permission change revokes read access, the subscriber receives no event — they simply stop hearing about the record. There is no "removed from your view" signal, and adding one would disclose the revocation itself. A long-lived cache can therefore hold a record its holder may no longer read; consumers displaying shared data should revalidate on a schedule of their own.
- **Gaining access arrives as `changed`, not `created`.** Hence upsert semantics.
- **A restart with no feed is a full resync.** Local stacks have no `seq`.
- **`migrateAll()` fans out.** One event per migrated record, with no batch frame — a sweep over thousands of records emits thousands of events.
- **Hard delete is unreconcilable by query.** Nothing distinguishes "purged" from "never existed" afterwards, so a consumer that missed a `purged` event finds it only by enumerating.
- **`actor` can be absent, and absent is not a value.** An unscoped `Stack` write has no requester to name. A consumer must treat absence as "unknown" rather than substituting the record's author, which is a different fact.
- **A purge is auditable only in outline.** `kind`, `op`, `recordId`, `typeId`, `version` and the actor — never the author or the content. Deliberate: retaining either would defeat the erasure the verb performs.
