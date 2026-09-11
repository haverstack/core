# @haverstack/wire-types

## 0.29.0

### Minor Changes

- Released for a breaking change in `@haverstack/core`.

### Patch Changes

- [#275](https://github.com/haverstack/core/pull/275) [`974f10a`](https://github.com/haverstack/core/commit/974f10aec3ebc1ebf47041152da105dbbecfd1a2) Thanks [@cuibonobo](https://github.com/cuibonobo)! - `NATIVE_SORT_FIELDS` is exported from `@haverstack/core`, and
  `NativeSortField` is derived from it. The three native sort columns had
  been spelled out four times across three packages — core's own wire-request
  parser, `normalizeCapabilities()` in wire-types, the cursor decoder in
  sqlite-shared, and the type itself — so adding a fourth column meant
  finding all four. Each site now narrows against the one array, following
  the same array-is-the-source-of-truth shape `GRANT_ACTIONS` already uses.
  No behavior change: the set of accepted sort fields is what it was.
- Updated dependencies [[`1010033`](https://github.com/haverstack/core/commit/101003350a4bb8e590c1942339fc405bef31aeb8), [`974f10a`](https://github.com/haverstack/core/commit/974f10aec3ebc1ebf47041152da105dbbecfd1a2), [`e1420b0`](https://github.com/haverstack/core/commit/e1420b0e27a9027d4d00e61e47874e8b1685cff7), [`fca0f79`](https://github.com/haverstack/core/commit/fca0f79196c2703d4fea168e983d519249012719)]:
  - @haverstack/core@0.30.0

## 0.28.0

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

- Updated dependencies [[`06b791c`](https://github.com/haverstack/core/commit/06b791cb4c5e15dd06442ab2ebfabb82cd014745), [`c8e70ab`](https://github.com/haverstack/core/commit/c8e70ab0576336d1f58bfd8054406e7f445ea2b4), [`64cda3b`](https://github.com/haverstack/core/commit/64cda3bb5b7b21ec9277695fea8fd78516d0e6ca)]:
  - @haverstack/core@0.29.0

## 0.27.0

### Minor Changes

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

- Updated dependencies [[`12e1a4b`](https://github.com/haverstack/core/commit/12e1a4bf9db1086a6b546859171f3a7bf72db322), [`e134c5a`](https://github.com/haverstack/core/commit/e134c5a8935893131361bc2da4ecff0de6ab0a5b)]:
  - @haverstack/core@0.28.0

## 0.26.0

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
  - @haverstack/core@0.27.0

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

## 0.24.0

### Minor Changes

- Released for a breaking change in `@haverstack/core`.

### Patch Changes

- Updated dependencies [[`8a31b4e`](https://github.com/haverstack/core/commit/8a31b4ecb0117c86e1c5004c52f73fec9730f625), [`a9f6ebf`](https://github.com/haverstack/core/commit/a9f6ebfc63824d604cd96647aaf862c9ad362275)]:
  - @haverstack/core@0.25.0

## 0.23.0

### Minor Changes

- Released for a breaking change in `@haverstack/core`.

### Patch Changes

- Updated dependencies [[`0c76cb7`](https://github.com/haverstack/core/commit/0c76cb7b51f2ea407521ae1df1ff0c8e5852d53e)]:
  - @haverstack/core@0.24.0

## 0.22.0

### Minor Changes

- Released for a breaking change in `@haverstack/core`.

### Patch Changes

- Updated dependencies [[`896b516`](https://github.com/haverstack/core/commit/896b5167d68690a307cba430ded97268c83fe218), [`e4119ea`](https://github.com/haverstack/core/commit/e4119eaa03f0510aa773b31cf36e860541857517)]:
  - @haverstack/core@0.23.0

## 0.21.0

### Minor Changes

- Released for a breaking change in `@haverstack/core`.

### Patch Changes

- Updated dependencies [[`d945ded`](https://github.com/haverstack/core/commit/d945ded1ead75e6e3e11a6088afa72dd889c8342), [`65476bd`](https://github.com/haverstack/core/commit/65476bd3f7aa025cec0790653bcc9cdb691bfce1)]:
  - @haverstack/core@0.22.0

## 0.20.0

### Minor Changes

- Released for a breaking change in `@haverstack/core`.

### Patch Changes

- Updated dependencies [[`64dfb36`](https://github.com/haverstack/core/commit/64dfb3621635438c9529b4be134b60cf936fb152)]:
  - @haverstack/core@0.21.0

## 0.19.0

### Minor Changes

- Released for a breaking change in `@haverstack/core`.

### Patch Changes

- Updated dependencies [[`59df7e6`](https://github.com/haverstack/core/commit/59df7e657a95cdc22a6f29c73c86e5d0e2d59b80), [`59df7e6`](https://github.com/haverstack/core/commit/59df7e657a95cdc22a6f29c73c86e5d0e2d59b80)]:
  - @haverstack/core@0.20.0

## 0.18.0

### Minor Changes

- Released for a breaking change in `@haverstack/core`.

### Patch Changes

- Updated dependencies [[`46691c5`](https://github.com/haverstack/core/commit/46691c57f6b3b79f3d008fc29b2382c5eb3da006)]:
  - @haverstack/core@0.19.0

## 0.17.0

### Minor Changes

- Released for a breaking change in `@haverstack/core`.

### Patch Changes

- Updated dependencies [[`5324f8e`](https://github.com/haverstack/core/commit/5324f8ec4ef6ef2225f3c05661e3d3d1d860512b), [`d0c0bb2`](https://github.com/haverstack/core/commit/d0c0bb25bae95f1285e2b2a0db980d0c4d215ac2), [`5324f8e`](https://github.com/haverstack/core/commit/5324f8ec4ef6ef2225f3c05661e3d3d1d860512b)]:
  - @haverstack/core@0.18.0

## 0.16.0

### Minor Changes

- Released for a breaking change in `@haverstack/core`.

### Patch Changes

- Updated dependencies [[`d27cfe4`](https://github.com/haverstack/core/commit/d27cfe4fc09406abda36c1c93f071446e13ef7b8)]:
  - @haverstack/core@0.17.0

## 0.15.0

### Minor Changes

- Released for a breaking change in `@haverstack/core`.

### Patch Changes

- Updated dependencies [[`609c320`](https://github.com/haverstack/core/commit/609c320728ff47cae3997042685a9fc2f7a12150)]:
  - @haverstack/core@0.16.0

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

## 0.13.0

### Minor Changes

- Released for a breaking change in `@haverstack/core`.

### Patch Changes

- Updated dependencies [[`7db6eaf`](https://github.com/haverstack/core/commit/7db6eaff9dd96eccbc9e96e7a104f3529aa708c9)]:
  - @haverstack/core@0.14.0

## 0.12.0

### Minor Changes

- Released for a breaking change in `@haverstack/core`.

### Patch Changes

- Updated dependencies [[`d556069`](https://github.com/haverstack/core/commit/d5560696f3ec1d08e9d49f66b79cbf2f5036dfef)]:
  - @haverstack/core@0.13.0

## 0.11.0

### Minor Changes

- [#191](https://github.com/haverstack/core/pull/191) [`ca0acdc`](https://github.com/haverstack/core/commit/ca0acdc78e6861fc371140b040898ce28279c435) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Add the change-feed wire types: `WireRecordChange` and `serializeChange()`, the `ready`/`record`/`reset` frame names and their payloads, `DiscoveryChanges` with `supportsChangeFeed()`, and `isValidSeq()` for the cursor charset.

  `serializeChange()` drops the record, its parent, and everything else identifying it from a `purged` frame, whatever the caller passes. A server holds the purged record at emission — readability can only be evaluated before the write — so enforcing the rule in the encoding puts it where the leak would otherwise start.

## 0.10.0

### Minor Changes

- Released for a breaking change in `@haverstack/core`.

### Patch Changes

- Updated dependencies [[`779ddd6`](https://github.com/haverstack/core/commit/779ddd6599c8b9049ca6fbf1516a4a54705e9609)]:
  - @haverstack/core@0.12.0
