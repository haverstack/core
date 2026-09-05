# @haverstack/adapter-api

## 0.25.0

### Minor Changes

- [#256](https://github.com/haverstack/core/pull/256) [`0bd803f`](https://github.com/haverstack/core/commit/0bd803f607d39faa776d5dcc1cb8bcb722d99651) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Reshape `AdapterCapabilities` around the query surface each entry gates, and collapse the two content-filter flags into one ordered reach:

  ```ts
  type AdapterCapabilities = {
    filter: { content: 'none' | 'field' | 'path'; contentPresent: boolean; search: boolean };
    sort: { fields: NativeSortField[]; contentField: boolean };
    limits: { attachmentBytes: number | null; contentBytes: number | null };
  };
  ```

  `filter.content` replaces `contentFieldQuery` and `nestedContentQuery`, which were never siblings: path reach without field reach is not a state an adapter can be in, and two booleans could spell it. As one ordered value the rungs nest by construction, and the query layer compares against a rung instead of consulting one flag before the other.

  Every other entry is renamed for the query key it answers for — `filter.search` gates `filter.search`, `sort.fields` gates `sort.field` — so the capability a query needs is derivable from the query rather than memorized, and `APIAdapterCapabilityError.capability` now names it as a path (`'filter.contentPresent'`) rather than a flag. `limits` groups the two byte ceilings apart from the feature flags: nothing is refused for lacking one.

  `@haverstack/wire-types` exports `normalizeCapabilities()`, and `APIAdapter.open()` reads every discovery response through it. One rule now covers absent, malformed and unrecognized alike — each resolves to the least capable value it could stand for — where each key previously carried its own default at the call site, and three of them carried none at all: a discovery response omitting `maxAttachmentBytes` left `undefined` behind a `number | null`, which silently skipped the client-side upload pre-check instead of enforcing it. A `filter.content` rung a client does not recognize reads as `'none'` for the same reason silence does: refusing a query is recoverable, presenting an unfiltered superset as a filtered result is not.

  The wire shape of `capabilities` changes with the type, and `DiscoveryCapabilities` now types it as a foreign server may actually send it — every field optional, and loose where an unrecognized value is possible.

### Patch Changes

- Updated dependencies [[`0bd803f`](https://github.com/haverstack/core/commit/0bd803f607d39faa776d5dcc1cb8bcb722d99651)]:
  - @haverstack/core@0.26.0
  - @haverstack/wire-types@0.25.0

## 0.24.0

### Minor Changes

- [#253](https://github.com/haverstack/core/pull/253) [`8a31b4e`](https://github.com/haverstack/core/commit/8a31b4ecb0117c86e1c5004c52f73fec9730f625) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Sort by a top-level content field: `query({ sort: { contentField: 'publishedAt', direction: 'desc' } })`. A consumer wanting a bounded page in a meaningful order previously had to page the whole matched set and sort it in memory — a cost that grew with the stack while the page stayed the same size.

  `QuerySort` gains a `contentField` member beside `field` rather than widening `field` to a string: a content field may be named `version`, and a `'content.'` prefix collides with the filter path separator. Over the wire the two are `?sortContent=` and `?sort=`, and a request naming both is refused.

  The ordering is defined once in core so no two adapters answer one query differently. A field orders as the kind its schema declares — dates as instants, booleans as false-then-true — a record holding no value at the field sorts last in both directions, numbers precede text where types disagree about a field name, and text orders by a case- and accent-folded key (`apple`, `Émile`, `Zebra`) rather than by code point. What that fold does not promise — locale tailoring, script-aware or natural-number ordering — is stated in `docs/spec/data-model.md` § Text ordering.

  SQLite-backed adapters materialize a `content_sort` index, maintained on every write alongside `file_refs`, and only for top-level scalars — the same line `file-ref` indexing draws.

  `AdapterCapabilities` gains `contentFieldSort`, and `sortableFields` is now enforced rather than merely declared: a sort an adapter has not declared throws `StackQueryError` instead of being answered in some other order. `sortableFields` is typed `NativeSortField[]`, since content fields are unbounded and an adapter that indexes content for sorting indexes every top-level scalar.

  `MemoryAdapter` now honors `sort`, where it previously returned insertion order whatever the query asked for.

- [#253](https://github.com/haverstack/core/pull/253) [`a9f6ebf`](https://github.com/haverstack/core/commit/a9f6ebfc63824d604cd96647aaf862c9ad362275) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Add `filter.contentPresent`, the question an exact-match filter value cannot ask: which records hold a value at a path at all. A `null` content filter already matched "no value at the path, or a value that is null" — this is the other side, and without it an app wanting only the records that _have_ a field had to carry a redundant boolean beside it.

  ```ts
  query({ filter: { contentPresent: ['publishedAt'] } }); // published articles
  query({ filter: { content: { publishedAt: null } } }); // drafts
  ```

  It lists paths, all of which must hold a value (an intersection, like `tags`), and an empty list filters nothing. A path holds a value when at least one non-null value is reachable at it, so it reads an array element-wise exactly as a content filter does. Where a path is multi-valued the two filters are not strict complements — `tags: [null, 'x']` satisfies both — which falls out of element-wise matching rather than being a special case.

  `AdapterCapabilities` gains `contentPresenceQuery`, a third content flag beside `nestedContentQuery` and for the same reason: a server promising to match a content value has not thereby promised to answer whether one is there, and reading it as such would hand a client the unfiltered superset that ignoring the filter produces. It travels in the `POST /records/query` body only, as `filter.content` does.

### Patch Changes

- Updated dependencies [[`8a31b4e`](https://github.com/haverstack/core/commit/8a31b4ecb0117c86e1c5004c52f73fec9730f625), [`a9f6ebf`](https://github.com/haverstack/core/commit/a9f6ebfc63824d604cd96647aaf862c9ad362275)]:
  - @haverstack/wire-types@0.24.0
  - @haverstack/core@0.25.0

## 0.23.0

### Minor Changes

- Released for a breaking change in `@haverstack/core`, `@haverstack/wire-types`.

### Patch Changes

- Updated dependencies [[`0c76cb7`](https://github.com/haverstack/core/commit/0c76cb7b51f2ea407521ae1df1ff0c8e5852d53e)]:
  - @haverstack/wire-types@0.23.0
  - @haverstack/core@0.24.0

## 0.22.0

### Minor Changes

- Released for a breaking change in `@haverstack/core`, `@haverstack/wire-types`.

### Patch Changes

- Updated dependencies [[`896b516`](https://github.com/haverstack/core/commit/896b5167d68690a307cba430ded97268c83fe218), [`e4119ea`](https://github.com/haverstack/core/commit/e4119eaa03f0510aa773b31cf36e860541857517)]:
  - @haverstack/wire-types@0.22.0
  - @haverstack/core@0.23.0

## 0.21.0

### Minor Changes

- Released for a breaking change in `@haverstack/core`, `@haverstack/wire-types`.

### Patch Changes

- Updated dependencies [[`d945ded`](https://github.com/haverstack/core/commit/d945ded1ead75e6e3e11a6088afa72dd889c8342), [`65476bd`](https://github.com/haverstack/core/commit/65476bd3f7aa025cec0790653bcc9cdb691bfce1)]:
  - @haverstack/wire-types@0.21.0
  - @haverstack/core@0.22.0

## 0.20.0

### Minor Changes

- Released for a breaking change in `@haverstack/core`, `@haverstack/wire-types`.

### Patch Changes

- Updated dependencies [[`64dfb36`](https://github.com/haverstack/core/commit/64dfb3621635438c9529b4be134b60cf936fb152)]:
  - @haverstack/wire-types@0.20.0
  - @haverstack/core@0.21.0

## 0.19.0

### Minor Changes

- [#227](https://github.com/haverstack/core/pull/227) [`59df7e6`](https://github.com/haverstack/core/commit/59df7e657a95cdc22a6f29c73c86e5d0e2d59b80) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Refuse a plaintext `http://` URL to a non-loopback host, before the credential is spent or anything is sent: the bearer token, the handshake signature and every record would travel in the clear. `localhost`, `127.0.0.0/8` and `::1` are unaffected. Pass `allowInsecure: true` where the transport is already private.

### Patch Changes

- Updated dependencies [[`59df7e6`](https://github.com/haverstack/core/commit/59df7e657a95cdc22a6f29c73c86e5d0e2d59b80), [`59df7e6`](https://github.com/haverstack/core/commit/59df7e657a95cdc22a6f29c73c86e5d0e2d59b80)]:
  - @haverstack/wire-types@0.19.0
  - @haverstack/core@0.20.0

## 0.18.0

### Minor Changes

- [#225](https://github.com/haverstack/core/pull/225) [`46691c5`](https://github.com/haverstack/core/commit/46691c57f6b3b79f3d008fc29b2382c5eb3da006) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Make nested content queryable: a `filter.content` key is now a dot-separated
  path, and an array anywhere along it is matched element-wise. `contact@1`
  stores `emails` as `[{ value, label }]`, so "which contact has this address"
  is `{ content: { 'emails.value': 'ada@example.com' } }` rather than a fetch
  and an in-memory scan. Containment falls out of the same rule, so
  `{ content: { tags: 'starred' } }` matches a record whose `tags` array
  contains it.

  This replaces the reading in which a filter key named one top-level field
  literally: `{ content: { 'a.b': 1 } }` now asks for `b` inside `a` on every
  adapter, and a field literally named `a.b` is no longer writable. Paths and
  field names are kept unambiguous from the write side rather than by an escape
  convention: a content field name may no longer contain `.`, `[`, `]`, `$`,
  `"`, `*`, or `#`, at every depth and in a declared schema alike, with
  `StackValidationError`. An escape convention fails silently when app code
  builds a key from a variable name; a write-time rule fails loudly while the
  caller can still pick another name. The guarantee that no key is reinterpreted
  as syntax is kept: a segment is carried as a bound parameter matched against a
  key, never assembled into a path expression, and a key that cannot be a path
  is `StackQueryError` (400) rather than an engine error.

  Multi-segment keys are gated on a new `nestedContentQuery` capability rather
  than on a widened `contentFieldQuery`: a foreign server declaring the latter
  matches whole field names, and reading that as a promise of traversal would
  hand a client an unfiltered superset presented as a filtered result. A
  discovery response omitting the flag means `false`.

  A `null` filter value now reads as "no value at the path, or a value that is
  null", so a missing intermediate matches. A path is capped at 32 segments,
  the longest both SQLite engines can execute. Nested fields stay unindexed, and
  depth multiplies cost: each segment fans out across every element of an array
  it meets, so a server owes the bound in wire-format's Bounding query cost.
  A `file-ref` nested in an array or object is now reachable by a filter but is
  still not indexed as a reference.

### Patch Changes

- Updated dependencies [[`46691c5`](https://github.com/haverstack/core/commit/46691c57f6b3b79f3d008fc29b2382c5eb3da006)]:
  - @haverstack/wire-types@0.18.0
  - @haverstack/core@0.19.0

## 0.17.0

### Minor Changes

- Released for a breaking change in `@haverstack/core`, `@haverstack/wire-types`.

### Patch Changes

- [#220](https://github.com/haverstack/core/pull/220) [`5324f8e`](https://github.com/haverstack/core/commit/5324f8ec4ef6ef2225f3c05661e3d3d1d860512b) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Discard a `ready` frame `seq` that falls outside the framable base64url charset, as frame ids already are. Echoing one into `Last-Event-ID` on the reconnect after a `reset` had `fetch` refuse every attempt, wedging a feed that could have resumed from the present.
- Updated dependencies [[`5324f8e`](https://github.com/haverstack/core/commit/5324f8ec4ef6ef2225f3c05661e3d3d1d860512b), [`d0c0bb2`](https://github.com/haverstack/core/commit/d0c0bb25bae95f1285e2b2a0db980d0c4d215ac2), [`5324f8e`](https://github.com/haverstack/core/commit/5324f8ec4ef6ef2225f3c05661e3d3d1d860512b)]:
  - @haverstack/core@0.18.0
  - @haverstack/wire-types@0.17.0

## 0.16.0

### Minor Changes

- Released for a breaking change in `@haverstack/core`, `@haverstack/wire-types`.

### Patch Changes

- Updated dependencies [[`d27cfe4`](https://github.com/haverstack/core/commit/d27cfe4fc09406abda36c1c93f071446e13ef7b8)]:
  - @haverstack/wire-types@0.16.0
  - @haverstack/core@0.17.0

## 0.15.0

### Minor Changes

- Released for a breaking change in `@haverstack/core`, `@haverstack/wire-types`.

### Patch Changes

- Updated dependencies [[`609c320`](https://github.com/haverstack/core/commit/609c320728ff47cae3997042685a9fc2f7a12150)]:
  - @haverstack/core@0.16.0
  - @haverstack/wire-types@0.15.0

## 0.14.0

### Minor Changes

- [#209](https://github.com/haverstack/core/pull/209) [`9edf5d0`](https://github.com/haverstack/core/commit/9edf5d02925fc6db3d829c21e23150abf15d8a8f) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Add an `unlisted` state for records — reachable by ID, absent from enumeration by default.

  `StackRecord.unlistedAt` is a native field, orthogonal to `permissions`: it says nothing
  about who may read a record, only whether it is enumerable. A record with `unlistedAt` set
  is reachable by `get()` for anyone who may already read it, and excluded from an unfiltered
  `query()` and the change feed by default — the same posture soft delete already has.
  - `stack.create(typeId, content, { unlisted: true })` creates a record already unlisted, so
    there is no window where it exists and is briefly enumerable.
  - `stack.setUnlisted(id, unlisted)` toggles it on an existing record, gated exactly like
    `setPermissions()` under `ScopedStack` — both decide who can discover a record, not merely
    read one already found.
  - `RecordFilter.includeUnlisted` and `SubscribeOptions.includeUnlisted` opt a query or
    subscription back in. Unlike `includeDeleted`, `includeUnlisted` is refused to everyone but
    the stack owner acting alone under `ScopedStack` — enumeration standing rests on nothing but
    ownership, so no grant or delegation carries it.
  - The change feed matches `query()`'s exclusion, with one exception: marking a record unlisted
    emits a dedicated `unlist` op (kind `deleted`) so a subscriber that already knows the record
    is told to drop it; relisting emits `list` (kind `changed`), an ordinary upsert like
    `undelete`. Every other transition — created unlisted, an edit while already unlisted, a
    purge of a record that was never listed — needs no special-casing, since it falls out of
    checking the record's current state.

  See docs/spec/access-control.md § Unlisted records and docs/spec/events.md § The unlisted
  transition.

### Patch Changes

- Updated dependencies [[`9edf5d0`](https://github.com/haverstack/core/commit/9edf5d02925fc6db3d829c21e23150abf15d8a8f)]:
  - @haverstack/core@0.15.0
  - @haverstack/wire-types@0.14.0

## 0.13.0

### Minor Changes

- [#207](https://github.com/haverstack/core/pull/207) [`7db6eaf`](https://github.com/haverstack/core/commit/7db6eaff9dd96eccbc9e96e7a104f3529aa708c9) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Relationship associations carry a discriminated `target` instead of a bare `recordId`

  A relationship's target now names which identifier space its value belongs to:
  `{ scope: 'record', recordId, stackUrl? }` for a Record here or in another stack,
  `{ scope: 'entity', entityId }` for a DID, and `{ scope: 'external', ns, id }` for
  anything outside the stack — an ATProto post, an ActivityPub actor, an email address,
  a URL. Core expresses the reference and never dereferences it, so no protocol is
  privileged.

  The `entity` arm closes a gap in the identity model rather than only enabling external
  references: group rosters stored member DIDs in a field typed `RecordId`, and the
  permission path compared the two as plain strings. A roster entry carrying a `record`
  target now confers nothing, even when its value equals a member's DID.

  `RecordFilter.relatedTo` moves with it. It names a label, a target, or both, and each
  is a pattern: a bare `label` matches every target under it, and an external target with
  no `id` matches a whole namespace. A `record` target with no `stackUrl` matches only
  local targets — absence names this stack rather than acting as a wildcard. Label-only
  and namespace-wide queries were not expressible before. "Carries any relationship at
  all" is deliberately not expressible, in line with `tags` and `hasAttachment`, which
  have no match-any form either.

  Reference-creation gating now applies only to a relationship naming a Record in this
  stack; the other arms name nothing core can resolve, so there is no access for the
  gate to protect. The SQLite association table gains `related_scope`, `related_ns` and
  `related_stack` columns, all part of the primary key — so two copies of one record on
  two networks are two associations rather than a silent no-op. Existing stack files
  predate those columns and must be recreated.

  Over the wire, the relationship filter's scope is implied by which parameters appear
  (`relatedTo`/`relatedToStack`, `relatedToEntity`, or `relatedToNs`/`relatedToId`), and
  a request mixing scopes is rejected with 400. At least one is always present, so the
  filter cannot encode to an empty query string and widen the query it meant to narrow.

  A target names exactly one thing, exactly one way, and both halves are enforced at
  runtime rather than only by the type — a target reaching a server in a request body,
  or a filter decoded from query parameters, is a plain object the type never saw. A
  `scope` outside the three, or an empty string where a target names something, is
  rejected with `StackValidationError`; a `relatedTo` naming neither a label nor a target
  is rejected with `StackQueryError` instead of matching every Record carrying a
  relationship. This stack is named by omitting `stackUrl`, never by sending an empty
  one: storage, association identity and the filter all read absent and empty as this
  stack, and reference-creation gating now reads them that way too, so both spellings of
  a local Record require read access to it.

### Patch Changes

- Updated dependencies [[`7db6eaf`](https://github.com/haverstack/core/commit/7db6eaff9dd96eccbc9e96e7a104f3529aa708c9)]:
  - @haverstack/wire-types@0.13.0
  - @haverstack/core@0.14.0

## 0.12.2

### Patch Changes

- [#200](https://github.com/haverstack/core/pull/200) [`ddeaaf4`](https://github.com/haverstack/core/commit/ddeaaf426b106e19bb7c8807722f781995a3dd48) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Stop the change-feed client reconnecting against a refusal that will repeat.

  `isFatalFeedError` ended the reconnect loop only for an unrenewable
  credential (401) and an authorization refusal (403). Every other refusal the
  server faulted the request for — a malformed cursor or filter answered
  `400 bad_request`, say — was treated as transient, so `subscribeChanges()`
  retried it with backoff indefinitely, settling into an attempt roughly every
  15 seconds and reporting the same error to `onError` each time. The
  subscriber was never told to stop, and `onReset` never fired, so the
  application had nothing to reconcile from either.

  The predicate now decides on the wire status: a `4xx` ends the loop, since
  the reconnect sends the same request and would be refused the same way. A
  `5xx` still reconnects, which is what keeps `timeout` — the answer a server
  gives while shedding query load — from turning a busy server into a
  permanently dead subscription.

## 0.12.1

### Patch Changes

- [#196](https://github.com/haverstack/core/pull/196) [`bc2224f`](https://github.com/haverstack/core/commit/bc2224f9dba882b3928d18a68d28d54fa966cb76) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Harden query sorting and the change-feed client.
  - Validate `sort.direction` (and `sort.field`) at the invariant layer: the
    types promise `'asc' | 'desc'`, but a type is not a runtime guard, and a
    SQLite record adapter interpolates the direction straight into `ORDER BY`.
    An out-of-range value is now refused with `StackQueryError` instead of
    reaching SQL, closing a blind-injection sink reachable from any untrusted
    caller (a delegated app, or a server mapping `?direction=`). The SQL query
    builder re-checks defensively.
  - Change-feed SSE decoder: hold a trailing `\r` across chunk boundaries so a
    CRLF frame split between its CR and LF decodes as one frame, and cap an
    unterminated frame's buffer so a peer that never closes one cannot exhaust
    client memory.
  - Change-feed client: report an unparseable record frame through `onError`
    and keep reading instead of dropping the connection; refuse a resume cursor
    outside the seq charset locally; and stop reconnecting after a fatal auth or
    authorization failure rather than looping with backoff.

## 0.12.0

### Minor Changes

- [#193](https://github.com/haverstack/core/pull/193) [`d556069`](https://github.com/haverstack/core/commit/d5560696f3ec1d08e9d49f66b79cbf2f5036dfef) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Relay changes that originate elsewhere. `Stack.subscribe()` now opens the adapter's feed alongside its own emitter, so a subscriber to a remote stack hears about writes made by anyone, and `onReset` — until now a documented option that could never fire — reaches the app when a gap opens that resumption could not close.

  `APIAdapter.subscribeChanges()` consumes `GET /changes` as SSE over `fetch`: refused locally when discovery advertises no feed, resolved once the server's `ready` frame makes subscribe-then-query gap-free, resumed with `Last-Event-ID`, reconnected with exponential backoff and full jitter, and re-authenticated through the existing single-flight 401 path.

  A relay is opened per subscription and carries that subscription's filter, because `entityId` and `parentId` are answerable only where the record is. A scoped view of a stack that relays refuses to subscribe with the new `StackRelayScopeError` rather than narrow a feed it cannot re-scope.

### Patch Changes

- Updated dependencies [[`d556069`](https://github.com/haverstack/core/commit/d5560696f3ec1d08e9d49f66b79cbf2f5036dfef)]:
  - @haverstack/wire-types@0.12.0
  - @haverstack/core@0.13.0

## 0.11.0

### Minor Changes

- Released for a breaking change in `@haverstack/wire-types`.

### Patch Changes

- Updated dependencies [[`ca0acdc`](https://github.com/haverstack/core/commit/ca0acdc78e6861fc371140b040898ce28279c435)]:
  - @haverstack/wire-types@0.11.0

## 0.10.0

### Minor Changes

- Released for a breaking change in `@haverstack/core`, `@haverstack/wire-types`.

### Patch Changes

- Updated dependencies [[`779ddd6`](https://github.com/haverstack/core/commit/779ddd6599c8b9049ca6fbf1516a4a54705e9609)]:
  - @haverstack/wire-types@0.10.0
  - @haverstack/core@0.12.0
