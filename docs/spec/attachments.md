# Attachments

Binary files are stored and retrieved through the library using **content-addressed storage**. A file's ID is the SHA-256 hash of its bytes, so uploading identical bytes twice returns the same `fileId` without writing a second binary copy. Each upload creates a new `_attachment@1` metadata record regardless of deduplication, so metadata (mimeType, size, filename) is tracked per upload.

```ts
// Upload a file — stores the bytes and creates the _attachment@1 record,
// returning that record. content.fileId is a stable SHA-256 hex ID.
const record = await stack.putAttachment(data: Uint8Array, mimeType: string, filename?: string, appId?: AppId)
  : Promise<StackRecord & { content: AttachmentContent }>

// Fetch the binary
const data: Uint8Array = await stack.getAttachment(record.content.fileId)

// Delete the binary and its _attachment@1 metadata record(s)
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

To read metadata for a `fileId` uploaded by _someone else_, query `_attachment@1` records — note that a `fileId` may have several, one per upload:

```ts
const results = await stack.query({
  filter: {
    typeId: '_attachment@1',
    content: { fileId },
  },
  limit: 1,
});
const meta = results.records[0]?.content as AttachmentContent | undefined;
```

**`mimeType` is a property of the `fileId`, not the uploader's perspective.** The first `_attachment@1` record created for a given `fileId` establishes its `mimeType`; this is the value later served as `Content-Type` when no override is given (see [Wire format § Attachments](./wire-format.md#attachments)). A later upload of the same bytes is free to declare a matching `mimeType` — it creates its own record with its own `filename` and `entityId`, same as always — but a **conflicting `mimeType` is rejected with `StackValidationError` (422)** rather than stored: a contradictory claim (one uploader's `image/png` against another's `text/html` for byte-identical content) should not survive in the data to confuse the next reader or a downstream cache. `filename` has no such rule — it stays per-uploader, and the requester's own record's `filename` is what's served to them on download.

**The rejection is best-effort; the resolution is not.** The check reads the existing records for the `fileId` and then writes, with no storage-level uniqueness constraint behind it, so two conflicting _first_ uploads racing on a concurrent server can both find nothing and both land. Unreachable in a single-process embedded Stack, reachable on a server. What that does **not** cost is determinism: "first-recorded" is a total order over the stored records — earliest `createdAt`, ties broken by the lower record `id` — so every reader resolving the served `Content-Type` picks the same record whether one conflicting record exists or two. Core applies the same order when deciding what a write conflicts with, so its rejection and a server's serving choice agree.

A lost race therefore leaves a contradiction in the data, not an exploitable one: the download path's [dangerous-type forcing](./wire-format.md#download) applies to whatever type wins, so a `text/html` claim that beats an `image/png` claim is still served as `application/octet-stream` with `Content-Disposition: attachment`. A server that can enforce single-writer semantics over `_attachment@1` creates-per-`fileId` (an atomic check-and-create in its storage layer, the shape `deleteUnreferencedAttachmentRecords()` takes for the delete race) MAY do so and close the gap; nothing in this spec depends on it having done so.

**Once created, an `_attachment@1` record's `fileId`, `size`, and `mimeType` are immutable — `filename` is the only field `update()` may change.** `fileId` and `size` describe the bytes themselves, so any attempted change is rejected (`StackValidationError`, 422). `mimeType` was already pinned to the `fileId`'s established type at create time, so `update()` rejects any patch that touches it at all, including one that restates the same value. To correct a wrongly-declared type, delete the attachment and re-upload: identical bytes hash to the same `fileId`, and the fresh first record establishes the corrected type.

## `Stack` vs `ScopedStack` methods

- `Stack.putAttachment(data, mimeType, filename?, appId?)` — owner-level upload. Creates an `_attachment@1` record with no `entityId`. No grant check.
- `ScopedStack.putAttachment(data, mimeType, filename?, appId?)` — entity-scoped upload. Requires a `create` grant on `_attachment@1`. The created record's `entityId` is the subject, and `principalId` the authenticated principal when the two differ — stamped exactly as `ScopedStack.create()` does (see [Access control § Delegation](./access-control.md#delegation-principal-and-subject)).
- `Stack.getAttachment(fileId)` — no permission check; always succeeds if the bytes exist.
- `ScopedStack.getAttachment(fileId)` — accessible if the requester is the owner, can read any record that references the file, or uploaded the file themselves and it hasn't been associated with a record yet. Throws `StackPermissionError` otherwise. A referencing record that is [unlisted](./unlisted.md) counts exactly as a listed one does: unlisted governs enumeration, not reach, and the requester's ability to read the record is what the clause turns on.
- `Stack.deleteAttachment(fileId)` — deletes bytes and all `_attachment@1` metadata records for the file (including soft-deleted ones). See [Deleting attachments](#deleting-attachments).
- `ScopedStack.deleteAttachment(fileId)` — owner only. Throws `StackPermissionError` for non-owners. Delegates to `Stack.deleteAttachment()`.

## Deleting attachments

`deleteAttachment(fileId)` throws `StackConflictError` if any record — **live or soft-deleted** — still references the file, either via an `attachment` Association or via a top-level `file-ref` content field (see [Types](./data-model.md#types)). A soft-deleted record is recoverable via `undelete()` and must find its attachments intact, so it counts as a reference exactly like a live one. Throws `StackNotFoundError` if the file doesn't exist.

**Atomicity of the reference check.** The reference check and the metadata-record deletes must happen as one unit — otherwise a concurrent `associate()` can add a new reference in the gap between them, leaving a dangling association after the delete completes. Adapters MAY implement `StackRecordAdapter.deleteUnreferencedAttachmentRecords(fileId, metadataTypeId)` to close this race (`Stack.deleteAttachment()` uses it when present, falling back to a non-atomic check-then-act sequence otherwise). Byte deletion always happens after the metadata step commits: a crash in between leaves orphaned bytes, which is harmless and later reclaimed by garbage collection, rather than a dangling reference, which is not.

## Creating `_attachment@1` records directly

`_attachment@1` records are access-conveying: `getAttachment()` and [reference-creation gating](./access-control.md#reference-creation-gating) both grant access to a `fileId` a requester merely names in a readable record. `putAttachment()` is safe to expose to non-owners because it never lets the caller name that `fileId` — it computes one from bytes it just hashed, so possession is proven by construction. Generic `create()` has no such proof: its `fileId` is a plain caller-supplied string. So `ScopedStack.create()` refuses to create an `_attachment@1` record for any non-owner requester — `StackPermissionError` — even with an otherwise-sufficient `create` grant on the type. Without this, a bare `create` grant on `_attachment@1` (held by every uploader, by design) would let a requester name an arbitrary guessed `fileId` and, via `getAttachment()`'s uploader clause, turn a correct guess into a read.

One carve-out: a non-owner who can already read some record referencing `fileId` may create an additional `_attachment@1` record for it (e.g. to record their own `filename`) without re-uploading bytes — this conveys no access they didn't already have. The carve-out is satisfied only by a readable referencing record, never by the requester's own prior `_attachment@1` record for the same `fileId` — allowing that would let one successful guess unlock unlimited further metadata records for the same guessed `fileId`.

The owner and unscoped `Stack` are unaffected — this applies to `ScopedStack.create()` only. The owner's exemption requires the owner [acting alone](./access-control.md#delegation-principal-and-subject): under delegation the refusal applies whichever side the owner is on, since the uploader clause that turns a guess into a read matches the subject a scoped create stamps, not the principal claiming the exemption. `ScopedStack.putAttachment()` is unaffected too: having already derived `fileId` from bytes it hashed itself, it creates its record directly, bypassing this gate rather than satisfying it.

**Anti-oracle.** The `mimeType`-conflict error (above) never names the established `mimeType` — doing so would confirm an existing `fileId`'s content type to a caller who only guessed the `fileId`, exactly the confirmation oracle the create refusal is designed to close.

## Garbage collection

Attachment bytes are only ever removed by an explicit `deleteAttachment(fileId)` call — normal app flows delete _records_, and nothing notices when the last record referencing a file goes away. `collectAttachmentGarbage()` is an explicit, owner-invoked sweep that finds and removes those orphans. It is **not** automatic reference-counting: auto-delete on last dissociate/record-delete would couple every record write to blob lifecycle and would race without a transactional adapter.

```ts
stack.collectAttachmentGarbage(opts?: {
  graceMs?: number; // default: 24 hours
  dryRun?: boolean; // default: false
}): Promise<{ deleted: string[]; reclaimedBytes: number }>
```

**What counts as garbage:** a file is collectable only when _no_ record — live or soft-deleted — references it via an `attachment` Association or a `file-ref` content field. This is the same reference definition `deleteAttachment()` uses, and the same recoverability principle: nothing reachable from a soft-deleted (undelete-able) state gets destroyed.

**`_attachment@1` metadata records never themselves count as references** — otherwise nothing would ever be garbage — but a file's _newest_ metadata record (or, for bare bytes with no metadata record at all, the blob's own storage timestamp) must be older than `graceMs` to be collected. This protects the legitimate upload-then-associate window: a file just uploaded and not yet attached to anything is not yet garbage, just new.

**Bare-bytes orphans** — bytes with no `_attachment@1` record at all (a `putAttachment()` that stored bytes on a non-atomic adapter but crashed before writing metadata) — are only discoverable by enumerating the blob store directly, via the optional `StackBlobAdapter.listFiles()` capability (see [Adapters](./adapters.md)). An adapter that doesn't implement it still gets full protection for the common case (metadata-tracked files with no remaining reference); it simply can't find this rarer orphan class.

Deletion goes through `deleteAttachment()` itself, so its usual conflict check runs once more per file at delete time. A file that turns out to be referenced again (or already gone) by then is skipped, not treated as a sweep failure — the sweep always completes and reports what it actually collected.

`dryRun: true` computes and returns what _would_ be deleted, without deleting anything — useful for previewing a sweep.

**`Stack` vs `ScopedStack`:**

- `Stack.collectAttachmentGarbage(opts?)` — owner-level, no permission check.
- `ScopedStack.collectAttachmentGarbage(opts?)` — owner only. Throws `StackPermissionError` for non-owners (including anonymous requesters). Delegates to `Stack.collectAttachmentGarbage()`.
