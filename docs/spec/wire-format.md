# API Wire Format

The API adapter speaks REST over HTTP with JSON bodies and standard status codes. It is the only adapter where permissions are enforced and app identity can be validated.

## Discovery

A client hits this endpoint first to understand the server's identity and capabilities. The response supplies `entityId` and `timezone`, which the `APIAdapter` caches as `ownerEntityId` and `timezone` properties for the session.

```
GET /.well-known/stack
```

```json
{
  "version": "1.0",
  "entityId": "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
  "timezone": "America/New_York",
  "capabilities": {
    "fullTextSearch": true,
    "contentFieldQuery": true,
    "sortableFields": ["createdAt", "updatedAt", "version"],
    "maxAttachmentBytes": 52428800
  }
}
```

### Version negotiation

`version` is the wire protocol's own version, `MAJOR.MINOR`, and it is required — not the server's software version, which is the server's business and appears nowhere in this spec.

**A client refuses a server whose major differs from its own**, at `open()`, before any other request. A major bump is defined as a change that would make a client of an earlier major read a response wrongly — a field whose meaning changed, a shape that no longer parses the same way. There is no way to use such a server safely, and discovering it mid-session is worse than refusing: the caller is left unsure which writes landed.

**A minor difference is never a refusal, in either direction.** A higher server minor is additive fields an older client ignores; a higher client minor is optional fields the server may omit. Neither can make a response read wrongly — that is what makes them minor.

A response with no `version`, or one that isn't `MAJOR.MINOR`, is refused the same way a major mismatch is. The field is mandatory here, so its absence is a server that isn't implementing this spec, and guessing on its behalf would defeat the check.

`@haverstack/wire-types` exports the current `WIRE_PROTOCOL_VERSION` along with `parseProtocolVersion()` and `isProtocolCompatible()`, so a server implementation applies the same rule as `adapter-api` rather than reimplementing it.

### Identity is trusted on transport

`entityId` in the response above is an **unsigned JSON field**, and nothing here challenges the server to prove it holds any binding to that DID. Structurally it cannot: the server deliberately never holds the owner's key (see [Identity](./identity.md)). So a client's belief about _whose stack it is talking to_ rests on TLS and the URL it was given — not on a signature, unlike every other claim in this system. A hostile or misdirected server can present itself as anyone's stack, and a client that writes private data to it has no cryptographic recourse.

This is inherent to the hosted topology rather than an omission, and it is stated here because the rest of the spec is otherwise scrupulous about naming exactly this kind of asymmetry. Proving a server↔owner binding is deferred alongside [key rotation](./identity.md#deferred-key-rotation): both need an identity that outlives a single key, and neither is foreclosed by anything above.

**A client that already knows which DID it expects can say so.** One following a Group's `stackUrl`, or reconnecting to a stack it has used before, holds that expectation and today has no way to state it. `APIAdapter`'s `expectedOwner` option compares it against discovery's `entityId` and fails `open()` with `APIAdapterOwnerMismatchError` on any difference — including a discovery response carrying no `entityId` at all, which is not a match. The comparison is exact string equality; no DID method is normalized, since core resolves none of them.

Two limits, so the option is not read as more than it is. It narrows misdirection to a server that already knows which DID it should be claiming — it does not make discovery identity a proof, and no client-side check can. And it runs on a response that has already been fetched, so a static `token`, if one was configured, reached that server before the check could refuse it: `expectedOwner` guards what a client goes on to _write_, not what it already sent to a URL it chose to contact.

## Authentication

Bearer token in the `Authorization` header. Token issuance itself is out of scope for this spec — that is the server's concern — but _how a token is earned_ has a shape worth stating: see [Authentication: challenge–response](./identity.md#authentication-challengeresponse) for the nonce/signature handshake a server implements before calling `createToken()`. The adapter sends the token if configured; the server returns `401` if missing or invalid, `403` if the requester verified but lacks a grant (see [Error responses](#error-responses)).

```
Authorization: Bearer <token>
```

(As a non-normative example, `@haverstack/core` defines a `StackTokenStore` contract — `createToken` / `lookupToken` / `listTokens` / `revokeToken` — and `record-adapter-sqlite` ships `NativeTokenStore`, a hashed-token reference implementation in its own file, separate from the records database, for servers that want DB-backed bearer tokens without rolling their own storage. This is optional tooling, not part of the wire protocol. Its `entityId` values are DIDs, same as everywhere else — see [Identity](./identity.md).)

## Error responses

| Status  | Meaning                  | When                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **400** | Bad request              | `StackQueryError` (code `bad_request`) where the library can identify the malformed input itself — e.g. an undecodable pagination cursor; otherwise a lower-level parse failure (missing required field, invalid JSON) with no core-taxonomy equivalent                                                                                                                                                                                    |
| **401** | Unauthorized             | Missing or invalid bearer token — no verified DID behind the request at all ("who are you?")                                                                                                                                                                                                                                                                                                                                               |
| **403** | Forbidden                | `StackPermissionError` — the requester's DID verified but they lack access ("your claim is genuine; no") — record exists but permissions/grants don't cover them                                                                                                                                                                                                                                                                           |
| **404** | Not found                | `StackNotFoundError` — record or version does not exist                                                                                                                                                                                                                                                                                                                                                                                    |
| **409** | Conflict                 | `StackConflictError` — operation blocked by a constraint violation (e.g. deleting a still-referenced attachment, a duplicate client-supplied `id`, deleting `_config` or changing its `entityId`); or `StackSchemaDriftError` (code `schema_drift`) — `POST /types` redefining an existing `id` with a non-additive schema change                                                                                                          |
| **412** | Precondition failed      | `StackVersionConflictError` (code `version_conflict`) — an `If-Match` precondition doesn't match the record's current version. A distinct error type and status from `StackConflictError`/409 — the two have different recovery stories                                                                                                                                                                                                    |
| **413** | Request entity too large | `StackPayloadTooLargeError` (code `payload_too_large`) — attachment upload exceeds the server's size limit. Unambiguous status (no other code shares 413), so status-only reconstruction recovers this class even without a parseable body. `putAttachment()` also pre-checks the declared `maxAttachmentBytes` ceiling client-side and throws the same class before sending, so this status is a backstop, not the only enforcement point |
| **422** | Unprocessable entity     | `StackValidationError` — request is syntactically valid but content fails schema validation (e.g. a required field has the wrong type)                                                                                                                                                                                                                                                                                                     |
| **500** | Internal server error    | Reserved for `StackMigrationError` (code `migration`) — migration-graph corruption. No current code path produces this over the wire; the mapping exists for forward compatibility only. **Not** used as a generic catch-all: an unrelated server crash is a plain 500 with no wire error body, and clients must not infer `StackMigrationError` from status 500 alone (see below)                                                         |

The distinction between **400** and **422** matters for write endpoints (`POST /records`, `PATCH /records/:id`, `POST /records/:id/migrate`, `POST /types`): a 400 means the request couldn't be parsed at all; a 422 means the server understood the request but the content didn't satisfy the type schema.

### The taxonomy root

Every class in the table above extends the abstract `StackError`, so `err instanceof StackError` answers the one question a server's error middleware asks first: is this a Stack-domain failure with a wire representation, or an ordinary bug that should surface as a bare 500? Membership is exactly that guarantee — a `StackError` always has a `code`, and every code has a status. Errors with no wire mapping (`IdGenerationError`, `InvalidDidError`) stay outside the hierarchy for that reason.

The root adds no other structure. `StackVersionConflictError` remains a sibling of `StackConflictError` rather than a subtype (see the 409/412 rows above), and no other pair is related either, so catching a leaf class never catches a different failure by accident.

### Wire error body

Every non-2xx response whose failure maps to the core error taxonomy carries a JSON body of the shape:

```json
{
  "error": {
    "code": "permission" | "not_found" | "conflict" | "version_conflict" | "validation" | "migration" | "bad_request" | "schema_drift" | "payload_too_large",
    "message": "human-readable description",
    "details": [ { "path": "title", "message": "expected string, got number" } ],
    "versionConflict": { "recordId": "rec-abc123", "expectedVersion": 5, "actualVersion": 7 },
    "schemaDrift": { "typeId": "com.example.myapp/note@1", "violations": [ { "path": "title", "message": "field removed" } ] }
  }
}
```

Each error code that carries extra structured data gets its own uniquely-named, uniquely-typed field, present only for that code — `details` for `code: "validation"` (`StackValidationError.errors`), `versionConflict` for `code: "version_conflict"` (the data an `ifVersion` retry loop needs: which record, what it expected, what actually won the race), `schemaDrift` for `code: "schema_drift"` (which Type, and which specific fields made the change non-additive). This keeps each field's shape fixed rather than making any one field polymorphic across codes.

`code` is the authoritative discriminator — HTTP status is a transport hint (proxies and intermediaries rewrite statuses more often than bodies). Each core error class exposes the mapping both as a static (`StackPermissionError.code === 'permission'`) and on every instance (`err.code`), so serializing a caught error is a status lookup on the instance rather than a hand-maintained chain of class tests, and `APIAdapter` reconstructs the same class from the response. The vocabulary itself is `StackErrorCode` in `@haverstack/core` — it lives with the classes that carry it, and `@haverstack/wire-types` re-exports it as `WireErrorCode`.

Note that an instance `code` discriminates but doesn't narrow: TypeScript won't refine a `StackError` to a subclass from a literal `code` check, so reaching the payload fields (`errors`, `versionConflict` state, `violations`) still means an `instanceof` on the three classes that define them. Those three are leaves with no subtype relation, so unlike a full class ladder the checks are order-independent.

When a response has no parseable wire error body (a foreign server implementation, or a proxy that strips bodies but preserves status), `APIAdapter` still recovers the precise error from status alone for the unambiguous statuses (400/403/404/412/413/422) — **not** for 500, since that status is a generic "unhandled server exception" signal and would misclassify ordinary server bugs as `StackMigrationError`. `schema_drift` is the one deliberate exception to one-code-per-status: it shares **409** with `conflict` (both are "operation conflicts with a constraint" in HTTP terms), so status-only reconstruction of a bodyless 409 degrades to the generic `StackConflictError` — the precise class is only recoverable with a parseable body. When neither the body nor the status yields a typed error, `APIAdapter` throws its own generic `APIAdapterError`.

This mapping is pinned by the shared conformance fixtures (`@haverstack/conformance-fixtures`) so `APIAdapter` and any server implementation can't drift on it independently.

## Records

```
GET    /records              — query by native fields (see query params below)
POST   /records/query        — query including content field filters (JSON body)
POST   /records              — create
GET    /records/:id          — get one
PATCH  /records/:id          — update content only (partial merge, null = delete field)
DELETE /records/:id          — soft delete
DELETE /records/:id?hard=true — hard delete
POST   /records/:id/undelete — undelete (reverse a soft delete; idempotent)
POST   /records/:id/migrate  — commit a migration (change typeId + content together)
```

**`GET /records` query params:**

```
?typeId=
?parentId=           (use "null" for root records)
?appId=
?entityId=
?principalId=
?createdBefore=
?createdAfter=
?updatedBefore=
?updatedAfter=
?tag=                (repeatable: ?tag=starred&tag=important)
?hasAttachment=
?attachmentFileId=
?relatedTo=
?relatedToLabel=   (only meaningful alongside ?relatedTo; narrows to that label)
?search=
?sort=createdAt|updatedAt|version
?direction=asc|desc
?limit=
?cursor=
?includeDeleted=
```

`GET /records` covers all native field queries and is usable from a browser or simple HTTP client without a JSON body. `POST /records/query` is a superset — it accepts the full `Query` object as a JSON body and additionally supports `content` field filtering. A server that declares `contentFieldQuery: false` in discovery does not support the POST query endpoint.

**Filters gated by a capability fail loudly, not silently.** A `content` filter has no representation in `GET /records`' query params, and `search` behaves however the server does with an unsupported param — so `APIAdapter` checks `capabilities.contentFieldQuery`/`capabilities.fullTextSearch` before dispatching and throws `APIAdapterCapabilityError` locally, without sending a request, when the corresponding filter is used against a server that hasn't declared the capability. The alternative — degrading to an unfiltered or partially filtered result presented as the requested query — is worse than an error for anything that trusts the filter (dedup checks, existence checks, selection-sensitive logic).

`PATCH /records/:id` accepts a partial content object. Omitted fields retain their current values. A field set to `null` is removed (RFC 7396 / JSON Merge Patch). Associations and permissions are managed via their own endpoints.

**Optimistic concurrency:** `PATCH`, `DELETE`, `POST .../undelete`, `POST .../restore/:version`, and the association/permission endpoints below all accept an optional `If-Match` header:

```
PATCH /records/abc123
If-Match: "5"
```

When present, the server applies the mutation only if the record's current version equals the header's value; otherwise it returns **412** with a `version_conflict` wire error and changes nothing. Omit the header to keep unconditional last-writer-wins behavior. See [Versioning & deletion](./versioning.md#optimistic-concurrency-ifversion) for the corresponding `ifVersion` API.

`POST /records` accepts a full record body, including an optional client-supplied `id` — see [Record IDs](./data-model.md#record-ids) for the validation and duplicate-conflict rules the server applies.

**`entityId` and `principalId` are assigned by the server from the authenticated session, and MUST be ignored if a request body carries them.** They are the two fields that answer "who did this", so a server that echoes back what it was handed makes both self-reported — and `principalId` exists precisely to be the field that isn't (see [Identity § Attribution and what can be trusted](./identity.md#attribution-and-what-can-be-trusted)). A client naming its own `principalId` could dress any write up as a verified app action, defeating the `_app` cross-check that reads it. `ScopedStack` already overrides both regardless of what a caller passes, so a server built on it inherits this; one that maps a request body onto `Stack` directly has to drop them itself. The same applies to `version`, `createdAt`, and `updatedAt`, which the server assigns as it does on any write. `appId` is the deliberate exception — self-reported by design, and never a permission input. For `typeId: "_attachment@1"`, a non-owner requester gets `403` regardless of grants — see [Attachments](./attachments.md#creating-_attachment1-records-directly) for the refusal, its carve-out, and `POST /attachments` as the non-owner-safe combined path.

`POST /records/:id/migrate` is the only way a record's `typeId` changes after creation. Body: `{ "toTypeId": "...", "content": {...} }` — the full post-migration content, computed client-side by the type's owning app (migration functions are app code, not server code) and validated by the server against `toTypeId`'s schema before writing. This is what `stack.update()` uses to commit a pending lazy migration alongside a content patch (a content-only `PATCH` can't carry a `typeId` change), and what `stack.migrateAll()` uses for each record in a batch pass.

**Response envelope for queries:**

```json
{
  "records": [...],
  "cursor": "opaque-string-or-null",
  "total": 142
}
```

## Permissions

```
GET  /records/:id/permissions        — get current permissions
PUT  /records/:id/permissions        — replace all permissions (empty array = private)
```

Both endpoints use the envelope `{ "permissions": [...] }` as the request/response body. `PUT` accepts the same optional `If-Match` precondition described under [Records](#records).

## Versions

**The server snapshots prior state automatically on every mutating endpoint that bumps `version`** — there is no client-initiated endpoint to write a version directly. The list is exhaustive on purpose: `PATCH /records/:id`, the association endpoints, `PUT .../permissions`, `DELETE` (soft), `POST .../undelete`, `POST .../migrate`, and `POST .../restore/:version` itself (restore always creates a new version). `saveVersion()` is a deliberate no-op over `APIAdapter` — the server is the only snapshot writer for this adapter — so a server that implements anything less than every endpoint above silently loses rollback history for that endpoint's mutations.

```
GET  /records/:id/versions            — list all versions (newest first)
GET  /records/:id/versions/:version   — get a specific version
POST /records/:id/restore/:version    — restore a version (creates new version, no rewrite)
```

Both `GET` endpoints require the requester to hold the same mutate-surface authorization as a write to the record (write access, or owner/creator, or a Group's admin) — **not** plain read access; a read-only requester gets `403`. Snapshot `permissions` are additionally omitted from the response body for any non-owner requester, including a write-holder who passes the gate. See [Versioning & deletion](./versioning.md#history-access) for the rationale.

`POST .../restore/:version` accepts the same optional `If-Match` precondition described under [Records](#records).

## Associations

Associations are always in the context of a Record:

```
GET    /records/:id/associations               — all associations
GET    /records/:id/associations?kind=tag
GET    /records/:id/associations?kind=attachment
GET    /records/:id/associations?kind=relationship
GET    /records/:id/associations?label=avatar  — filter by label across all kinds
POST   /records/:id/associations               — add an association
POST   /records/:id/associations/delete        — remove an association (by body)
```

Removing an association is a `POST` to a `/delete` sub-path, not a `DELETE` with a body — `DELETE` request bodies have no defined semantics (RFC 9110 §9.3.5), and this protocol is meant to be implemented behind arbitrary proxies, gateways, and localhost setups that may drop or reject them. The discriminant (which association to remove) travels as a JSON body either way, so the endpoint is a `POST` like every other body-carrying mutation.

Both endpoints accept the same optional `If-Match` precondition described under [Records](#records).

Response shape is consistent regardless of kind:

```json
{
  "associations": [
    { "kind": "tag", "label": "starred" },
    { "kind": "attachment", "label": "avatar", "fileId": "abc123" },
    { "kind": "relationship", "label": "reply-to", "recordId": "xyz789" }
  ]
}
```

## Types

```
GET  /types        — list all types known to this stack
GET  /types/:id    — get one type definition (id is URL-encoded)
POST /types        — register a type, or evolve an existing one in place
```

`POST /types` on an `id` that already has a stored Type runs the same [schema drift check](./data-model.md#schema-drift-detection) as `Stack.defineType()` — the server-side storage layer never blindly overwrites a Type definition; legality is decided once, in the same invariant layer both the local and wire paths share.

## Attachments

```
POST   /attachments           — store raw file bytes and create the _attachment@1 record, returns the record
GET    /attachments/:fileId   — download a file
DELETE /attachments/:fileId   — delete a file
```

Attachments are uploaded first, then referenced in an Association when creating or updating a Record. This keeps all other Record endpoints JSON-only — `POST /attachments` is the one endpoint that also accepts a binary body.

File IDs are SHA-256 hashes of the content. Uploading identical bytes twice returns the same `fileId` without writing a second copy.

### Upload

Send the raw binary as the request body, with `Content-Type` set to the MIME type and, optionally, `Content-Disposition` carrying a filename. The server stores the bytes and creates the `_attachment@1` record in the same request — implemented as `scopedStack.putAttachment(bytes, mimeType, filename, appId)`. `Content-Type` defaults to `application/octet-stream` if omitted.

An optional `?appId=` query param carries the writing app's reverse-DNS identifier onto the created record, since a binary body has nowhere to put the field that `POST /records` takes inline. Self-reported like every other `appId`.

```
POST /attachments?appId=com.example.myapp
Authorization: Bearer <token>
Content-Type: image/png
Content-Disposition: attachment; filename*=UTF-8''photo.png

<binary data>
```

Response: the created `_attachment@1` record (`200`), not just `{ fileId }` — same shape as `POST /records`.

This is not an efficiency shortcut — it's the security boundary itself. The record's `fileId` must be established from bytes the server actually received in _this_ request, with no seam where a caller-supplied string could stand in for them. That's why generic `POST /records` for `_attachment@1` is not available to non-owners at all (see [Attachments](./attachments.md#creating-_attachment1-records-directly)): a separate two-step "upload bytes, then claim a fileId in a record" is indistinguishable, server-side, from an attacker who never uploaded anything and only guessed the fileId.

`POST /attachments` requires the same authorization as creating an `_attachment@1` record: `401` for anonymous/missing tokens, `403` if the requester lacks a `create` grant on `_attachment@1`.

Returns `413 Request Entity Too Large` (code `payload_too_large`, reconstructed client-side as `StackPayloadTooLargeError`) if the payload exceeds the server's configured limit (default 50 MB, controlled by `MAX_ATTACHMENT_BYTES`). The same limit is exposed ahead of time as `maxAttachmentBytes` in [discovery](#discovery); `putAttachment()` pre-checks it client-side and throws `StackPayloadTooLargeError` before sending, so apps normally see the failure without burning the upload — this endpoint's 413 is the authoritative backstop.

**SDK usage.** `Stack.putAttachment()`, when backed by `APIAdapter`, calls this endpoint directly — one request, carrying the real `mimeType`/`filename` — via the optional [`putAttachmentWithMetadata()`](./adapters.md#interface-split) capability. Local storage adapters don't implement that capability — bytes and records are different backends there, with no shared transaction — so `Stack.putAttachment()` falls back to its own `create()` call.

Either way the caller gets the created `_attachment@1` record back, the same thing this endpoint returns — the atomic path passes the server's response through, and the fallback path returns what its own `create()` produced. See [Attachments](./attachments.md#the-_attachment-record-type).

One consequence: there is no bytes-only upload anywhere on the wire — this endpoint always creates a record. Accordingly, **bytes-only upload has no public SDK surface either**: `putAttachment(data, mimeType, filename?)` is the upload operation, everywhere, for everyone. `StackBlobAdapter.putAttachment()` remains the required adapter-level primitive local storage needs (it's what `Stack.putAttachment()`'s fallback writes bytes through), but on `APIAdapter` it is **unsupported and throws** rather than mapping to this endpoint — implementing it anyway would silently create a record with a default `mimeType`, a bytes-only upload that isn't. `Stack.putAttachment()` never reaches it there (the atomic capability takes precedence), so the throw guards direct adapter-level callers only.

### Download

Two optional query parameters control the response metadata and, when both are supplied, allow the server to skip the `_attachment@1` database lookup entirely:

| Parameter      | Effect                                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `?contentType` | Candidate `Content-Type` for the response.                                                                                           |
| `?filename`    | Sets the filename in `Content-Disposition`. Also a candidate source for `Content-Type` (below), used when `?contentType` is omitted. |

```
GET /attachments/<fileId>?contentType=image/png&filename=photo.png
```

**Candidate `Content-Type` resolution**, in order — the first source that yields a value wins:

1. `?contentType`, if given.
2. Extension inference from `?filename`, if given and the extension is recognized.
3. The **first-recorded** `mimeType` on an `_attachment@1` record for the file — deterministic regardless of how many records exist for the `fileId` or which requester is asking, since conflicting `mimeType`s are rejected at write time and can never coexist (see [Attachments](./attachments.md#the-_attachment-record-type)).
4. `application/octet-stream`, if none of the above apply.

**Dangerous-type forcing applies to the result of that resolution, not to whichever source produced it** — a server that forces only the `?contentType` case and leaves the other sources unguarded has a spec-conformance gap, not a defensible partial implementation. Compute the candidate first, _then_ apply the policy below to whatever came out:

- **Safe list** — passes through unforced: `image/*` (**except** `image/svg+xml`), `video/*`, `audio/*`, `application/pdf`, `text/plain`, `application/octet-stream`. Checked against the MIME type's base (parameters like `; charset=...` stripped, comparison case-insensitive), so neither casing nor a parameter can smuggle an unsafe type past the check.
- **Everything else** is forced to `Content-Type: application/octet-stream` with `Content-Disposition: attachment` — forcing the content type alone is not sufficient, since disposition determines whether a browser treats the response as inline-renderable at all.
- **`X-Content-Type-Options: nosniff` is sent on every attachment download response**, forced or not — without it, browsers may sniff an `application/octet-stream` body back into the dangerous type the forcing just removed.

`@haverstack/core` exports the canonical implementation of this resolution and policy — `resolveAttachmentDownloadContentType()`, `isSafeAttachmentContentType()`, `inferContentTypeFromFilename()`, and the `NOSNIFF_HEADER_NAME`/`NOSNIFF_HEADER_VALUE` constants — so server implementations share one safe-list rather than each re-deriving it.

The filename in `Content-Disposition` is taken from `?filename` if given, else the requester's own `_attachment@1` record (if one exists), falling back to the first record's filename otherwise.

### Delete

Owner only. Returns `409 Conflict` if any record in the stack still references the file (via an `attachment` association or a `file-ref` content field). The bytes and all `_attachment@1` metadata records for the file are removed atomically on success.

### Access

Attachment permissions are governed by the Record(s) that reference them, not the attachment itself. If any Record referencing a `fileId` is accessible to the requester, the attachment is accessible. A non-owner requester can also access a file if they own an `_attachment@1` record for it, enabling access in the window between upload and record association.

## Entity

```
GET   /entity    — get the stack owner's entity record
PATCH /entity    — update it
```

A convenience alias for the owner entity rather than requiring clients to look it up by ID.
