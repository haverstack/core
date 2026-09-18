# @haverstack/core

## 0.33.1

### Patch Changes

- [#294](https://github.com/haverstack/core/pull/294) [`b40731a`](https://github.com/haverstack/core/commit/b40731a0ae54689772e38729615a7bc753be58d0) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Build a change's two halves from one object, and correct the spec the journal left behind

  **`Stack` now names a change once.** A mutation writes its change twice — the
  durable half travels into the adapter's transaction ahead of the write, and the
  live half is built from the record that write produced — and until now each verb
  spelled both out separately. "The entry set is the event set" was a sentence in
  the spec enforced by nothing: eleven emission sites reconciled against eight
  journal sites only by reading each one, and the mutate path already stated the
  same actor two different ways.

  Both halves now come off one `PendingChange`, so a verb cannot journal one thing
  and announce another, and the rule that a hard delete writes no entry is a
  property of that object rather than something two call sites remember.

  No public API moves — neither builder was exported — and every reachable case
  resolves its actor exactly as before: read off the record for a version-bumping
  write, which stamped it, and off the request for `associate()`/`dissociate()`,
  which did not.

  **The surrounding spec caught up with the three changes that landed before it.**
  - `docs/spec/journal.md` is a document of its own, indexed from `docs/spec.md`.
    The journal has its own wire endpoint, permission gate and erasure rule; it had
    outgrown being a subsection of Versioning, and `wire-format.md § Journal` now
    defers to it instead of re-arguing five of its rules.
  - `data-model.md § Mutations` no longer teaches that every `mutate()` produces a
    version. A change set whose only key is `associations` produces none, which is
    the whole point of decoupling them, and this was the one document a reader
    meets that rule in.
  - `attachments.md` claimed nothing retains the `attachmentRecordId` a re-point
    discarded. The journal's `associationsReplaced` does, which is what makes a
    re-point undoable rather than merely observable.
  - `wire-format.md § Journal` documents `associationsReplaced`, which the wire
    already serialized and a fixture already pinned.
  - `spec.md`'s `StackClient` listing names `getJournal`, `subscribe`,
    `commitMigration`, `getEntityByDid` and `getOwnerEntity`, all of which the
    interface has and the list did not.
  - `StackClient.getJournal()`'s doc comment no longer says there is no wire
    surface. There is one.

- [#292](https://github.com/haverstack/core/pull/292) [`fd71019`](https://github.com/haverstack/core/commit/fd7101948d23b438e227dd03417201a10513585c) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Harden `MemoryAdapter`'s pagination cursor codec. The cursor descriptor embeds `sort.contentField` verbatim, so a non-Latin-1 field name made bare `btoa()` throw an `InvalidCharacterError` (a `DOMException`, not a `StackError`) out of an otherwise valid query — it now goes through the same explicit UTF-8 step the SQLite adapters' codec uses. Decoding also rejects a negative offset, which was previously accepted and slid the page window to the end of the result set.

## 0.33.0

### Minor Changes

- [#287](https://github.com/haverstack/core/pull/287) [`b164b5f`](https://github.com/haverstack/core/commit/b164b5f553967ae6190b5bd60ff42ad128724494) Thanks [@cuibonobo](https://github.com/cuibonobo)! - `associate()`/`dissociate()` events report what they moved

  `RecordChange` gains `associationsAdded`/`associationsRemoved`, present
  whenever `ops` includes `associate`/`dissociate`. Previously a subscriber
  learned only that _some_ association changed — recovering which one, or
  what an attachment association's `attachmentRecordId` changed to, meant
  fetching the whole record.

  Both fields report only what is true **now**, the same convention every
  other field on `RecordChange` follows:
  - `associationsAdded` is each association as it now stands, current
    annotation included — a re-point (a new `attachmentRecordId` on an
    association the record already held) surfaces here under its new value.
  - `associationsRemoved` is identity only (`kind`/`label`, plus `fileId` for
    an attachment) — an attachment's `attachmentRecordId` is never repeated
    on removal, the same way a `purged` frame never carries the content it
    destroyed.

  This does not make an association overwrite recoverable after the fact:
  associations are never snapshotted (see the `associations-outside-versioning`
  changeset), so a re-point's old `attachmentRecordId` still isn't retained
  anywhere — these fields only let a subscriber who is listening at the
  moment of the change observe it, in place of a fetch of the whole record.
  Retroactive recovery is tracked separately.

- [#287](https://github.com/haverstack/core/pull/287) [`a0163e7`](https://github.com/haverstack/core/commit/a0163e73126e487579502cd36a0e1be9e27ba30d) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Associations no longer bump `version`, snapshot, or restore

  **`associate()`/`dissociate()` — and a change set whose only key is
  `associations` — no longer bump a Record's `version`, touch `updatedAt`, or
  write a version snapshot.** Content mutation is destructive the instant it
  lands, which is what version history exists to make recoverable.
  Associations aren't: the inverse operation is the same shape as the
  forward one and reconstructs the prior state exactly (an
  attachment-annotation overwrite is the one minor exception), so they never
  needed the rollback machinery.

  ```ts
  const before = await stack.get(record.id);
  await stack.associate(record.id, { kind: 'tag', label: 'starred' });
  const after = await stack.get(record.id);
  after.version === before.version; // true — this used to bump
  ```

  They still appear on the change feed (`docs/spec/events.md`) as
  `associate`/`dissociate` ops, so a subscriber still hears about them — the
  event just carries the record's unchanged `version`/`updatedAt`, and its
  `actor` now travels as an explicit fact about the call rather than being
  read off a record field these calls no longer stamp.

  **`associate()`/`dissociate()` drop `ifVersion` entirely — this is a
  breaking signature change.** A set-add/remove composes correctly
  regardless of write order, so there was never a race for the precondition
  to guard, and offering one that could no longer trigger a bump would just
  be silently useless. `mutate()` follows the same line, read off the keys a
  change set names: one whose only key is `associations` carries no
  precondition either, so an `ifVersion` passed alongside it is not checked.
  A change set that names any other aspect is unaffected — `ifVersion` still
  fences the whole call, same as ever, including where that aspect restates
  what the record already holds and the call writes nothing.

  **`restoreVersion()` never restores associations, for any Record type —
  this generalizes what used to be a `_group`-only carve-out.** A `_group`'s
  roster already didn't roll back, on the grounds that a roster is authority
  rather than data; that reasoning turned out to apply to every Record's
  associations, not just a group's. `RecordVersion` drops the `associations`
  field entirely — no snapshot has ever captured one since associate()/
  dissociate() stopped bumping, so there was nothing left for a restore to
  read one back from. `restoreAssociations` is gone from every
  `restoreVersion()` options type; it's unconditional now, and needs no more
  flag than `permissions`, which restore has never touched.

  **Adapter contract:** `StackRecordAdapter.associate()`/`dissociate()` drop
  their `opts` parameter — no `ifVersion`, snapshot, or actor stamping,
  since none of it applies to a write that never bumps. `mutateRecord()`
  gains `opts.bumpsVersion` (computed by `Stack`, not inferred by the
  adapter) so a change set naming only `associations` can skip the
  records-table update and snapshot entirely. `restoreVersion()` drops
  `restoreAssociations` — an adapter no longer receives an association list
  to restore from in the first place.

  **Wire protocol:** the association endpoints (`POST /records/:id/associations`,
  `POST /records/:id/associations/delete`) no longer accept `If-Match` — same
  reasoning as the local `ifVersion` drop. `WireVersion` drops
  `associations`. A `PATCH /records/:id` change set naming only
  `associations` no longer bumps `version` either, matching the standalone
  endpoints, and an `If-Match` sent with such a body is not checked.

- [#291](https://github.com/haverstack/core/pull/291) [`dc6f3b2`](https://github.com/haverstack/core/commit/dc6f3b28e42f4ab6ffd5c14ef9465155c8f1eb14) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Serve the change journal over the wire

  `GET /records/:id/journal` reads a record's change journal, so
  `getJournal()` answers over `adapter-api` instead of refusing. It was the
  one required `StackClient` method the adapter fronting a server could never
  answer, which made "required" mean "required except where it matters" — and
  it left the argument that took associations out of version history only
  half true. Associations were dropped from snapshots because the journal
  keeps what an inverse cannot reconstruct; over the wire that store was
  unreachable, so an `attachmentRecordId` a re-point discarded was gone for
  good. `associationsReplaced` is now readable wherever a stack lives.

  `APIAdapterCapabilityError` accordingly drops `'journal'` from its
  `capability` union, and refuses nothing for this surface any more.

  **The endpoint is mandatory, not advertised in discovery.** A server with
  no journal has only one spelling available to it — an empty log — and that
  is the answer it must not give, since a caller reconstructing an
  association's history cannot tell it from "nothing changed". A feed can be
  advertised because a client can be told up front it will not get a live
  connection; a log is a question with a wrong answer.

  **Responses are paged, and the local contract is not.** `{ entries, cursor }`
  mirrors a query envelope: a server MAY answer a page shorter than the
  `limit` asked for — this is the one read with no ceiling when `limit` is
  omitted, so it needs that freedom — and `cursor` is the only end-of-log
  signal. `APIAdapter.getJournal()` follows it to the end, so "omitting
  `limit` reads the whole log" holds identically whatever page size a server
  picks and no caller has to know which adapter it is on.

  **`previousParentId` is the one field on any response where `null` is a
  value rather than an input spelling.** Absent means the entry is not a
  reparent; present and `null` means the record moved out of the root.
  Everywhere else — a record body, a snapshot — both collapse to absent,
  which here would lose which of the two happened.

  New: `WireJournalEntry`, `WireJournalResponse` and `serializeJournalEntry()`
  from `@haverstack/wire-types`, `parseJournalParams()` from
  `@haverstack/core/wire` so a server decodes the window with the grammar the
  client builds it with, and four `getJournalFixtures` plus a `403` case
  pinning the mutate-surface gate. `serializeChangeActor()` is now shared by
  a change frame and a journal entry rather than inlined in one of them.

  The journal stays per-record: `seq` is dense from 1 per record, so this
  endpoint reads the history of a record you can already name and does not
  answer "which records changed while I was disconnected". A reconnect still
  reconciles that by query, as it did before.

- [#289](https://github.com/haverstack/core/pull/289) [`b34de0d`](https://github.com/haverstack/core/commit/b34de0d5aceb933aff91b82714c47ad96e9f00b2) Thanks [@cuibonobo](https://github.com/cuibonobo)! - A durable change journal, beside version history

  **Every write that emits a change event now also appends one entry to the
  record's journal** — a second durable tier holding what the change moved,
  who moved it, and the association deltas nothing else retains.

  A snapshot answers _what could be put back_; a journal entry answers _what
  happened_. Content needs only the first, because its prior state is in the
  snapshot. Associations need the second, because theirs is nowhere: the
  inverse of an `associate()` is a `dissociate()` of the same shape, but
  deriving _which_ inverse takes the prior state, and until now that state
  reached the change feed and nowhere else.

  ```ts
  await stack.associate(note.id, { kind: 'tag', label: 'draft' });
  await stack.dissociate(note.id, { kind: 'tag', label: 'draft' });

  // Days later, in a process that was never subscribed:
  for (const entry of await stack.getJournal(note.id)) {
    entry.ops; // ['associate'] / ['dissociate']
    entry.associationsAdded; // the association, as it stood
  }
  ```

  `associationsReplaced` is the one field with no counterpart on the feed:
  re-pointing an `attachmentRecordId` overwrites the old value, and a frame
  reports only what is current. The journal keeps what it replaced, which is
  what makes a re-point undoable rather than merely observable.

  **`stack.getJournal(recordId, { sinceSeq?, limit? })` is gated on the
  mutate surface, exactly as `getVersions()` is.** A log of who changed what,
  gated on current read access, would make a record's past as reachable as
  its present. A plain reader gets `StackPermissionError`. `sinceSeq` and
  `limit` are each held to a non-negative integer at the surface, before any
  adapter sees them: left unchecked a negative `limit` diverged rather than
  failing, dropping the newest entry on an in-memory log and lifting the
  ceiling entirely on SQLite. Omitting `limit` still reads the whole log —
  no ceiling is imposed, because the caller reconstructing an association's
  full history is exactly who a silent truncation would betray.

  `getJournal()` is declared on the `StackClient` interface alongside
  `getVersions()`/`restoreVersion()`. Anyone implementing `StackClient`
  outside this package must add it.

  **A hard delete destroys the journal, exactly as it destroys version
  history** — so the journal never records a purge.

  **Adapter contract:** every mutating `StackRecordAdapter` method takes
  `opts.journal`, and `associate()`/`dissociate()` take an options object for
  the first time since they stopped bumping. Adapters append the entry inside
  the same write as the mutation, stamping `seq`, `at`, `version`, `typeId`
  and `parentId` from the row they just wrote — `Stack` supplies only the
  half a record cannot report afterwards. `seq` is allocated by the adapter
  from the log's own maximum, so unlike a snapshot's caller-computed version
  number there is no collision to heal. `getJournal()` is **required** on
  the interface, not optional: an adapter with no journal to read refuses
  the call rather than declining to have the method, so an empty log always
  means "nothing changed" and never "this stack does not remember".

  **Also fixes `createRecord` applying non-atomically** in the SQLite
  adapters. It writes five statements — the record row, associations, the
  full-text index, the content index and now a journal entry — and was the
  only mutating method in the shared logic not wrapped in a transaction. A
  failure partway left a records row behind while raising to the caller, so
  a create that reported failure had half-succeeded, its retry failed on the
  primary key, and the surviving row was invisible to `filter.search` and
  mis-ordered by `sort.contentField` until something wrote it again.

  The wire surface lands in this same release: `GET /records/:id/journal`
  carries the read, so `APIAdapter.getJournal()` answers it like any other
  adapter and refuses nothing. That is what lets the method sit on
  `StackClient` as a requirement rather than a capability — there is no
  adapter left that cannot answer it.

## 0.32.0

### Minor Changes

- [#284](https://github.com/haverstack/core/pull/284) [`8e42a7f`](https://github.com/haverstack/core/commit/8e42a7fc0bf13be2b2697f10efb21a88c95752fc) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Let an attachment association name the upload it came from, with an optional `attachmentRecordId`.

  Attachments are content-addressed, but their metadata is per-upload: two byte-identical uploads share one `fileId` and get one `_attachment` record each. A `kind: 'attachment'` Association carried only `{ label, fileId }`, so two records referencing the same bytes were indistinguishable, and resolving a display name through `getAttachmentRecords(fileId)[0]` gave every one of them the _first_ uploader's filename.

  `attachmentRecordId` names the `_attachment` record whose upload established a particular reference. It is optional, validated when written — the named record must exist, be in the `_attachment` family, and carry the association's own `fileId`, with one refusal for every way of failing so it is no existence oracle — and best-effort afterwards: the record it names can be deleted, and every reader falls back.

  `resolveReferencedAttachment()` (exported from `@haverstack/core/wire`) applies the resolution order over the records `getAttachmentRecords()` returns: the named record, else the requester's own, else the first-recorded. A download has no reference to carry a pointer, so `GET /attachments/:fileId` resolves the last two steps and a client holding the association passes what it resolved as `?filename`.

  The pointer stays outside association identity, which is still `(kind, label)` plus `fileId`. `dissociate()` matches without it, garbage collection and the `attachmentFileId` filter go on asking their `fileId`-level question, and an `associate()` naming a different one re-points the association already there — a version-bumping write, not a second reference to the same file. The association written is the association stored, so leaving the field off one that carries it clears it, rather than merging the old value forward. The SQLite adapters store it in a column outside the associations primary key and upsert on conflict.

## 0.31.0

### Minor Changes

- [#279](https://github.com/haverstack/core/pull/279) [`14a63db`](https://github.com/haverstack/core/commit/14a63db7ba51ae20bcd8e27ff7c40da5afb81683) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Exempt the owner acting alone from the reference-creation gate, so the answers a caller-named `parentId` owes are reachable through a `ScopedStack`.

  `canReadReferent()` resolved the destination and refused a missing one before `Stack` ran either of the checks a caller-named `parentId` is owed. Because a record that does not exist is unreadable by everyone, the owner's documented exemption from the gate — keyed on readability — silently stopped applying to absence, and both `validateParentId()`'s `StackQueryError` (wire: 400) and `assertParentExists()`'s `StackConflictError` (wire: 409) collapsed into `StackPermissionError` for every requester going through a scope.

  The owner acting alone now passes the gate before the lookup, handing the question to `Stack`. This grants nothing — there is no record in their own stack the owner may not read — and the anti-oracle property is unchanged for every other requester, for whom missing and unreadable remain one indistinguishable refusal. Delegation does not carry the exemption on either side.

  One consequence follows: the owner may name a `relationship` target that does not exist, exactly as an unscoped `Stack` allows. `restoreVersion()` is unaffected — it already skipped the whole snapshot-gating block for the owner acting alone, so the spec's promise that a snapshot naming a since-hard-deleted container restores anyway was already honored there.

- [#278](https://github.com/haverstack/core/pull/278) [`0052b6b`](https://github.com/haverstack/core/commit/0052b6b14a32e9ada2faa4454999c33d2847c61a) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Name the missing capability on the refusal itself, and remove the copy of the rule that re-derived it.

  `StackQueryError` now carries a `capability` field — the path into adapter capabilities the query needed (`'filter.content'`, `'filter.contentPresent'`, `'filter.search'`, `'sort.fields'`, `'sort.contentField'`), or undefined when the query's own shape was what was wrong. `assertQueryCapabilities()` and `assertSortCapability()` set it at each refusal. `APIAdapter.queryRecords()` reads it instead of re-deriving the answer from the query, which it could disagree with: a query that both sorted by an undeclared field and used an undeclared `filter.search` reported the sort as the missing capability while the message named the search.

  `filtersContent()` and the `MissingCapability` type are now exported from `@haverstack/core/adapter`; `adapter-api` re-exports `MissingCapability` under its existing name. `MissingCapability` is also exported from `@haverstack/core`'s main entry, where `StackQueryError` itself ships — app code catching a refusal from `Stack.query()` needs the type to name the field it just read.

  `@haverstack/core/wire` now exports `assertQueryTravels()`, the build-side half of the refusal `parseQueryParams()`/`parseQueryBody()` already apply to the two `Query` fields with no wire encoding. `APIAdapter.queryRecords()` calls it before choosing an encoding, so a direct adapter call carrying `filter.baseId` or `presentAt` is refused the same way at every content reach. Previously only the `POST /records/query` body carried them as far as the server's `400`: the `GET /records` params have nowhere to put them, so the same query came back as an unfiltered result set. (`Stack.query()` resolves `baseId` and applies `presentAt` itself, so queries made through it were never affected.)

  `APIAdapter.createRecord()`, `commitMigration()`, `undeleteRecord()` and `restoreVersion()` now report a server that answers a version-bumping mutation with no Record body, as the other mutations already did, instead of raising a `TypeError` from reading the body that never arrived.

## 0.30.0

### Minor Changes

- [#272](https://github.com/haverstack/core/pull/272) [`1010033`](https://github.com/haverstack/core/commit/101003350a4bb8e590c1942339fc405bef31aeb8) Thanks [@cuibonobo](https://github.com/cuibonobo)! - `generateId()` carries into the next millisecond when a millisecond's suffix space is spent, instead of throwing. The suffix opens on a random draw and increments from there, so the room a millisecond has left was itself random — a draw near the top of the range could exhaust it after a single further ID, and minting failed with `IdGenerationOverflowError` while the millisecond looked far from full. The prefix now advances and a fresh suffix is drawn, so IDs stay unique, strictly ascending, and well-formed, and minting never fails for want of room.

  `IdGenerationOverflowError` is removed; nothing can throw it.

- [#275](https://github.com/haverstack/core/pull/275) [`974f10a`](https://github.com/haverstack/core/commit/974f10aec3ebc1ebf47041152da105dbbecfd1a2) Thanks [@cuibonobo](https://github.com/cuibonobo)! - `NATIVE_SORT_FIELDS` is exported from `@haverstack/core`, and
  `NativeSortField` is derived from it. The three native sort columns had
  been spelled out four times across three packages — core's own wire-request
  parser, `normalizeCapabilities()` in wire-types, the cursor decoder in
  sqlite-shared, and the type itself — so adding a fourth column meant
  finding all four. Each site now narrows against the one array, following
  the same array-is-the-source-of-truth shape `GRANT_ACTIONS` already uses.
  No behavior change: the set of accepted sort fields is what it was.

### Patch Changes

- [#275](https://github.com/haverstack/core/pull/275) [`e1420b0`](https://github.com/haverstack/core/commit/e1420b0e27a9027d4d00e61e47874e8b1685cff7) Thanks [@cuibonobo](https://github.com/cuibonobo)! - `assertValidSort()` narrows against `NATIVE_SORT_FIELDS` rather than its
  own copy of the three column names, and names that array's contents in the
  error a rejected sort field gets. It is the gate every query passes through
  before an adapter sees it, so it was the copy a fourth native column could
  least afford to be missing from — the wire parser would accept the field
  and this would still refuse it, with no error pointing at the cause. No
  behavior change: the set of accepted sort fields is what it was.

- [#274](https://github.com/haverstack/core/pull/274) [`fca0f79`](https://github.com/haverstack/core/commit/fca0f79196c2703d4fea168e983d519249012719) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Split `stack.ts` into focused modules. The `Stack` and `ScopedStack`
  classes, the error taxonomy, the query sanitizers, grant coverage, DID
  bindings, record-id validation and the change-set helpers now live in
  their own files. Exported names and their types are unchanged — nothing a
  consumer can observe.

## 0.29.0

### Minor Changes

- [#269](https://github.com/haverstack/core/pull/269) [`06b791c`](https://github.com/haverstack/core/commit/06b791cb4c5e15dd06442ab2ebfabb82cd014745) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Move a record's aspects in one call, one version

  **`mutate(id, changes, opts)` replaces `update()`, `setPermissions()`, `setUnlisted()` and
  `setParent()`.** It takes a change set naming any combination of `contentPatch`, `parentId`,
  `permissions`, `associations` and `unlisted`, applies it as one atomic write, and produces
  exactly one version carrying one snapshot.

  ```ts
  await stack.mutate(note.id, {
    contentPatch: { title: 'Q3 plan' },
    parentId: folder.id,
    unlisted: false,
  });
  ```

  Each aspect used to have its own verb, so "save and move", "save and share" and "save and
  publish" each cost a version apiece and three round trips — and could not be fenced by one
  `ifVersion`, since the second call had to be pinned against a version only the first call's
  response could supply.

  **Keys are read for presence, not truthiness.** `unlisted: false` and `parentId: null` name
  aspects and are applied; an omitted key is untouched. A change set naming no key at all is
  `StackQueryError` (wire: 400) — it addresses nothing, so there is nothing it could have
  failed to satisfy. A change set already satisfied in every key writes nothing and returns
  the record unchanged.

  **`patchContent(id, patch, opts)` is the content-only spelling**, and the name the adapter
  primitive already used. `update()` is gone: it promised a symmetry with `create()` that a
  merge patch does not have.

  ## `contentPatch` is the one key that merges

  Every other key replaces the aspect it names. Content stays a patch for three concrete
  reasons: `limits.contentBytes` bounds what travels, so a whole-document write would charge a
  one-field edit against the full ceiling; two apps editing different top-level fields both
  survive a patch and clobber one another under replacement; and content read through
  `presentAt: 'latest'` cannot be written back wholesale at all, since a write validates
  against the record's _own stored_ type and a read-modify-write across a pending migration
  would submit migrated content to the schema it was migrated away from.

  The key is named for its semantic so that asymmetry is visible at the call site rather than
  resident in prose.

  ## Authority resolves per key, against the record as it stands

  The aspects do not share a gate — content is reachable by a write-holder or an `update-*`
  grantee, `permissions` and `unlisted` only by the owner or the record's own creator. So a
  change set resolves each key on its own and lands exactly where the same caller would have
  landed one key at a time: **a requester who may perform every key may perform the set, and a
  requester who may not perform one of them may not perform any of it.**

  Every gate reads the record's **pre-change** state. A widened `permissions` in a change set
  never satisfies the read check on a `parentId` named in the same call, and a `_group` roster
  never satisfies the admin check that same call must pass — either would be a one-call
  escalation out of a gate the single-key spelling enforces. A refused key refuses the whole
  call: nothing is partially applied and no key is silently dropped.

  ## `associate()` / `dissociate()` stay their own verbs

  They amend the association set where the `associations` key replaces it. Two apps tagging
  one record both succeed through the methods and race through the key, so the delta spelling
  is kept for the operation that most needs it rather than folded into a declarative envelope,
  where "add this one" is not a thing that can be said.

  ## Change events name every aspect that moved

  `RecordChange.op` becomes **`ops: ChangeOp[]`**, derived by diffing the record against its
  prior state rather than read off the request — so naming an aspect without moving it is
  never reported as moving it. The `update` op is renamed **`patch`**. `kind` resolves to the
  most conservative entry: a change set carrying `unlist` is `deleted` whatever else it
  carries, because a subscriber holding the record still has to drop it. Every op outside
  `mutate()`'s reach (`create`, `delete`, `undelete`, `hard-delete`, `migrate`, `restore`) is
  still emitted alone, so a multi-entry `ops` is always a change set.

  ## Wire format

  `PATCH /records/:id` now takes the change-set envelope, and `PUT .../parent`,
  `PUT .../permissions` and `PUT .../unlisted` are gone — one `If-Match` fences a whole
  multi-aspect edit. `GET /records/:id/permissions` stays. An unrecognized top-level key is
  **400** and a key the type does not declare inside `contentPatch` is **422**, the same split
  every other write endpoint makes. `changesFromWireBody()` in `@haverstack/core/wire` applies
  this for servers built on core.

  The envelope also retires a wart: `contentPatch.parentId` and the native `parentId` are now
  unambiguous by construction, rather than by a rule the spec had to state twice.

  ## Adapters

  The four single-aspect adapter methods (`patchContent`, `setPermissions`, `setUnlisted`,
  `setParent`) collapse into one **`mutateRecord(id, changes, opts)`**. This shrinks the
  contract rather than growing it: in `sqlite-shared` those four were already the same
  `UPDATE records SET <col>, version = version + 1, updated_at = ?, ...` with one column
  swapped, and they are now one statement with a variable SET list. `Stack` narrows a change
  set to the aspects that actually moved before it reaches an adapter, so every key an adapter
  receives is one it must write — which is what keeps a restated `unlisted: true` from
  dragging `unlistedAt` forward with no op reporting it.

  ## Conformance fixtures

  The three fixture groups named for retired endpoints are renamed for the change-set keys
  they now exercise: `setPermissionsFixtures` → **`permissionsChangeFixtures`**,
  `setUnlistedFixtures` → **`unlistedChangeFixtures`**, `setParentFixtures` →
  **`parentChangeFixtures`**. `patchContentFixtures` keeps its name, since `patchContent()`
  does.

  ## Also

  **Fixed: the content merge was documented as RFC 7396, which recurses, but is one level
  deep.** `applyMergePatch` iterates top-level keys and replaces each value whole, so a nested
  object in a patch replaces rather than merges. The spec now states the top-level rule and
  drops the RFC citation; an app author trusting the reference would have expected a nested
  patch to preserve sibling keys and silently lost them. Behavior is unchanged — only the
  claim about it.

- [#271](https://github.com/haverstack/core/pull/271) [`c8e70ab`](https://github.com/haverstack/core/commit/c8e70ab0576336d1f58bfd8054406e7f445ea2b4) Thanks [@cuibonobo](https://github.com/cuibonobo)! - A group keeps at least one admin

  **"A `_group` Record's roster carries at least one `admin`" becomes an invariant of the
  Record rather than a convenience at create time.** `stampGroupAdmin()` already made the
  creator the first admin, and `identity.md` already promised that "no Group is ever
  management-orphaned" — but nothing re-asserted it on a subsequent write, so a roster could
  be emptied and the Group left manageable by the stack owner alone.

  Any write that would leave the roster with no `admin` is now refused with
  `StackConflictError` (wire: 409), whether it arrives through a change set's `associations`,
  which replaces the roster wholesale, or through `dissociate()`, which removes one entry.

  ```ts
  // Refused: nothing would be left to manage the group.
  await stack.mutate(group.id, { associations: [] });

  // Fine: an admin may step down while another remains.
  await stack.dissociate(group.id, { kind: 'relationship', label: 'admin', target: me });
  ```

  **The check reads the roster the write would produce, not the one it started from.** That is
  what makes it precise without special cases: an `admin` may remove themselves while another
  remains, and may not remove the last one, and neither case needs to name who is being
  removed. It is also the one place a change-set check reads the post-state — the rule is
  about what a write leaves behind rather than about what the caller named.

  **The stack owner does not bypass it.** They can already manage any Group, so the rule costs
  them nothing they wanted, and a bypass would mean nothing downstream could rely on the
  invariant. It therefore lives in `Stack` alongside the other integrity constraints rather
  than in `ScopedStack`'s group gate: who may write a `_group` is a permission question, and
  this is not one.

  Taken with the restore rule below, the three together close the invariant by construction:
  every `_group` holds an admin from its first version, no write takes a roster to zero, and no
  restore moves a roster at all. An admin-less roster is not a state the API can reach. Because
  the check reads the post-state it would still behave correctly on one manufactured by a
  direct adapter write — permitting a write that names an incoming admin, refusing one that
  does not — but that falls out of the framing rather than being a repair path the rules
  promise.

  What this does **not** promise is that an `admin` is _reachable_: an admin who loses their
  key strands a Group as thoroughly as an empty roster would. The invariant closes an
  accidental write, not the general problem of custody.

  ## A restore does not roll back a Group's roster

  On a `_group` Record, `content` and `parentId` roll back as they do anywhere, and the
  Record's **`associations` are left exactly as they stand** — the snapshot's are not put back,
  and the current ones are not taken away.

  This is the stance restore already takes on `permissions`, applied to the whole roster on the
  grounds that a roster is authority rather than data. A Group's `member` and `admin` entries
  are what group ACLs and group-targeted grants resolve against, so rolling either half back
  silently re-grants access as a side effect of a verb the caller asked for its content:
  management to an `admin` who had been deliberately removed, reach to a `member` who had been
  dropped. Recovering a former roster is a deliberate `associate()`, which is the point.

  It is also what lets the invariant hold here without a check. A restore cannot move a roster,
  so it cannot be the write that empties one, and no version of a `_group` is unrestorable on
  that ground.

  ## Adapters

  `StackRecordAdapter.restoreVersion()` gains an optional **`restoreAssociations`** in `opts`.
  `false` rolls back everything but the associations, leaving the record's current list where
  it stands; absent or `true` applies the snapshot's, as before. An adapter needs no knowledge
  of `_group` or of roster labels, which keeps the rule in core where the record's meaning is
  known. `Stack.restoreVersion()` is its only caller.

  No association list travels to an adapter, which is deliberate: there is no list resolved
  above the adapter and written below it, so nothing a restore writes can disagree with what
  the record already holds, and no read-then-write window exists for a concurrent roster change
  to be undone through.

  `@haverstack/adapter-api` does not send it. The wire protocol has no field for it and needs
  none: the server runs the same `Stack` logic over its own adapter and reaches the same answer
  from the same record. A wire field would only let a client _propose_ that answer.

  `ScopedStack.restoreVersion()`'s reference-creation gate skips a `_group` Record's
  associations entirely — a restore does not move the roster, so it introduces no association
  to gate, on the same reasoning that leaves a `parentId` the restore would not change
  un-regated.

- [#267](https://github.com/haverstack/core/pull/267) [`64cda3b`](https://github.com/haverstack/core/commit/64cda3bb5b7b21ec9277695fea8fd78516d0e6ca) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Hold content to the type's schema, and hold a schema to being one

  **Behavior change: a content field the record's type does not declare is refused with
  `StackValidationError` (wire: 422)** — on `create()`, in a content patch, and on
  `commitMigration()` against the destination type — naming the field and the path it
  sits at. It holds at every depth: an undeclared key inside a declared `object`, or
  inside the `object` an `array` declares as its items, is refused with its full path
  (`address.postcode`, `emails[1].label`).

  The schema is the record's shape. A key outside it is a typo, a stale writer, or a
  caller reaching for something that is not content at all, and accepting it makes all
  three look like a write that worked. The third is what motivated this: content is its
  own namespace, so a `parentId` in a content patch writes a content field of that name and
  never the native one, leaving a `content.parentId` beside a native `parentId` holding
  something else, with nothing downstream reading it. That now names the field and
  points the caller back at the verb they wanted.

  **The rule is about the schema, not about the names.** A type is free to declare
  `parentId`, `version` or `createdAt` as content — a bookmark's `parentId` naming the
  upstream record it was clipped from is an ordinary field — and once declared it is
  patched like any other. Nothing is reserved by resemblance to a native field, and the
  same check catches `titel` and `craetedAt`, which no list of names would.

  ## Open containers

  An `object` or `array` field declared `open: true` is not validated inside — the
  schema places a container there and says nothing about its interior. That is the
  deliberate way to store a shape a schema cannot describe: an imported blob, a payload
  whose keys are data, or a heterogeneous or null-bearing list (a declared array has
  never accepted a `null` element, so this is the only spelling for one).

  A container declares either its interior or `open`, never neither: `ArrayFieldDef` and
  `ObjectFieldDef` are unions, so `{ kind: 'object' }` on its own does not type-check.
  Opacity is a claim the schema makes rather than something inferred from a missing
  `items`/`properties`, so forgetting to describe a container's elements is a compile
  error instead of a silently unchecked field.

  An open container is still held to its own kind — an open `object` refuses an array,
  an open `array` refuses an object — which is why this is a flag on the container kinds
  rather than an "any JSON here" kind of its own: a type meaning "a list, contents
  unspecified" can still say so. It is exempt from the schema only. Content field names
  are still checked at every depth inside one, since that rule is about what a filter
  path can address rather than about what the type promised. Query reach is unchanged: a
  content path walks into an open container, because the query engine reads the content
  rather than the schema.

  Open and declared are different shapes, not degrees of one. They hash differently, so
  `schemaHash` tells them apart. Changing a type from one to the other is schema drift in
  **both** directions — closing an open container refuses content it used to accept, and
  opening a declared one accepts content it used to refuse — so neither is an
  additive-in-place change, and the remedy is a version bump. `isCompatible()` reads them
  the same way: an open candidate satisfies a required container only where the required
  side asks nothing of its interior, since a bag promises a consumer nothing to read.

  ## What a schema may declare

  A schema is a promise that a field is meaningful, so a promise nothing can satisfy is
  refused where it is written. `defineType()` already applied that to a declared name no
  filter could ever address; two more cases join it, both answering
  `StackValidationError` (wire: 422 on `POST /types`).

  **`defineType()` refuses a schema declaring `__proto__`, `constructor` or `prototype`
  as a top-level field name**, at exactly the scope the write rule holds — a nested
  declaration names a field a record can carry, so it is left alone. A declaration
  cannot license what the write rule refuses, so accepting one defined a field no record
  could carry; where the declaration was `required`, it defined a type no record could
  satisfy at all, since supplying the field is refused as a reserved key and omitting it
  is refused as a missing required field.

  **Fixed: `defineType()` reports a malformed schema instead of failing inside the
  machinery that reads it.** It takes a `TypeSchema`, but a schema arriving at
  `POST /types` is parsed JSON no compiler has seen, so every malformed shape is
  reachable: a definition that is not an object, one naming no `kind` or an unrecognized
  one, a non-boolean `required`/`open`, a container declaring neither its interior nor
  `open`, and a container declaring both (contradictory — one of the two would have to be
  ignored, and nothing says which). Two of them threw a raw `TypeError` out of schema
  hashing; the rest were accepted and defined a field whose every write failed against an
  expectation the schema never stated (`Expected undefined, got string`), sending the
  caller looking through their content for a bug that was in their type. All now name
  each bad field and what is wrong with it, checked recursively through `properties` and
  `items`.

  `__proto__`, `constructor` and `prototype` remain refused as top-level _content_ keys
  independently of the schema, including inside an open container.

  ## What does not change

  **Additive-in-place evolution is unchanged in mechanism and narrower in what it
  licenses.** Validation runs on write and the schema lives in the stack, so a reader
  holding an older idea of a type still reads records carrying fields it was never taught
  about, and a content patch still preserves fields the caller didn't name. What
  changed is that _writing_ a new field means declaring it first — a `defineType()` call
  with the field added, which is already the additive-legal path, not a version bump.

  A content patch validating against the record's **own stored type** rather than the latest is
  what keeps this safe across a migration: an unswept `@1` record answers to `@1`'s
  schema, so a field that exists only in `@2` is refused until `migrateAll()` moves the
  record. A field can only ever be added to a schema in place, so a stored record cannot
  accumulate content its own type does not declare.

  **For server authors:** the content rule is a `Stack` invariant that a server built on
  core inherits through ordinary record validation, and a third content-key rule for a
  server mapping request bodies onto storage directly to apply itself. It answers **422**
  (code `validation`) on `POST /records`, inside a `PATCH /records/:id` content patch, and on
  `POST /records/:id/migrate`. The two schema rules answer **422** on `POST /types`.

## 0.28.0

### Minor Changes

- [#263](https://github.com/haverstack/core/pull/263) [`12e1a4b`](https://github.com/haverstack/core/commit/12e1a4bf9db1086a6b546859171f3a7bf72db322) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Add `setParent()` — records can be moved between containers after creation

  `parentId` was settable at create and nowhere else: `update()` is a content-only
  merge patch, `patchContent()` is content-only by contract, and `PATCH /records/:id`
  carries the content patch as its whole body. A record's place in the hierarchy was
  therefore fixed for life, and a `parentId` key in an `update()` patch was stored as
  a content field of that name instead.

  `setParent(id, parentId | null)` joins `setUnlisted()` and `setPermissions()` as a
  native-field verb — `null` moves a record to the root. It bumps `version`, snapshots
  the prior state, takes `ifVersion`, and travels as `PUT /records/:id/parent`.
  `StackAdapter` gains a matching `setParent()`; every bundled adapter implements it.

  Moving a record confers nothing: containment is not an access-control edge, so
  nothing is inherited from a container and nothing cascades out of one. `ScopedStack`
  gates a move as an ordinary write on the record plus read access to the destination —
  the same reference gate `create()` applies to a `parentId`. The origin is ungated,
  since naming it requires reading the record.

  An edge that would make a record its own ancestor is refused with `StackConflictError`
  (wire: 409), at both sites that add one: `setParent()`, and a `create()` supplying both
  `id` and `parentId` — a generated id names nothing, but a caller-supplied one may already
  have records pointing at it. Dangling parents stay legal. The check is read-then-write, so
  it is advisory under concurrency, the same posture as DID binding uniqueness; consumers
  that walk `parentId` should carry a visited set.

  The change feed gains a `reparent` op (kind `changed`), matched against both
  containers a move concerns so a subscription filtered on the origin learns the record
  left it. Frames carry the destination in `parentId`, as every frame carries the
  record's state at the moment of the change; a subscriber compares it to its own
  filter to tell a departure from an arrival.

- [#266](https://github.com/haverstack/core/pull/266) [`e134c5a`](https://github.com/haverstack/core/commit/e134c5a8935893131361bc2da4ecff0de6ab0a5b) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Make reparenting restorable, and settle what `parentId` spells and promises

  A version snapshot now captures `parentId`, so a move rolls back like every other
  mutation and the write bit's recoverability claim — anything a write-holder does,
  the owner can undo — holds for `setParent()` too. `RecordVersion` and `WireVersion`
  gain the field; `restoreVersion()` applies it.

  A snapshot spells `parentId` exactly as the record does: **absent is the root.**
  That follows the rule the field has always followed, now stated. Inputs spell the
  root `null`, because they must tell the root from "not specified" — `setParent()`'s
  argument, the `PUT /records/:id/parent` body, `RecordFilter`, `?parentId=null`.
  State spells it by omission, because a record is always somewhere — `StackRecord`,
  `RecordChange`, and now `RecordVersion`. `null` never appears on a snapshot; a
  foreign server that sends the input spelling is read as the root rather than
  misread. Because absence is the root rather than a missing claim, a restore always
  settles containment: a snapshot carrying no `parentId` returns the record to the
  root instead of leaving it where it sits.

  A restore that puts a different container back is a move, and is treated as one
  throughout. It is refused with `StackConflictError` (wire: 409) where it would make
  the record its own ancestor, joining `setParent()` and a `create()` naming both its
  own `id` and a `parentId` as the sites that walk the proposed chain. `ScopedStack`
  applies the same reference gate to it that `setParent()` applies to a destination
  named directly, so a restore cannot reach a container the requester could not name
  today; a `parentId` the restore would not change is not re-gated, since the record
  is already there, and a snapshot taken at the root names no container to gate. And
  its change event is matched against both containers it concerns, exactly as a
  `reparent` is — a subscription filtered on the origin learns the record left.

  **Behavior change: a `parentId` a caller names must be well-formed and must name a
  record that exists.** `setParent()` and `create()` now check format first
  (`StackQueryError`, wire: 400) and then existence (`StackConflictError`, wire: 409).
  Format is the rule a caller-supplied `id` already passes, so the empty string is not
  a `parentId` any more than it is a record id. Code that relied on pointing at a
  container before creating it, or on planting a reference to nothing, has to create
  the container first. This is a front-door check rather than an invariant: deleting a
  container never touches its children, so a `parentId` resolving to nothing remains
  an ordinary state at rest and consumers must still handle one. What it buys is that
  a caller cannot mint one — a dangling parent now means a container was removed.

  **`restoreVersion()` is exempt from that check.** It is not a caller naming a
  destination, it is history being put back, and the container may have been
  hard-deleted since the snapshot was taken; refusing would let an unrelated deletion
  cost a record its content rollback. It is the same stance restore takes on content,
  validating against the snapshot's own `typeId` rather than the record's current one.
  A restore is therefore the only write that can still produce a dangling parent.

  **Behavior change: a chain deeper than the acyclicity walk's 64-level cap is no
  longer refused.** The walk stops at the cap and the write proceeds. Depth is not
  something the library bounds — an ordinary `create()` under a parent never walks,
  and moving a subtree checks only the chain above it — so refusing there advertised a
  guarantee that does not hold, and permanently froze a deep region against moves,
  since nothing shortens a chain. The cap still bounds each move's cost and still
  guarantees the walk terminates on a chain that is already cyclic. Acyclicity is a
  guardrail against the common accident of moving a container into its own descendant:
  exact for a single writer within the cap, and nothing beyond it. A consumer that
  walks `parentId` must carry a visited set or a depth bound of its own.

  `appId` remains uncaptured by snapshots. It names the software that authored the
  record, a create-time fact no later write moves, so there is nothing for a rollback
  to revert it to.

  **Fixed:** a record soft-deleted or unlisted at the epoch was read back as neither.
  `deletedAt` and `unlistedAt` are stored as integers, and the SQLite mappers tested
  them for truthiness, so a timestamp of `0` came back absent — `getRecord()` reported
  the record live while every query, reading `deleted_at IS NULL`, correctly excluded
  it. The same row answered two ways. The mappers now read every nullable native field
  by presence, so SQL NULL is the only spelling of an absent field and the mapper
  agrees with the predicates beside it.

  **Also:** `create()` now refuses an empty-string `entityId`, `appId` or `principalId`
  (`StackQueryError`, wire: 400) rather than silently dropping it. The empty string
  names nobody, and a field quietly discarded is the same silent normalization the
  mapper fix above is about.

  **Fixed:** healing an orphaned version row — the snapshot an interrupted write left
  behind at the record's current version — replaced only some of the row. `parent_id`,
  `updated_by` and `updated_via` kept the orphan's values, so a later restore could
  move a record into a container the healing snapshot never named, and the two
  reference adapters disagreed about it.

  **For adapter authors:** `StackAdapter.restoreVersion()`'s contract now states that
  it restores the snapshot's `parentId` alongside content and associations, and that
  an absent `parentId` means the root. An adapter written to the previous wording
  would ignore containment on restore while `Stack` refused cycles and `ScopedStack`
  refused moves against it.

## 0.27.0

### Minor Changes

- [#258](https://github.com/haverstack/core/pull/258) [`e40e814`](https://github.com/haverstack/core/commit/e40e8143cda1b4a97ce930cd4e7f6d7b6b3f077f) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Remove `total` from `QueryResult`. A query answers with `records` and
  `cursor`.

  The count was only ever a number on one of the three paths a query can
  take. A permission-scoped query could not report one — the count of
  matching Records reveals the cardinality the permission check just hid —
  and neither could any response on the wire, for the same reason. That left
  it populated on a direct unscoped `Stack.query()` in process and `null`
  everywhere else, so an app reading it saw a number locally and `null` the
  moment the same code ran scoped or against a server.

  Meanwhile every path paid for it. `ScopedStack.query()` filters and refills
  by calling the adapter per page, so one scoped query at `limit: 50` ran
  eleven `COUNT(*)`s and discarded all eleven. Measured over 20k records, the
  count was 74% of a scoped query and 77% of an `asEntity(null)` one.

  A caller that needs a count follows `cursor` to exhaustion and counts what
  arrives — the only number that was ever true for that requester.

  `MemoryAdapter` and the SQL adapters had also disagreed about what the
  field meant: the documented "ignoring pagination" (which `MemoryAdapter`
  implemented) against the count of what remained after the cursor (which the
  SQL adapters returned). Removing the field settles it.

## 0.26.0

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

## 0.25.0

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

## 0.24.0

### Minor Changes

- [#250](https://github.com/haverstack/core/pull/250) [`0c76cb7`](https://github.com/haverstack/core/commit/0c76cb7b51f2ea407521ae1df1ff0c8e5852d53e) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Add `Stack.getAttachmentRecords(fileId)`, the candidate set `firstRecordedAttachment()` orders: every `_attachment` record describing a file, family-wide by `baseId`, including soft-deleted and unlisted records, content-filtered only where the adapter declares `contentFieldQuery`, and cursor-walked to exhaustion. Sorted earliest-recorded first, so `records[0]` is the record that establishes the file's `mimeType` and the two helpers compose without the caller re-sorting. Core exported the tie-breaker but not the lookup that safely feeds it, leaving every server to re-derive a query with three ways to get it wrong.

  It lands on `Stack` and deliberately not on `StackClient`: the lookup answers a presentation question about an access decision already made, so a scoped version would impose a second, different permission check and silently drop metadata the requester is entitled to.

  `_attachment` lookups are now family-wide throughout, where they were pinned to `_attachment@1`. A record migrated to a later version of the family now establishes the file's `mimeType` (so a conflicting later upload is rejected, where it was previously accepted), is purged by `deleteAttachment()`, and is seen by `collectAttachmentGarbage()` — which previously could not discover a file whose only metadata record had been migrated.

  `StackRecordAdapter.deleteUnreferencedAttachmentRecords()` takes `metadataTypeIds: TypeId[]` in place of a single `metadataTypeId`. Core resolves the `_attachment` family to concrete typeIds before the call, so adapters still need no `baseId` concept of their own.

## 0.23.0

### Minor Changes

- [#248](https://github.com/haverstack/core/pull/248) [`896b516`](https://github.com/haverstack/core/commit/896b5167d68690a307cba430ded97268c83fe218) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Add `createOptionsFromWireRecord()` to `@haverstack/core/wire`

  `POST /records` is the one endpoint where a client sends a whole record and
  the server may trust only part of it, and the three dispositions its fields
  take — stamped, conditionally dropped, forwarded — are not derivable from a
  field's name. A server got them right by naming each field it wanted and
  never reading `entityId`, which nothing enforces: the obvious
  `create(body.typeId, body.content, { ...body })` forwards a self-reported
  `entityId` and `principalId`, has no symptom, and passes every fixture.

  The helper takes a body, a `TokenSession` and the owner's DID, and returns
  the `typeId`, `content` and options `ScopedStack.create()` takes.
  `entityId` and `principalId` are absent from the returned type rather than
  merely unread. `createdAt`/`updatedAt` are dropped by value for anyone but
  the owner acting alone — every client sends both on every create, so
  forwarding them unfiltered turns an ordinary grantee create into a `403`.
  `unlistedAt` becomes `unlisted: true` for everyone, leaving the refusal to
  `ScopedStack`.

  `isOwnerActingAlone()` is exported beside it and now backs `ScopedStack`'s
  own owner-only gates, so the tier a server applies to a session and the one
  core enforces are one definition. A server needs it for hard delete,
  `commitMigration()` and `includeUnlisted` regardless.

  A present field whose value is the wrong shape is refused rather than
  dropped: a dropped `id` mints a different record than the one the client
  asked for, and a dropped `unlistedAt` publishes one the client meant to
  withhold. Which error class says so follows whether the failure names a
  field of the record being written — `StackQueryError` (400) for a body that
  is not a create request at all, `StackValidationError` (422), carrying the
  path, for one that is.

- [#246](https://github.com/haverstack/core/pull/246) [`e4119ea`](https://github.com/haverstack/core/commit/e4119eaa03f0510aa773b31cf36e860541857517) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Add the parse half of the request encoding to `@haverstack/core/wire`

  `adapter-api` builds requests and nothing in core parsed them, so every
  mirror pair was split across repositories with the parse side hand-written
  per implementation. `parseQueryParams()`, `parseQueryBody()`,
  `parseChangeParams()`, `parseIfMatch()` and `parseUploadFilename()` are now
  exported, and the round trip against the builders is pinned by a test rather
  than by each implementer transcribing the query-parameter table correctly.

  The parsers do not clamp `limit` — a ceiling is deployment policy — and do
  not gate on capabilities, which stays a separate `assertQueryCapabilities()`
  call.

  Two behavioural changes come with them. A malformed `If-Match` is now
  refused with `StackQueryError` instead of read as an absent header, which
  had silently degraded a fenced write to unconditional last-writer-wins. And
  `filter.baseId` and `presentAt`, which have no wire encoding, are refused
  rather than dropped: dropping either answers with a result set wider, or
  staler, than the one that was asked for.

  `parseDate()` moves to core and `@haverstack/wire-types` re-exports it, so
  the request and response sides share one definition.

## 0.22.0

### Minor Changes

- [#243](https://github.com/haverstack/core/pull/243) [`d945ded`](https://github.com/haverstack/core/commit/d945ded1ead75e6e3e11a6088afa72dd889c8342) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Add `getEntityByDid()` and `getOwnerEntity()` to `StackClient`, resolving a DID to its `_entity` card with the rules that make the answer single-valued: family-wide by `baseId` (so a card migrated to a later type version still resolves), including soft-deleted cards (which still reserve their `did`), and matched in memory when the adapter doesn't declare `contentFieldQuery`. Every caller that needed this lookup was re-deriving it, and two existing implementations (`Stack.ensureOwnerEntity()` in this repo, `entityRoutes`'s `resolveOwnerRecordId()` in the server) disagreed on the rules.

  `getOwnerEntity()` is `getEntityByDid()` for the one DID every stack reserves — the owner's own, named by `ownerEntityId`.

  Under `ScopedStack`, the result is filtered to what the request may read, and `includeUnlisted` is honored only for the owner acting alone — matching what `query()` itself permits rather than throwing. `null` therefore covers three cases that share one answer (missing, unreadable, or unlisted-and-not-permitted) and is never evidence a card is absent, per the anti-oracle rule.

  `Stack.ensureOwnerEntity()`'s bootstrap probe is now implemented in terms of `getEntityByDid()`, so there is one lookup rather than two.

- [#244](https://github.com/haverstack/core/pull/244) [`65476bd`](https://github.com/haverstack/core/commit/65476bd3f7aa025cec0790653bcc9cdb691bfce1) Thanks [@cuibonobo](https://github.com/cuibonobo)! - `associate()`, `dissociate()`, `setPermissions()` and `setUnlisted()` now return the record they produced

  All four returned `Promise<void>` while every other version-bumping method on `StackClient` — `update()`, `undelete()`, `restoreVersion()`, `commitMigration()` — returns the record. Their wire endpoints already answer with a Record body (`docs/spec/wire-format.md` § Records) and `APIAdapter` already parses it, so the record was being fetched and then discarded. Callers can now report what they wrote without a second read.

  A no-op (a duplicate association, removing one that isn't there, a deep-equal permission set, setting `unlistedAt` to the state it already holds) returns the record unchanged: what marks it a no-op is the version that didn't move, not an answer that never came.

  `delete()` is deliberately unchanged — a hard delete leaves no record and no version to return.

  This is source-compatible for callers that ignore the return value; it is breaking only for code that structurally implements `StackClient` itself.

## 0.21.1

### Patch Changes

- [#236](https://github.com/haverstack/core/pull/236) [`d6b1fc3`](https://github.com/haverstack/core/commit/d6b1fc3cdc4e5f1511a780f1b328aae79408d398) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Harden the non-owner `_attachment@1` create carve-out so it no longer depends implicitly on `fileId`'s `kind: 'string'` schema declaration.

  `hasReadableReference()` — shared by `canAccessFile()` and the carve-out that lets a non-owner add an additional `_attachment@1` metadata record without re-uploading bytes — now excludes `_attachment@1` records from matching outright, rather than relying on `fileId` not being a `file-ref` field to keep a requester's own prior metadata record from satisfying it. No observable behavior change: the carve-out already refused a requester's own prior record for the same `fileId`, this just makes that guarantee hold on its own terms instead of by way of a schema detail declared elsewhere.

## 0.21.0

### Minor Changes

- [#232](https://github.com/haverstack/core/pull/232) [`64dfb36`](https://github.com/haverstack/core/commit/64dfb3621635438c9529b4be134b60cf936fb152) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Ask two guards for the value a caller supplied rather than for the key they named, so an explicit `undefined` is no longer read as a claim on the field it names.

  `ScopedStack.create()` refuses `createdAt`/`updatedAt` to everyone but the owner acting alone. That refusal now tests both options for a value: `undefined` carries no date, `Stack.create()` already reads it as absent, and a grantee passing one gets the ordinary current-time stamp instead of `StackPermissionError`. A server dropping the two fields from a non-owner `POST /records` body may therefore drop them by value — deleting the keys and setting them to `undefined` are both drops.

  `update()` now rejects a top-level patch key whose value is `undefined` with `StackValidationError` (422). A merge patch spells "leave this alone" by omission and "remove this" with `null`, and has no third state left for `undefined` — which cannot arrive over the wire in any case, since JSON has neither a literal for it nor a `JSON.stringify` that emits one. Accepting it resolved the ambiguity two ways at once: storage dropped the key, while the presence checks a patch passes through read it as a value. The visible effect was on `_app` cards, where a write-holder patching `{ did: undefined }` was refused for repointing a DID it never sent — a permission error naming a field the caller did not set, for a patch the owner got a validation error for. `ScopedStack.update()` applies the check ahead of its own binding fences, so the malformed patch is now the same error for every requester.

## 0.20.0

### Minor Changes

- [#227](https://github.com/haverstack/core/pull/227) [`59df7e6`](https://github.com/haverstack/core/commit/59df7e657a95cdc22a6f29c73c86e5d0e2d59b80) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Refuse a record-level `access: 'group'` permission whose `groupId` names a Record outside the `_group` family. Only a `_group` Record carries a roster; without the check, an app modelling its own `member`/`admin` relationship links turned every Record a permission was pointed at into an ACL, and a Record migrated out of `_group` kept resolving after it stopped being a group. Type-level grants already applied this rule — record-level permissions now match. Access that depended on the old behavior stops resolving: point the permission at a real `_group` Record.

- [#227](https://github.com/haverstack/core/pull/227) [`59df7e6`](https://github.com/haverstack/core/commit/59df7e657a95cdc22a6f29c73c86e5d0e2d59b80) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Raise `StackQueryError` (`bad_request`/400) rather than a bare `Error` for a `typeId` no definition exists for and for a malformed TypeId. Both are client-reachable over the wire, and an error outside the `StackError` taxonomy has no code for a server to map, so ordinary requests answered as 500s.

## 0.19.0

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

## 0.18.0

### Minor Changes

- [#220](https://github.com/haverstack/core/pull/220) [`5324f8e`](https://github.com/haverstack/core/commit/5324f8ec4ef6ef2225f3c05661e3d3d1d860512b) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Apply the attachment download safe-list to the whole `Content-Type` candidate, not a prefix of it. `isSafeAttachmentContentType()` now requires a single well-formed MIME type (`type/subtype` plus optional parameters), so a multi-type value such as `image/png,text/html` — which a browser resolves to its last type while a check stopping at the first `;` reads the first — is forced to `application/octet-stream` rather than served as-is.

- [#220](https://github.com/haverstack/core/pull/220) [`d0c0bb2`](https://github.com/haverstack/core/commit/d0c0bb25bae95f1285e2b2a0db980d0c4d215ac2) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Present a soft-deleted Record as a tombstone under `ScopedStack`, and refuse mutations aimed at one.

  `get()` and `query({ includeDeleted: true })` return identity, clock, `version`, `deletedAt` and `permissions` with an empty `content` and no associations, `parentId` or authorship; the change feed carries the same projection, so no channel serves more of a deleted Record than a fetch by ID does. `permissions` is retained because it decides whether the caller may `undelete()`; history is deliberately exempt and still serves the content, since reviewing a Record is how a caller decides to restore it.

  `update()`, `associate()`, `dissociate()`, `setPermissions()`, `setUnlisted()` and `restoreVersion()` now throw `StackConflictError` on a soft-deleted Record — asked after the authority decision, so a requester who cannot read it still gets `StackNotFoundError` rather than learning the ID names something. `undelete()` and `commitMigration()` are unaffected.

  This resolves a contradiction between the spec's two accounts of soft delete: `versioning.md` called a soft-deleted Record a tombstone whose "current state is gone" while the implementation served it whole.

- [#220](https://github.com/haverstack/core/pull/220) [`5324f8e`](https://github.com/haverstack/core/commit/5324f8ec4ef6ef2225f3c05661e3d3d1d860512b) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Let a readable unlisted record convey access to the file it references. `ScopedStack.getAttachment()` and the reference-creation gate scan referencing records with `includeUnlisted`, so a requester the record's own permissions admit reaches its attachment on the same terms as a listed record — unlisted governs enumeration, not reach.

## 0.17.0

### Minor Changes

- [#218](https://github.com/haverstack/core/pull/218) [`d27cfe4`](https://github.com/haverstack/core/commit/d27cfe4fc09406abda36c1c93f071446e13ef7b8) Thanks [@cuibonobo](https://github.com/cuibonobo)! - `SubscribeOptions` gains `since`, a resume cursor forwarded to the adapter as
  `SubscribeChangesOptions.since` — the missing half of resumption. The plumbing on
  the adapter side already existed (`APIAdapter.subscribeChanges()` has honored
  `since` since it shipped, turning it into `Last-Event-ID`), but nothing on
  `Stack.subscribe()` or `ScopedStack.subscribe()` could pass one in. A consumer can
  now persist the last `seq` present on a delivered `RecordChange` and hand it back
  on the next `subscribe()` call to resume where it left off, rather than getting
  every change from the present onward after every restart. Note that a relaying
  stack delivers its own local writes through the same handler and those carry no
  `seq`, so what a consumer holds is the last cursor it saw, not the last change's.

  `since` means something only where a relay exists: a stack with no third party
  whose writes could have been missed has no cursor it could ever have minted.
  Passing `since` to a stack that relays nothing — including through
  `ScopedStack.subscribe()`, which never has a relay of its own — now throws
  `StackQueryError` rather than silently starting from the present, which would let
  the caller believe it resumed when it did not.

  A cursor outside the framable base64url charset is refused by `subscribe()` with
  the same `StackQueryError`, rather than being handed down for whichever adapter is
  underneath to reject in its own way — a malformed cursor now reports identically
  everywhere, the same posture `query()` already takes with a filter no adapter
  declared. The value stays opaque: this asks whether it can be framed, never what
  it means.

  `onReset` can now fire on the very first connection, when `since` names a cursor
  the far end will not honor (a `resume: false` server, an expired cursor) — that is
  a gap too, and the one an app most needs to hear about.

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
