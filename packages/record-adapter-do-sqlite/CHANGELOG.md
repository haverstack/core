# @haverstack/record-adapter-do-sqlite

## 0.14.0

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

### Patch Changes

- Updated dependencies [[`06b791c`](https://github.com/haverstack/core/commit/06b791cb4c5e15dd06442ab2ebfabb82cd014745), [`c8e70ab`](https://github.com/haverstack/core/commit/c8e70ab0576336d1f58bfd8054406e7f445ea2b4), [`64cda3b`](https://github.com/haverstack/core/commit/64cda3bb5b7b21ec9277695fea8fd78516d0e6ca)]:
  - @haverstack/core@0.29.0

## 0.13.0

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

- Updated dependencies [[`12e1a4b`](https://github.com/haverstack/core/commit/12e1a4bf9db1086a6b546859171f3a7bf72db322), [`e134c5a`](https://github.com/haverstack/core/commit/e134c5a8935893131361bc2da4ecff0de6ab0a5b)]:
  - @haverstack/core@0.28.0

## 0.12.0

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

- [#258](https://github.com/haverstack/core/pull/258) [`053b53e`](https://github.com/haverstack/core/commit/053b53e016d7af16a207e940de111bcfa0eab032) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Rework the shared SQLite storage layout so reads are index-driven,
  trading index bytes for read latency and write throughput.

  `content_sort` and `file_refs` held one row per top-level content field
  each, on the same key and with the same lifecycle; they are now one
  `content_index`, halving the per-write index maintenance and removing a
  table and its implicit index from the file. A `value_rank` column
  replaces the "is num_value null" partitioning, so a single index carries
  the whole content ordering where two carried none the planner would use.

  A content-field sort now reads as two ordered index walks — the records
  holding a value at the field, then the records holding none — instead of
  a LEFT JOIN the planner could only sort after the fact. Filter indexes on
  `records` carry `(created_at, id)` so a filtered listing walks the index
  in order and stops at the page boundary; the `deleted_at` and
  `unlisted_at` indexes are gone, since every query asks for `IS NULL` and
  their presence steered the planner away from the ordering index. The
  redundant `idx_assoc_record_id` and `idx_tokens_hash` are gone too — the
  primary key and the UNIQUE constraint already index those columns.

  `records_fts` is declared `columnsize=0`: search here is a membership
  test, never a relevance ranking, so the per-row token-count shadow table
  was written on every record write and never read. A foreign reader can no
  longer rank against `records_fts` with `bm25()`.

  Measured over 20k records: listings and content sorts 5-7x faster, writes
  ~19% faster, table bytes ~7% smaller, index bytes ~7% larger, and the
  file ~2% larger overall. Carrying the sort key on the filter indexes is
  what costs those bytes, and what makes a filter on a low-cardinality
  column — one entity, a handful of types, most records without a parent —
  an ordered index walk rather than a sort of everything it matched.

  Query results, ordering and cursors are unchanged. The stack file layout is
  not — an existing database is not readable by this version.

### Patch Changes

- [#258](https://github.com/haverstack/core/pull/258) [`5463fc1`](https://github.com/haverstack/core/commit/5463fc13e7e0f3e55c6c17bbab87ed6f4d7da7f4) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Stop `sanitizeFts5Query` collapsing on adversarial search text.

  Several rules re-scanned the same run of input once per starting position
  inside it, which is quadratic in that run — on text a caller types into a
  search box. A few hundred kilobytes of the right shape held the thread for
  seconds to minutes; the same inputs now take tens of milliseconds.

  This bounds the collapse, not the growth: sanitizing still costs a little
  more than proportionally as the search text grows, so bounding that text's
  length remains the caller's.

  The rewrites are unchanged for every input FTS5 would accept. A paren
  inside a `NEAR(...)` call now reads as grouping rather than being
  swallowed with the wrapper, since no input FTS5 accepts puts one there.

- Updated dependencies [[`e40e814`](https://github.com/haverstack/core/commit/e40e8143cda1b4a97ce930cd4e7f6d7b6b3f077f)]:
  - @haverstack/core@0.27.0

## 0.11.0

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

## 0.10.0

### Minor Changes

- [#253](https://github.com/haverstack/core/pull/253) [`8a31b4e`](https://github.com/haverstack/core/commit/8a31b4ecb0117c86e1c5004c52f73fec9730f625) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Sort by a top-level content field: `query({ sort: { contentField: 'publishedAt', direction: 'desc' } })`. A consumer wanting a bounded page in a meaningful order previously had to page the whole matched set and sort it in memory — a cost that grew with the stack while the page stayed the same size.

  `QuerySort` gains a `contentField` member beside `field` rather than widening `field` to a string: a content field may be named `version`, and a `'content.'` prefix collides with the filter path separator. Over the wire the two are `?sortContent=` and `?sort=`, and a request naming both is refused.

  The ordering is defined once in core so no two adapters answer one query differently. A field orders as the kind its schema declares — dates as instants, booleans as false-then-true — a record holding no value at the field sorts last in both directions, numbers precede text where types disagree about a field name, and text orders by a case- and accent-folded key (`apple`, `Émile`, `Zebra`) rather than by code point. What that fold does not promise — locale tailoring, script-aware or natural-number ordering — is stated in `docs/spec/data-model.md` § Text ordering.

  SQLite-backed adapters materialize a `content_sort` index, maintained on every write alongside `file_refs`, and only for top-level scalars — the same line `file-ref` indexing draws.

  `AdapterCapabilities` gains `contentFieldSort`, and `sortableFields` is now enforced rather than merely declared: a sort an adapter has not declared throws `StackQueryError` instead of being answered in some other order. `sortableFields` is typed `NativeSortField[]`, since content fields are unbounded and an adapter that indexes content for sorting indexes every top-level scalar.

  `MemoryAdapter` now honors `sort`, where it previously returned insertion order whatever the query asked for.

### Patch Changes

- Updated dependencies [[`8a31b4e`](https://github.com/haverstack/core/commit/8a31b4ecb0117c86e1c5004c52f73fec9730f625), [`a9f6ebf`](https://github.com/haverstack/core/commit/a9f6ebfc63824d604cd96647aaf862c9ad362275)]:
  - @haverstack/core@0.25.0

## 0.9.0

### Minor Changes

- [#250](https://github.com/haverstack/core/pull/250) [`0c76cb7`](https://github.com/haverstack/core/commit/0c76cb7b51f2ea407521ae1df1ff0c8e5852d53e) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Add `Stack.getAttachmentRecords(fileId)`, the candidate set `firstRecordedAttachment()` orders: every `_attachment` record describing a file, family-wide by `baseId`, including soft-deleted and unlisted records, content-filtered only where the adapter declares `contentFieldQuery`, and cursor-walked to exhaustion. Sorted earliest-recorded first, so `records[0]` is the record that establishes the file's `mimeType` and the two helpers compose without the caller re-sorting. Core exported the tie-breaker but not the lookup that safely feeds it, leaving every server to re-derive a query with three ways to get it wrong.

  It lands on `Stack` and deliberately not on `StackClient`: the lookup answers a presentation question about an access decision already made, so a scoped version would impose a second, different permission check and silently drop metadata the requester is entitled to.

  `_attachment` lookups are now family-wide throughout, where they were pinned to `_attachment@1`. A record migrated to a later version of the family now establishes the file's `mimeType` (so a conflicting later upload is rejected, where it was previously accepted), is purged by `deleteAttachment()`, and is seen by `collectAttachmentGarbage()` — which previously could not discover a file whose only metadata record had been migrated.

  `StackRecordAdapter.deleteUnreferencedAttachmentRecords()` takes `metadataTypeIds: TypeId[]` in place of a single `metadataTypeId`. Core resolves the `_attachment` family to concrete typeIds before the call, so adapters still need no `baseId` concept of their own.

### Patch Changes

- Updated dependencies [[`0c76cb7`](https://github.com/haverstack/core/commit/0c76cb7b51f2ea407521ae1df1ff0c8e5852d53e)]:
  - @haverstack/core@0.24.0

## 0.8.0

### Minor Changes

- Released for a breaking change in `@haverstack/core`.

### Patch Changes

- Updated dependencies [[`896b516`](https://github.com/haverstack/core/commit/896b5167d68690a307cba430ded97268c83fe218), [`e4119ea`](https://github.com/haverstack/core/commit/e4119eaa03f0510aa773b31cf36e860541857517)]:
  - @haverstack/core@0.23.0

## 0.7.0

### Minor Changes

- Released for a breaking change in `@haverstack/core`.

### Patch Changes

- Updated dependencies [[`d945ded`](https://github.com/haverstack/core/commit/d945ded1ead75e6e3e11a6088afa72dd889c8342), [`65476bd`](https://github.com/haverstack/core/commit/65476bd3f7aa025cec0790653bcc9cdb691bfce1)]:
  - @haverstack/core@0.22.0

## 0.6.0

### Minor Changes

- Released for a breaking change in `@haverstack/core`.

### Patch Changes

- Updated dependencies [[`64dfb36`](https://github.com/haverstack/core/commit/64dfb3621635438c9529b4be134b60cf936fb152)]:
  - @haverstack/core@0.21.0

## 0.5.0

### Minor Changes

- [#227](https://github.com/haverstack/core/pull/227) [`59df7e6`](https://github.com/haverstack/core/commit/59df7e657a95cdc22a6f29c73c86e5d0e2d59b80) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Repair search text FTS5 cannot parse instead of failing on it, so `5" nails`, `cats AND`, `-cats` and `cats-dogs` search for the terms they name. Everything outside a phrase is now reduced to an allow-list rather than a list of metacharacters to strip: FTS5's column-filter syntax is wider than `colname:term` — `-name` and `{a b}` filter columns with no colon — so a leading minus and an ordinary hyphenated word were reaching the engine as column names. Also closes an odd trailing quote, drops operators left without an operand, writes back the `AND` a group needs beside it, and removes control characters, which truncate SQLite's C string. Text inside a phrase is left alone. Behind that, any parse failure still reaching the engine surfaces as `StackQueryError` (`bad_request`/400) rather than a raw engine error a server has no code to map — scoped to `filter.search`, the one filter carrying a query language, so a failure in a parameter-built clause is still reported as the bug it is.

### Patch Changes

- Updated dependencies [[`59df7e6`](https://github.com/haverstack/core/commit/59df7e657a95cdc22a6f29c73c86e5d0e2d59b80), [`59df7e6`](https://github.com/haverstack/core/commit/59df7e657a95cdc22a6f29c73c86e5d0e2d59b80)]:
  - @haverstack/core@0.20.0

## 0.4.0

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
  - @haverstack/core@0.19.0

## 0.3.0

### Minor Changes

- [#220](https://github.com/haverstack/core/pull/220) [`f568011`](https://github.com/haverstack/core/commit/f568011af1f3ba41ea4671cd879b845285574eba) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Match a `content` filter key as a literal top-level field name. The key is quoted and escaped into the JSON path rather than interpolated, so `{ 'a.b': 1 }` now selects the field called `a.b` instead of `b` nested inside `a`, a key like `arr[0]` selects that field instead of an array element, and a key that is not path-shaped (`$.`, a stray bracket) is an ordinary zero-match filter instead of a raw SQLite "bad JSON path" error. Brings both SQLite adapters in line with the literal lookup every other adapter performs.

### Patch Changes

- Updated dependencies [[`5324f8e`](https://github.com/haverstack/core/commit/5324f8ec4ef6ef2225f3c05661e3d3d1d860512b), [`d0c0bb2`](https://github.com/haverstack/core/commit/d0c0bb25bae95f1285e2b2a0db980d0c4d215ac2), [`5324f8e`](https://github.com/haverstack/core/commit/5324f8ec4ef6ef2225f3c05661e3d3d1d860512b)]:
  - @haverstack/core@0.18.0

## 0.2.0

### Minor Changes

- Released for a breaking change in `@haverstack/core`.

### Patch Changes

- Updated dependencies [[`d27cfe4`](https://github.com/haverstack/core/commit/d27cfe4fc09406abda36c1c93f071446e13ef7b8)]:
  - @haverstack/core@0.17.0

## 0.1.1

### Patch Changes

- [#215](https://github.com/haverstack/core/pull/215) [`c01f8de`](https://github.com/haverstack/core/commit/c01f8de8c3ddaa931e7de8b428d18fbe1eb4f38c) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Add `@haverstack/record-adapter-do-sqlite` — a `StackRecordAdapter` over Cloudflare
  Durable Objects' SQLite storage, for Workers deployments with no Node runtime
  available. Reuses `SharedSqlRecordLogic`, the FTS5 schema and strategy, the query
  builder, cursor codec, and row mappers from `@haverstack/sqlite-shared` — the same
  shared layer `record-adapter-sqlite` is built on, now via its `./record` subpath
  (the token-store and file-lock pieces stay Node-only and unreachable from this
  adapter's bundle). No lock file: a Durable Object id maps to exactly one running
  instance, so the platform itself is the single-writer guarantee. No persist/flush
  step: every write through `ctx.storage.sql` is durable by the time the call returns.

  `@haverstack/sqlite-shared`'s `SqlExecutor` gained a `transaction<T>(fn: () => T): T`
  primitive, replacing the raw `BEGIN`/`COMMIT`/`ROLLBACK` statements `record-logic.ts`
  used to issue directly. Durable Object SQLite storage rejects those statements
  outright and does not roll back a write on a later exception the way an open SQL
  transaction would (verified against the real Workers runtime) — its real primitive
  is `ctx.storage.transactionSync(fn)`, a callback boundary that three independent
  string-based `exec()` calls can't reach. `record-adapter-sqlite`'s executor
  implements `transaction()` as literal `BEGIN`/`COMMIT`/`ROLLBACK` around `fn()`,
  behavior-identical to what the inline code did before — its full test suite passes
  unchanged.
