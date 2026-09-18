# Change events

Apps observe record changes by subscribing, rather than by polling `query()`. A subscription reports **that** something changed; `query()` and `get()` report **what** it now is.

This section is the model and the local API. Its wire encoding — discovery, `GET /changes`, the frames and the obligations that fall on a server — is [Change feed](./change-feed.md).

**A change event announces that something changed; a version records what a rollback could put back.** The two usually coincide — every mutation that bumps `version` and snapshots prior state emits exactly one event. Where they part, it is because the feed asks the broader question. Hard delete emits and ends the record's stream while snapshotting nothing: there is no prior state to keep once the record is destroyed, but a subscriber still has to learn it is gone. `associate()`/`dissociate()` emit without bumping `version` or snapshotting: associations are invertible, so they need no rollback history (see [Versioning § Version history](./versioning.md#version-history)), but a subscriber watching a tag or a roster still has to hear that it moved.

Two things follow immediately:

- **The event set is closed.** These writes emit and no others: create, hard delete, the association endpoints, and every endpoint that bumps `version` — the same set [Wire format § Versions](./wire-format.md#versions) spells out endpoint by endpoint. A server has nothing to decide for itself about which verbs are reportable.
- **A no-op mutation emits nothing.** What decides is `ops`, not `version`. Re-adding an association the record already holds, setting a deep-equal permission set, or deleting an already-deleted record produces no `ops` at all, and no `ops` means no event. A subscriber never sees a phantom change.

## What a feed is not

**A feed is a change notification, not a replication log.** It answers "something you can read changed"; it does not promise that a subscriber can reconstruct stack state from events alone. Three things make the stronger promise unavailable at this price:

- Permission changes move records into and out of a subscriber's view, and a revocation is deliberately invisible (see [Known limitations](#known-limitations)).
- Hard delete destroys history, so no reconcile-by-query can discover it afterwards.
- History is gated on the mutate surface rather than read access, so a stream rich enough to replay would route around [History access](./versioning.md#history-access).

So the pattern is **notify-then-reconcile**: the feed says _when_ to run a `query()`, and the query — already permission-filtered, already paginated — says _what_.

**A feed is also not a history, and widening it into one is not the way to get one.** Replaying a stored feed from the beginning would have to decide readability against an ACL that has moved on since — the retroactive exposure [history access](./versioning.md#history-access) is gated on the mutate surface to prevent — and would go on naming records a hard delete destroyed, which is the [one thing a purged frame is shaped to avoid](#purged-records-carry-nothing). The durable question is answered a tier down, by [the change journal](./journal.md), which is gated and erased like the history it sits beside.

## The event shape

```ts
type ChangeKind = 'created' | 'changed' | 'deleted' | 'purged';

type ChangeOp =
  | 'create'
  | 'patch'
  | 'associate'
  | 'dissociate'
  | 'permissions'
  | 'migrate'
  | 'restore'
  | 'delete'
  | 'undelete'
  | 'hard-delete'
  | 'unlist'
  | 'list'
  | 'reparent';

type RecordChange = {
  kind: ChangeKind;
  ops: ChangeOp[]; // non-empty; one entry per aspect this change moved
  recordId: RecordId;
  typeId: TypeId; // as stored at the moment of the change
  version: number; // the version this change produced; unchanged from before on associate/dissociate, which never bump
  updatedAt: Date; // as persisted by this change; unchanged from before on associate/dissociate
  parentId?: RecordId;
  actor?: ChangeActor;
  associationsAdded?: Association[]; // present when `ops` includes `associate`
  associationsRemoved?: Association[]; // present when `ops` includes `dissociate`
  record?: StackRecord;
  seq?: string; // resume cursor, on a resumable feed only
};
```

`kind` and `ops` map deterministically:

| `kind`    | `ops`                                                                                                   |
| --------- | ------------------------------------------------------------------------------------------------------- |
| `created` | `create`                                                                                                |
| `changed` | `patch`, `associate`, `dissociate`, `permissions`, `migrate`, `restore`, `undelete`, `list`, `reparent` |
| `deleted` | `delete` (soft), `unlist`                                                                               |
| `purged`  | `hard-delete`                                                                                           |

**Two discriminators at different altitudes, not per-verb events.** `kind` is the coarse branch every consumer must make, and it is closed at four values: a subscriber that handles exactly `created`/`changed`/`deleted`/`purged` is _correct_, not merely adequate. `changed` is an **upsert** signal, never "you have seen this before" — a subscriber can receive `changed` for a record it has never seen, because gaining access arrives that way. `ops` is the precise verb list, for audit logs and sync engines that care whether a permission change or a content edit produced this version.

**`ops` is a list because [one mutation can change several aspects](./data-model.md#mutations).** A `mutate()` call producing a single version reports every aspect it moved — `['patch', 'reparent']` for an edit that also moved the record, `['associate', 'dissociate']` for one association swapped for another — derived by comparing the record against its own prior state, never from the shape of the request. A caller that names an aspect without changing it is not reported as changing it. The list is unordered, carries no duplicates, and is never empty: a call that changes nothing produces no version and therefore no event.

Every op outside `mutate()`'s reach is emitted **alone**: `create`, `delete`, `undelete`, `hard-delete`, `migrate` and `restore` each name a whole-record transition and never share a frame, however much they moved. So a multi-entry `ops` is always a change set, and `restore` remains one op even though it puts back both content and `parentId` together — it never puts back associations at all, on any Record, so there's nothing of theirs for `restore` to bundle. See [Versioning § Restore semantics](./versioning.md#restore-semantics).

**`associationsAdded`/`associationsRemoved` are the live report of what an `associate()`/`dissociate()` call moved** — associations are never snapshotted (see [Versioning § Version history](./versioning.md#version-history)), so the durable record of the same delta is [the change journal](./journal.md), which a subscriber who missed the frame reads instead. Both report only what is true **now**, the same convention every other field on this type follows:

- `associationsAdded` is each association as it now stands, current annotation included. A re-point (a new `attachmentRecordId` on an association the record already held) surfaces here under its new value; the value it replaced is not on this frame or any other, because a frame reports what is current — the journal's [`repoint`](./journal.md#the-entry) is what keeps it.
- `associationsRemoved` is identity only — `kind` and `label`, plus `fileId` for an attachment — never the annotation a removed association carried. An attachment's `attachmentRecordId` is not repeated on removal, the same way a `purged` frame never carries the content it destroyed: the field names what happened, not a payload that is no longer current. The journal's [`remove`](./journal.md#the-entry) keeps the annotation, because putting an association back is exactly what that tier is read for.

Neither list is ever present on an op other than `associate`/`dissociate`, and a `mutate()` change set that swaps one association for another (`ops: ['associate', 'dissociate']`) carries both — the tag added in `associationsAdded`, the tag it replaced in `associationsRemoved`.

**Both lists are derived from the [journal's tagged list](./journal.md#the-entry), not computed beside it.** One write names what it moved once; the durable half takes that list as it stands and the frame is flattened out of it. So a frame can never report an edit an entry doesn't, and the two shapes are a difference in what each tier is read for rather than two comparisons that might disagree.

**`kind` resolves to the most conservative entry in `ops`.** A change set carrying `unlist` is `deleted` whatever else it carries, because a subscriber holding the record still has to drop it and an `upsert` would leave a stale copy behind — an edit bundled with an unlist reaches a default subscriber as a removal, and the edit is not separately announced. Nothing else in the set competes: `list`, `patch`, `permissions`, `reparent`, `associate` and `dissociate` are all `changed`, and no op that maps to `created` or `purged` can appear beside another.

Named events per verb (`record:create`, `record:update`, `record:delete`) were rejected: a subscriber wiring three of them silently misses the other ten verbs, and the bug is invisible until an index drifts from the records it describes.

**`record` is shared, and a handler must not mutate it.** One emission is delivered to every subscription, and they receive the same record object rather than a copy each — copying per subscriber would cost every consumer for a defect none of them have. A handler that needs to alter what it received copies first; mutating in place corrupts what the other subscribers on that stack see.

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

**Where it comes from.** For every mutation that bumps a version, the record carries it: `updatedBy` and `updatedVia` are stamped in the same write (see [Data model § Authorship and attribution](./data-model.md#authorship-and-attribution)), so reading them back after the write matches what was persisted by construction. **Hard delete and `associate()`/`dissociate()` are the exceptions.** Hard delete destroys the record and bumps no version, so nothing is stamped and there is nothing left to read — a `purged` frame's actor comes from the request that performed the delete. That verb is owner-acting-alone and refuses delegation, so the actor there is always the owner, with no principal beside it. `associate()`/`dissociate()` don't bump either, so they don't stamp `updatedBy`/`updatedVia` on the record — but unlike hard delete they aren't owner-only, so their actor still has to reflect whoever actually made the call. It travels the same way a purge's does: read off the request rather than off the record, which in this case simply was never touched.

`appId` rides a `created` frame only. It is self-reported at create and never recorded per mutation, so on any later version the record's `appId` is the _creating_ app — record provenance, not this change's actor.

**Attribution is record-level, not history-grade.** [Prior state is excluded](#prior-state-is-not-in-the-envelope) because history is gated on the mutate surface while a feed's gate is plain `canRead`. That argument is about prior _content_ — the revision someone deliberately edited out. Knowing that a record changed, and who changed it, reveals nothing about what was removed; and identity is already record-level, since `entityId` sits on the record where every reader sees it. "Who wrote version 7" is the same class of fact as "who wrote version 1".

## Purged records carry nothing

**A `purged` frame carries `kind`, `ops`, `recordId`, `typeId`, `version`, `updatedAt` and `actor` — nothing else.** No `parentId`, no record provenance, and `record` is never present, whatever the subscriber asked for.

Hard delete is the erasure primitive: it destroys the record and its version history, and the reason to reach for it over soft delete is that no trace should remain (see [Versioning § Deletion](./versioning.md#deletion)).

The hazard is not disclosure at emission, which is already bounded — a subscriber who cannot read a record receives no event, so anyone holding a purge frame was entitled to its author anyway. **The hazard is durability.** A frame naming the author would hand every subscriber a permanent, un-erasable note — "this DID had a record here, and it was destroyed" — written into their logs at the moment the stack finished erasing its own copy. The stack cannot un-emit. An erasure primitive that seeds durable records of what was erased defeats itself.

What follows is worth keeping deliberately: **a purge event tells you to forget something you already knew, and tells someone who never knew it nothing.** `recordId` is opaque, so a subscriber holding the record can evict it and one that never held it learns nothing it could act on.

Filtering is unaffected: the emitter holds the record it destroyed, so a subscription filtered by `parentId` or `entityId` still receives exactly the purges that match. Those fields decide delivery without appearing in what is delivered.

## Soft-deleted records reach the feed as tombstones

A purge carries nothing because erasure must leave no trace. Soft delete is the gentler neighbour, and it gets the gentler rule: under `ScopedStack`, a frame whose record carries `deletedAt` delivers [the same tombstone `get()` returns](./versioning.md#the-tombstone-is-literal) — identity, clock, `deletedAt`, `permissions`, and an empty `content` — rather than the body.

The reason is the one that governs the [unlisted exclusion](#the-unlisted-transition): a feed that served what `query()` and `get()` withhold would be a strictly better read channel than either, and the withholding would be decoration. A subscriber still learns everything the event exists to tell it — this record is deleted, drop your copy — which needs no body at all.

The projection keys on the record's `deletedAt`, not on the op, so it covers the `delete` transition and any later frame about a record that is still deleted, while an `unlist` frame — whose record stays fully readable — is untouched. Unscoped `Stack` subscribers receive the whole record: that layer is trusted by definition and reaches every record by other means.

## Prior state is not in the envelope

There is no `previous`. Prior state is already a first-class, addressable thing: `getVersion(id, version - 1)`. Shipping it inside an event would route around [History access](./versioning.md#history-access), which gates history on the **mutate surface** precisely so that sharing a record after editing something out does not hand every current reader the pre-edit revision. A feed's gate is plain `canRead`, so putting `previous` in the envelope would make every reader a history reader, in the one code path nobody would think to audit. A consumer needing a diff holds the mutate surface, and fetches the version.

## Handlers

**Handlers never block, delay, or fail a write.**

- **The write is durable before any handler runs.** A handler cannot veto, amend, or roll back what it is being told about.
- **A throwing handler cannot fail the write**, because there is nothing left to fail. The error goes to the subscription's `onError`; with no `onError` it is rethrown asynchronously so that it surfaces as an unhandled error rather than vanishing. It never reaches the caller of `create()`/`mutate()`.
- **Handlers are invoked after the adapter write resolves and before the mutating method's promise settles.** So `await stack.mutate(...)` guarantees subscribers have been _notified_, and guarantees nothing about work they deferred.

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
  opts: SubscribeChangesOptions,
  handler: (change: RecordChange) => void,
): Promise<() => void>;

type SubscribeChangesOptions = {
  filter?: ChangeFilter;
  since?: string;
  includeRecords?: boolean;
  includeUnlisted?: boolean;
  onError?: (err: unknown) => void;
  onReset?: () => void;
};
```

An optional method checked for truthiness at the call site, per [Adapters § Adapter capabilities](./adapters.md#adapter-capabilities) — never a boolean in `capabilities`. A remote adapter implements it; local adapters do not, and their absence is not a gap: [a stack's storage has exactly one owning process](./adapters.md#concurrency--storage-ownership), so locally there is no third party whose writes could have been missed. **Resumption is meaningful only in the multi-writer topology.**

`onError` here is the relay's own trouble — a connection it could not restore — rather than a subscriber's, and `onReset` is the gap that leaves. A relay reports what it is told and decides nothing, so it has no handler of its own to route errors from.

**One relay per subscription, carrying that subscription's filter.** The filter travels rather than being applied to what comes back, because `entityId` and `parentId` are answerable only where the record is: the far end holds it, and this end never will. Sharing one relay across subscriptions would mean either re-deriving those filters locally without the record, or subscribing unfiltered and paying for every change on every subscription.

**A relayed frame is delivered as it arrives.** It was filtered and permission-checked by the emitter that produced it, against the record it held, and nothing here re-derives that decision — a `purged` frame in particular leaves nothing to decide with. It goes to the subscriber that opened the relay, never through the local emitter, which would hand every other subscriber a stream it did not ask for. Errors from a throwing handler route exactly as they do for a local event.

**A subscriber sees both streams, and duplicates are ordinary.** A local write emits here immediately and the far end echoes the same version back a round trip later. That is a duplicate, duplicates are legal, and the consumer's `(recordId, version, kind)` dedupe already absorbs it. Suppressing local emission whenever the adapter has a feed would make a subscriber's own writes invisible whenever the feed is down, which is when a UI most needs to reflect them.

**Every record emits, including the ones a query hides.** `_config` is [addressable only by ID](../spec.md#the-_config-record) and never returned by `query()`, but a change to it is a change like any other and reports as one — it is owner-only by permission and ungrantable, so the exclusion query() makes for addressability reasons is not a permission rule to mirror here. `_grant` and `_group` writes emit as ordinary record events too, which is load-bearing: they are what expires a cached authority decision (see [Permission scoping](#permission-scoping)).

**Records only, in v1.** An `_attachment@1` record _is_ a record, so attachment metadata rides the feed already; bare blob writes with no accompanying record emit nothing, as they are invisible to `query()` too. `defineType()` writes a type, not a record, and type events are deferred.

## Subscribing

```ts
type Unsubscribe = () => void;

type SubscribeOptions = {
  filter?: ChangeFilter;
  includeRecords?: boolean;
  includeUnlisted?: boolean; // owner-only under ScopedStack — see Unlisted records
  since?: string; // resume cursor — the last `seq` present on a delivered RecordChange
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
- **`onReset` is the one control signal an app must handle.** A reconnect that resumes cleanly is the adapter's business and the app never hears about it; `onReset` means a gap opened that resumption could not close, and reconciling by query is the repair — the same work as startup. It never fires on a local stack, which has one writing process and so no gap to open. Passing a `since` the far end refuses (a `resume: false` server, an expired cursor) fires it on the very first connection — that is a gap too, and the one an app most needs to hear about: the difference between "you are current" and "you are missing an unknown amount."
- **`since` resumes a subscription; it does not restart one.** It is forwarded to the adapter as `SubscribeChangesOptions.since` — see [Where events come from](#where-events-come-from) — so it means something only where a relay exists. A stack with no relay has no third party whose writes could have been missed, and so no cursor it could ever have minted; passing `since` there throws `StackQueryError` rather than silently starting from the present, which would let the caller believe it resumed when it did not. `ScopedStack.subscribe()` refuses it for the same reason it refuses a relay outright — see [Permission scoping](#permission-scoping) — a scoped view never has a relay of its own to resume. A cursor outside the [framable charset](./change-feed.md#frames) is refused the same way and by the same layer, so a malformed one reports identically whatever adapter is underneath; the value is otherwise opaque, checked for whether it can be framed and never for what it means.

## Permission scoping

**A scoped feed is the events that scope may read, and nothing else.** The predicate is literally `canRead` applied per event — no second vocabulary, no feed-specific ACL. `ScopedStack.subscribe()` filters `Stack`'s stream, so scoping needs no adapter cooperation.

**The unlisted exclusion composes with `canRead` rather than replacing it, and is not a second ACL either.** It is the same boundary an unfiltered `query()` applies, asked again here so the feed can never deliver more than an equivalent `query()` would return — see [The unlisted transition](#the-unlisted-transition) below.

**A scoped view of a stack that relays refuses to subscribe**, with `StackRelayScopeError`. `canRead` needs the record, and a relayed frame does not carry one — on a `purged` frame there is nothing left to fetch either. Neither answer available here is honest: delivering relayed frames would hand a narrower scope events it may not be entitled to, and delivering only local writes would silently drop every change made elsewhere, which is [the failure that looks fine in testing](./change-feed.md#feed-implementation-checklist). A relayed feed is already scoped by the session that opened it, so the way to scope one is to open it with the session you mean — a server does exactly that, subscribing unscoped at the storage owner it holds and fanning out per connection.

- **A record a subscriber cannot read produces no event**, not an empty or redacted one. Event existence is itself a disclosure — the same reasoning that keeps a count of the whole match off a [query result](./data-model.md#sorting-and-pagination).
- **A `purged` record is evaluated at mutation time**, on the record as it stood, because after the write there is nothing left to check.
- **The check fails closed.** A permission decision that cannot be made is not a yes: the event is dropped and the error goes to `onError`.
- **Delivery is serialized per subscription.** The permission check is asynchronous, so without a queue two changes to one record could be decided out of order and delivered newest-first, breaking the ordering guarantee below.

**Authority is cached per subscription, and expired by the stream itself.** `canRead` resolves grants, and re-resolving them per event would be a `_grant` scan for every change the stack makes. A subscription therefore prefetches grants once and memoizes group-roster roles — and drops both when a `_grant` or `_group` event passes through it, _before_ that event is filtered, so a subscriber that cannot read the revocation still has its cache expired by it.

**This is only sound because every authority-changing write emits.** `_grant` and `_group` writes are ordinary record mutations and reach the emitter like any other. A future change that altered either without emitting would strand every cached decision, so that invariant belongs to this section as much as to [Where events come from](#where-events-come-from).

## The unlisted transition

An unlisted record that emits a change event to a default subscriber is not unlisted, so the feed excludes them the same way `query()` does — `includeUnlisted` opts a subscription back in, gated exactly as [`RecordFilter.includeUnlisted`](./unlisted.md#includeunlisted-is-owner-only) is. Since `unlistedAt` deliberately keeps `get()` working, an ID is sufficient to fetch; if `query()` excluded unlisted records but the feed did not, the feed would be a strictly better enumeration channel than the query it is supposed to match.

**Suppression is not total, or a default subscriber would keep a stale copy forever.** Soft delete is the model: `query()` hides a deleted record while the feed still emits `deleted`, because that event is what tells a subscriber to drop its copy. The same reasoning governs every transition here:

| Transition                   | Emits to a default subscriber? | Why                                                                 |
| ---------------------------- | :----------------------------: | ------------------------------------------------------------------- |
| Created unlisted             |               No               | Nobody knew it existed; the announcement _is_ the disclosure        |
| Listed → unlisted (`unlist`) |            **Yes**             | Subscribers already know it and must drop it                        |
| Any change while unlisted    |               No               | The ongoing case the feature exists for                             |
| Unlisted → listed (`list`)   |            **Yes**             | The publish moment                                                  |
| Hard delete while unlisted   |               No               | Same reasoning as row 1 — nothing was ever announced to un-announce |

Only the second row needs special-casing. Every other row falls out of checking the record's **current** `unlistedAt` against the subscriber's `includeUnlisted`, the same check `query()`'s default filter makes: a just-created or still-unlisted record's current state already excludes it, with no need to know which ops produced the event. The `unlist` transition is the one case where that check would give the wrong answer, because the record's post-change state is exactly what it is announcing — so the exclusion is asked of the **pre**-change state there, which is why `unlist` gets a dedicated op (mapped to `kind: 'deleted'`, per [The event shape](#the-event-shape)) rather than reusing `permissions`'s pattern of one op for both directions. A change set that unlists while also editing is asked the same question, and answers it the same way.

**`list` needs no new semantics.** Kind `changed` is already an upsert a subscriber may never have seen before — the same case [gaining access](#known-limitations) already covers — so a record created silently, edited silently any number of times while unlisted, and finally relisted reaches a default subscriber as a single `changed` event it upserts as if seeing the record for the first time.

## The reparent transition

A `parentId` filter is answered by the record, not the envelope, so a record that moves between containers would otherwise be announced only to the container it arrived in — the departure would be silent, and a subscriber watching the origin would keep a record that is no longer there. A move is therefore matched against **both** sides of it: the record's post-change `parentId` for the destination, and the pre-change one for the origin. Same shape as the [`unlist` transition](#the-unlisted-transition), which likewise cannot be decided from the post-change record alone.

**Two ops move a record**, and both are matched this way: `reparent`, and a `restore` whose snapshot [puts a different container back](./versioning.md#restore-semantics). Which one a subscriber is looking at is an ordinary `ops` distinction and changes nothing about the routing — undoing a move is a move. A frame carrying `reparent` is matched against both containers however many other aspects share the change set with it. Every frame without one leaves `parentId` where it was, so the two sides are the same container and the second match is a no-op.

**A frame carries only the destination.** `parentId` on a frame means what it means everywhere — the record's state at the moment of the change — and a subscriber tells the two cases apart by comparing it to the filter it subscribed with: equal is an arrival, unequal is a departure. Nothing more is needed, and adding a `previousParentId` to the wire would give every subscriber a second container's ID to reason about for the sake of a comparison they can already make.

**Kind is `changed`, not `deleted`.** `unlist` maps to `deleted` because the record genuinely leaves the subscriber's view and must be dropped. A moved record is still there and still readable; only its container moved, and the same frame reaches the destination's subscribers, for whom "drop your copy" would be exactly wrong. A subscriber maintaining a list of one container's children therefore has to read `parentId` rather than treating every `changed` as an upsert — the one place where kind alone under-determines what to do, and the reason a filtered subscription is [guaranteed `parentId` in the stub](#the-event-shape).

An unscoped `parentId` filter (`null`, for root records) participates on the same terms: a record moved to the root is an arrival there, and one moved off it a departure.

## Delivery

- **At-least-once.** Duplicates are legal and expected. The dedupe key is `(recordId, version, kind)` — `kind` is in the key because a `changed` at v7 and a `purged` at v7 are different events about the same version.
- **Per record, order is guaranteed**, and it is `version` order, which a consumer can verify itself. Max-version-wins is a sound reducer.
- **Across records, no causal ordering is promised.** Core has no multi-record transaction, so there is nothing to be ordered _about_.
- **Nothing is silently skipped.** An emitter that cannot honor a resume cursor says so, rather than resuming from wherever it can.

`seq` is an opaque resume cursor minted by a server, never computed with by a client — the same posture as query [pagination cursors](./data-model.md#sorting-and-pagination). Ordering and durability are storage concerns, and local events carry no `seq` at all.

## Known limitations

- **Losing access is invisible.** When a permission change revokes read access, the subscriber receives no event — they simply stop hearing about the record. There is no "removed from your view" signal, and adding one would disclose the revocation itself. A long-lived cache can therefore hold a record its holder may no longer read; consumers displaying shared data should revalidate on a schedule of their own.
- **Gaining access arrives as `changed`, not `created`.** Hence upsert semantics.
- **A restart against a local stack, or with no cursor held, is a full resync.** Local stacks have no `seq` to have held. A restart against a stack that relays is not: persist the last `seq` that was **present** — a relaying stack delivers its own local writes through the same handler, and those carry none, so a consumer that stores every change's `seq` unconditionally erases its own cursor on its next write — pass it back as `since`, and let `(recordId, version, kind)` dedupe absorb whatever the resumed feed replays.
- **`migrateAll()` fans out.** One event per migrated record, with no batch frame — a sweep over thousands of records emits thousands of events. A scoped subscription serializes its permission checks, so a fan-out that outpaces them queues: pending events are held, with the record each describes, until their check runs.
- **A hard delete over the wire is announced twice, and deduped.** The verb answers with the record it destroyed, so a `Stack` driving a remote adapter emits its own `purged` frame exactly as it does for every other write, and the far end emits one too, which arrives through the relay a round trip later. `(recordId, version, kind)` absorbs the pair, the same way it absorbs a relayed copy of any other local write.
- **Hard delete is unreconcilable by query.** Nothing distinguishes "purged" from "never existed" afterwards, so a consumer that missed a `purged` event finds it only by enumerating.
- **`actor` can be absent, and a purge carries only an outline.** Absent means unknown — never the record's author, which is a different fact ([Attribution](#attribution)) — and a purged frame names neither author nor content ([Purged records carry nothing](#purged-records-carry-nothing)).
