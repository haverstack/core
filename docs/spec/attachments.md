# Attachments

Binary files are stored and retrieved through the library using **content-addressed storage**. A file's ID is the SHA-256 hash of its bytes, so uploading identical bytes twice returns the same `fileId` without writing a second binary copy. Each upload creates a new `_attachment@1` metadata record regardless of deduplication, so metadata (mimeType, size, filename) is tracked per upload.

```ts
// Upload a file — stores the bytes and creates the _attachment@1 record,
// returning that record. content.fileId is a stable SHA-256 hex ID.
const record = await stack.putAttachment(data: Uint8Array, mimeType: string, filename?: string, appId?: AppId)
  : Promise<StackRecord & { content: AttachmentContent }>

// Fetch the binary
const data: Uint8Array = await stack.getAttachment(record.content.fileId)

// Every metadata record describing those bytes, earliest-recorded first
const meta = await stack.getAttachmentRecords(record.content.fileId)

// Delete the binary and its _attachment metadata record(s)
// Throws StackConflictError if any record still references the file
await stack.deleteAttachment(fileId)
```

## The `_attachment` record type

Attachment metadata is modeled as a Record of the built-in system type `_attachment`, separate from the binary content which is stored by the adapter.

```ts
type AttachmentContent = {
  fileId: string; // SHA-256 hex hash of the file bytes — content-addressed ID
  mimeType: string; // MIME type declared at upload e.g. "image/png"
  size: number; // File size in bytes
  filename?: string; // Original filename if provided at upload
};
```

An `_attachment@1` record is created on every `putAttachment()` call — even if the same bytes were previously uploaded. Multiple `_attachment@1` records may therefore exist for the same `fileId`, each with its own `filename`; the binary is stored only once.

The optional `appId` is stamped onto that record, so an upload is attributable to the software that made it like any other write — the alternative would leave attachments the one record kind that cannot carry attribution, even though `create()` has always taken it. Self-reported and never a permission input, as everywhere else (see [Identity § App](./identity.md#app)). On the wire it travels as a query param, since a binary request body has nowhere to put it (see [Wire format § Upload](./wire-format.md#upload)).

**`putAttachment()` returns the record it created**, matching what `POST /attachments` returns on the wire — the uploader's own metadata record is never something they have to go looking for. The `id` is the part that matters: `filename` is the only mutable field on an `_attachment@1` record, and setting it later needs an id. Without this, every caller wanting one would have to query by `fileId` and disambiguate among the several records a shared `fileId` can have.

**`mimeType` is a property of the `fileId`, not the uploader's perspective.** The first `_attachment` record created for a given `fileId` establishes its `mimeType`; this is the value later served as `Content-Type` when no override is given (see [Wire format § Attachments](./wire-format.md#attachments)). A later upload of the same bytes is free to declare a matching `mimeType` — it creates its own record with its own `filename` and `entityId`, same as always — but a **conflicting `mimeType` is rejected with `StackValidationError` (422)** rather than stored: a contradictory claim (one uploader's `image/png` against another's `text/html` for byte-identical content) should not survive in the data to confuse the next reader or a downstream cache. `filename` has no such rule — it stays per-uploader, and the requester's own record's `filename` is what's served to them on download.

**The rejection is best-effort; the resolution is not.** The check reads the existing records for the `fileId` and then writes, with no storage-level uniqueness constraint behind it, so two conflicting _first_ uploads racing on a concurrent server can both find nothing and both land. Unreachable in a single-process embedded Stack, reachable on a server. What that does **not** cost is determinism: "first-recorded" is a total order over the stored records — earliest `createdAt`, ties broken by the lower record `id` — so every reader resolving the served `Content-Type` picks the same record whether one conflicting record exists or two. Core applies the same order when deciding what a write conflicts with, so its rejection and a server's serving choice agree.

A lost race therefore leaves a contradiction in the data, not an exploitable one: the download path's [dangerous-type forcing](./wire-format.md#download) applies to whatever type wins, so a `text/html` claim that beats an `image/png` claim is still served as `application/octet-stream` with `Content-Disposition: attachment`. A server that can enforce single-writer semantics over `_attachment@1` creates-per-`fileId` (an atomic check-and-create in its storage layer, the shape `deleteUnreferencedAttachmentRecords()` takes for the delete race) MAY do so and close the gap; nothing in this spec depends on it having done so.

**Once created, an `_attachment@1` record's `fileId`, `size`, and `mimeType` are immutable — `filename` is the only field a content patch may change.** `fileId` and `size` describe the bytes themselves, so any attempted change is rejected (`StackValidationError`, 422). `mimeType` was already pinned to the `fileId`'s established type at create time, so a patch that touches it at all is rejected, including one that restates the same value. To correct a wrongly-declared type, delete the attachment and re-upload: identical bytes hash to the same `fileId`, and the fresh first record establishes the corrected type.

### Finding a `fileId`'s metadata records

To read metadata for a `fileId` uploaded by _someone else_ — a download's filename and mime type, say — use `Stack.getAttachmentRecords(fileId)`, which returns every record describing the file:

```ts
const records = await stack.getAttachmentRecords(fileId);
const meta = records[0]?.content; // the record that establishes the mimeType
```

**The candidate set is family-wide and includes soft-deleted and unlisted records.** Every record whose `baseId` is `_attachment` counts, not only `_attachment@1`: a record migrated to a later version of the family still describes the file, and uniqueness, immutability, and reference rules are all enforced across the family. Soft-deleted and unlisted records count too, for the reason they count as references — an unlisted record is hidden from enumeration, not from reach, and a soft-deleted one must find its attachments intact on `undelete()`.

The result is sorted in the [first-recorded total order](#the-_attachment-record-type), so `records[0]` is the record that establishes the `mimeType` and a caller composing with `firstRecordedAttachment()` never re-sorts. A caller narrowing the set first — the download route preferring the requester's own `filename`, for instance — passes what's left to `firstRecordedAttachment()` and gets the same rule applied to the narrower set.

**The lookup is unscoped, and lives on `Stack` rather than `StackClient` for that reason.** By the time a download reads this metadata, `ScopedStack.getAttachment()` has already granted or denied the bytes; what remains is presentation for a decision that is over. A requester who reached the bytes through a grant on a record referencing the file may not be able to read the `_attachment` record itself, so scoping the lookup would impose a second, different permission check and silently drop the filename and mime type they are entitled to. That is a wrong answer that looks like a narrower correct one, which is why the scoped form does not exist to be reached by autocomplete.

The distinction generalizes: a lookup answering a question the caller asks **on their own behalf** belongs on `StackClient` and stays scoped (`getEntityByDid()`); one answering a question **about a decision already made** stays on `Stack`.

### Naming the upload a reference came from

An `attachment` Association carries `{ label, fileId }` — and a `fileId` names **content**, not an upload. Two byte-identical uploads share one `fileId` and have one `_attachment` record each, so two records referencing "the same file" cannot say which upload each of them was given: the association shapes are identical, and `getAttachmentRecords(fileId)[0]` answers both with the earliest record's `filename`, which is the wrong one for all but the first.

An attachment Association may therefore carry an optional second pointer:

```ts
{ kind: 'attachment', label: 'embed', fileId, attachmentRecordId?: RecordId }
```

`attachmentRecordId` names the `_attachment` record whose upload established **this** reference. Set it at `associate()` time (or in a change set, or at `create()`) when the reference has an upload of its own; leave it off when the record is simply pointing at content someone already uploaded — the common case of many records sharing one image needs no per-reference name.

**Resolution order**, applied by `resolveReferencedAttachment()` (exported from `@haverstack/core/wire`) over the records `getAttachmentRecords()` returns:

1. The record `attachmentRecordId` names, if it is still among them.
2. The requester's own `_attachment` record, matched by `entityId`, [first-recorded](#the-_attachment-record-type) if they have several.
3. The first-recorded record overall.

A `GET /attachments/:fileId` download resolves only steps 2 and 3 — it names a `fileId`, with no reference to carry a pointer — so a client that holds the association resolves step 1 itself and passes the result as `?filename`, which overrides everything ([Wire format § Download](./wire-format.md#download)).

**Every step falls back rather than failing.** The pointer is checked when it is written — the named record must exist, be in the `_attachment` family, and carry the association's own `fileId` — but nothing keeps it true afterwards: the metadata record can be hard-deleted while the reference to its bytes stands. A pointer at a record that is gone resolves exactly as an absent one does. `restoreVersion()` is not a route to a stale pointer: associations — this pointer included — are never restored, for any record, so a restore cannot put one back (see [Versioning § Restore semantics](./versioning.md#restore-semantics)). The write-time check is also a single refusal for every way of failing, naming neither the record nor the reason: a check that distinguished "no such record" from "a record for other bytes" would confirm which record ids exist. A write that **succeeds** does confirm the record it names — there is no way to accept a pointer without it — but only to a caller who already holds file access for those bytes, which is what writing an attachment association requires of them in the first place ([Reference-creation gating](./access-control.md#reference-creation-gating)). What the single refusal keeps back is everything outside that: the ids of records this caller cannot reach, and the reason any particular one was refused.

**The pointer annotates a reference; it does not name one.** Association identity stays `(kind, label)` plus `fileId` ([Data model § Associations](./data-model.md#associations)), so `dissociate()` matches without it, and an `associate()` naming a different `attachmentRecordId` for an association the record already holds **re-points that association in place** rather than adding a second reference to the same file. Re-pointing is still a write, so the pointer it discarded is kept on that entry's [`repoint`](./journal.md#the-entry) — the only durable record of it, and what makes a re-point undoable rather than merely observable. A `dissociate()` is kept the same way, its `previous` carrying the pointer in full.

**The association written is the association stored**, so an `associate()` or change set that leaves `attachmentRecordId` off an association already carrying one **clears** it — the field is not merged forward, the same way a change set's association list replaces rather than merges. That is a write like any other re-point, not a no-op: a caller that re-states an association it holds, and means to keep the pointer, sends the pointer with it. Only an association restated in full — pointer included, or absent on both sides — is the no-op.

Keeping it outside identity is what leaves the rest of the model alone. [Garbage collection](#garbage-collection), `deleteAttachment()`'s reference check, the `attachmentFileId` filter and attachment access conveyance all ask a `fileId`-level question — "does any record reference this content" — and continue to ask exactly that. For the same reason a [`file-ref` content field](./data-model.md#types) carries no pointer: a field holding a fileId names content, and an app that needs a per-reference name uses an Association.

## `Stack` vs `ScopedStack` methods

- `Stack.putAttachment(data, mimeType, filename?, appId?)` — owner-level upload. Creates an `_attachment@1` record with no `entityId`. No grant check.
- `ScopedStack.putAttachment(data, mimeType, filename?, appId?)` — entity-scoped upload. Requires a `create` grant on `_attachment@1`. The created record's `entityId` is the subject, and `principalId` the authenticated principal when the two differ — stamped exactly as `ScopedStack.create()` does (see [Access control § Delegation](./access-control.md#delegation-principal-and-subject)).
- `Stack.getAttachment(fileId)` — no permission check; always succeeds if the bytes exist.
- `ScopedStack.getAttachment(fileId)` — accessible if the requester is the owner, can read any record that references the file, or uploaded the file themselves. Throws `StackPermissionError` otherwise. A referencing record that is [unlisted](./unlisted.md) counts exactly as a listed one does: unlisted governs enumeration, not reach, and the requester's ability to read the record is what the clause turns on.

**The uploader clause does not lapse.** You can always read your own upload: it holds while the file is unreferenced, after it is attached to a record, after every referencing record is purged, whether or not you can read the records that reference it, and whether or not your own `_attachment@1` record is [listed](./unlisted.md) — withholding a record from enumeration decides nothing about what it conveys. An uploader's reach is a fact about who hashed those bytes, not about what has since been built on top of them — making it blink off the moment an unrelated record references the file would take access away for a reason that has nothing to do with the uploader, and would put a reference query on the path of every file access check. It is a narrower clause than it sounds: it matches the requester's own `_attachment@1` records, which [`ScopedStack.create()` fences](#creating-_attachment1-records-directly) precisely so a `fileId` cannot be guessed into one, and it still requires a `read-own`/`read-any` grant on `_attachment@1` of the principal's own. It matters most where bytes deliberately outlive the records naming them — see [below](#a-purge-strands-the-bytes-it-referenced).

- `Stack.deleteAttachment(fileId)` — deletes bytes and every `_attachment` metadata record for the file, family-wide and including soft-deleted and unlisted ones. See [Deleting attachments](#deleting-attachments).
- `ScopedStack.deleteAttachment(fileId)` — owner only. Throws `StackPermissionError` for non-owners. Delegates to `Stack.deleteAttachment()`.

## Deleting attachments

`deleteAttachment(fileId)` throws `StackConflictError` if any record — **live or soft-deleted** — still references the file, either via an `attachment` Association or via a top-level `file-ref` content field (see [Types](./data-model.md#types)). A soft-deleted record is recoverable via `undelete()` and must find its attachments intact, so it counts as a reference exactly like a live one. Throws `StackNotFoundError` if the file doesn't exist.

**Atomicity of the reference check.** The reference check and the metadata-record deletes must happen as one unit — otherwise a concurrent `associate()` can add a new reference in the gap between them, leaving a dangling association after the delete completes. Adapters MAY implement `StackRecordAdapter.deleteUnreferencedAttachmentRecords(fileId, metadataTypeIds)` to close this race (`Stack.deleteAttachment()` uses it when present, falling back to a non-atomic check-then-act sequence otherwise). `metadataTypeIds` is the resolved `_attachment` family: core turns the `baseId` into concrete typeIds before the call, so an adapter never needs a family concept of its own — the same split `query()` makes for `filter.baseId`. Byte deletion always happens after the metadata step commits: a crash in between leaves orphaned bytes, which is harmless and later reclaimed by garbage collection, rather than a dangling reference, which is not.

## Creating `_attachment@1` records directly

`_attachment@1` records are access-conveying: `getAttachment()` and [reference-creation gating](./access-control.md#reference-creation-gating) both grant access to a `fileId` a requester merely names in a readable record. `putAttachment()` is safe to expose to non-owners because it never lets the caller name that `fileId` — it computes one from bytes it just hashed, so possession is proven by construction. Generic `create()` has no such proof: its `fileId` is a plain caller-supplied string. So `ScopedStack.create()` refuses to create an `_attachment@1` record for any non-owner requester — `StackPermissionError` — even with an otherwise-sufficient `create` grant on the type. Without this, a bare `create` grant on `_attachment@1` (held by every uploader, by design) would let a requester name an arbitrary guessed `fileId` and, via `getAttachment()`'s uploader clause, turn a correct guess into a read.

One carve-out: a non-owner who can already read some record referencing `fileId` may create an additional `_attachment@1` record for it (e.g. to record their own `filename`) without re-uploading bytes — this conveys no access they didn't already have. The carve-out is satisfied only by a readable referencing record, never by the requester's own prior `_attachment@1` record for the same `fileId` — allowing that would let one successful guess unlock unlimited further metadata records for the same guessed `fileId`.

The owner and unscoped `Stack` are unaffected — this applies to `ScopedStack.create()` only. The owner's exemption requires the owner [acting alone](./access-control.md#delegation-principal-and-subject): under delegation the refusal applies whichever side the owner is on, since the uploader clause that turns a guess into a read matches the subject a scoped create stamps, not the principal claiming the exemption. `ScopedStack.putAttachment()` is unaffected too: having already derived `fileId` from bytes it hashed itself, it creates its record directly, bypassing this gate rather than satisfying it.

**Anti-oracle.** The `mimeType`-conflict error (above) never names the established `mimeType` — doing so would confirm an existing `fileId`'s content type to a caller who only guessed the `fileId`, exactly the confirmation oracle the create refusal is designed to close.

## A purge strands the bytes it referenced

**A [hard delete](./versioning.md#deletion) never touches the blob store.** Not cascading is deliberate, and the same argument garbage collection rests on: a `fileId` is a content hash, one file backs any number of records, and byte lifetime must not depend on which record happened to be purged. Attachment deletion stays intentional.

But intentionality needs an argument to be intentional about. The purge removes the record's association rows and its `content_index` rows — the only pointers to those files — so after it lands, a caller who means to erase the bytes as well has no `fileId` to pass `deleteAttachment()`, and the only route left is the sweep that should not be making this decision. So the purge reports what it referenced:

```ts
const { referencedFileIds } = await stack.delete(recordId, { hard: true });
for (const fileId of referencedFileIds) await stack.deleteAttachment(fileId);
```

**The report is information, not action.** `referencedFileIds` names the purged record's attachment associations and its top-level `file-ref` content fields, deduplicated — the same reference definition `deleteAttachment()` and the sweep use, which is why an `_attachment` record's own `fileId` (a plain `string` by design) is not among them. Nothing is deleted by being named, nothing is orphaned by being reported — "orphaned" is a reference query, which a purge has no business running — and `deleteAttachment()` applies its usual refusal, so a file another record still references is refused there rather than silently kept here. A soft delete reports nothing: a tombstone is recoverable and must find its attachments intact, so its references stand.

**Until that second call, the bytes remain reachable** to anyone who can name the hash — the [uploader](#stack-vs-scopedstack-methods) in particular, whose access does not lapse. That is what makes the second step part of the erasure rather than tidying after it.

## Garbage collection

Attachment bytes are only ever removed by an explicit `deleteAttachment(fileId)` call — normal app flows delete _records_, and nothing notices when the last record referencing a file goes away. `collectAttachmentGarbage()` is an explicit, owner-invoked sweep that finds and removes those orphans. It is **not** automatic reference-counting: auto-delete on last dissociate/record-delete would couple every record write to blob lifecycle and would race without a transactional adapter.

```ts
stack.collectAttachmentGarbage(opts?: {
  graceMs?: number; // default: 24 hours
  dryRun?: boolean; // default: false
}): Promise<{ deleted: string[]; reclaimedBytes: number }>
```

**What counts as garbage:** a file is collectable only when _no_ record — live or soft-deleted — references it via an `attachment` Association or a `file-ref` content field. This is the same reference definition `deleteAttachment()` uses, and the same recoverability principle: nothing reachable from a soft-deleted (undelete-able) state gets destroyed.

**Version history is not a reference.** A `file-ref` field sitting in a snapshot does not hold bytes alive, for either the sweep or `deleteAttachment()`: counting it would make a file undeletable for the lifetime of any snapshot that ever mentioned it, which is exactly the intentional delete this model exists to keep possible. The consequence is that [`restoreVersion()`](./versioning.md#restore-semantics) can put back a `file-ref` naming bytes that have since been deleted — a **dangling file reference**, and the one kind of dangle a restore can produce: history is put back, not re-litigated against what is true now. (A [dangling parent](./data-model.md#reparenting) comes from a container being deleted out from under its children, never from a restore, which settles no containment at all.) Consumers handle one the way they handle any `fileId` that resolves to nothing, and `getAttachment()` answers `StackNotFoundError`.

**`_attachment` metadata records never themselves count as references** — otherwise nothing would ever be garbage — but a file's _newest_ metadata record — family-wide, as everywhere else — (or, for bare bytes with no metadata record at all, the blob's own storage timestamp) must be older than `graceMs` to be collected. This protects the legitimate upload-then-associate window: a file just uploaded and not yet attached to anything is not yet garbage, just new.

**Bare-bytes orphans** — bytes with no `_attachment@1` record at all (a `putAttachment()` that stored bytes on a non-atomic adapter but crashed before writing metadata) — are only discoverable by enumerating the blob store directly, via the optional `StackBlobAdapter.listFiles()` capability (see [Adapters](./adapters.md)). An adapter that doesn't implement it still gets full protection for the common case (metadata-tracked files with no remaining reference); it simply can't find this rarer orphan class.

Deletion goes through `deleteAttachment()` itself, so its usual conflict check runs once more per file at delete time. A file that turns out to be referenced again (or already gone) by then is skipped, not treated as a sweep failure — the sweep always completes and reports what it actually collected.

`dryRun: true` computes and returns what _would_ be deleted, without deleting anything — useful for previewing a sweep.

**`Stack` vs `ScopedStack`:**

- `Stack.collectAttachmentGarbage(opts?)` — owner-level, no permission check.
- `ScopedStack.collectAttachmentGarbage(opts?)` — owner only. Throws `StackPermissionError` for non-owners (including anonymous requesters). Delegates to `Stack.collectAttachmentGarbage()`.
