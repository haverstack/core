# Change Events — agreed design

> **Status: design agreed, not yet implemented.** Nothing described here ships in
> `@haverstack/core` today. This document exists so that `haverstack/server` can build
> its change-notification endpoint against a settled vocabulary rather than inventing
> one that core would later be contorted to fit. Sections marked **normative** are the
> wire contract a server implements; they move into [`docs/spec/`](../spec.md) verbatim
> when the implementation lands, alongside conformance fixtures.

Resolves the design half of #3. The implementation may proceed on its own clock.

## The model, in one sentence

**A change event is the observable side of the versioning one-rule.** Every mutation that
snapshots prior state and bumps `version` emits exactly one event; hard delete, the one
exception to that rule, is the one exception here too (it emits, but carries no snapshot
and terminates the record's stream). See
[Versioning § Version history](../spec/versioning.md#version-history) for the rule this
mirrors.

Two consequences fall out immediately and are worth stating before the shape:

- **The event set is closed and already enumerated.** It is the same exhaustive list
  [Wire format § Versions](../spec/wire-format.md#versions) gives for endpoints that bump
  `version`, plus create and hard delete. There is no judgement call about what "counts"
  as a change.
- **A no-op mutation emits nothing.** Re-adding an association that is already present,
  setting a deep-equal permission set, deleting an already-deleted record — these bump no
  version, so they fire no event. Consumers never see a phantom change.

## What this is not

**The feed is a change notification, not a replication log.** It answers "something you
can read changed"; it does not promise that a consumer can reconstruct stack state from
events alone. Three things make the stronger promise unbuyable at this price:

- Permission changes move records into and out of a subscriber's view, and a revocation
  is deliberately invisible (see [Known limitations](#known-limitations)).
- Hard delete destroys history, so no reconcile-by-query can discover it after the fact.
- History is gated on the mutate surface, not read access, so an event stream rich enough
  to replay would route around [History access](../spec/versioning.md#history-access).

So sync (#3's second use case) is **notify-then-reconcile**: the feed tells you _when_ to
run a `query()`, and the query — already permission-filtered, already paginated — tells
you _what_. The alternative, an ordered durable log with retention and tombstones, is a
large server commitment bought for a guarantee the permission model cannot honor anyway.

## The event shape — normative

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
  updatedAt: Date; // ISO string on the wire
  parentId?: RecordId;
  entityId?: EntityId;
  appId?: AppId;
  principalId?: EntityId;
  /** The record as of this change. Optional — see D2. */
  record?: StackRecord;
  /** Resume cursor. Present only on a resumable feed — see D7. */
  seq?: string;
};
```

`kind` and `op` map deterministically:

| `kind`    | `op`                                                                                 |
| --------- | ------------------------------------------------------------------------------------ |
| `created` | `create`                                                                             |
| `changed` | `update`, `associate`, `dissociate`, `permissions`, `migrate`, `restore`, `undelete` |
| `deleted` | `delete` (soft)                                                                      |
| `purged`  | `hard-delete`                                                                        |

## Decisions

### D1. One event with two discriminators, not per-verb events

The issue sketched `stack.on('record:create', ...)` / `'record:update'` / `'record:delete'`.
**Rejected in that form.** A consumer subscribing to three named events silently misses
the other seven mutation verbs — an indexer wired to `record:update` never learns about
`associate`, `migrate`, or `restore`, and the bug is invisible until a record's tags stop
matching its index entry.

Instead, one event carrying two fields at different altitudes:

- **`kind` is the coarse branch every consumer must make**, and it is closed at four
  values. An implementation that handles exactly `created`/`changed`/`deleted`/`purged`
  and nothing else is _correct_, not merely adequate. `changed` is an **upsert** signal,
  never "you have seen this before" — a subscriber can receive `changed` for a record it
  has never seen (see [permission grants](#known-limitations)).
- **`op` is the precise verb**, for audit logs and sync engines that genuinely care
  whether a permission change or a content edit produced this version.

The cost is one redundant field. The benefit is that the safe default is the _easy_
default, which is the same reason
[capability-gated filters](../spec/data-model.md#capability-gated-filters) fail loudly
rather than degrade.

### D2. The stub is the contract; the record body is an optional payload

**What a subscriber is guaranteed** is identity, type, version, attribution, and
`parentId` — enough to route the event (invalidate this cache key, append this audit
entry, drop this index entry) without a fetch. **`record` is optional**: present when the
emitter has it in hand and the subscriber asked for it, absent otherwise, and never
required for correctness. A consumer that needs guaranteed-current state re-reads;
`record` is that read's cache, and may already be stale by the time it is handled.

This is the same shape as every other optional capability in the codebase — an optional
thing, checked at the call site, with a documented fallback (see
[Adapters § Adapter capabilities](../spec/adapters.md#adapter-capabilities)).

Permission-wise, stub and body are equivalent: **if a subscriber may not read the record,
it does not receive the event at all**, so there is no case where the envelope is
deliverable but the body is not. The body is a bandwidth decision, not an access one.

### D3. No `previous` — and the reason is a permission boundary, not cost

The issue sketched `(record, previous)`. **Rejected.** Prior state is already a
first-class, addressable thing: `getVersion(id, version - 1)`. Shipping it inside the
event would route around
[History access](../spec/versioning.md#history-access), which gates history on the
**mutate surface** — a write-holder, or owner/creator — precisely so that sharing a record
after editing something out does not hand every current reader the pre-edit revision. The
feed's gate is plain `canRead`. Putting `previous` in the envelope would make every
reader a history reader, undoing that rule for the one code path nobody would think to
audit.

A consumer that needs a diff holds the mutate surface, and fetches the version.

### D4. Handlers never block, delay, or fail a write

The issue asked whether hooks should be "async (awaited before the write completes —
useful for indexing)". **Rejected, deliberately and completely.**

- **The write is durable before any handler runs.** A handler cannot veto, amend, or roll
  back what it is being told about.
- **A throwing handler cannot fail the write**, because there is nothing left to fail. The
  error is routed to the subscription's `onError`; with no `onError` it is rethrown
  asynchronously (`queueMicrotask`) so it surfaces as an unhandled error rather than
  vanishing. It never propagates to the caller of `create()`/`update()`.
- **Handlers are invoked synchronously after the adapter write resolves and before the
  mutating method's promise settles.** So `await stack.update(...)` guarantees subscribers
  have been _notified_; it guarantees nothing about work they deferred. A returned promise
  is not awaited.

An indexer that must not miss a write does not get that from a blocking hook — it gets it
from a resumable cursor and idempotent application. A blocking hook buys, instead, a world
where every subscriber is a latency and failure dependency of every write, and a slow
plugin makes the stack look broken.

A pre-commit _validation_ hook is a different feature (middleware, with permission-bypass
hazards of its own) and is explicitly out of scope here, so that #3 does not drift into it.

### D5. `Stack` emits; adapters do not — except to relay a remote feed

Emission lives in `Stack`, the invariant layer, for the same reason validation, `_config`
protection, and ID rules do: every adapter inherits it and no adapter can forget it. Local
adapters implement nothing.

The one adapter-side hook is the inverse direction — changes that originate _elsewhere_:

```ts
// StackRecordAdapter, optional
subscribeChanges?(
  opts: { filter?: ChangeFilter; since?: string },
  handler: (change: RecordChange) => void,
): Promise<() => void>;
```

An optional method checked for truthiness at the call site, per the house rule — never a
boolean in `capabilities`. `APIAdapter` implements it; local adapters do not, and their
absence is not a gap: [a stack's storage has exactly one owning
process](../spec/adapters.md#concurrency--storage-ownership), so locally there is no third
party whose writes could have been missed. **Resumption is meaningful only in the
multi-writer topology, which is exactly the wire topology.**

**Echoes are covered by the at-least-once contract.** Over `APIAdapter`, a local write
emits from `Stack` immediately and the server's feed echoes the same version a round-trip
later. That is a duplicate, and duplicates are already legal (D6) — consumers dedupe on
`(recordId, version, kind)`. An emitter _may_ suppress an echo it cheaply recognizes; this
is best-effort, never contractual. The alternative — suppressing local emission whenever
the adapter has a feed, mirroring `saveVersion()`'s no-op over `APIAdapter` — was
considered and rejected: it makes a subscriber's own writes invisible whenever the feed is
down, which is exactly when a UI most needs to reflect them.

### D6. Delivery: at-least-once, per-record ordered, globally unordered

- **At-least-once.** Duplicates are legal and expected. The dedupe key is
  `(recordId, version, kind)` — `kind` is in the key because a `changed` at v7 and a
  `purged` at v7 are different events about the same version.
- **Per record, order is guaranteed**, and it is `version` order, which the consumer can
  verify itself. Max-version-wins is a sound reducer.
- **Across records, no causal ordering is promised.** On the wire, frames arrive in `seq`
  order; locally, in emission order. Neither is a transaction boundary — core has no
  multi-record transaction, so there is nothing to be ordered _about_.
- **Nothing is silently skipped.** A server that cannot honor a resume cursor says so
  (`reset`, below) rather than resuming from wherever it can.

### D7. `seq` is opaque, restricted-charset, and server-minted

Resume cursors are **opaque strings**, not comparable integers — the same posture as query
[pagination cursors](../spec/data-model.md#sorting-and-pagination). A client echoes one
back; it never computes with one, so a server is free to implement it as a WAL offset, a
timestamp-counter pair, or anything else.

**`seq` is restricted to the unreserved base64url charset (`A-Za-z0-9_-`)**, for the same
reason [the auth nonce is](../spec/wire-format.md#the-handshake): it travels in a
line-oriented protocol (SSE `id:`), where an unconstrained value could span fields.

`seq` is minted by the server, not by core. Ordering and durability are storage concerns,
and core runs no storage it shares with anyone. Local events carry no `seq` at all.

### D8. Records only, in v1

- **Attachments need nothing.** An `_attachment@1` record _is_ a record, so attachment
  metadata rides the record feed already. Bare blob writes with no accompanying record
  emit nothing — they are invisible to `query()` too, and
  [garbage collection](../spec/attachments.md#garbage-collection) exists for exactly that
  orphan class.
- **Types are deferred.** `defineType()` writes a type, not a record. A schema-caching
  subscriber will eventually want to know, but nothing today does.
- **Grants need nothing special.** `grant()`/`revoke()` write `_grant` records, so they
  emit ordinary record events, visible to whoever may read the grant. This is load-bearing
  for servers — see the [checklist](#server-implementation-checklist).

Deferral is cheap here because the frame is **named**: every frame carries an event name
(`record`), and **a client MUST ignore frames whose name it does not recognize**. Adding
`event: type` later is therefore an additive, minor-version change under
[version negotiation](../spec/wire-format.md#version-negotiation), not a break.

## Local API — `StackClient`

```ts
type Unsubscribe = () => void;

type SubscribeOptions = {
  filter?: ChangeFilter;
  /** Ask the emitter to include `record`. Honored when it can; never assume it. */
  includeRecords?: boolean;
  onError?: (err: unknown) => void;
};

interface StackClient {
  // ...existing surface...
  subscribe(handler: (change: RecordChange) => void, opts?: SubscribeOptions): Promise<Unsubscribe>;
}

type ChangeFilter = {
  /** Matched by baseId, like grants: `com.example/note@1` also covers `@2`. */
  typeId?: TypeId | TypeId[];
  parentId?: RecordId | null;
  entityId?: EntityId;
  kinds?: ChangeKind[];
};
```

Notes on the shape:

- **It lives on `StackClient`**, so both `Stack` and `ScopedStack` implement it and plugin
  code that already accepts `StackClient` gets reactivity without learning the backend.
- **`subscribe()` is async and resolves when the subscription is live** — immediately for a
  local stack, after the server's `ready` frame for a remote one. This makes the
  no-gap startup pattern the natural one: `await subscribe()`, _then_ `query()` for the
  initial state, and let dedupe absorb the overlap. A synchronous `subscribe()` would
  leave every remote consumer to discover that race on their own.
- **It returns an unsubscribe function**, not `off(name, handler)`. Handler identity is a
  bad key once closures are involved.
- **`typeId` matches by `baseId`**, exactly as
  [grants do](../spec/access-control.md#type-level-grants), so a type version bump never
  silently orphans a subscription. Same rule, same reason.
- **Filtering is exact, not advisory.** A filtered subscription never receives an event
  outside its filter; a consumer that filters again is doing redundant work, not defensive
  work.

## Wire contract — normative

### Discovery

A server that offers a feed advertises it, as its own top-level discovery object:

```json
{
  "version": "1.0",
  "entityId": "did:key:z6Mk...",
  "capabilities": { "...": "..." },
  "auth": { "methods": ["did-challenge"] },
  "changes": { "transports": ["sse"], "resume": true, "records": true }
}
```

Absent `changes` means no feed. An object rather than a boolean for the same reason `auth`
is one: this is a surface that will grow entries (a long-poll transport, batched frames),
and the alternative is a boolean plus three more booleans later.

`resume: false` is conformant — it means every reconnect gets a `reset` (below). `records`
reports whether `?include=record` is honored.

**A client checks discovery and fails locally.** `APIAdapter.subscribeChanges()` against a
server advertising no `changes` throws `APIAdapterCapabilityError` **without sending a
request**, exactly as `contentFieldQuery` and `fullTextSearch` filters do today. Learning
this as a 404 partway through is the failure mode `auth: { methods }` was added to avoid.

### The endpoint

```
GET /changes
Accept: text/event-stream
Authorization: Bearer <token>
Last-Event-ID: <seq>          (equivalently ?since=<seq>)

?typeId=          (repeatable; baseId or versioned, matched by baseId)
?parentId=        ("null" for root records, as GET /records)
?entityId=
?kind=            (repeatable: created|changed|deleted|purged)
?include=record
```

Response: `200 text/event-stream`, a stream of frames.

```
event: ready
data: {"seq":"AA3f1Q"}

id: AA3f1R
event: record
data: {"kind":"changed","op":"update","recordId":"1hk153x00001",
       "typeId":"com.example/note@1","version":7,
       "updatedAt":"2026-08-13T12:00:00.000Z","entityId":"did:key:z6Mk..."}

: keepalive

event: reset
data: {"reason":"cursor_expired"}
```

- **`ready`** is sent first, always, carrying the head `seq`. It is what makes
  `subscribe()`-then-`query()` gap-free.
- **`record`** carries one `RecordChange`. Dates are ISO strings; `record`, when included,
  is a `WireRecord`.
- **`reset`** means _your cursor cannot be honored; resynchronize by query_. A server with
  no buffer at all sends it on every connect and is fully conformant. `reason` is
  informational (`cursor_expired`, `not_supported`, `overflow`).
- **`: keepalive` comments** SHOULD be sent on an idle interval, so intermediaries do not
  reap the connection and so a client can detect a dead one.

**Backpressure:** a server holds a bounded per-connection buffer and, on overflow,
**closes the stream** rather than dropping frames silently. The client reconnects, presents
its cursor, and gets `reset` if the gap cannot be filled. Silent gaps are the one behavior
that makes the whole feed untrustworthy.

**Reconnection** is the client's job, with exponential backoff **and jitter** — a server
restart otherwise produces a synchronized reconnect stampede from every client it dropped.

### Why SSE, and why not `EventSource`

SSE is one-way server→client, which is the entire requirement; it carries frame ids and
resumption (`id:` / `Last-Event-ID`) in the protocol itself; and a server implements it as
a streaming HTTP response with no new dependency, no upgrade path, and no separate auth
story. WebSocket buys bidirectionality nothing here needs.

But **the browser `EventSource` API cannot set an `Authorization` header**, which is why
SSE deployments so often end up with a token in the query string. That is not available
here: **a token MUST NOT be accepted as a query parameter** — query strings land in access
logs, referrers, and proxy telemetry, and this token is now a programmatically renewable
credential rather than a hand-placed one. The feed is therefore consumed via `fetch` with a
streaming body, which `APIAdapter` is already built on.

Long-poll (`GET /changes?since=&wait=`) is the reserved fallback for servers that cannot
hold open connections. The frame vocabulary is transport-independent by construction, so it
adds a `transports` entry and no new semantics. It is **not** specified in v1 — see
[Open questions](#open-questions).

## Permission scoping

**A feed is the events a `ScopedStack` for that session may read**, and nothing else. The
predicate is literally `canRead` applied per event — no second vocabulary, no feed-specific
ACL.

- `ScopedStack.subscribe()` filters `Stack`'s stream through `canRead`, so scoping needs no
  adapter cooperation at all.
- A server builds its feed by subscribing **unscoped** at the storage owner and fanning out
  per connection, filtering each connection through the `ScopedStack` its token's session
  names — `Stack.forSession(session)`, taking the `(principalId, subjectId)` pair whole.
  Delegated authority is then the ordinary
  [intersection](../spec/access-control.md#delegation-principal-and-subject), inherited
  rather than reimplemented.
- **A record a subscriber cannot read produces no event**, not an empty or redacted one.
  Event existence is itself a disclosure — the same reasoning that makes
  `ScopedStack.query()`'s `total` always `null`.

Two consequences a server must design for rather than discover:

- **`canRead` is not free per event.** It resolves grants, and without prefetching that is
  a `_grant` query _per event per connection_ (`ScopedStack.query()` prefetches once per
  query for exactly this reason). A feed needs a per-connection grant cache — and the
  cache invalidation signal is already in the stream, because `_grant` writes emit ordinary
  record events (D8). A server that caches grants and ignores `_grant` events will serve a
  revoked subscriber indefinitely.
- **A `purged` record cannot be permission-checked after the fact.** The record is gone, so
  readability must be evaluated — or the record captured — **at mutation time**, not at
  delivery time. A server that evaluates lazily will either leak the existence of hard-
  deleted records or drop the event for everyone.

## Interaction with the auth handshake (#138)

The handshake landing first is what makes the feed cheap; these are the concrete joins.

**Renewal is already solved, and the feed should not re-solve it.** A feed (re)connect is
an ordinary request through `APIAdapter.send()`, so a 401 triggers the existing
single-flight `reauthenticate()` and one retry. **The change feed introduces no new auth
machinery.** A design that opened the stream outside that path would need its own token
lifecycle, and would get it subtly wrong.

**A stream's authority is fixed at connect and re-evaluated only at reconnect.** Renewing a
token does not extend or re-authorize an open stream, and a client MUST NOT assume it does.
`expiresAt` [is advisory](../spec/wire-format.md#the-handshake) and remains so: for a
stream, proactive renewal buys nothing, because the stream is not what holds the token.

**Therefore a long-lived stream can outlive the authority that opened it** — a token
expires, or is revoked through `StackTokenStore.revokeToken()`, and a connection opened an
hour ago keeps delivering. This is the genuinely new hazard the feed introduces, and it is
a state property no fixture can catch, so it belongs in the checklist below alongside
#138's own entries.

**Delegated sessions need no new rule.** `/auth/token` reports `(principalId, subjectId)`,
`forSession()` takes the pair whole, and the feed is that session's `ScopedStack` view.
A consent-flow-issued token (the extension point `auth.methods` reserves) arrives already
scoped.

**Nothing secret is sent before `expectedOwner` can refuse.** Discovery runs first, the
owner check runs on it, and a client using a DID credential holds no token yet — so the
feed inherits that ordering unchanged.

## Server implementation checklist

Core runs no server, and **the fixtures cannot check any of these** — each is a property of
state or configuration, so a server can pass every change-feed fixture and still be wrong.
Collected here for the same reason
[the auth checklist](../spec/wire-format.md#server-implementation-checklist) is.

- **Bound stream lifetime, or re-check the session periodically.** A revoked or expired
  token must stop delivering. Closing the stream is enough — the client reconnects and gets
  a 401, which is a path that already works.
- **Never accept a bearer token as a query parameter**, on this endpoint or any other, no
  matter how convenient `EventSource` would make it.
- **Evaluate readability at mutation time for `purged`**, before the record is destroyed.
- **Invalidate per-connection grant caches on `_grant` events.** Caching grants is
  necessary for throughput and unsafe without this.
- **Close on buffer overflow; never drop a frame silently.** A client that cannot tell it
  missed something cannot recover from it.
- **Only the storage owner can emit.** [Exactly one process owns a stack's
  storage](../spec/adapters.md#concurrency--storage-ownership), so events exist only in
  that process. A multi-process server needs its own fan-out from the owner; a second
  process subscribing to its own `Stack` sees nothing and will look fine in testing.
- **`seq` in the base64url charset only** — a value containing a newline truncates the
  frame that carries it.
- **Emit for every mutating endpoint**, not the convenient ones. The list is the same
  exhaustive list [Versions](../spec/wire-format.md#versions) gives for snapshots; a server
  that skips one loses reactivity for that verb exactly as silently as it loses rollback
  history.

## Known limitations

State them here so no one designs against a guarantee that isn't offered.

- **Losing access is invisible.** When a permission change revokes a subscriber's read
  access, they receive no event — they simply stop hearing about the record. There is no
  "removed from your view" signal, and adding one would disclose the revocation itself.
  A long-lived cache can therefore hold a record the holder may no longer read; consumers
  displaying shared data should revalidate on a schedule of their own.
- **Gaining access arrives as `changed`, not `created`.** Hence upsert semantics (D1).
- **A restart with no feed is a full resync.** Local stacks have no `seq`; remote stacks
  with `resume: false` always `reset`.
- **`migrateAll()` fans out.** One event per migrated record, with no batch frame in v1.
  A sweep over thousands of records emits thousands of events. Batching is additive later
  (a new frame name); it is not a v1 requirement.
- **Hard delete is unreconcilable by query.** Nothing distinguishes "purged" from "never
  existed" after the fact, so a consumer that missed a `purged` event finds it only by
  enumerating.

## Work items

Core and server can proceed in parallel from here; the wire sections above are what the
server builds against.

**`@haverstack/core`**

- [ ] `RecordChange`, `ChangeKind`, `ChangeOp`, `ChangeFilter`, `SubscribeOptions` in `types.ts`
- [ ] Emitter in `Stack`, one emission per version bump, at the points D4 fixes
- [ ] `ScopedStack.subscribe()` — `canRead` per event, grants prefetched per subscription
- [ ] `subscribe()` on `StackClient`; optional `subscribeChanges?()` on `StackRecordAdapter`
- [ ] `docs/spec/events.md` + the wire sections above folded into `docs/spec/wire-format.md`

**`@haverstack/wire-types`**

- [ ] `WireRecordChange`, frame names, `DiscoveryChanges`, `?include=record`

**`@haverstack/conformance-fixtures`**

- [ ] Frame fixtures per `kind`; `ready`/`reset` control frames
- [ ] A sequence fixture for resume: connect, mutate, reconnect with `Last-Event-ID`
- [ ] A sequence fixture for `reset` on an unhonorable cursor
- [ ] Permission fixture: a record the session cannot read produces no frame

**`@haverstack/adapter-api`**

- [ ] `subscribeChanges()` over `fetch` streaming; discovery gate; backoff with jitter;
      reconnect through the existing 401 re-auth path

## Open questions

Neither blocks the server starting; both should be answered before fixtures freeze.

- **Long-poll as a second normative transport.** A serverless deployment cannot hold a
  stream. The `since`/`reset` semantics carry over unchanged, so the cost is a second
  conformance surface, not a second design. Worth deciding by whether `haverstack/server`
  targets a long-lived process.
- **Whether `?include=record` is worth v1 at all.** Notify-then-reconcile (the position
  this document takes) makes the body an optimization the first consumers may not need,
  and dropping it removes a `records` discovery flag and a fixture axis. Keeping it is
  cheap for a server that already has the record in hand at emission.
