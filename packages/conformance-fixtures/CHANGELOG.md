# @haverstack/conformance-fixtures

## 0.33.0

### Minor Changes

- [#353](https://github.com/haverstack/core/pull/353) [`a431168`](https://github.com/haverstack/core/commit/a43116869768b7f6e7f7a7bb9712d6821d831498) Thanks [@cuibonobo](https://github.com/cuibonobo)! - The `./wire` request parsers refuse input their endpoint does not define instead of ignoring it. `parseQueryParams()`, `parseChangeParams()` and `parseJournalParams()` throw `StackBadRequestError` for an unknown query param, a repeat of a param that names one value, or a boolean param other than `true`/`false`. `parseQueryBody()` does the same for an unknown key at any depth, a non-object body, a non-boolean `includeDeleted`/`includeUnlisted` or a non-string `cursor`. `createOptionsFromWireRecord()` refuses a key no wire record carries. The rule is specified in docs/spec/wire-format.md § Unrecognized input, and four new error fixtures cover it.

- [#356](https://github.com/haverstack/core/pull/356) [`4a3bc8e`](https://github.com/haverstack/core/commit/4a3bc8e86f69296ce18413e2225e6f35557a3b1c) Thanks [@cuibonobo](https://github.com/cuibonobo)! - `@haverstack/core/wire` adds a parser for every remaining endpoint core specifies, so a server no longer keeps its own list of their param and field names: `parseAuthChallengeBody()`, `parseAuthTokenBody()`, `parseEntityPatchBody()`, `parseTypeBody()`, `parseMigrationBody()`, `parseDeleteParams()`, `parseDownloadParams()` and `parseAssociationParams()`. Each refuses an unknown name or a malformed boolean with `StackBadRequestError`, and a known body field of the wrong type with `StackValidationError`. Two error fixtures pin a non-boolean `purge` and an unknown key on `POST /auth/token`.

  `Stack` refuses an association, permission or grant-target element carrying a key its kind does not define, at every depth, with `StackBadRequestError`. This applies on every write that takes an element, on a `relatedTo` filter target, and on `grantType()`, `revokeType()` and `listTypeGrants()`. A `_grant` record's `grantee` is held to the same keys and refused with `StackValidationError`. A new error fixture pins an unknown key on a permission grantee.

### Patch Changes

- Updated dependencies []:
  - @haverstack/wire-types@0.38.0

## 0.32.0

### Minor Changes

- [#328](https://github.com/haverstack/core/pull/328) [`ce4ac6d`](https://github.com/haverstack/core/commit/ce4ac6da617549745aee4b7ccc1aacad3d8007b7) Thanks [@cuibonobo](https://github.com/cuibonobo)! - "Who did this, and through which principal" is one `Actor` type — `{ subjectId, principalId? }` — everywhere it appears. `StackRecord` and `RecordVersion` carry `createdBy: Actor` (replacing `entityId` + `principalId`) and `updatedBy: Actor` (replacing `updatedBy` + `updatedVia`), on the wire as in memory. `ChangeActor` is `Actor & { appId? }`, `TokenSession` is an `Actor` with `principalId` always set, and `ActorOptions` is `{ actor?: Actor }`. `RecordFilter.createdBy` and `ChangeFilter.createdBy` replace the author filters (query params `createdBySubject` / `createdByPrincipal`). `Stack.asActor(actor)` replaces `forSession()` and `asEntity()`'s `onBehalfOf` option, and `StackTokenStore.createToken()` takes an `Actor`. The SQLite `versions` table gains a `principal_id` column so a snapshot keeps its author's principal.

- [#348](https://github.com/haverstack/core/pull/348) [`147bbdf`](https://github.com/haverstack/core/commit/147bbdf8e8ce50c5865875b0c56e410fee01994f) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Replace the `hasAttachment` and `attachmentFileId` filters with `attachment: { label?, fileId? }`, shaped like `relatedTo`: at least one half is required, and both halves together match a single association. The wider "does this record reference the file" question — attachment associations plus top-level `file-ref` fields, used by `deleteAttachment()` and garbage collection — moves to `referencesFileId`. On the wire, `GET /records` takes `attachmentLabel`, `attachmentFileId` and `referencesFileId`. `assertValidRelatedTo` becomes `assertValidAssociationFilters(filter)`, which also refuses an empty `attachment` filter.

- [#343](https://github.com/haverstack/core/pull/343) [`83ded9c`](https://github.com/haverstack/core/commit/83ded9c2274d5e1ca29e8de4fa714a9da5eff2d1) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Rename `StackQueryError` to `StackBadRequestError`, matching its wire code `bad_request`. It is thrown for any malformed request — bad record IDs, empty change sets, malformed TypeIds, unknown types, unusable `since` cursors, and every `./wire` parser — not only queries. The wire code and HTTP status are unchanged.

- [#329](https://github.com/haverstack/core/pull/329) [`e36923c`](https://github.com/haverstack/core/commit/e36923cf3799f8d3a13176c23b293f4967e4928b) Thanks [@cuibonobo](https://github.com/cuibonobo)! - `ChangeFilter` is a subset of `RecordFilter`, and every key means the same thing in both, so one filter drives `query()` and `subscribe()` alike. `typeId` is now an exact match; a subscriber that wants the whole type family passes `baseId`, which `GET /changes` carries as `?baseId=`. `createdBy` accepts lists and `principalId`, as on `RecordFilter` (`?createdByPrincipal=` on the wire). A `migrate` or `restore` that changes a record's type is delivered to subscribers of the type it left as well as the one it entered.

- [#350](https://github.com/haverstack/core/pull/350) [`987d533`](https://github.com/haverstack/core/commit/987d53303099fc9478a5f6708651c8a898c3008d) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Make every `ChangeOp` a verb and spell permanent deletion one way. The record-level ACL op `'permissions'` is now `'reshare'`. Permanent deletion is `purge` everywhere: `delete(id, { purge: true })` (was `{ hard: true }`), `deleteRecord(id, { purge: true })` on every adapter, `DELETE /records/:id?purge=true` on the wire (was `?hard=true`), and the op `'purge'` (was `'hard-delete'`), matching the existing `'purged'` kind.

- [#349](https://github.com/haverstack/core/pull/349) [`ad14212`](https://github.com/haverstack/core/commit/ad142122b11c74aee921e61441691c1914425ed2) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Rename the change feed's resume cursor from `seq` to `cursor`, so it no longer shares a name with the journal's per-record `seq`. `RecordChange.seq` is now `RecordChange.cursor`, the `ready` frame carries `{"cursor": …}`, and `isValidSeq()` is now `isValidCursor()`. The journal window's exclusive bound `JournalQuery.sinceSeq` (and the `?sinceSeq=` query param) is now `afterSeq`.

- [#326](https://github.com/haverstack/core/pull/326) [`4caed17`](https://github.com/haverstack/core/commit/4caed174a242fac5698018a63762a53f9b642ff6) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Record-level permission grantees now discriminate on `kind` instead of `scope`, matching type-level grant grantees: `{ kind: 'entity', entityId }` and `{ kind: 'group', groupId, role }`. The shared arms are exported as `Grantee`, which replaces `PermissionGrantee`, with `GroupRole` naming `'member' | 'admin'`; `GrantGrantee` is `Grantee` plus `{ kind: 'authenticated' }`. The `GrantTarget` alias is removed in favor of `GrantGrantee`. Relationship targets (`RelationshipTarget`, `RelationshipTargetPattern`) move to `kind` too — `{ kind: 'record' | 'entity' | 'external', … }` — so an entity target and an entity grantee are the same value.

### Patch Changes

- [#345](https://github.com/haverstack/core/pull/345) [`7cffb1d`](https://github.com/haverstack/core/commit/7cffb1dc8e33993082aaa83599ba2e031a1c5cde) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Reshape the type-level grant methods to mirror the record-level `grantAccess(id, permission)`, and put their layer in their names:
  - `Stack.grant(target, [{ typeId, actions }])` is `Stack.grantType(typeOrBaseId, { actions, grantee })`: subject first, grantee inside the element. It creates and returns one `_grant` record; the batch form is removed, so call it once per type. The element type is exported as `TypeGrant`.
  - `Stack.revoke(target, [{ typeId, actions }])` is `Stack.revokeType(typeOrBaseId, { actions, grantee })`, returning the grants it withdrew.
  - `Stack.listGrants()` is `Stack.listTypeGrants()`.
  - All three return records typed with `content: GrantContent`.

  `typeOrBaseId` accepts a bare baseId as well as a versioned TypeId. The record-level `grantAccess()`/`revokeAccess()` are unchanged.

- Updated dependencies [[`ce4ac6d`](https://github.com/haverstack/core/commit/ce4ac6da617549745aee4b7ccc1aacad3d8007b7), [`cd467d9`](https://github.com/haverstack/core/commit/cd467d90cab977001bc4b097f9291c6c49fae226), [`2f12d0a`](https://github.com/haverstack/core/commit/2f12d0a6ed6adab7d04cf858f566bad18826cdc9), [`546e28c`](https://github.com/haverstack/core/commit/546e28cf1d78f3a088d7962272a7d3bd70a9ff62), [`83ded9c`](https://github.com/haverstack/core/commit/83ded9c2274d5e1ca29e8de4fa714a9da5eff2d1), [`ad14212`](https://github.com/haverstack/core/commit/ad142122b11c74aee921e61441691c1914425ed2)]:
  - @haverstack/wire-types@0.37.0

## 0.31.0

### Minor Changes

- [#320](https://github.com/haverstack/core/pull/320) [`f99ab6b`](https://github.com/haverstack/core/commit/f99ab6b990721ed3f12893d53570762c8e0383c1) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Pin the grantee arms and the evaluation-time refusals that the fixtures only described.

  Two fixtures covered a grant with no grantee at all and a group arm with no role, and both said in prose that the other arms "are refused the same way" — a rule stated in a fixture and checked by nothing. Nine fixtures now stand behind it: each incomplete arm (`entity` with no `entityId`, `group` with no `groupId`), an empty `entityId` as distinct from an absent one, the listing-only `role: 'any'` that a `listGrants()` query may ask for and a stored grantee may never carry, an unrecognized `kind`, and a `null` grantee reported as the missing field it is rather than read as absent-then-defaulted.

  Two more pin the half of the rule no request shape can show: that a grant reaching storage unvetted confers nothing when it is read back. A grant naming `_app@1` still answers 403 on a create, and a mutate verb with no read companion in the same grant conveys neither the write nor a read — so it answers 404, not 403. Both are states `grant()` refuses and a server mapping a request body, an import, or a foreign server's response can still produce.

  Also pins that an `anyone` element labelled anything but `read` is refused, which is load-bearing beyond the element: stored, it would read as world read _and_ satisfy the `read` a `write` element needs beside it, silencing write-implies-read for every grantee on the record.

  No behavior change — every rule here is already in `docs/spec/access-control.md`. A consumer holding these fixtures to a coverage gate will see the new names and need to dispatch or skip them.

## 0.30.0

### Minor Changes

- [#318](https://github.com/haverstack/core/pull/318) [`11444f6`](https://github.com/haverstack/core/commit/11444f694cfa6b24fbe926cf7420d3523a3fa95f) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Add `deleteAndReturn()` — an atomic read-and-destroy, for a caller that needs the record too

  Hard delete leaves nothing to read once the row is destroyed, so a caller
  that also needs the record for its own response — a server building `DELETE
/records/:id?hard=true`'s body, in particular — had to read the record
  separately before calling `delete()`. That opened a window between the read
  and the destroy: a concurrent write with no `If-Match` to fence it could land
  in the gap, get destroyed by the purge, and never appear in the response.

  `Stack.deleteAndReturn()` and `ScopedStack.deleteAndReturn()` close it:
  `delete()`'s own read-and-destroy, reported back instead of discarded.
  `{ record, referencedFileIds }` — `record` is the record exactly as it stood
  at the moment of destruction for a hard delete, or the resulting tombstone
  for a soft one, captured inside the same write rather than a read beforehand.
  `delete()` is unchanged, now expressed as `deleteAndReturn()` with `record`
  dropped. `ScopedStack.deleteAndReturn()` is gated identically to `delete()`,
  including the existence/visibility check that produces `404` ahead of the
  `403` permission gate.

  `@haverstack/conformance-fixtures` gains `deleteRecordSequenceFixtures`,
  pinning that a hard delete's response reflects a write landing immediately
  before it rather than a copy read earlier.

### Patch Changes

- Updated dependencies []:
  - @haverstack/wire-types@0.36.0

## 0.29.0

### Minor Changes

- Released for a breaking change in `@haverstack/wire-types`.

### Patch Changes

- Updated dependencies []:
  - @haverstack/wire-types@0.35.0

## 0.28.0

### Minor Changes

- [#304](https://github.com/haverstack/core/pull/304) [`1d3d8b9`](https://github.com/haverstack/core/commit/1d3d8b998bd52ac0f0b88707a7116007779a226a) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Move `parentId` and `unlisted` off the version tier

  A move and a listing transition no longer bump `version`, take a snapshot, or
  read `ifVersion`. Both join `associations` in the journal tier, whose entry
  already records them in full: a `reparent` carries `previousParentId`, and
  `unlist`/`list` is its own inverse.

  `RecordVersion` and `WireVersion` lose `parentId`, and the SQLite `versions`
  table loses its `parent_id` column. `restoreVersion()` correspondingly settles
  `content` and `typeId` alone — it leaves a record in whatever container it is
  in now, which removes the ancestor-cycle walk, the reference gate on the
  snapshot's container, and the second-container routing a restore used to get
  on the change feed.

  `version` is now documented as the ordinal of a record's snapshot history
  rather than a count of its changes; the journal's `seq` is what counts every
  change.

- [#306](https://github.com/haverstack/core/pull/306) [`b4b21db`](https://github.com/haverstack/core/commit/b4b21dbc208937817f26602fd53751601e6d43a0) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Store record permissions as associations, behind a partitioned API surface

  A permission entry has element identity, so the delta the association tier
  already computes describes it exactly. `Permission` is replaced by two
  association kinds — `permission`, whose bit is its label and whose grantee
  carries a required `role`, and `anyone`, which spells reach to the world
  affirmatively — and the whole-list snapshot goes with it. `RecordVersion` and
  `WireVersion` lose `permissions`, the SQLite `versions` and `records` tables
  lose their `permissions` columns, and `restoreVersion()` loses its
  never-restores-permissions carve-out: it falls out of a restore never touching
  associations.

  Storage unifies; the API does not. `StackRecord.associations` and
  `StackRecord.permissions` are projections over one table partitioned by kind,
  and each change-set key replaces only within its own domain, so an app editing
  tags is never handed the ACL and cannot drop it. A kind named in the wrong key
  is a `StackQueryError`, `associate()`/`dissociate()` refuse authority kinds,
  and record-level ACL changes get their own verbs — `grantAccess()` and
  `revokeAccess()`, mirroring the type-level `grant()`/`revoke()`, with
  `POST /records/:id/permissions[/delete]` on the wire.

  The reshare gate reads the computed delta rather than the incoming list, so a
  wholesale replacement that drops every element — which names nothing at all —
  still needs reshare authority, while a set restated is not a reshare. _Write
  implies read_ becomes a cross-element invariant over the set a write would
  produce, which is what makes revoking a `read` refusable while its `write`
  stands, and an `anyone` element satisfies it for every grantee — a
  world-readable record leaves no writer blind. The rule it enforces is that no
  write lands in a set whose grantee cannot read it, whichever verb or key
  produced the set: withdrawing an `anyone` while a write it covered stands is
  refused, while `permissions: []` and a key naming the writer's own `read` in
  its place are ordinary one-call writes. A permission change is a no-bump write: it
  leaves `version` and `updatedAt` where they stand and appends one journal entry
  carrying `previous` per element it moved.

  The journal is therefore where a record's sharing history lives, and reading it
  is gated in two tiers: the mutate surface for the entry, reshare authority for
  its authority half. A write-holder who is neither owner nor creator gets the
  `permissions` op without the grantees beneath it, asked of both identities so
  delegation is no route to it either. Entries are never dropped, so `seq` stays
  dense and a mixed write still reports its content half.
  `getVersions()`/`getVersion()` serve the same `RecordVersion` rows to every
  requester who passes their gate, since a snapshot now carries nothing to
  project.

  An association naming no known kind — `null`, `{}`, or a kind outside the five
  — is a `StackValidationError` at every surface that takes one, rather than a
  `TypeError` from the first field read off it.

- [#307](https://github.com/haverstack/core/pull/307) [`93111dc`](https://github.com/haverstack/core/commit/93111dcb4989a35c5c5160eb46b418fd829ed50e) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Spell a Grant's reach affirmatively, in a required `grantee`

  `GrantContent.granteeEntityId`/`granteeGroupId` are replaced by one required
  `grantee` discriminated on `kind`: `{ kind: 'entity', entityId }`,
  `{ kind: 'group', groupId, role }`, or `{ kind: 'authenticated' }` for any
  authenticated entity. The tier is read off the discriminant, so no dropped
  field widens a grant's reach — a `_grant` Record arriving without a grantee
  fails schema validation instead of becoming a grant to everyone, and one
  carrying an unknown `kind` or an empty `entityId`/`groupId` confers nothing
  however it reached storage. Mutual exclusivity is a property of the type
  rather than a documented convention.

  `role` is required on the group arm, matching the record-permission side:
  `role: 'member'` is the wider set — an admin satisfies it — and
  `role: 'admin'` the narrower.

  The two "everyone" tiers reach different audiences and now share no word. A
  Grant's `{ kind: 'authenticated' }` reaches any entity holding a DID; a
  Record permission's `{ kind: 'anyone' }` reaches anonymous requesters too.

  Each arm's own fields are required on every write, not only at the helper.
  `create()`, `patchContent()`, `restoreVersion()` and `commitMigration()`
  refuse a `_grant` whose `entity` arm carries no `entityId`, whose `group` arm
  carries no `groupId` or role, or whose grantee names an unknown `kind`, with
  `StackValidationError`. A closed `object` field holds one `properties` set,
  so the schema can only require `kind`; without this an arm missing its own
  field would store, answer 200, and deny forever.

  `GrantTarget` is the same union, so the target passed to
  `grant()`/`revoke()`/`listGrants()` is the grantee the record carries, and
  `null` no longer does double duty as "default grant" and "default-only
  listing". A group target matches whole, role included, so a revoke aimed at a
  group's admins leaves its members' grant standing.

  `listGrants()` takes a `GrantQuery` — the same union, widened by a
  listing-only `role: 'any'` that returns every grant naming a group whichever
  role it carries. `'any'` is not a role an entity can hold and never reaches
  storage; `grant()` and `revoke()` reject it. Every arm but `entity` answers
  identity — what `grant()` would have written with the same argument — while
  the `entity` arm answers coverage, so its result is not a preview of what
  `revoke()` would withdraw.

  `revoke()` returns the grants it withdrew, as they stood, instead of `void`.
  Matching nothing stays a no-op rather than an error — re-running a revocation
  is safe — but the empty array now says so, where the silence did not.

### Patch Changes

- [#310](https://github.com/haverstack/core/pull/310) [`70075a2`](https://github.com/haverstack/core/commit/70075a268a8fbae909dfb5fe9dae04a53f13f2e9) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Point spec citations at the document that now carries the rule

  The 404-over-403 rule moved out of `docs/spec/access-control.md` into its own
  `docs/spec/disclosure.md`. JSDoc on `ScopedStack` and one conformance
  fixture's description cited the old section, and both ship — the comments in
  `.d.ts`, the description in the fixture data. No behavior changes.

- [#309](https://github.com/haverstack/core/pull/309) [`eb03eb5`](https://github.com/haverstack/core/commit/eb03eb524b8ba6982474cc461069829d1c7c4dee) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Point the journal read-gate fixture at the section that states the rule

  `error-permission-denied-journal-read-only` cited
  `docs/spec/versioning.md § Reading it`, which is not a section. The
  mutate-surface gate on `GET /records/:id/journal` is stated in
  `docs/spec/journal.md § Reading it`.

- Updated dependencies [[`1d3d8b9`](https://github.com/haverstack/core/commit/1d3d8b998bd52ac0f0b88707a7116007779a226a), [`b4b21db`](https://github.com/haverstack/core/commit/b4b21dbc208937817f26602fd53751601e6d43a0)]:
  - @haverstack/wire-types@0.34.0

## 0.27.0

### Minor Changes

- [#296](https://github.com/haverstack/core/pull/296) [`5feb1cd`](https://github.com/haverstack/core/commit/5feb1cd1a58726df6e9ff113daab57c27935d843) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Give the change journal its own association shape, and write down the erasure boundary around a purge.

  A journal entry's three association lists become one tagged list, `associations: AssociationChange[]`, with `add`, `repoint` and `remove` arms. Each element carries the state it displaced, so an inverse is read off one element instead of joined across two lists against a key that was never identity. A removal now keeps the annotation it carried, which makes it as undoable as a re-point. The change feed keeps its two flat lists unchanged; they are flattened out of the entry's list, so the two halves cannot disagree. The `journal` table replaces its three `associations_*` columns with one, and `GET /records/:id/journal` carries the new field.

  An association list holding one identity twice is now refused with `StackValidationError` rather than collapsed, and every adapter keys associations by identity.

  `delete()` returns `{ referencedFileIds }`: a purge deletes no bytes, but it destroys the only rows naming the files the record referenced, so it reports them and the caller makes the intentional `deleteAttachment()` call. A hard delete over the wire answers `200` with the record it destroyed rather than `204`, which is where a client reads that report.

  `getJournal()` throws `StackNotFoundError` for a record that does not exist or was purged, instead of answering an empty log — an empty log means "nothing changed" unconditionally.

### Patch Changes

- Updated dependencies [[`5feb1cd`](https://github.com/haverstack/core/commit/5feb1cd1a58726df6e9ff113daab57c27935d843)]:
  - @haverstack/wire-types@0.33.0

## 0.26.1

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

## 0.26.0

### Minor Changes

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

- [#291](https://github.com/haverstack/core/pull/291) [`8e55da7`](https://github.com/haverstack/core/commit/8e55da7dd061e197054d652262efad9b51989eba) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Pin the wire surface for associations outside versioning

  The wire spec and fixtures now state what associations outside version
  history mean for a server implementation, which is where they are read from:
  - **A snapshot body carries no `associations`**, and a restore leaves a
    record's associations where they stand. `WireVersion` has no such field,
    so a server emitting one writes a key every client drops — and a server
    that snapshots on the association endpoints hands every later restore a
    stale set to put back. A new fixture,
    `get-versions-after-associate-is-unchanged`, pins that
    `GET /records/:id/versions` answers identically across an `associate()`,
    and the conformance run asserts no parsed snapshot names an association
    set.
  - **The change feed's own document describes the association fields.** Its
    frame examples spell `ops` as the list it is, one of them carries
    `associationsAdded`, and the implementation checklist names the two
    association endpoints — a server emitting off its snapshot path alone
    serves no association events at all, and the checklist previously pointed
    only at the list of endpoints that bump `version`.
  - **An `If-Match` sent to an association endpoint is ignored, not refused.**
    The endpoints read no precondition, so there was nothing for the
    spec's "a malformed `If-Match` is 400" rule to protect there, and it
    said only that the endpoints "take no `If-Match`" — which a server could
    as easily have implemented as a rejection. They never look at the header,
    whatever its value. A `PATCH` naming `associations` alone still earns the
    400 for a malformed one: that route reads the header and finds it
    unreadable, where the association endpoints never look. The conformance
    run now asserts the client half — `APIAdapter` sends no `If-Match` on
    either endpoint.

  `restore-version` and `change-feed-changed-frame-names-the-verb` had
  descriptions naming a restore's association set and a singular `op`; both
  now say what the endpoints do.

### Patch Changes

- Updated dependencies [[`b164b5f`](https://github.com/haverstack/core/commit/b164b5f553967ae6190b5bd60ff42ad128724494), [`a0163e7`](https://github.com/haverstack/core/commit/a0163e73126e487579502cd36a0e1be9e27ba30d), [`dc6f3b2`](https://github.com/haverstack/core/commit/dc6f3b28e42f4ab6ffd5c14ef9465155c8f1eb14)]:
  - @haverstack/wire-types@0.32.0

## 0.25.0

### Minor Changes

- [#284](https://github.com/haverstack/core/pull/284) [`8e42a7f`](https://github.com/haverstack/core/commit/8e42a7fc0bf13be2b2697f10efb21a88c95752fc) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Let an attachment association name the upload it came from, with an optional `attachmentRecordId`.

  Attachments are content-addressed, but their metadata is per-upload: two byte-identical uploads share one `fileId` and get one `_attachment` record each. A `kind: 'attachment'` Association carried only `{ label, fileId }`, so two records referencing the same bytes were indistinguishable, and resolving a display name through `getAttachmentRecords(fileId)[0]` gave every one of them the _first_ uploader's filename.

  `attachmentRecordId` names the `_attachment` record whose upload established a particular reference. It is optional, validated when written — the named record must exist, be in the `_attachment` family, and carry the association's own `fileId`, with one refusal for every way of failing so it is no existence oracle — and best-effort afterwards: the record it names can be deleted, and every reader falls back.

  `resolveReferencedAttachment()` (exported from `@haverstack/core/wire`) applies the resolution order over the records `getAttachmentRecords()` returns: the named record, else the requester's own, else the first-recorded. A download has no reference to carry a pointer, so `GET /attachments/:fileId` resolves the last two steps and a client holding the association passes what it resolved as `?filename`.

  The pointer stays outside association identity, which is still `(kind, label)` plus `fileId`. `dissociate()` matches without it, garbage collection and the `attachmentFileId` filter go on asking their `fileId`-level question, and an `associate()` naming a different one re-points the association already there — a version-bumping write, not a second reference to the same file. The association written is the association stored, so leaving the field off one that carries it clears it, rather than merging the old value forward. The SQLite adapters store it in a column outside the associations primary key and upsert on conflict.

### Patch Changes

- Updated dependencies []:
  - @haverstack/wire-types@0.31.0

## 0.24.0

### Minor Changes

- Released for a breaking change in `@haverstack/wire-types`.

### Patch Changes

- Updated dependencies []:
  - @haverstack/wire-types@0.30.0

## 0.23.0

### Minor Changes

- Released for a breaking change in `@haverstack/wire-types`.

### Patch Changes

- Updated dependencies [[`974f10a`](https://github.com/haverstack/core/commit/974f10aec3ebc1ebf47041152da105dbbecfd1a2)]:
  - @haverstack/wire-types@0.29.0

## 0.22.0

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

### Patch Changes

- Updated dependencies [[`06b791c`](https://github.com/haverstack/core/commit/06b791cb4c5e15dd06442ab2ebfabb82cd014745)]:
  - @haverstack/wire-types@0.28.0

## 0.21.0

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

### Patch Changes

- Updated dependencies [[`e134c5a`](https://github.com/haverstack/core/commit/e134c5a8935893131361bc2da4ecff0de6ab0a5b)]:
  - @haverstack/wire-types@0.27.0

## 0.20.0

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

### Patch Changes

- Updated dependencies [[`e40e814`](https://github.com/haverstack/core/commit/e40e8143cda1b4a97ce930cd4e7f6d7b6b3f077f)]:
  - @haverstack/wire-types@0.26.0

## 0.19.0

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
  - @haverstack/wire-types@0.25.0

## 0.18.0

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

- Updated dependencies []:
  - @haverstack/wire-types@0.24.0

## 0.17.0

### Minor Changes

- Released for a breaking change in `@haverstack/wire-types`.

### Patch Changes

- Updated dependencies []:
  - @haverstack/wire-types@0.23.0

## 0.16.0

### Minor Changes

- Released for a breaking change in `@haverstack/wire-types`.

### Patch Changes

- Updated dependencies []:
  - @haverstack/wire-types@0.22.0

## 0.15.0

### Minor Changes

- Released for a breaking change in `@haverstack/wire-types`.

### Patch Changes

- Updated dependencies []:
  - @haverstack/wire-types@0.21.0

## 0.14.0

### Minor Changes

- Released for a breaking change in `@haverstack/wire-types`.

### Patch Changes

- Updated dependencies []:
  - @haverstack/wire-types@0.20.0

## 0.13.0

### Minor Changes

- Released for a breaking change in `@haverstack/wire-types`.

### Patch Changes

- Updated dependencies []:
  - @haverstack/wire-types@0.19.0

## 0.12.0

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

- Updated dependencies []:
  - @haverstack/wire-types@0.18.0

## 0.11.0

### Minor Changes

- Released for a breaking change in `@haverstack/wire-types`.

### Patch Changes

- Updated dependencies []:
  - @haverstack/wire-types@0.17.0

## 0.10.0

### Minor Changes

- Released for a breaking change in `@haverstack/wire-types`.

### Patch Changes

- Updated dependencies []:
  - @haverstack/wire-types@0.16.0

## 0.9.0

### Minor Changes

- Released for a breaking change in `@haverstack/wire-types`.

### Patch Changes

- Updated dependencies []:
  - @haverstack/wire-types@0.15.0

## 0.8.0

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
  - @haverstack/wire-types@0.14.0

## 0.7.0

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

- Updated dependencies []:
  - @haverstack/wire-types@0.13.0

## 0.6.0

### Minor Changes

- Released for a breaking change in `@haverstack/wire-types`.

### Patch Changes

- Updated dependencies []:
  - @haverstack/wire-types@0.12.0

## 0.5.0

### Minor Changes

- [#191](https://github.com/haverstack/core/pull/191) [`dcf1e4c`](https://github.com/haverstack/core/commit/dcf1e4cb4b9b8e75087d28ae72722826bcc665e3) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Add change-feed fixtures: `changeFeedFixtures` and `changeFeedSequenceFixtures`, with the `ChangeFeedFixture`, `ChangeFeedSequenceFixture`, `ChangeFeedActivity` and `ChangeFeedFrame` types they are written in. Discovery gains fixtures for a server advertising a feed, including one that neither resumes nor includes records.

  A connection is pinned as an ordered stream of frames plus the mutations made while it is open, since most of what the endpoint owes a client is what a _mutation_ makes an open connection say. The group covers a frame per kind, `ready` leading every connection, `reset` in place of a partial resume, exact filtering, a record the session cannot read producing no frame, and the purge that carries nothing about the record even when the connection asked for one.

### Patch Changes

- Updated dependencies [[`ca0acdc`](https://github.com/haverstack/core/commit/ca0acdc78e6861fc371140b040898ce28279c435)]:
  - @haverstack/wire-types@0.11.0

## 0.4.0

### Minor Changes

- [#185](https://github.com/haverstack/core/pull/185) [`779ddd6`](https://github.com/haverstack/core/commit/779ddd6599c8b9049ca6fbf1516a4a54705e9609) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Stop `ScopedStack` refusals from confirming which record IDs exist.

  A record the request cannot read now answers exactly as a missing one does. `ScopedStack.get()` returns `null` for an unreadable record instead of throwing `StackPermissionError`, and `update()`, `associate()`, `dissociate()`, `setPermissions()`, `delete()`, `undelete()`, `getVersions()`, `getVersion()` and `restoreVersion()` throw `StackNotFoundError` rather than `StackPermissionError` where the requester holds no read access. `StackPermissionError` is now reserved for a requester who can read the record — over the wire, 403 is earned by readability and everything else is 404.

  Record IDs encode their creation millisecond and increment within it, so the old distinction let anyone holding one ID confirm its same-millisecond siblings. Callers that branch on `StackPermissionError` to detect "exists but forbidden" will see `StackNotFoundError`/`null` instead; the distinction is still available to server operators, which `docs/spec/wire-format.md` § Server implementation checklist now asks them to log.

  Unaffected: refusals that never read the record — `commitMigration()`, `deleteAttachment()` and `collectAttachmentGarbage()` answer identically whether or not it exists — and reference-creation gating, which continues to collapse missing and inaccessible targets onto `StackPermissionError`.

  Fixtures gain `error-not-found-record-the-requester-cannot-read`, so a server that answers 403 there now fails conformance.

### Patch Changes

- Updated dependencies []:
  - @haverstack/wire-types@0.10.0
