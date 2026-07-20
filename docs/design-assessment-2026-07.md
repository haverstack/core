# Haverstack Design Assessment — Post-Implementation Consistency Pass

Follow-up to [`design-review-2026-07.md`](./design-review-2026-07.md), after the implementation
batch that closed issues #45–#69. This is a whole-system read of the spec plus every package,
looking specifically for (a) holes the issue-by-issue review didn't cover, and (b) inconsistencies
introduced by implementing decisions one issue at a time. It deliberately does **not** re-raise
anything already tracked open (#3, #15, #16, #72, #90, #93).

Verdict up front: the design philosophy held up remarkably well through implementation — the
invariant layering (#67/#68), the error taxonomy round-trip (#53), the two-relations split
(#54/#68), and the attachment determinism/backstop pairing (#65/#66) are all implemented
faithfully and coherently. The findings below cluster where two decided principles _intersect_:
mostly (1) the #51 reference-gating model meeting the `_attachment@1` record type, (2) the #61
one-versioning-rule meeting #58's `role` field and the adapters' snapshot encoding, and (3) the
#52 conformance fixtures not yet covering the contracts decided latest.

Severity labels: **[hole]** = permission/integrity gap; **[bug]** = implementation contradicts a
decided rule; **[drift]** = spec and implementation disagree; **[note]** = worth a decision, low
stakes.

---

## A. Permission-model holes

### A1. [hole] `_attachment@1` creation bypasses the #51 reference gate — access conveyance + hash oracle

The #51 work gated every reference-creating path (`attachment` associations, `file-ref` content
fields, `relationship`/`parentId`) on the access the reference would convey, with
missing-vs-inaccessible deliberately indistinguishable so content-addressed fileIds can't be
probed. But creating an `_attachment@1` **record directly** is itself an access-conveying act
that got no gate:

- `canAccessFile()` (`packages/core/src/stack.ts:1829`) grants file access to a requester who
  "uploaded the file themselves" — operationalized as _holds an `_attachment@1` record with their
  `entityId` and that `content.fileId`_.
- `ScopedStack.create()` applies no special check for `_attachment@1`. Its `fileId` field is
  schema-kind `string` (deliberately not `file-ref`, so metadata records don't count as GC
  references — `stack.ts:1571`), which also means `requireFileRefAccess()` never fires on it.
- Nothing verifies the bytes exist or that the requester can access them.

So any entity holding a `create` grant on `_attachment@1` — which is **every uploader**, by
design — can mint a metadata record claiming an arbitrary guessed SHA-256 and then
`getAttachment()` succeeds via the uploader clause. Guessing the hash of _suspected known
content_ (the exact scenario #51's anti-oracle language names) both confirms the stack holds
those bytes and exfiltrates them.

Compounding it, `checkAttachmentMimeTypeOnCreate` (`stack.ts:1153`) is an oracle even when the
grab fails: its 422 message embeds the **established mimeType** for the guessed fileId
(`stack.ts:1176-1179`), confirming existence and leaking metadata, in exactly the
error-shape-differences #51 forbade for the association path.

The wire flow _requires_ direct metadata creation (`POST /attachments` stores bytes only; spec
§Attachments says "Direct HTTP callers must create the `_attachment@1` record separately"), so
this can't be fixed by forbidding it. Candidate directions:

1. **Gate metadata creation on `canAccessFile(fileId)` for non-owners**, and treat
   `putAttachment()`'s internal create as pre-authorized (it just stored the bytes). The
   two-step wire flow then needs the bytes-upload to count as "access": e.g. `POST /attachments`
   returns the fileId _and the server remembers recent uploads per entity_ (a short-lived
   upload receipt, or an owner-invisible marker record) — or simply: require that the blob
   **exist** and the requester pass `canAccessFile` _or_ be able to present the bytes' hash
   preimage… the receipt shape is the cleanest.
2. Failing that, at minimum make the mimeType-conflict rejection generic for non-owner
   requesters (same message whether the fileId exists or not) so the oracle half closes even if
   the conveyance half waits.

Either way, the anti-oracle rule (`StackPermissionError`, no distinguishing detail) applies.

### A2. [bug] `permissionEqual()` ignores `role` — role-only ACL changes are silently dropped

#58 added `role?: 'admin'` to group permission entries; #61 made `setPermissions()` a versioned,
no-op-detecting mutation. The no-op detector was never taught about the new field:
`permissionEqual` (`packages/core/src/stack.ts:1633-1636`) compares `groupId`/`read`/`write` but
not `role`. Consequence: narrowing `{ access: 'group', groupId, read: true, write: true }` to the
same entry **plus `role: 'admin'`** is judged deep-equal → `Stack.setPermissions()` returns early
→ the restriction is silently not applied, while the call reports success. That's a failed
_tightening_ of access with no signal — the worst direction to fail in. (No test covers a
role-only change; `scoped-stack.test.ts` only exercises `role` on reads.)

One-line fix in `permissionEqual`, plus a regression test. Worth also grepping for any other
comparator/serializer that predates `role` (the SQLite layer stores `permissions` as opaque JSON,
so it's unaffected).

### A3. [bug] `canAccessFile()` treats a bounded scan as exhaustive — false denials

`ScopedStack.query()` stops after `maxFetched = limit * 10` adapter records and returns a cursor
for continuation (`stack.ts:1991-2007`). `canAccessFile()` calls it with `limit: 1`
(`stack.ts:1832`) and ignores the cursor — so only the **first ten** records referencing the file
are ever permission-checked. A file referenced by ten records the requester can't read plus one
they can (a shared record attaching a widely-used file — a logo, a group header image) yields a
false `StackPermissionError` on `getAttachment()` and on legitimate reference creation. This is
precisely the "treating one `query()` call as exhaustive is a caller bug" rule #50 established —
violated by the permission predicate itself.

Fix: walk the cursor until a readable referencing record is found or the result set is exhausted
(the grant prefetch already exists to make per-record checks cheap), or push an
"exists a record referencing fileId readable-by-X" predicate down a layer.

### A4. [note] Version history is readable by anyone with _current_ read access — including pre-sharing content and ACL history

`ScopedStack.getVersions()/getVersion()` gate on `canRead(current record)` (`stack.ts:2086-2098`).
#61 made snapshots full-state, including `permissions`. Two consequences the review never
discussed:

1. A record shared _after_ sensitive content was edited out exposes the sensitive revisions to
   every reader.
2. Snapshot `permissions` — which the spec explicitly frames as "for audit and deliberate owner
   action" (§Versions) — are served to any reader, revealing who else had access historically.

This may be acceptable at intimates-scale, but it deserves a decision of record: e.g. history
reads require `write` (a write-holder needs history to use `restoreVersion` anyway), or
owner/creator, or at minimum strip `permissions` from non-owner version reads. Related: a
write-holder's `restoreVersion()` can re-attach references (and thereby re-convey file access)
from a snapshot without the #51 checks — defensible under recoverability ("owner can undo"), but
worth stating in the spec so it reads as chosen rather than missed.

---

## B. Versioning-rule inconsistencies (#61's "one rule, no special cases")

### B1. [bug] "No associations" is unrepresentable in a snapshot — restore can't remove associations

`Stack.saveVersion()` writes `associations` only when the record has them (`stack.ts:1597-1608`),
and adapters restore associations only `if (target.associations !== undefined)`
(`record-logic.ts:290`, `testing.ts:265`). So a snapshot of a record with **zero** associations is
indistinguishable from a pre-#61 snapshot that didn't record them, and restoring it leaves
later-added associations in place: create note (v1, no tags) → tag it (v2) → `restoreVersion(1)`
→ content reverts, tag survives. The "full prior state" rule holds in one direction only.

It's worse than asymmetric — it's adapter-divergent: SQL adapters materialize empty association
sets as `undefined` (`mappers.ts:29`), but `MemoryAdapter.dissociate()` leaves `associations: []`
(truthy → snapshotted → restore clears). The same sequence restores differently on the test
double than on real storage.

Fix: always snapshot `associations` (empty array included) and always restore them; treat
old snapshots lacking the key as legacy "leave as-is". Same question applies to `permissions`
for the owner's deliberate-restore path, and to `parentId`/`appId` — the snapshot shape still
doesn't capture `parentId`, so a re-parented record's hierarchy position is unrecoverable; if
that's intended ("associations and content only"), the spec should say so.

### B2. [hole] Orphaned snapshot permanently bricks a record's mutations

Snapshot and mutation are two separate, non-transactional adapter calls issued by `Stack`
(`saveVersion()` then `patchContent()`/`associate()`/…). The loud UNIQUE-collision behavior on
`(record_id, version)` — correct and load-bearing for the concurrent-writer case — turns a crash
in the gap into a permanent failure: the orphan snapshot sits at the record's _current_ version,
so **every** subsequent mutation (which must first snapshot that same version) throws
`StackConflictError` forever (`record-logic.ts:430-457`, `testing.ts:244-253`). There is no API to
inspect or clear a version row; the record becomes read-only-except-hard-delete. `migrateAll()`
interrupted between `saveVersion` and `commitMigration` has the same failure shape.

The original plan saw this: the review doc's keystone note says "#61's atomic snapshot+mutate …
land in or on" the #46 adapter work — but implementation kept snapshotting in `Stack` as a
separate call. Two directions:

1. Move snapshot+mutate into one adapter transaction (a `mutateWithSnapshot`-shaped contract, or
   have each mutating adapter method accept the snapshot to write) — the honest fix, and the
   SQLite layer already has transactions (`deleteUnreferencedAttachmentRecords` shows the idiom).
2. Cheaper mitigation: on collision, if the existing snapshot is deep-equal to the one being
   written (same prior state — always true for a crash orphan), treat as success instead of
   conflict. Keeps the loud behavior for genuine races (racing writers snapshot _different_
   `updatedAt`s at minimum… note they may not — so (1) is the sound one; (2) would need care).

### B3. [drift] Wire spec's auto-snapshot endpoint list omits `migrate` and `restore`

`APIAdapter.saveVersion()` is a deliberate no-op (`adapter-api/src/index.ts:523`) — over the wire,
the server is the _only_ snapshot writer. But both places the spec enumerates the auto-snapshot
endpoints (§Versions "Storage per adapter", and §Versions under the wire format) list only
"PATCH, associations, permissions, delete, undelete". `POST /records/:id/migrate` and
`POST /records/:id/restore/:version` are mutating endpoints under the one-rule and both rely on a
prior-state snapshot (`migrateAll()` and `restoreVersion()` call `saveVersion` locally — a no-op
over the API adapter). A server implementing the literal list silently loses rollback history for
migrations and restores. Spec fix plus conformance fixtures (see D2) — this is exactly the kind
of contract the fixtures exist to pin.

---

## C. Wire-honesty asymmetries (#56/#53 applied unevenly)

### C1. [bug] A search string that sanitizes to nothing silently drops the filter — full superset returned

`buildWhereClause` adds the FTS condition only `if (sanitized)` (`sqlite-shared/src/query.ts:131-137`).
A query like `search: "*"` (or any input the sanitizer strips entirely) returns **every record,
unfiltered**, presented as the search result — the precise "superset silently presented as the
filtered result" failure #56 declared worse than an error. Should return an empty result set (a
query for nothing matches nothing) or throw `StackQueryError`; either is defensible, silence
isn't.

### C2. [note] The loud-capability-failure rule exists only in `adapter-api`

`APIAdapterCapabilityError` fires before dispatch for `content`/`search` against a
non-declaring server — but `Stack.query()` itself performs no capability check, so a local
adapter with `fullTextSearch: false` (e.g. `MemoryAdapter`, which ignores `f.search` entirely)
silently returns the unfiltered superset. Open issue #90 fixes the `contentFieldQuery` half by
contract ("local adapters MUST declare true"); the `search` half has no equivalent. Cheapest
symmetric fix: hoist the check into `Stack.query()` (the invariant layer) against
`adapter.capabilities`, making local and wire behave identically — the same "local and remote
behave identically" phrasing the spec already uses for `ifVersion`.

### C3. [drift] Blob-layer errors are outside the taxonomy

`DiskBlobAdapter.getAttachment()` throws plain `Error("Attachment not found")` and
`assertFileId` plain `Error` (`blob-adapter-disk/src/index.ts:18-40`), while the same conditions
over the wire produce typed `StackNotFoundError`/400. #53's round-trip covered record errors;
the blob adapter contract never got error-taxonomy language. Callers can't
`instanceof`-distinguish a missing attachment locally. Fix: spec the `StackBlobAdapter` error
contract (`StackNotFoundError` for missing fileId; arguably `StackQueryError` for malformed) and
update the disk adapter + `MemoryAdapter` (which currently returns _empty bytes_ for unknown
fileIds — documented as deliberate leniency, but it means the test double can't exercise the
not-found path without subclassing, and diverges from what the contract should say).

### C4. [note] Upload-too-large has no typed error

`maxAttachmentBytes` is a first-class capability, but 413 maps to no wire code and no core error
class — an oversized upload surfaces as generic `APIAdapterError`. Neither `Stack.putAttachment()`
nor `APIAdapter` pre-checks against the declared ceiling. Cheap wins: a `payload_too_large` wire
code (or local pre-check throwing `StackValidationError`), so apps can catch it as something.

---

## D. Conformance fixtures under-pin the newest contracts (#52)

### D1. [bug] Fixture data violates the spec's own ID rules — a conformant server must reject the fixtures

Every record fixture uses ids like `rec-1`, `rec-attachment-2`; attachment fixtures use fileId
`abc123` (`conformance-fixtures/src/index.ts`). Under #55 — "the server validates always:
charset/length → 400, exactly 12 lowercase Crockford base-32" — a spec-conformant server
**rejects** `POST /records` with `id: "rec-1"`, and `DiskBlobAdapter.assertFileId` rejects
`abc123` on the download path. The enforcement suite and the validation rules it's meant to
enforce cannot both pass. Fix: regenerate fixture ids as valid 12-char Crockford ids and fileIds
as real 64-hex values (they can stay memorable — `000000000001`-style ids are legal).

### D2. [drift] The contracts decided _latest_ have no fixtures

Missing entirely: `If-Match` request + 412 `version_conflict` body (with the `versionConflict`
payload an ifVersion retry loop needs — #48); `schema_drift` on `POST /types` (409 + `schemaDrift`
payload — #68); the #55 ID-validation 400s and duplicate-id-409 (only the duplicate exists);
`_config` protection over the wire (DELETE `_config` → 409, entityId change → 409 — #67);
401-vs-403 (#49's verified-but-ungranted distinction). The spec repeatedly says these mappings
"are pinned by the shared conformance fixtures"; today they aren't. Given principle 7 makes the
fixtures the enforcement point, this is the highest-leverage cheap work in this list.

### D3. [bug] The malformed-cursor fixture pins a message the codec doesn't produce

`error-bad-request-malformed-cursor` expects `'Invalid cursor: unknown sort field
"not-a-valid-cursor"'`, but `decodeCursor` never gets that far: `atob("not-a-valid-cursor")`
throws (invalid base64 characters) → the actual message is `Invalid cursor: malformed …`
(`cursor.ts:21-27`). Any consumer comparing bodies fails on a correct implementation.

---

## E. `entityId` invariant leaks (#69/#57's "owner never stamped, through any path")

### E1. [bug] `ScopedStack.putAttachment()` stamps `entityId` on owner uploads

`ScopedStack.create()` normalizes owner writes to no `entityId` (#69, `stack.ts:1957-1961`) — but
`ScopedStack.putAttachment()` bypasses it, calling `stack.create` directly with
`{ entityId: requester }` unconditionally (`stack.ts:2132-2146`). The owner uploading through
`asEntity(ownerEntityId)` gets an owner-authored record with `entityId` set — the exact
differently-shaped-record case #69 closed for `create()`. Same one-line normalization applies.

### E2. [bug] `ensureOwnerEntity()` reads one page — duplicate owner cards past 50 entities

The idempotency check queries `{ typeId: '_entity@1' }` with **no cursor walk**
(`stack.ts:450-461`) and scans the first (default-50) page for the owner's DID. A stack holding
more than ~50 `_entity` petname cards — an address book, not an edge case — eventually pages the
owner's card out of page one, and every subsequent `Stack.create(adapter, { ownerProfile })`
mints a duplicate owner card. Another instance of the #50 rule violated internally (the code
comment asserts the result set "stays small by design"; 50 contacts is small). Fix: cursor-walk
via `queryAllPages`, or query `content: { did }` when `contentFieldQuery` is available with the
in-memory fallback walked to exhaustion — the same pattern `checkAttachmentMimeTypeOnCreate`
already uses correctly. (The existing idempotency test only covers a one-page stack.)

---

## F. Smaller items, worth a decision each

- **F1. [note] `AttachmentAssociation.mimeType` is now a contradiction waiting to happen.**
  Post-#65, mimeType is a property of the fileId, established by `_attachment@1` records and
  validated on create; the _association's_ `mimeType` field is a second, per-reference claim
  that is never validated against the established one, isn't part of association identity
  (`associationEqual`, and the SQL PK, both ignore it — a re-associate with a different mimeType
  is silently dropped), and feeds nothing in the download path. Under the
  properties-vs-perspectives principle it's a property expressed as a perspective. Candidates:
  validate it against the established mimeType at `associate()` time, or deprecate it and drop it
  at the next consolidation bump (#57's in-place policy means it can simply stop being written
  now and be removed from the type at `@2`).
- **F2. [drift] Group first-admin stamping only happens on the `ScopedStack` path.**
  Spec §Group says unconditionally "the creator … is automatically stamped as its first admin";
  `stampGroupAdmin` runs only in `ScopedStack.create()` (`stack.ts:1953-1956`). An owner-created
  group via plain `Stack` has an empty roster — fine for management (owner is always a manager)
  but a `role: 'admin'` ACL entry pointing at such a group matches _no one_. Either stamp the
  owner's DID on the unscoped path too, or scope the spec sentence.
- **F3. [note] The #65 "conflicting mimeTypes can never coexist" invariant is race-prone.**
  `checkAttachmentMimeTypeOnCreate` is check-then-create with no storage-level uniqueness
  backstop; two concurrent first uploads of the same bytes with different mimeTypes can both
  pass. Download resolution then depends on createdAt ordering with millisecond ties broken
  arbitrarily. At personal scale this is unlikely; on a server it's reachable. Worth either an
  adapter-level guard (the #46 transaction idiom again) or a spec sentence acknowledging
  best-effort.
- **F4. [note] Grant `actions` are validated as bare strings.** `_grant@1`'s schema is
  `array of string`; a typo'd action (`'read_any'`) or malformed typeId is stored silently and
  simply never matches — a permission that looks granted but isn't. The schema language has no
  enum kind; cheapest fix is explicit validation in `grant()` against the `GrantAction` union.
- **F5. [note] Grants on system types are a foot-gun with no guardrail.** A `create` or
  `update-any` grant on `_grant@1` is self-service privilege escalation; a default (any-entity)
  grant on it doubly so. Only the owner can create grants, so this is owner-error territory —
  but `grant()` could cheaply refuse (or require an explicit override for) the `_grant` and
  `_config` families, matching the "privilege-bearing verbs stay owner-only" principle.
- **F6. [note] A cursor's embedded sort field isn't cross-checked against the query's.** A cursor
  minted under `sort: createdAt` replayed against `sort: version` produces an incoherent
  keyset/ORDER pairing (skips/duplicates) rather than a 400 (`query.ts:139-147`). One
  comparison away from being a `StackQueryError`.
- **F7. [note] `MemoryAdapter.createRecord()` silently overwrites an existing id** (and appends a
  duplicate `order` entry), diverging from the #55 "never a silent overwrite" contract the real
  adapters honor via PK. `Stack.create()` pre-checks, so only raw-adapter tests can hit it — but
  the SQL adapters' raw PK violation also surfaces as an unmapped engine error rather than
  `StackConflictError` (`isUniqueConstraintViolation` is only consulted in `saveVersion`).
  Both halves are one small mapping each.
- **F8. [bug] `DiskBlobAdapter.putAttachment()` writes non-atomically — and dedup makes a torn
  blob permanent.** A crash mid-`writeFile` leaves a partial file at its final content-addressed
  name; every future upload of the same bytes sees the file exists and **skips writing**
  (`blob-adapter-disk/src/index.ts:29-35`), so the corruption is never repaired and reads serve
  bytes that don't match their hash. The temp-file-and-rename idiom the spec already prescribes
  for `adapter-json` (§Concurrency) — and that #72 assumes for streaming — applies here today.

---

## What held up well (for balance)

The `#67`/`#68` invariant layering is exactly as specified — `_config` protection, drift-guard,
and ID legality live once in `Stack` and every adapter inherits them; the one specced exception
(query-shape exclusion pushed into adapter predicates) is implemented in all three query engines
including the test double. The #53 error taxonomy round-trips faithfully, including the
deliberate 412/409 split and the refusal to reconstruct from bare 500s. The #54/#68 two-relations
split is implemented with the exact `text`⇄`string` disagreement the spec calls out, both
depth-bounded and fail-closed. `sqlite-shared` genuinely eliminates the two-engine drift risk,
including the FTS5 external-content delete subtlety. #66's result-not-source forcing is a clean,
shared, pure function with the fixture matrix to hold it. And #69's null-content-filter
semantics are implemented consistently across SQL and memory adapters.

## Suggested order

1. **A2** (one-line, silent security no-op) and **E1** (one-line invariant leak) — land immediately.
2. **A1** — needs a design decision (upload-receipt vs. gate-with-carve-out); highest-stakes hole.
3. **A3 + E2** — same bug class (#50 violated internally); fix together with a shared helper.
4. **B1 + B2** — both are #61 follow-through; B2 decides whether snapshotting moves into the
   adapter transaction (the #46 keystone as originally scoped), and B1's always-snapshot change
   rides the same contract touch.
5. **D1–D3 + B3** — fixture regeneration and the two spec-list corrections; cheap, and they pin
   everything above once fixed.
6. **C1–C4, F1–F8** — as they're reached; none block the others.
