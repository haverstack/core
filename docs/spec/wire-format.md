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
    "maxAttachmentBytes": 52428800,
    "maxContentBytes": 1048576
  },
  "auth": { "methods": ["did-challenge"] },
  "changes": { "transports": ["sse"], "resume": true, "records": true }
}
```

`auth` is optional and describes how a token can be earned here — see [Authentication § Advertising it](#advertising-it). `changes` is optional and describes the [change feed](#change-feed); its absence means the server offers none.

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

That second limit is specific to a static token. A client authenticating with a [DID credential](#authentication) sends nothing secret during discovery — it holds no token yet — and the handshake runs only after this check passes, so a server that fails it never sees a signature either.

## Authentication

Bearer token in the `Authorization` header. The adapter sends the token if configured; the server returns `401` if missing or invalid, `403` if the requester verified but lacks a grant (see [Error responses](#error-responses)).

```
Authorization: Bearer <token>
```

**How a token is earned is normative, not a sketch.** A client that cannot obtain a token programmatically has to be handed one out of band, which makes "the same client works against `localhost` or a remote provider" false at step zero — connecting. So the two endpoints below are part of this wire format, on the same terms as every other endpoint here, and are pinned by the same conformance fixtures (`@haverstack/conformance-fixtures`) — whose handshake fixtures carry a real DID, nonce and signature, so a server can verify one rather than trusting its own construction of the payload.

A server MAY additionally issue tokens by any scheme of its own; the handshake is the one a client can rely on finding.

### Advertising it

The handshake is optional to implement, so a server that implements it says so in [discovery](#discovery):

```json
"auth": { "methods": ["did-challenge"] }
```

Absent `auth` means only whatever issuance scheme was arranged out of band. A client holding a DID credential then learns at `open()` that there is nothing to perform, rather than discovering it as a 404 partway through a handshake. It is an object rather than a boolean because issuance is the surface most likely to grow another entry — a consent flow (below) arrives here.

### The handshake

```
POST /auth/challenge   { "did": "did:key:z6Mk..." }
                     → { "nonce": "k7Qm2Zx...", "expiresAt": "2024-06-15T12:05:00.000Z" }

POST /auth/token       { "did": "did:key:z6Mk...", "nonce": "k7Qm2Zx...", "signature": "CIvHvqS..." }
                     → { "token": "...", "expiresAt": "...", "principalId": "did:key:z6Mk...", "subjectId": "did:key:z6Mk..." }
```

Both are unauthenticated — they are how a token is obtained. `signature` is base64url.

**The nonce.** Opaque to the client, but restricted to unreserved base64url characters (`A-Za-z0-9_-`), because it lands in a newline-delimited signing payload where an unconstrained value could span fields. Its lifetime is the server's to choose and it is returned rather than assumed, so no client has to guess; **it MUST be single-use and bound to the DID it was issued for.** A nonce redeemable twice is a replayable signature, and one redeemable by a different DID proves nothing about either.

**The token's `expiresAt` is advisory.** A client MAY renew ahead of it and MUST NOT depend on it being present — it is optional, so 401-driven renewal is the floor a client needs regardless, and `APIAdapter` uses only that today. A server should therefore read an aggressive expiry as costing a wasted round-trip per lifetime rather than as something clients will schedule around.

**What gets signed is not the nonce.** It is a domain-separated payload, built identically on both sides by `buildAuthChallengePayload()` in `@haverstack/core/wire` — exported for exactly this reason, so a server and a client cannot each derive "the same string" and diverge on the first ambiguity:

```
haverstack-auth-v1\n<origin>\n<did>\n<nonce>
```

`haverstack-auth-v1` is the domain-separation tag: any future signing primitive takes its own, so no signature made for one purpose ever verifies as another.

**`<origin>` is what makes the handshake safe to perform against a server you have not verified**, and it is the reason the payload isn't just the nonce. Discovery identity is only [trusted on transport](#identity-is-trusted-on-transport), so a client can be talking to a server that is not the one it meant. Without the origin, that server can fetch a challenge from the client's _real_ stack, pass the nonce along as its own, and redeem the returned signature there — a relay that costs it nothing and hands it a token as the client. Signing the origin the client believes it is talking to makes such a signature verify nowhere else.

Two rules follow, and a server that skips either has a conformance gap rather than a lenient implementation:

- **A server MUST build the payload from its own configured public origin**, never from a request header. `Host` and `X-Forwarded-Host` are client-controlled, so deriving the origin from one lets a client choose which origin it signs for, which is the whole property being bought.
- **A server MUST verify against the payload it builds itself.** Nothing signed or claimed by the client contributes to it beyond the `did` and `nonce` fields named above.

`@haverstack/core/wire` provides both halves — `signAuthChallenge()` / `verifyAuthChallenge()` — and `didCredentialFromKeypair()` builds the `{ did, sign }` credential `APIAdapter` takes. The credential is a **signing callback, never a private key**: key custody stays with the app (see [Identity](./identity.md)), so a caller is free to back it with a hardware key or a keychain prompt.

### Auth errors

Handshake failures carry their own vocabulary, deliberately outside [`WireErrorCode`](#wire-error-body): no Stack operation has begun, so none of them is a `StackError` and none has a class to reconstruct — the same reason `InvalidDidError` stays outside that hierarchy.

| Code                | Status | Meaning                                                           | Retryable |
| ------------------- | ------ | ----------------------------------------------------------------- | --------- |
| `invalid_did`       | 400    | `did` is not a well-formed DID, or not one this server can verify | No        |
| `unknown_nonce`     | 401    | Never issued, or already spent                                    | Yes       |
| `expired_nonce`     | 401    | Past `expiresAt`                                                  | Yes       |
| `invalid_signature` | 401    | Does not verify against the payload                               | No        |

```json
{ "error": { "code": "expired_nonce", "message": "Challenge has expired" } }
```

The retryable column is the reason these carry codes at all, rather than being bodyless 401s like every other endpoint. A stale nonce is not a credential failure — the window between issuing and signing is small but real — so a client re-runs the handshake once and proceeds. A rejected signature will be rejected identically forever, so a client that retried it would loop. Collapsing the two means choosing one of those failure modes for every caller.

**A server MUST NOT distinguish never-issued from already-spent** in the code it returns. The two differ only in what an attacker learns.

### Server implementation checklist

Core runs no server, so every control below lives in the implementer's code — and the fixtures cannot check any of them. A fixture pins the shape of a request and its response; each of these is a property of state or configuration, so **a server can pass every fixture in this spec and still be unsafe.** They are collected here rather than left scattered through the prose above because that is exactly the reading order that misses one.

- **Derive the signing origin from your own configured public origin, never from a request header.** `Host` and `X-Forwarded-Host` are set by the client. A server that builds the payload from one lets the client choose which origin it signs for, which silently restores the relay this binding exists to prevent — an impostor replays a harvested signature with the matching `Host` and it verifies. The failure has no symptom: every fixture passes, since none varies the header. Behind a TLS terminator, the configured value is the **public** origin clients dial, not the internal one the proxy forwards to.
- **Spend a nonce when it is redeemed** — do not merely check that it exists and has not expired. This is pinned by `authSequenceFixtures`, the one fixture group whose point is ordering; a single request/response pair cannot express "and not a second time".
- **Record which DID each nonce was issued to, and check it on redemption.** A redemption can be internally consistent — a valid signature by the DID it names — and still be a nonce that belongs to someone else.
- **Never let a client name its own subject.** Delegation is asserted by the owner through an admin surface of your own; an endpoint where an app requests a token for a user is an app choosing its own authority (see [below](#the-session-a-token-names)).
- **Generate nonces in the base64url alphabet** (`A-Za-z0-9_-`) — `base64` output containing `+`, `/` or `=` is refused by conforming clients before they sign, so the error surfaces at the client rather than the server that caused it.
- **Return 401 and 403 for different things.** Anonymous or invalid token is 401; verified-but-ungranted is 403 (see [Error responses](#error-responses)). Collapsing them discards the distinction the whole identity model rests on.
- **Log the refusal you didn't send.** A 404 covering a record the requester could not read is [deliberately indistinguishable from a missing one](./access-control.md#errors-and-information-exposure) — to the client. The operator is not the adversary, so record which of the two it was, along with the requester DID (as [Identity](./identity.md#authentication-challengeresponse) already asks for denied-but-verified requests), the record ID, and the check that refused. Without it the distinction is lost to everyone: a grant that is subtly wrong looks exactly like a bad ID or a write that never landed, so it sends whoever is debugging it to the write path, which is the one place the bug is not. This is the bullet that makes the anti-oracle rule cheap to live with, and skipping it is how a deployment concludes the rule is not worth keeping. Treat the log as sensitive in its own right — "who asked after what, and was refused" is the sharing graph, written down.
- **Rate-limit record reads, not just writes.** The remaining ID-guessing attack is online — every candidate costs a request — so a limit sane for a personal Stack is most of the defence. One known millisecond is 32,768 candidates: 33 seconds to exhaust at 1000 req/s, 55 minutes at 10 req/s, and a single second of uncertainty about the timestamp multiplies both by a thousand. A server that answers an unauthenticated 404 with `WWW-Authenticate` keeps the login prompt working without reopening the distinction, since it says the same thing for a missing record.
- **Strip `includeUnlisted` before it reaches an unscoped `Stack`.** Routing the request through `ScopedStack` makes the owner-only refusal automatic; a server that maps query params or a subscribe request straight onto an unscoped adapter call must refuse or strip the flag itself, exactly as it already must for `entityId`/`principalId` on a create body. See [Unlisted § The one unsafe path](#unlisted).
- **A duplicate client-minted `id` answers 409, and that is an existence check.** Anyone holding a `create` grant on any type can learn whether an ID is taken by trying to use it (see [Record IDs](./data-model.md#record-ids)). This one cannot be closed in the response — any answer other than "created" confirms the ID — and it is accepted rather than closed, because it is what makes a create safe to retry after a network blip. Unlike a read, it is loud: every probe writes a record stamped with the requester's `entityId` that the owner can see and count, and that the requester cannot hard delete. Rate-limit creates, and narrow `idTimestampSkewMs` if a deployment wants the window tighter than 24 hours.

Two more sit in code this spec doesn't reach but a server does: `entityId` and `principalId` [must be ignored on input](#records), and a session's two identities must reach `ScopedStack` in the right order — `Stack.forSession()` takes the pair whole for that reason.

### The session a token names

A token resolves to **two** identities — the principal that authenticated and the subject it acts for (see [Access control § Delegation](./access-control.md#delegation-principal-and-subject)). `/auth/token` reports both, and **always reports them equal**: proving key possession proves the principal and says nothing whatever about whom that key may act for. There is no field a client could add to change that — an app that could name its own subject would be choosing its own authority, and containment would evaporate.

The pair is reported anyway rather than collapsed to one field, because delegated tokens exist and are issued elsewhere: **the owner asserts the binding out of band**, through an admin surface of the server's own. That is safe without the subject's involvement because effective authority is the intersection of both parties' grants, so a mis-issued delegation cannot escalate anyone — the binding is a question of correctness and consent, not a security boundary.

**Scoped consent is the extension point this shape reserves.** A flow where the _subject_ authorizes an app directly — OAuth/IndieAuth-shaped — issues a token of exactly this shape through a different route, advertises itself as another entry in `auth.methods`, and needs nothing here to change. Nothing in core builds it today.

(`@haverstack/core` defines the `StackTokenStore` contract — `createToken(principalId, { onBehalfOf })` / `lookupToken` / `listTokens` / `revokeToken` — and `record-adapter-sqlite` ships `NativeTokenStore`, a hashed-token reference implementation in its own file, separate from the records database, for servers that want DB-backed bearer tokens without rolling their own storage. This is optional tooling, not part of the wire protocol. `lookupToken()` returns both identities always populated, so no caller has to know which field stands in for the other when there is no delegation, and `Stack.forSession()` takes that pair whole — see [Access control § Enforcement](./access-control.md#enforcement-stackasentity). Its values are DIDs, same as everywhere else — see [Identity](./identity.md).)

## Error responses

| Status  | Meaning                  | When                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **400** | Bad request              | `StackQueryError` (code `bad_request`) where the library can identify the malformed input itself — e.g. an undecodable pagination cursor; otherwise a lower-level parse failure (missing required field, invalid JSON) with no core-taxonomy equivalent                                                                                                                                                                                                                                                                                                                                                                |
| **401** | Unauthorized             | Missing or invalid bearer token — no verified DID behind the request at all ("who are you?")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **403** | Forbidden                | `StackPermissionError` — the requester's DID verified but they lack access ("your claim is genuine; no"). Reserved for a requester who can **read** the record: telling anyone else that it exists would confirm a guessed or derived ID, so they get 404 instead. See [Access control § Errors and information exposure](./access-control.md#errors-and-information-exposure)                                                                                                                                                                                                                                         |
| **404** | Not found                | `StackNotFoundError` — record or version does not exist, **or** exists and the requester cannot read it. The two are deliberately indistinguishable (previous row)                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **409** | Conflict                 | `StackConflictError` — operation blocked by a constraint violation (e.g. deleting a still-referenced attachment, a duplicate client-supplied `id`, deleting `_config` or changing its `entityId`); or `StackSchemaDriftError` (code `schema_drift`) — `POST /types` redefining an existing `id` with a non-additive schema change                                                                                                                                                                                                                                                                                      |
| **412** | Precondition failed      | `StackVersionConflictError` (code `version_conflict`) — an `If-Match` precondition doesn't match the record's current version. A distinct error type and status from `StackConflictError`/409 — the two have different recovery stories                                                                                                                                                                                                                                                                                                                                                                                |
| **413** | Request entity too large | `StackPayloadTooLargeError` (code `payload_too_large`) — an attachment upload, a record body, or a PATCH body exceeds the server's size limit (see [Request size limits](#request-size-limits)). Unambiguous status (no other code shares 413), so status-only reconstruction recovers this class even without a parseable body. `putAttachment()` also pre-checks the declared `maxAttachmentBytes` ceiling client-side and throws the same class before sending, so this status is a backstop, not the only enforcement point                                                                                        |
| **422** | Unprocessable entity     | `StackValidationError` — request is syntactically valid but content fails schema validation (e.g. a required field has the wrong type)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **503** | Service unavailable      | `StackTimeoutError` (code `timeout`) — the server abandoned an operation for taking too long, in practice a full-text search (see [Bounding query cost](#bounding-query-cost)). Nothing was applied, and the request is worth retrying — which is why this is not `bad_request`: that code tells a client its request was malformed and retrying won't help. Status-only reconstruction deliberately does **not** map 503 to this class: a bodyless 503 is usually a load balancer or a restarting process, and reporting that as a timeout would tell an app its query was too expensive when the server never ran it |
| **500** | Internal server error    | Reserved for `StackMigrationError` (code `migration`) — migration-graph corruption. No current code path produces this over the wire; the mapping exists for forward compatibility only. **Not** used as a generic catch-all: an unrelated server crash is a plain 500 with no wire error body, and clients must not infer `StackMigrationError` from status 500 alone (see below)                                                                                                                                                                                                                                     |

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

**Every mutation that bumps `version` answers with the record it produced** — `POST /records`, `PATCH /records/:id`, both association endpoints, `PUT .../permissions`, `PUT .../unlisted`, `DELETE` (soft), `POST .../undelete`, `POST .../migrate` and `POST .../restore/:version` all return `200` with a Record body. A hard delete produces no version and returns `204`.

This is what lets a client report a mutation's outcome without a second read, and it is load-bearing for [change events](./events.md): the emitter reads the version, timestamp and acting identity of a change off what was persisted rather than inferring them, so a frame cannot disagree with storage. A server answering `204` to any of the above leaves a client unable to say what it just wrote.

**A soft-deleted Record is served as a tombstone.** `GET /records/:id` on one answers `200` with identity, clock, `version`, `deletedAt` and `permissions`, an empty `content` object, and no `associations`, `parentId` or authorship fields — the shape [Versioning § The tombstone is literal](./versioning.md#the-tombstone-is-literal) defines. The same projection applies to every Record in a `?includeDeleted=true` listing, to the body a soft `DELETE` answers with, and to change-feed frames. It is not a `404`: the requester passed the read check, and the tombstone confirms nothing a live read would have withheld. A requester who fails that check gets the usual `404`.

**Mutating a soft-deleted Record is `409`.** `PATCH`, the association endpoints, `PUT .../permissions` and `PUT .../unlisted`, and `POST .../restore/:version` answer `409 conflict` — undelete it first. `POST .../undelete` and `POST .../migrate` are the exemptions. A server MUST apply this **after** its authorization check, so a requester who cannot read the Record still receives `404`: a `409` reachable by a stranger would confirm that a guessed ID names something, which is exactly what the [404-over-403 rule](./access-control.md#errors-and-information-exposure) exists to prevent.

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
?relatedTo=          (a Record id — the `record` scope)
?relatedToStack=     (only alongside ?relatedTo; that Record's stack URL)
?relatedToEntity=    (a DID — the `entity` scope)
?relatedToNs=        (a namespace — the `external` scope)
?relatedToId=        (only alongside ?relatedToNs; omit to match the whole namespace)
?relatedToLabel=     (narrows any of the above to one label; valid alone)
?search=
?sort=createdAt|updatedAt|version
?direction=asc|desc
?limit=
?cursor=
?includeDeleted=
?includeUnlisted=    (owner-only — see Unlisted)
```

**The relationship filter's scope is implied by which parameters appear**, and the three sets are mutually exclusive: a request mixing `relatedTo`, `relatedToEntity` or `relatedToNs` is rejected with `400`, since there is no correct way to guess which the caller meant. At least one of these parameters is always present when the filter is used — [`relatedTo` names a label, a target, or both](./data-model.md#filter), never neither — so the filter cannot encode to an empty query string and silently widen the query. Omitting `relatedToStack` means the target has no `stackUrl`; the server MUST NOT treat it as a wildcard matching targets that carry one. `relatedToStack` MUST be omitted rather than sent empty — this stack is named one way — and a server MUST reject an empty one with `400` rather than reading it as either a local target or a wildcard. The same holds for `relatedToId`: omit it to match a whole namespace.

`GET /records` covers all native field queries and is usable from a browser or simple HTTP client without a JSON body. `POST /records/query` is a superset — it accepts the full `Query` object as a JSON body and additionally supports `content` field filtering. A server that declares `contentFieldQuery: false` in discovery does not support the POST query endpoint.

**Filters gated by a capability fail loudly, not silently.** A `content` filter has no representation in `GET /records`' query params, and `search` behaves however the server does with an unsupported param — so `APIAdapter` checks `capabilities.contentFieldQuery`/`capabilities.fullTextSearch` before dispatching and throws `APIAdapterCapabilityError` locally, without sending a request, when the corresponding filter is used against a server that hasn't declared the capability. The alternative — degrading to an unfiltered or partially filtered result presented as the requested query — is worse than an error for anything that trusts the filter (dedup checks, existence checks, selection-sensitive logic).

`PATCH /records/:id` accepts a partial content object. Omitted fields retain their current values. A field set to `null` is removed (RFC 7396 / JSON Merge Patch). Associations and permissions are managed via their own endpoints.

**Optimistic concurrency:** `PATCH`, `DELETE`, `POST .../undelete`, `POST .../restore/:version`, `POST .../migrate`, and the association/permission/unlisted endpoints below all accept an optional `If-Match` header:

```
PATCH /records/abc123
If-Match: "5"
```

When present, the server applies the mutation only if the record's current version equals the header's value; otherwise it returns **412** with a `version_conflict` wire error and changes nothing. Omit the header to keep unconditional last-writer-wins behavior. See [Versioning & deletion](./versioning.md#optimistic-concurrency-ifversion) for the corresponding `ifVersion` API.

`POST /records` accepts a full record body, including an optional client-supplied `id` — see [Record IDs](./data-model.md#record-ids) for the validation and duplicate-conflict rules the server applies.

**`entityId`, `principalId`, `updatedBy` and `updatedVia` are assigned by the server from the authenticated session, and MUST be ignored if a request body carries them.** They are the fields that answer "who did this", so a server that echoes back what it was handed makes every one of them self-reported — and `principalId` exists precisely to be the field that isn't (see [Identity § Attribution and what can be trusted](./identity.md#attribution-and-what-can-be-trusted)). A client naming its own `principalId` could dress any write up as a verified app action, defeating the `_app` cross-check that reads it. `ScopedStack` already overrides both regardless of what a caller passes, so a server built on it inherits this; one that maps a request body onto `Stack` directly has to drop them itself. `updatedBy` and `updatedVia` answer the same question about the mutation that `entityId` and `principalId` answer about the Record, so they are assigned and ignored on identical terms — see [Data model § Authorship and attribution](./data-model.md#authorship-and-attribution). The same applies to `version`, which the server always assigns. `createdAt` and `updatedAt` are server-assigned and ignored on every request but one: an **owner-authenticated** request (the stack owner acting alone, undelegated — the same tier that already gates hard delete, `commitMigration()`, and `includeUnlisted`) may include them, to backdate an imported record's clock fields instead of stamping the import moment. **The server MUST drop both fields from a non-owner request body before it creates the record.** This one is not inherited the way `entityId`/`principalId` are, and the difference matters: those two are _overridden_ by `ScopedStack` whatever a caller passes, whereas `createdAt`/`updatedAt` are **refused** — `ScopedStack.create()` throws `StackPermissionError` rather than ignoring them. A client always sends both fields (a record body is a whole record; `adapter-api` serializes it with `JSON.stringify`, Dates included), so a server that forwards a non-owner body unfiltered turns every ordinary grantee create into a refusal. Dropping is therefore the server's job, and deciding whether to drop means making the owner-acting-alone determination itself. Forwarding anyway fails safe — `ScopedStack` refuses rather than accepting a forged date — but it fails. A server that maps a request body onto `Stack` directly has neither the refusal nor the override, so it has to reproduce the owner check _and_ the drop. See [Data model § Backdating on import](./data-model.md#backdating-on-import). `appId` is the deliberate exception among the rest — self-reported by design, and never a permission input. For `typeId: "_attachment@1"`, a non-owner requester gets `403` regardless of grants — see [Attachments](./attachments.md#creating-_attachment1-records-directly) for the refusal, its carve-out, and `POST /attachments` as the non-owner-safe combined path.

### Migration commit

`POST /records/:id/migrate` is the only way a record's `typeId` changes after creation. Body: `{ "toTypeId": "...", "content": {...} }` — the full post-migration content, computed client-side by the type's owning app (migration functions are app code, not server code) and validated by the server against `toTypeId`'s schema before writing. This is what `stack.update()` uses to commit a pending lazy migration alongside a content patch (a content-only `PATCH` can't carry a `typeId` change), and what `stack.migrateAll()` uses for each record in a batch pass. `Stack.commitMigration()`/`ScopedStack.commitMigration()` is the client-side entry point that backs this endpoint for a single record — see [Type migrations](./data-model.md#type-migrations). A server built on `ScopedStack` serves this endpoint to the **stack owner** and answers `403` otherwise: migration is owner-driven, and no grant confers it (see [Access control](./access-control.md#type-level-grants)). Like every other endpoint that bumps a record's version, it accepts `If-Match` — a migration commit replaces content wholesale, so it is precisely the write a caller most needs to be able to fence. `stack.migrateAll()` sends none, since a batch pass doesn't know each record's version going in; a single `commitMigration()` passes whatever `ifVersion` its caller supplied.

### Response envelope

Both query endpoints return:

```json
{
  "records": [...],
  "cursor": "opaque-string-or-null",
  "total": null
}
```

**`total` is always `null` over the wire.** Every request a server serves is authenticated as some requester, so every response it produces has passed a permission boundary — and a count of matching Records ignoring pagination would report how many Records exist beyond what that requester may read. The field stays in the envelope (it is part of core's `QueryResult`, and an in-process unscoped `Stack.query()` does report a number) but a server MUST NOT populate it, and a client MUST NOT rely on it. See [Data model § Sorting and pagination](./data-model.md#sorting-and-pagination).

**An empty `records` array with a non-null `cursor` is a valid response, and does not mean the result set is exhausted.** A server filters a bounded window of stored Records per request against the requester's permissions, so a requester with little visibility into a large Stack can receive several empty pages before results appear. `cursor: null` is the only end-of-results signal; a client that stops paging on an empty page silently truncates its own results.

### Bounding query cost

**A server SHOULD bound how long a query may run, and MAY answer one that exceeds the bound with `503` (code `timeout`).** The obligation is the server's alone: nothing in the query grammar makes a search cheap, and nothing in core can interrupt one.

The record adapters sanitize a `search` string's _complexity_ — wildcards stripped, `NEAR` neutralized, parenthesis nesting capped — but not its _cost_. A syntactically modest query over a large index can still be expensive, and a SQLite-backed adapter runs synchronously in-process — `node:sqlite` blocks the calling thread. There is no timeout to set from inside the call, because there is no other thread left to fire it. On a personal Stack this bounds nothing worse than the requester's own session; on a server, one expensive search stalls every other request sharing that thread.

The mitigation therefore lives where the engine is driven, not in the sanitizers: run record-adapter queries off the request thread (a worker per connection, or a worker pool), so a slow query can be interrupted — `sqlite3_interrupt`, or terminating the worker — and apply the per-request deadline at that boundary. A server that does none of this is conforming but will serve exactly as well as its slowest query.

`timeout` is a distinct code because a client acts on it differently from every other failure in the table: nothing was applied, and the same request may well succeed if narrowed or retried. Reusing `bad_request` would say the opposite. See [Data model § Capability-gated filters](./data-model.md#capability-gated-filters).

### Request size limits

**A server MUST set a request-body size limit and answer an oversized body with `413` (code `payload_too_large`).** `maxAttachmentBytes` bounds attachment bytes only; a record body or a `PATCH` body has no ceiling anywhere in core, and nothing upstream of an adapter's `JSON.parse` imposes one — so an unbounded body is parsed, stored, and full-text indexed on the server's time and memory. This is ordinary request-size-limit territory, stated here because the rest of the spec bounds its resources explicitly (validation depth, cursor-walk caps, GC grace) and a server implementer reading it could reasonably conclude this one was covered too.

The limit applies to the whole request body, so the check belongs upstream of parsing — a body rejected only after `JSON.parse` has already cost what the limit exists to prevent.

**A server SHOULD declare the limit as `maxContentBytes` in [discovery](#discovery)**, the content-side counterpart to `maxAttachmentBytes`. `Stack.create()` and `Stack.update()` pre-check against it — the create body and the patch respectively, since the patch is what travels — and throw `StackPayloadTooLargeError` before sending. As with attachments, the client-side check is a courtesy that saves a round trip and yields a typed error; the server's own limit remains authoritative, and a server that declares `null` (or omits the field) is simply saying clients can't pre-check, not that nothing is enforced.

**`__proto__`, `constructor`, and `prototype` are refused as top-level content keys** on `POST /records` and `PATCH /records/:id`, with `422` (code `validation`) — a `Stack` invariant a server built on core inherits through ordinary record validation, and one that a server mapping request bodies onto storage directly has to apply itself. See [Data model § Reserved content keys](./data-model.md#reserved-content-keys).

## Permissions

```
GET  /records/:id/permissions        — get current permissions
PUT  /records/:id/permissions        — replace all permissions (empty array = private)
```

`GET` uses the envelope `{ "permissions": [...] }` as its response body, and `PUT` takes the same envelope as its request body. `PUT` answers `200` with the updated **Record** — it bumps `version` like any other mutation, and the rule under [Records](#records) is uniform — and accepts the same optional `If-Match` precondition described there.

An entry conveying `write` without `read` is refused with `422` (code `validation`), here and wherever else a request body carries `permissions`: the write bit reaches content and history through the mutate surface, so it withholds nothing without read. See [Access control § Write implies read](./access-control.md#write-implies-read).

## Unlisted

```
PUT  /records/:id/unlisted           — withhold from enumeration, or relist
```

Request body: `{ "unlisted": boolean }`. Answers `200` with the updated **Record** — it bumps `version` like any other mutation — carrying `unlistedAt` when `true`, absent when `false`. Accepts the same optional `If-Match` precondition as every other mutating endpoint. Orthogonal to `PUT .../permissions`: it decides whether the record is enumerable, never who may read it. See [Access control § Unlisted records](./access-control.md#unlisted-records).

**`GET /records` and `POST /records/query` accept `includeUnlisted`** (a query parameter on the former, a `filter` key on the latter), excluded by default like `includeDeleted`. **A server built on `ScopedStack` MUST refuse it with `403` for any requester but the owner acting alone** — enumeration standing rests on nothing but ownership, so no grant or delegation carries it (see [Access control § `includeUnlisted` is owner-only](./access-control.md#includeunlisted-is-owner-only)). `GET /changes` accepts the same parameter, refused on the same terms, for the change feed's own default exclusion — see [Change feed](#change-feed) below.

**The one unsafe path is a server mapping a request body straight onto an unscoped `Stack`.** Unscoped `Stack` honors `includeUnlisted` unconditionally, the same as `includeDeleted` — it is fully trusted by definition — so a server that forwards a request's filter verbatim onto one must strip `includeUnlisted` itself before dispatching, exactly as it already must for `entityId`/`principalId` on a create body (see [Records](#records)). Routing the request through `ScopedStack` instead makes this the library's problem rather than the server's, which is the shape every example in this document assumes.

## Versions

**The server snapshots prior state automatically on every mutating endpoint that bumps `version`** — there is no client-initiated endpoint to write a version directly. The list is exhaustive on purpose: `PATCH /records/:id`, the association endpoints, `PUT .../permissions`, `PUT .../unlisted`, `DELETE` (soft), `POST .../undelete`, `POST .../migrate`, and `POST .../restore/:version` itself (restore always creates a new version). `saveVersion()` is a deliberate no-op over `APIAdapter` — the server is the only snapshot writer for this adapter — so a server that implements anything less than every endpoint above silently loses rollback history for that endpoint's mutations.

```
GET  /records/:id/versions            — list all versions (newest first)
GET  /records/:id/versions/:version   — get a specific version
POST /records/:id/restore/:version    — restore a version (creates new version, no rewrite)
```

Both `GET` endpoints require the requester to hold the same mutate-surface authorization as a write to the record (write access, or owner/creator, or a Group's admin) — **not** plain read access; a read-only requester gets `403`. Snapshot `permissions` are additionally omitted from the response body for any non-owner requester, including a write-holder who passes the gate. See [Versioning & deletion](./versioning.md#history-access) for the rationale.

`POST .../restore/:version` accepts the same optional `If-Match` precondition described under [Records](#records).

**That same exhaustive list is what the [change feed](#change-feed) reports on**, plus create and hard delete. A server that skips an endpoint there loses reactivity for that verb exactly as silently as it loses rollback history here.

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

Both endpoints accept the same optional `If-Match` precondition described under [Records](#records), and both answer `200` with the updated Record, per the rule under [Records](#records).

`GET .../associations` response shape is consistent regardless of kind:

```json
{
  "associations": [
    { "kind": "tag", "label": "starred" },
    { "kind": "attachment", "label": "avatar", "fileId": "abc123" },
    {
      "kind": "relationship",
      "label": "reply-to",
      "target": { "scope": "record", "recordId": "xyz789" }
    },
    {
      "kind": "relationship",
      "label": "author",
      "target": { "scope": "entity", "entityId": "did:key:z6Mk..." }
    },
    {
      "kind": "relationship",
      "label": "syndicated-to",
      "target": {
        "scope": "external",
        "ns": "atproto",
        "id": "at://did:plc:abc/app.bsky.feed.post/3k4"
      }
    }
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
3. The **first-recorded** `mimeType` on an `_attachment@1` record for the file — the record with the earliest `createdAt`, ties broken by the lower record `id`. That total order is what makes the served type deterministic regardless of how many records exist for the `fileId` or which requester is asking; a conflicting `mimeType` is rejected when a write detects it, but under concurrency two conflicting first-writes can both land, and this rule still names one winner (see [Attachments](./attachments.md#the-_attachment-record-type)).
4. `application/octet-stream`, if none of the above apply.

**Dangerous-type forcing applies to the result of that resolution, not to whichever source produced it** — a server that forces only the `?contentType` case and leaves the other sources unguarded has a spec-conformance gap, not a defensible partial implementation. Compute the candidate first, _then_ apply the policy below to whatever came out:

- **Safe list** — passes through unforced: `image/*` (**except** `image/svg+xml`), `video/*`, `audio/*`, `application/pdf`, `text/plain`, `application/octet-stream`. Checked against the MIME type's base (parameters like `; charset=...` stripped, comparison case-insensitive), so neither casing nor a parameter can smuggle an unsafe type past the check.
- **The candidate must be a single well-formed MIME type** — `type/subtype` plus optional `; name=value` parameters, and nothing else — or it is unsafe whatever its base looks like. A `Content-Type` header carrying more than one type is split on commas and resolved to its **last** parsable type, so a candidate like `image/png,text/html` reads as `image/png` to a check that stops at the first `;` and as `text/html` to the browser it is served to. The safe-list is applied to the whole value precisely so the two cannot disagree; the same rule keeps a control character out of a header a server writes verbatim.
- **Everything else** is forced to `Content-Type: application/octet-stream` with `Content-Disposition: attachment` — forcing the content type alone is not sufficient, since disposition determines whether a browser treats the response as inline-renderable at all.
- **`X-Content-Type-Options: nosniff` is sent on every attachment download response**, forced or not — without it, browsers may sniff an `application/octet-stream` body back into the dangerous type the forcing just removed.

`@haverstack/core/wire` exports the canonical implementation of this resolution and policy — `resolveAttachmentDownloadContentType()`, `isSafeAttachmentContentType()`, `inferContentTypeFromFilename()`, and the `NOSNIFF_HEADER_NAME`/`NOSNIFF_HEADER_VALUE` constants — so server implementations share one safe-list rather than each re-deriving it.

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

## Change feed

Apps observe record changes by subscribing rather than polling. The feed answers _when_ something the requester can read changed; `query()` and `get()` answer _what_ it now is. The event vocabulary, the delivery guarantees and the permission rule are one design shared with the local API — see [Change events](./events.md), which this section is the wire encoding of.

### Advertising it

```json
"changes": { "transports": ["sse"], "resume": true, "records": true }
```

An object rather than a boolean, for the same reason `auth` is one: this surface grows entries — another transport, batched frames — and the alternative is a boolean followed by three more of them. Absent `changes` means no feed.

- `transports` lists the delivery mechanisms offered. `sse` is the only one in this version.
- `resume: false` is conformant. It means the server honors no cursor, so every connection is answered with a `reset` frame.
- `records` reports whether `?include=record` is honored. `false` is conformant; the fetch fallback is the contract either way.

**A client checks discovery and fails locally.** `APIAdapter.subscribeChanges()` against a server advertising no feed throws `APIAdapterCapabilityError` **without sending a request**, exactly as `contentFieldQuery` and `fullTextSearch` filters do. Learning this as a 404 partway through a connection is the failure mode `auth.methods` exists to avoid.

### The endpoint

```
GET /changes
Accept: text/event-stream
Authorization: Bearer <token>
Last-Event-ID: <seq>          (equivalently ?since=<seq>)

?typeId=          (repeatable; baseId or versioned, matched by baseId)
?parentId=        ("null" for root records, as GET /records)
?entityId=        (the record's author, not the actor)
?kind=            (repeatable: created|changed|deleted|purged)
?include=record   (ignored for kind=purged)
?includeUnlisted= (owner-only — see Unlisted)
```

Response: `200 text/event-stream`, a stream of frames.

**Filtering is exact, not advisory.** A filtered connection never receives an event outside its filter, so a client that filters again is doing redundant work rather than defensive work. `typeId` is matched by `baseId`, exactly as [grants are](./access-control.md#type-level-grants), so a type version bump never silently orphans a subscription. `entityId` filters on the record's **author** — which is deliberately not in the envelope, and never needed to be: filtering happens here, where the record is in hand.

### Frames

```
event: ready
data: {"seq":"AA3f1Q"}

id: AA3f1R
event: record
data: {"kind":"changed","op":"update","recordId":"1hk153x00001",
       "typeId":"com.example/note@1","version":7,
       "updatedAt":"2026-08-13T12:00:00.000Z",
       "actor":{"entityId":"did:key:z6Mk..."}}

id: AA3f1S
event: record
data: {"kind":"purged","op":"hard-delete","recordId":"1hk153x00002",
       "typeId":"com.example/note@1","version":4,
       "updatedAt":"2026-08-13T12:00:03.000Z",
       "actor":{"entityId":"did:key:z6MkOwner..."}}

: keepalive

event: reset
data: {"reason":"cursor_expired"}
```

- **`ready` is sent first, always.** It carries the head cursor, and it is what makes subscribe-then-query gap-free: a client that awaits it before querying knows every later change is in one or the other. A server that mints no cursors sends it with no `seq`.
- **`record`** carries one change. `updatedAt` is an ISO string; `record`, when included, is a `WireRecord`. The envelope describes the change and carries no record provenance — `actor` is who performed it, never who authored the record. See [Change events § Attribution](./events.md#attribution).
- **`reset`** means _your cursor cannot be honored; resynchronize by query_. A server with no buffer at all sends it on every connection and is fully conformant. `reason` is informational (`cursor_expired`, `not_supported`, `overflow`) — the client's repair is the same for all three.
- **`: keepalive` comments** SHOULD be sent on an idle interval, so intermediaries do not reap the connection and a client can detect a dead one.

**A purged frame carries `kind`, `op`, `recordId`, `typeId`, `version`, `updatedAt` and `actor` — nothing else**, whatever the client asked for and whatever the server advertises. No `record`, no `parentId`, no author. Hard delete is the erasure primitive, and a frame naming what was erased hands every subscriber a permanent, un-erasable note about it at the moment the stack finished destroying its own copy. `@haverstack/wire-types`' `serializeChange()` enforces this in the encoding, because the server holds the record at emission — for the readability check below — and is therefore in exactly the position to leak it. See [Change events § Purged records carry nothing](./events.md#purged-records-carry-nothing).

**A client MUST ignore a frame whose name it does not recognize.** That is what makes a new frame an additive, minor change under [version negotiation](#version-negotiation) rather than a break — type events, batch frames and anything else arrive that way.

**`seq` is opaque and restricted to the unreserved base64url alphabet (`A-Za-z0-9_-`)**, for the same reason [a nonce is](#the-handshake): it travels in a line-oriented protocol, where an unconstrained value would span fields and truncate the frame carrying it. A client echoes a cursor back and never computes with one, so a server is free to implement it as a WAL offset, a timestamp-counter pair, or anything else. `isValidSeq()` in `@haverstack/wire-types` applies the rule on both sides, and `@haverstack/core` applies it again to a `since` handed to `subscribe()` — so a cursor that could not be framed is refused the same way whatever adapter is underneath, rather than reaching one as a header it would truncate.

### Backpressure and reconnection

**On buffer overflow a server closes the stream** rather than dropping frames silently. The client reconnects, presents its cursor, and receives `reset` if the gap cannot be filled. Silent gaps are the one behavior that makes a feed untrustworthy: a client that cannot tell it missed something cannot repair it either.

**Reconnection is the client's job, with exponential backoff and jitter.** A server restart otherwise produces a synchronized reconnect stampede from every client it dropped.

**A client stops reconnecting when the answer was `4xx`, and keeps reconnecting when it was `5xx`.** The reconnect sends the same request, so a status faulting that request — a malformed cursor or filter, an unrenewable credential, an authorization refusal — will be answered identically however long the client waits, and backing off only spins. A `5xx` says the server could not serve a request it did not fault, which is the case backoff exists for; `timeout` is the answer a server gives while [shedding query load](#bounding-query-cost) and a client that gave up on it would turn a busy server into a dead subscription. A client that stops reports the error to its subscriber first; the repair is to subscribe again.

### Permission scoping

**A connection delivers the events its token's session may read, and nothing else.** The predicate is literally `canRead` applied per event — no second vocabulary, no feed-specific ACL. A server subscribes **unscoped** at the storage owner and fans out per connection, filtering each through the `ScopedStack` its token's session names via `Stack.forSession()`, taking the `(principalId, subjectId)` pair whole. Delegated authority is then the ordinary [intersection](./access-control.md#delegation-principal-and-subject), inherited rather than reimplemented.

**A record the requester cannot read produces no frame** — not an empty or redacted one. The existence of a change is itself a disclosure, the same reasoning that keeps `ScopedStack.query()`'s `total` null.

Two consequences are easy to discover too late:

- **`canRead` is not free per event.** It resolves grants, and without a cache that is a `_grant` query per event per connection. A subscription opened through `ScopedStack.subscribe()` already carries that cache and expires it from the stream itself, so a server that opens one per connection inherits both and has nothing to build — see [Change events § Permission scoping](./events.md#permission-scoping). The cost is a real one to weigh only where a server scopes the feed some other way.
- **A purged record cannot be permission-checked after the fact.** Readability must be evaluated at mutation time, on the record as it stood, because after the write there is nothing left to check.

### Auth, and what a stream does not renew

A feed connection is an ordinary request through the same path every other request takes, so a `401` triggers the existing single-flight re-authentication and one retry. **The change feed introduces no new auth machinery**, and a design that opened the stream outside that path would need its own token lifecycle and would get it subtly wrong.

**A stream's authority is fixed at connect and re-evaluated only at reconnect.** Renewing a token does not extend or re-authorize an open stream, and a client MUST NOT assume it does; [`expiresAt` is advisory](#the-handshake) and stays so, since the stream is not what holds the token. The consequence is the one genuinely new hazard here: **a long-lived stream can outlive the authority that opened it**, delivering to a token that has since expired or been revoked. It is a property of state rather than shape, so no fixture catches it — see the checklist below.

### Feed implementation checklist

As with [the auth checklist](#server-implementation-checklist), each of these is a property of state or configuration rather than shape, so **a server can pass every change-feed fixture and still be wrong.**

- **Bound stream lifetime, or re-check the session periodically.** A revoked or expired token must stop delivering. Closing the stream is enough: the client reconnects and gets a `401`, which is a path that already works.
- **Never accept a bearer token as a query parameter**, on this endpoint or any other, however convenient `EventSource` would make it.
- **Evaluate readability at mutation time for a purge**, before the record is destroyed.
- **Never put the purged record, or anything identifying it, into a purged frame.** Holding the record for that readability check makes it easy to serve under `?include=record`, and to fill an author field from it. Both defeat the erasure the verb performs.
- **Invalidate any authority cache of your own on `_grant` and `_group` events.** Caching authority is necessary for throughput and unsafe without it — a cache that ignores them serves a revoked subscriber indefinitely. The per-subscription cache behind `canRead` already does this, so what remains is any cache a server adds on top, such as one shared across connections.
- **Close on buffer overflow; never drop a frame silently.**
- **Only the storage owner can emit.** [Exactly one process owns a stack's storage](./adapters.md#concurrency--storage-ownership), so events exist only in that process. A multi-process server needs its own fan-out from the owner; a second process subscribing to its own `Stack` sees nothing and looks fine in testing.
- **Mint cursors in the base64url alphabet only** — a value containing a newline truncates the frame that carries it.
- **Emit for every mutating endpoint**, not the convenient ones. The list is the exhaustive one under [Versions](#versions), plus create and hard delete.

### Why SSE, and why not `EventSource`

SSE is one-way server→client, which is the entire requirement; it carries frame ids and resumption (`id:` / `Last-Event-ID`) in the protocol itself; and a server implements it as a streaming HTTP response with no new dependency, no upgrade path and no separate auth story. WebSocket buys bidirectionality that nothing here needs.

But **the browser `EventSource` API cannot set an `Authorization` header**, which is why SSE deployments so often end up with a token in the query string. That is not available here — query strings land in access logs, referrers and proxy telemetry, and this token is a programmatically renewable credential rather than a hand-placed one. The feed is therefore consumed via `fetch` with a streaming body.
