# @haverstack/core

## 0.16.0

### Minor Changes

- [#214](https://github.com/haverstack/core/pull/214) [`609c320`](https://github.com/haverstack/core/commit/609c320728ff47cae3997042685a9fc2f7a12150) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Add `createdAt`/`updatedAt` options to `Stack.create()`, so an app — or a stack owner, through
  their own server — can import an existing corpus with its real dates instead of every record
  landing stamped with the import moment.
  - Unconditional on unscoped `Stack.create()`, like the existing client-minted `id` option.
    `ScopedStack.create()` accepts the same two fields, but only from the stack owner acting
    alone (undelegated, authenticated as themselves — the same tier that already gates hard
    delete, `commitMigration()`, and `includeUnlisted`); a grantee, or a delegated app acting for
    the owner, is refused with `StackPermissionError`. Over the wire, an owner-authenticated
    `POST /records` may carry both fields — but unlike `entityId`/`principalId`, which
    `ScopedStack` silently overrides, these are refused, and every client sends them on every
    create. A server must drop them from a non-owner body itself rather than forwarding it.
  - Omit `id` and it is derived from `createdAt`'s timestamp, so the two agree by construction.
    Supply both, and they are checked against each other using the same `idTimestampSkewMs`
    tolerance the ordinary `id`-vs-current-time check already uses (default 24 hours; `null`
    disables this check too) — disagreement beyond that tolerance throws `StackValidationError`
    rather than silently diverging. An owner's plain `id`-only create through `ScopedStack` is
    unaffected — it still gets the ordinary `id`-vs-current-time check, not this one.
  - `updatedAt` defaults to `createdAt`, not to the actual current time, so a plain import
    doesn't fabricate a fake edit and inflate version history. An `updatedAt` earlier than
    `createdAt` is a validation error, including when `createdAt` defaulted to now.
  - Both fields must be valid Dates within the range a record ID's timestamp prefix can
    encode (1970-01-01 through 3084-12-12); anything else is a `StackValidationError`. An
    `Invalid Date` in particular is refused rather than stored, since its `NaN` timestamp
    would silently switch off the checks above instead of failing them.
  - Dates are copied on the way in, so an import loop that advances and reuses a single
    `Date` across rows doesn't retro-edit the records it already wrote.

  See docs/spec/data-model.md § Record IDs.

## 0.15.0

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

## 0.14.0

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

## 0.13.1

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

## 0.13.0

### Minor Changes

- [#193](https://github.com/haverstack/core/pull/193) [`d556069`](https://github.com/haverstack/core/commit/d5560696f3ec1d08e9d49f66b79cbf2f5036dfef) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Relay changes that originate elsewhere. `Stack.subscribe()` now opens the adapter's feed alongside its own emitter, so a subscriber to a remote stack hears about writes made by anyone, and `onReset` — until now a documented option that could never fire — reaches the app when a gap opens that resumption could not close.

  `APIAdapter.subscribeChanges()` consumes `GET /changes` as SSE over `fetch`: refused locally when discovery advertises no feed, resolved once the server's `ready` frame makes subscribe-then-query gap-free, resumed with `Last-Event-ID`, reconnected with exponential backoff and full jitter, and re-authenticated through the existing single-flight 401 path.

  A relay is opened per subscription and carries that subscription's filter, because `entityId` and `parentId` are answerable only where the record is. A scoped view of a stack that relays refuses to subscribe with the new `StackRelayScopeError` rather than narrow a feed it cannot re-scope.

## 0.12.0

### Minor Changes

- [#185](https://github.com/haverstack/core/pull/185) [`779ddd6`](https://github.com/haverstack/core/commit/779ddd6599c8b9049ca6fbf1516a4a54705e9609) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Stop `ScopedStack` refusals from confirming which record IDs exist.

  A record the request cannot read now answers exactly as a missing one does. `ScopedStack.get()` returns `null` for an unreadable record instead of throwing `StackPermissionError`, and `update()`, `associate()`, `dissociate()`, `setPermissions()`, `delete()`, `undelete()`, `getVersions()`, `getVersion()` and `restoreVersion()` throw `StackNotFoundError` rather than `StackPermissionError` where the requester holds no read access. `StackPermissionError` is now reserved for a requester who can read the record — over the wire, 403 is earned by readability and everything else is 404.

  Record IDs encode their creation millisecond and increment within it, so the old distinction let anyone holding one ID confirm its same-millisecond siblings. Callers that branch on `StackPermissionError` to detect "exists but forbidden" will see `StackNotFoundError`/`null` instead; the distinction is still available to server operators, which `docs/spec/wire-format.md` § Server implementation checklist now asks them to log.

  Unaffected: refusals that never read the record — `commitMigration()`, `deleteAttachment()` and `collectAttachmentGarbage()` answer identically whether or not it exists — and reference-creation gating, which continues to collapse missing and inaccessible targets onto `StackPermissionError`.

  Fixtures gain `error-not-found-record-the-requester-cannot-read`, so a server that answers 403 there now fails conformance.

## 0.11.2

### Patch Changes

- [#184](https://github.com/haverstack/core/pull/184) [`fb33761`](https://github.com/haverstack/core/commit/fb33761ed30ddc26d9fd5beb4c1559267e2d01dc) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Correct the `repository` URL to the `git+https://github.com/haverstack/core.git` form npm validates provenance against.
