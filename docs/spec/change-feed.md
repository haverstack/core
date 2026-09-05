# Change feed — wire format

Apps observe record changes by subscribing rather than polling. The feed answers _when_ something the requester can read changed; `query()` and `get()` answer _what_ it now is. The event vocabulary, the delivery guarantees and the permission rule are one design shared with the local API — see [Change events](./events.md), which this document is the wire encoding of. The rest of the HTTP API is [Wire format](./wire-format.md), whose discovery, auth and error vocabulary this feed rides on.

## Advertising it

A server that offers a feed says so in [discovery](./wire-format.md#discovery):

```json
"changes": { "transports": ["sse"], "resume": true, "records": true }
```

An object rather than a boolean, for the same reason [`auth`](./wire-format.md#advertising-it) is one: this surface grows entries — another transport, batched frames — and the alternative is a boolean followed by three more of them. Absent `changes` means no feed.

- `transports` lists the delivery mechanisms offered. `sse` is the only one in this version.
- `resume: false` is conformant. It means the server honors no cursor, so every connection is answered with a `reset` frame.
- `records` reports whether `?include=record` is honored. `false` is conformant; the fetch fallback is the contract either way.

**A client checks discovery and fails locally.** `APIAdapter.subscribeChanges()` against a server advertising no feed throws `APIAdapterCapabilityError` **without sending a request**, exactly as content and search filters do. Learning this as a 404 partway through a connection is the failure mode `auth.methods` exists to avoid.

## The endpoint

```
GET /changes
Accept: text/event-stream
Authorization: Bearer <token>
Last-Event-ID: <seq>          (equivalently ?since=<seq>)

?typeId=          (repeatable; baseId or versioned, matched by baseId)
?parentId=        ("null" for root records, as GET /records)
?entityId=        (the record's author, not the actor)
?kind=            (repeatable: created|changed|deleted|purged)
?include=record   (ignored for kind=purged)
?includeUnlisted= (owner-only — see Unlisted)
```

Response: `200 text/event-stream`, a stream of frames.

`@haverstack/core/wire` exports `parseChangeParams()`, a conforming implementation of the params above — filter, `include` and `includeUnlisted` in one object, since a server needs the last of those before the stream opens to answer the owner-only `403`. The resume cursor is not part of it: reconciling `Last-Event-ID` against `?since=` is resumption machinery rather than request encoding.

**Filtering is exact, not advisory**, exactly as it is [locally](./events.md#subscribing): a filtered connection never receives an event outside its filter. `typeId` is matched by `baseId`, as [grants are](./access-control.md#type-level-grants), so a type version bump never silently orphans a subscription. `entityId` filters on the record's **author** — which is deliberately not in the envelope, and never needed to be: filtering happens here, where the record is in hand.

## Frames

```
event: ready
data: {"seq":"AA3f1Q"}

id: AA3f1R
event: record
data: {"kind":"changed","op":"update","recordId":"1hk153x00001",
       "typeId":"com.example/note@1","version":7,
       "updatedAt":"2026-08-13T12:00:00.000Z",
       "actor":{"entityId":"did:key:z6Mk..."}}

id: AA3f1S
event: record
data: {"kind":"purged","op":"hard-delete","recordId":"1hk153x00002",
       "typeId":"com.example/note@1","version":4,
       "updatedAt":"2026-08-13T12:00:03.000Z",
       "actor":{"entityId":"did:key:z6MkOwner..."}}

: keepalive

event: reset
data: {"reason":"cursor_expired"}
```

- **`ready` is sent first, always.** It carries the head cursor, and it is what makes subscribe-then-query gap-free: a client that awaits it before querying knows every later change is in one or the other. A server that mints no cursors sends it with no `seq`.
- **`record`** carries one change. `updatedAt` is an ISO string; `record`, when included, is a `WireRecord`. The envelope describes the change and carries no record provenance — `actor` is who performed it, never who authored the record. See [Change events § Attribution](./events.md#attribution).
- **`reset`** means _your cursor cannot be honored; resynchronize by query_. A server with no buffer at all sends it on every connection and is fully conformant. `reason` is informational (`cursor_expired`, `not_supported`, `overflow`) — the client's repair is the same for all three.
- **`: keepalive` comments** SHOULD be sent on an idle interval, so intermediaries do not reap the connection and a client can detect a dead one.

**A purged frame carries `kind`, `op`, `recordId`, `typeId`, `version`, `updatedAt` and `actor` — nothing else**, whatever the client asked for and whatever the server advertises: no `record`, no `parentId`, no author. See [Change events § Purged records carry nothing](./events.md#purged-records-carry-nothing) for why. `@haverstack/wire-types`' `serializeChange()` enforces it in the encoding, because the server holds the record at emission — for the readability check below — and is therefore in exactly the position to leak it.

**A client MUST ignore a frame whose name it does not recognize.** That is what makes a new frame an additive, minor change under [version negotiation](./wire-format.md#version-negotiation) rather than a break — type events, batch frames and anything else arrive that way.

**`seq` is opaque and restricted to the unreserved base64url alphabet (`A-Za-z0-9_-`)**, for the same reason [a nonce is](./wire-format.md#the-handshake): it travels in a line-oriented protocol, where an unconstrained value would span fields and truncate the frame carrying it. A client echoes a cursor back and never computes with one, so a server is free to implement it as a WAL offset, a timestamp-counter pair, or anything else. `isValidSeq()` in `@haverstack/wire-types` applies the rule on both sides, and `@haverstack/core` applies it again to a `since` handed to `subscribe()` — so a cursor that could not be framed is refused the same way whatever adapter is underneath, rather than reaching one as a header it would truncate.

## Backpressure and reconnection

**On buffer overflow a server closes the stream** rather than dropping frames silently. The client reconnects, presents its cursor, and receives `reset` if the gap cannot be filled. Silent gaps are the one behavior that makes a feed untrustworthy: a client that cannot tell it missed something cannot repair it either.

**Reconnection is the client's job, with exponential backoff and jitter.** A server restart otherwise produces a synchronized reconnect stampede from every client it dropped.

**A client stops reconnecting when the answer was `4xx`, and keeps reconnecting when it was `5xx`.** The reconnect sends the same request, so a status faulting that request — a malformed cursor or filter, an unrenewable credential, an authorization refusal — will be answered identically however long the client waits, and backing off only spins. A `5xx` says the server could not serve a request it did not fault, which is the case backoff exists for; `timeout` is the answer a server gives while [shedding query load](./wire-format.md#bounding-query-cost) and a client that gave up on it would turn a busy server into a dead subscription. A client that stops reports the error to its subscriber first; the repair is to subscribe again.

## Permission scoping

**A connection delivers the events its token's session may read, and nothing else** — the `canRead`-per-event rule the [local feed](./events.md#permission-scoping) defines, including its refusal to emit anything at all about a record the requester cannot read. A server subscribes **unscoped** at the storage owner and fans out per connection, filtering each through the `ScopedStack` its token's session names via `Stack.forSession()`, taking the `(principalId, subjectId)` pair whole. Delegated authority is then the ordinary [intersection](./access-control.md#delegation-principal-and-subject), inherited rather than reimplemented.

Two consequences are easy to discover too late:

- **`canRead` is not free per event.** It resolves grants, and without a cache that is a `_grant` query per event per connection. A subscription opened through `ScopedStack.subscribe()` already carries that cache and expires it from the stream itself, so a server that opens one per connection inherits both and has nothing to build — see [Change events § Permission scoping](./events.md#permission-scoping). The cost is a real one to weigh only where a server scopes the feed some other way.
- **A purged record cannot be permission-checked after the fact.** Readability must be evaluated at mutation time, on the record as it stood, because after the write there is nothing left to check.

## Auth, and what a stream does not renew

A feed connection is an ordinary request through the same path every other request takes, so a `401` triggers the existing single-flight re-authentication and one retry. **The change feed introduces no new auth machinery**, and a design that opened the stream outside that path would need its own token lifecycle and would get it subtly wrong.

**A stream's authority is fixed at connect and re-evaluated only at reconnect.** Renewing a token does not extend or re-authorize an open stream, and a client MUST NOT assume it does; [`expiresAt` is advisory](./wire-format.md#the-handshake) and stays so, since the stream is not what holds the token. The consequence is the one genuinely new hazard here: **a long-lived stream can outlive the authority that opened it**, delivering to a token that has since expired or been revoked. It is a property of state rather than shape, so no fixture catches it — see the checklist below.

## Feed implementation checklist

As with [the auth checklist](./wire-format.md#server-implementation-checklist), each of these is a property of state or configuration rather than shape, so **a server can pass every change-feed fixture and still be wrong.**

- **Bound stream lifetime, or re-check the session periodically.** A revoked or expired token must stop delivering. Closing the stream is enough: the client reconnects and gets a `401`, which is a path that already works.
- **Never accept a bearer token as a query parameter**, on this endpoint or any other, however convenient `EventSource` would make it.
- **Evaluate readability at mutation time for a purge**, before the record is destroyed.
- **Never put the purged record, or anything identifying it, into a purged frame.** Holding the record for that readability check makes it easy to serve under `?include=record`, and to fill an author field from it. Both defeat the erasure the verb performs.
- **Invalidate any authority cache of your own on `_grant` and `_group` events.** Caching authority is necessary for throughput and unsafe without it — a cache that ignores them serves a revoked subscriber indefinitely. The per-subscription cache behind `canRead` already does this, so what remains is any cache a server adds on top, such as one shared across connections.
- **Close on buffer overflow; never drop a frame silently.**
- **Only the storage owner can emit.** [Exactly one process owns a stack's storage](./adapters.md#concurrency--storage-ownership), so events exist only in that process. A multi-process server needs its own fan-out from the owner; a second process subscribing to its own `Stack` sees nothing and looks fine in testing.
- **Mint cursors in the base64url alphabet only** — a value containing a newline truncates the frame that carries it.
- **Emit for every mutating endpoint**, not the convenient ones. The list is the exhaustive one under [Versions](./wire-format.md#versions), plus create and hard delete.

## Why SSE, and why not `EventSource`

SSE is one-way server→client, which is the entire requirement; it carries frame ids and resumption (`id:` / `Last-Event-ID`) in the protocol itself; and a server implements it as a streaming HTTP response with no new dependency, no upgrade path and no separate auth story. WebSocket buys bidirectionality that nothing here needs.

But **the browser `EventSource` API cannot set an `Authorization` header**, which is why SSE deployments so often end up with a token in the query string. That is not available here — query strings land in access logs, referrers and proxy telemetry, and this token is a programmatically renewable credential rather than a hand-placed one. The feed is therefore consumed via `fetch` with a streaming body.
