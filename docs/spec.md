# Stack Spec — Core Design

> Living document. Captures design decisions made so far.

---

## Overview

A **Stack** is a structured, portable personal or organizational data store. It provides a unified API for reading and writing **Records** regardless of the underlying storage backend. Apps integrate a single library and don't need to know or care how data is stored.

---

## Stack initialization

A Stack is created via an async factory that reads config from the adapter — the adapter is the single source of truth for stack-level configuration.

```ts
// First run — create a new database with initial config
const adapter = await SQLiteAdapter.initialize({
  path: './my-stack.db',
  entityId: 'abc123', // required — owner entity ID
  timezone: 'America/New_York', // required — IANA timezone string
});

// Subsequent runs — open an existing database
const adapter = await SQLiteAdapter.open({ path: './my-stack.db' });

// Always the same — reads config from the adapter
const stack = await Stack.create(adapter);
stack.ownerEntityId; // read from adapter config
stack.timezone; // read from adapter config
```

`SQLiteAdapter.initialize()` fails if the file already exists. `SQLiteAdapter.open()` fails if the file does not exist. This makes the distinction explicit and prevents silent config divergence.

Plugin and extension code that doesn't need to know the underlying backend should accept `StackClient` rather than the concrete `Stack` or `ScopedStack`. `StackClient` is the passable interface covering the full record API (`create`, `get`, `query`, `update`, `delete`, `associate`, `dissociate`, `setPermissions`, `getVersions`, `getVersion`, `restoreVersion`, `putAttachment`) plus a `features` getter. Both `Stack` and `ScopedStack` implement it.

**Stack config** is stored in a `stack_config` key/value table in the adapter. Current keys:

| Key         | Description                                    |
| ----------- | ---------------------------------------------- |
| `entity_id` | The owner Entity's record ID                   |
| `timezone`  | IANA timezone string e.g. `"America/New_York"` |
| `version`   | Stack schema version                           |

The `timezone` field is a property of the stack owner, not the app — an app running against two different stacks should display dates in each stack's configured timezone.

**For the API adapter**, config is not stored locally. The values are sourced from the discovery endpoint (`GET /.well-known/stack`) when the adapter is opened and cached for the session. `setConfig` is not supported and will throw — server configuration is managed server-side.

---

### Entity

An Entity represents the owner or author of a Stack — a person or organization. Entities are modeled as **Records** of the built-in system type `_entity`, rather than as a separate object type. This means Entities can have attachments (e.g. an avatar), relationships, and all other Record capabilities for free.

The Stack has a designated owner Entity, stored as a config value pointing to an `_entity` Record's ID.

**Content fields:**

```ts
type EntityContent = {
  name: string; // Display name — human-friendly, not necessarily unique. May contain spaces and punctuation. e.g. "Jane Smith"
  handle?: string; // Short unique identifier — URL-safe, no spaces. e.g. "janesmith". Like a username. Optional for private entities.
};
```

An Entity record's `entityId` may point to itself (the owner Entity authored its own record).

---

### App

Apps that write to a Stack are also modeled as Records, using the built-in system type `_app`. This allows querying all Records created by a specific app, and provides a foundation for future enforcement in the API adapter.

**Content fields:**

```ts
type AppContent = {
  name: string; // Display name of the app e.g. "My Notes App"
  version?: string; // Semver string e.g. "1.0.0". The app's unique machine-readable identity
  // is captured by the _app record's appId (e.g. "com.example.myapp"),
  // so no handle is needed.
};
```

---

### Group

A Group is a set of Entities, modeled as a Record of the built-in system type `_group`. Groups serve two distinct purposes, distinguished by a single optional field:

- **Permission group** — lives in a personal stack, used purely to manage access to Records. No shared stack. Lets you grant permissions to a set of Entities without listing them individually on every Record.
- **Collaborative group** — a Group that additionally owns its own Stack, used as a shared workspace. The presence of `stackUrl` in content is what makes a Group collaborative.

A permission group can be promoted to a collaborative group at any time by adding a `stackUrl` — no migration, no restructuring.

**Content fields:**

```ts
type GroupContent = {
  name: string; // Display name — human-friendly, not necessarily unique. e.g. "Jane's Book Club"
  handle?: string; // Short unique identifier — URL-safe, no spaces. e.g. "janes-book-club". Optional for private groups.
  stackUrl?: string; // If present, this group owns a shared collaborative stack at this URL. Absent = permission-only group.
};
```

**Membership** is expressed via associations on the `_group` Record, using the existing Association model:

```ts
{ kind: "relationship", label: "member", recordId: "<entity record id>" }
{ kind: "relationship", label: "admin",  recordId: "<entity record id>" }
```

This gives roles (member vs. admin) for free via association labels, and membership is queryable and versioned like any other Record data.

**Implementation note for the API adapter:** When enforcing group-based permissions, the server must resolve group membership by fetching the `_group` Record and walking its `relationship` associations. This requires the server to have read access to the stack where the `_group` Record lives.

---

### Grant

A Grant authorises one or more Entities to perform specific actions on Records of a given Type. Grants are modeled as Records of the built-in system type `_grant`, making them queryable, versioned, and subject to the same lifecycle as any other Record.

**Content fields:**

```ts
type GrantContent = {
  typeId: TypeId; // Which record type this grant covers
  actions: GrantAction[]; // Which actions are permitted
};

type GrantAction =
  | 'create' // Create new records of this type
  | 'read-own' // Read records where record.entityId === requester
  | 'read-any' // Read all records of this type
  | 'update-own' // Update records where record.entityId === requester
  | 'update-any' // Update all records of this type
  | 'delete-own' // Delete records where record.entityId === requester
  | 'delete-any'; // Delete all records of this type
```

`Stack.grant()` is the owner-facing helper for creating grant records:

```ts
// Grant a specific entity permission to create comments and manage their own
await stack.grant('bob-entity-id', [
  { typeId: 'com.example/comment@1', actions: ['create', 'read-own', 'update-own', 'delete-own'] },
]);

// Default grant — applies to any authenticated entity (null entityId on the grant record)
await stack.grant(null, [{ typeId: 'com.example/comment@1', actions: ['create', 'read-own'] }]);
```

**Design decisions:**

- **No wildcard `typeId`**: there is no `*` or catch-all. Every grant is opt-in per type. Adding a new type never implicitly inherits existing grants — it starts default-deny.
- **Default grants** (grant record has no `entityId`): apply to any authenticated entity. Useful for "any logged-in user can comment" scenarios. Anonymous requesters (no `entityId`) are always denied, even under a default grant.
- **Actions are independent**: `'create'` does not imply `'read-own'`, and so on. The combination `['create', 'read-own', 'update-own', 'delete-own']` is a common bundle for contributor access, but each action must be listed explicitly.
- **`-own` scope**: `-own` actions apply only to Records where `record.entityId` equals the requester — Records the entity authored. Records with no `entityId` (owner-created) do not satisfy any `-own` check.

---

### Attachment

An Attachment record stores the metadata for an uploaded file. Attachment metadata is modeled as a Record of the built-in system type `_attachment`, separate from the binary content which is stored by the adapter.

**Content fields:**

```ts
type AttachmentContent = {
  fileId: string; // SHA-256 hex hash of the file bytes — content-addressed ID
  mimeType: string; // MIME type declared at upload e.g. "image/png"
  size: number; // File size in bytes
  filename?: string; // Original filename if provided at upload
};
```

An `_attachment@1` record is created each time `stack.putAttachment()` or `scopedStack.putAttachment()` is called — even if the same bytes were previously uploaded. Multiple `_attachment@1` records may therefore exist for the same `fileId`, each with its own `mimeType` and `filename`. The binary is stored only once (content-addressed deduplication), but each upload gets its own metadata record.

When uploaded via `Stack.putAttachment()` (owner-level), the record carries no `entityId`. When uploaded via `ScopedStack.putAttachment()`, the `entityId` is set to the uploading entity.

---

## Types

A **Type** defines the schema for the `content` field of a Record. Types are identified by a **namespaced, versioned string ID** controlled by the app author — the app is the real coordination mechanism between stacks, so Type identity is scoped to the app that defined it.

```ts
type ScalarFieldKind =
  | 'string'
  | 'number'
  | 'boolean'
  | 'date'
  | 'text' // Long-form string (e.g. markdown body)
  | 'record-ref'; // Reference to another record by ID

type FieldDef =
  | { kind: ScalarFieldKind; required?: boolean }
  | { kind: 'array'; items: FieldDef; required?: boolean } // recursive
  | { kind: 'object'; properties: TypeSchema; required?: boolean }; // recursive

type TypeSchema = {
  [fieldName: string]: FieldDef;
};

type StackType = {
  id: string; // Versioned identifier, e.g. "com.example.myapp/note@2"
  baseId: string; // Derived from id by stripping version suffix, e.g. "com.example.myapp/note"
  version: number; // Incrementing integer
  name: string; // Human-readable label, e.g. "Note"
  schema: TypeSchema;
  schemaHash: string; // SHA-256 of canonical (minified, alpha-sorted) schema
  migratesFrom?: string; // e.g. "com.example.myapp/note@1" — documents lineage
  createdAt: Date;
};
```

**Array and object fields** are schema-validated on write but opaque to the query engine in v1 — only top-level scalar fields support exact-match content filtering in queries.

**Type identity:** Two Types are the same if their `id` matches (including version). Two stacks running the same app will have the same Type IDs and can rely on that for interop.

**Schema drift detection:** If two Records share a `typeId` but their Type definitions have different `schemaHash` values, that is unambiguously a bug — intentional changes always produce a new version number.

**Type compatibility:** Structural/duck-typed — a Type is compatible with a required schema if it contains all required fields with matching kinds. Used by apps that want to work with Records regardless of exact Type, e.g. any Type with `{ text: string }`:

```ts
function isCompatible(
  candidateSchema: TypeSchema, // the Record's actual Type
  requiredSchema: TypeSchema, // minimum fields the app needs
): boolean {
  return Object.entries(requiredSchema).every(([key, def]) => {
    if (!def.required) return true;
    const field = candidateSchema[key];
    return field !== undefined && field.kind === def.kind;
  });
}
```

Apps that care about semantics filter by exact `typeId`. Apps that want flexibility use `isCompatible()`.

**System types** (reserved, library-defined): `_entity@1`, `_app@1`, `_group@1`, `_grant@1`, `_attachment@1`. System types follow the same versioned ID format as user-defined types and can evolve using the same migration mechanism. All five are pre-seeded when a Stack is created via `Stack.create()` — they are always available without any setup by the caller.

### Type migrations

Apps register migration functions between adjacent Type versions at startup. The library composes them into a full migration graph, so an app that only knows about v3 doesn't need to know that v1 ever existed.

```ts
stack.registerMigration({
  from: 'com.example.myapp/note@1',
  to: 'com.example.myapp/note@2',
  migrate: (content) => ({ ...content, title: '' }),
});

stack.registerMigration({
  from: 'com.example.myapp/note@2',
  to: 'com.example.myapp/note@3',
  migrate: (content) => ({ ...content, pinned: false }),
});
```

The migration registry is **per-stack-instance** — different stacks can be at different migration states without interfering. Registration is part of app startup, immediately after creating the Stack.

**What the library does with registered migrations:**

- **Lazy migration on read** — `stack.get()` and `stack.query()` apply the migration chain in memory, returning Records as if they were the latest version. Nothing is written to disk.
- **Migration committed on update** — when a record is next updated via `stack.update()`, the library migrates existing content first, then applies the patch, then writes at the latest typeId. This is when lazy migration is persisted.
- **Path composition** — migrations between adjacent versions are automatically chained (v1→v2→v3), so apps only ever register one step at a time.
- **Warn on unmigratable reads** — if a Record's Type version has no registered path to the latest, the library warns the app and returns the raw record.
- **Batch migration** — `stack.migrateAll("com.example.myapp/note")` eagerly commits all pending migrations to disk in one deliberate pass. Version history is preserved before each write. Use before deployments or after major schema changes.

> **Not yet implemented:** validation of migration function output against the target schema at registration time.

---

## Records

A **Record** is the fundamental unit of data in a Stack.

```ts
type StackRecord = {
  // --- Core (always present) ---
  id: string; // Crockford base-32, time-sortable, unique within a stack
  typeId: string; // Versioned Type ID e.g. "com.example.myapp/note@2"
  createdAt: Date;
  updatedAt: Date;
  content: Record<string, unknown>; // Validated against the Type's schema
  version: number; // Increments on each write (for conflict detection)

  // --- Optional native fields ---
  parentId?: string; // ID of a parent Record (for hierarchy/folders)
  entityId?: string; // Author Entity. Absent means owner-created — Records written directly by the stack owner carry no entityId.
  appId?: string; // App that created this Record
  deletedAt?: Date; // Present if soft-deleted
  permissions?: Permission[]; // Access control (see Permissions)
  associations?: Association[]; // Tags, attachments, relationships
};
```

**Design principle:** Native fields are things the library needs to operate (routing, querying, syncing, hierarchy). Everything semantic and domain-specific goes in `content`.

---

## Associations

Tags, attachments, and relationships are unified under a single **Association** model. All three associate a Record with a labeled payload — the label carries semantic meaning (e.g. `"avatar"`, `"parent"`, `"reply-to"`).

```ts
type Association =
  | { kind: 'tag'; label: string }
  | { kind: 'attachment'; label: string; fileId: string; mimeType: string }
  | { kind: 'relationship'; label: string; recordId: string };
```

**Examples:**

- A `contact` type uses `{ kind: "attachment", label: "avatar", fileId: "..." }` as a profile picture.
- A `tweet` type uses `{ kind: "relationship", label: "reply-to", recordId: "..." }` to reference another tweet.
- Any record can use `{ kind: "tag", label: "starred" }` for user-defined labels.

**Note:** `parentId` is a separate native field (not an Association) because hierarchical containment is fundamental enough to warrant indexing at the library level. Associations are for metadata and cross-references.

---

## Permissions

Access control in a Stack has two complementary layers. `ScopedStack` (see below) enforces both.

### Layer 1: Record-level permissions

All Records are **private by default** — readable only by the stack owner. The `permissions` field is absent or empty on private records; there is no explicit `private` permission value. Permissions represent _grants_ of access, not restrictions. Enforcement is the responsibility of the API adapter. The JSON and SQLite adapters ignore the permissions field.

```ts
// Absence of permissions (empty or undefined) = private, owner only.
type Permission =
  | { access: 'public' }
  | { access: 'entity'; entityId: string; read: boolean; write: boolean }
  | { access: 'group'; groupId: string; read: boolean; write: boolean };
```

Group permissions reference a `_group` Record by ID. The group may be a simple permission group (living in the stack owner's personal stack) or a collaborative group with its own stack — the permission model is the same either way.

**Permission resolution:**

- `private` — owner only
- `public` — any requester can read
- `entity` — check the requester's entityId directly
- `group` — fetch the referenced `_group` Record, walk its `relationship` associations to verify the requester is a member or admin

Cross-stack group resolution (where the `_group` Record lives in a different stack than the Record being accessed) requires the server to have read access to that stack.

### Layer 2: Type-level grants

`_grant` records (see [Grant](#grant)) authorise Entities to perform actions across all Records of a given Type, without touching individual records. A read-any grant on `comment@1`, for example, makes all comments of that type readable by the grantee without setting `permissions` on each one.

`ScopedStack` checks both layers on every operation: if either the Record's own `permissions` or a matching `_grant` record permits the action, access is granted. The owner always has full access and bypasses both checks.

### Enforcement: `Stack.asEntity()`

The core library ships a permission-enforcing wrapper so server implementations don't need to reimplement this resolution logic. `stack.asEntity(entityId)` — `entityId` is `null` for an anonymous/unauthenticated requester — returns a `ScopedStack`: the same surface as `Stack`, but every operation is checked against both permission layers.

**`ScopedStack.create()`** additionally checks `_grant` records for a `'create'` action on the target type before allowing the Record to be written. Anonymous requesters are always denied. The owner always passes. The created Record's `entityId` is always set to the requester, so `-own` grants apply to it immediately.

Reading or writing a Record that exists but isn't accessible throws `StackPermissionError`; a missing Record throws `StackNotFoundError`, so callers can distinguish "not found" from "forbidden" (typically 404 vs 403 at the HTTP layer).

Plain `Stack` methods remain unscoped and perform no permission checks — correct for single-entity embedded use, where there's no requester distinct from the app itself. Use `asEntity()` when one `Stack` instance serves requests from multiple, possibly untrusted, entities, e.g. a server adapter.

`ScopedStack.query()`'s `total` is always `null`. The adapter's unfiltered count would otherwise leak the existence and cardinality of Records the requester can't read, even when the returned `records` array comes back empty. Computing an exact filtered count would require evaluating every match rather than just the returned page, so it's intentionally not attempted.

`ScopedStack`'s group-membership check only resolves `_group` Records living in the same stack as the Record being accessed — it does not yet implement the cross-stack case described above. A server relying on cross-stack groups must still handle that case itself.

---

## Versions

Version history is managed by the library as a side channel — apps do not manage it directly. On every `update()`, the library snapshots the previous state.

```ts
type RecordVersion = {
  version: number;
  content: object;
  updatedAt: Date;
  entityId?: string; // Who made this change
};
```

**API surface:**

- `stack.getVersions(recordId)` — retrieve version history
- `stack.restoreVersion(recordId, version)` — revert to a prior version

**Storage per adapter:**

- JSON: sibling file `{id}.versions.json`
- SQLite: `versions` table
- API: server snapshots automatically on every `PATCH /records/:id`; history is read via `/records/:id/versions`

---

## Adapters

The library exposes a single interface regardless of backend. Three adapters are planned:

| Adapter        | Use case                                | Notes                                                   |
| -------------- | --------------------------------------- | ------------------------------------------------------- |
| **JSON files** | Portable, human-readable, backup/export | Slow queries (O(n) scan); may maintain an `_index.json` |
| **SQLite**     | Local app storage, fast queries         | Indexes associations, parentId, appId, etc.             |
| **Server API** | Hosted/shared stacks                    | Enforces permissions and app identity                   |

All adapters support the full Record API. Performance guarantees differ; correctness does not.

---

## Attachments

Binary files are stored and retrieved through the library using **content-addressed storage**. A file's ID is the SHA-256 hash of its bytes, so uploading identical bytes twice returns the same `fileId` without writing a second binary copy. Each upload creates a new `_attachment@1` record (see [Attachment](#attachment)) regardless of deduplication, so metadata (mimeType, size, filename) is tracked per upload.

```ts
// Upload a file — returns a stable SHA-256 hex ID and creates an _attachment@1 record
const fileId = await stack.putAttachment(data: Uint8Array, mimeType: string, filename?: string): Promise<string>

// Fetch the binary
const data: Uint8Array = await stack.getAttachment(fileId)
```

A `fileId` is referenced in an `Association` of kind `"attachment"`. To read metadata for a given `fileId`, query `_attachment@1` records:

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

**`Stack.putAttachment()` vs `ScopedStack.putAttachment()`:**

- `Stack.putAttachment(data, mimeType, filename?)` — owner-level upload. Creates an `_attachment@1` record with no `entityId`. No grant check.
- `ScopedStack.putAttachment(data, mimeType, filename?)` — entity-scoped upload. Requires a `create` grant on `_attachment@1`. The created record's `entityId` is set to the uploading entity.

**Deduplication:** Bytes are deduplicated — uploading the same content twice stores the binary only once. However, each call to `putAttachment()` creates a new `_attachment@1` record with its own `mimeType` and `filename`. The same `fileId` may have multiple `_attachment@1` records from separate uploads.

---

## Queries

Queries are expressed as a `Query` object passed to `stack.query()`. All adapters support the full query shape; performance guarantees differ.

### Filter

```ts
type Filter = {
  // Native fields
  typeId?: string | string[];
  parentId?: string | null; // null = root records only
  appId?: string | string[];
  entityId?: string | string[];
  createdAt?: DateRange;
  updatedAt?: DateRange;

  // Association filters
  tags?: string[]; // records that have ALL of these tags
  hasAttachment?: string; // records with an attachment of this label
  relatedTo?: { recordId: string; label?: string };
  attachmentFileId?: string; // records that reference a specific attachment file ID

  // Content fields (exact match on top-level keys)
  content?: { [key: string]: unknown };

  // Full-text search (capability varies by adapter)
  search?: string;
};

type DateRange = {
  before?: Date;
  after?: Date;
};
```

### Sorting and pagination

```ts
type Query = {
  filter?: Filter;
  sort?: {
    field: 'createdAt' | 'updatedAt' | 'version';
    direction?: 'asc' | 'desc';
  };
  limit?: number;
  cursor?: string; // Opaque cursor for page-based pagination
};
```

Pagination is cursor-based rather than offset-based, so it works consistently across adapters and doesn't drift when records are inserted mid-page.

### Adapter capabilities

Adapters expose a capabilities object so apps can check what's supported before relying on a feature:

```ts
type AdapterCapabilities = {
  fullTextSearch: boolean;
  contentFieldQuery: boolean;
  sortableFields: string[];
};
```

`AdapterCapabilities` is the adapter-implementer-facing name. On the `StackClient` interface it is exposed as `features: StackFeatures` (`StackFeatures` is a type alias for `AdapterCapabilities`). App and plugin code should read `stack.features` rather than going through the adapter directly.

**Per-adapter notes:**

- **JSON adapter** — supports all filter fields via O(n) scan; may maintain `_index.json` to speed up native field lookups; `fullTextSearch: false` in v1
- **SQLite adapter** — indexes all native fields and association labels; supports content field queries and full-text search via FTS5
- **API adapter** — capabilities determined by the server; declared in a discovery endpoint

---

## Deletion

Records are never hard-deleted by default. Two levels of deletion are supported:

**Soft delete** — the default. A deleted Record is flagged with a `deletedAt` timestamp and excluded from normal queries, but remains recoverable. Version history is preserved. A soft-deleted Record is a tombstone — its current state is gone but its history is not.

**Hard delete** — permanent and explicit. Removes the Record and all its version history. Requires deliberate intent via a flag. The escape hatch for sensitive, secret, or harmful content.

```ts
stack.delete(recordId); // soft delete — reversible
stack.delete(recordId, { hard: true }); // hard delete — permanent
```

Queries exclude soft-deleted Records by default. Opt in with:

```ts
stack.query({ filter: { includeDeleted: true } });
```

**Restore** always creates a new version with the old content — it never rewrites history. The act of restoring is itself part of the version history.

```ts
stack.restoreVersion(recordId, version); // creates a new version, doesn't rewrite history
```

---

## API Adapter Wire Format

The API adapter speaks REST over HTTP with JSON bodies and standard status codes. It is the only adapter where permissions are enforced and app identity can be validated.

### Discovery

A client hits this endpoint first to understand the server's identity and capabilities. The response also supplies the stack config values (`entity_id`, `timezone`, `version`) that `Stack.create()` reads from the adapter — these are cached locally for the session rather than stored on the client.

```
GET /.well-known/stack
```

```json
{
  "version": "1.0",
  "entityId": "abc123",
  "timezone": "America/New_York",
  "capabilities": {
    "fullTextSearch": true,
    "contentFieldQuery": true,
    "sortableFields": ["createdAt", "updatedAt", "version"]
  }
}
```

### Authentication

Bearer token in the `Authorization` header. Token issuance is out of scope for the spec — that is the server's concern. The adapter sends the token if configured; the server returns `401` if missing or invalid.

```
Authorization: Bearer <token>
```

(As a non-normative example, `SQLiteAdapter` ships an optional hashed-token store — `createToken` / `lookupToken` / `listTokens` / `revokeToken` — for servers that want DB-backed bearer tokens without rolling their own storage. This is adapter-specific tooling, not part of the wire protocol; other adapters are free to manage tokens however they like, or not at all.)

### Error responses

Standard HTTP status codes are used throughout:

| Status  | Meaning                  | When                                                                                                                                   |
| ------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| **400** | Bad request              | Structurally malformed request — missing a required field, unparseable query parameter, invalid JSON                                   |
| **401** | Unauthorized             | Missing or invalid bearer token                                                                                                        |
| **403** | Forbidden                | `StackPermissionError` — record exists but the requester lacks access                                                                  |
| **404** | Not found                | `StackNotFoundError` — record or version does not exist                                                                                |
| **413** | Request entity too large | Attachment upload exceeds the server's size limit                                                                                      |
| **422** | Unprocessable entity     | `StackValidationError` — request is syntactically valid but content fails schema validation (e.g. a required field has the wrong type) |

The distinction between **400** and **422** matters for write endpoints (`POST /records`, `PATCH /records/:id`, `POST /types`): a 400 means the request couldn't be parsed at all; a 422 means the server understood the request but the content didn't satisfy the type schema.

### Records

```
GET    /records              — query by native fields (see query params below)
POST   /records/query        — query including content field filters (JSON body)
POST   /records              — create
GET    /records/:id          — get one
PATCH  /records/:id          — update content only (partial merge, null = delete field)
DELETE /records/:id          — soft delete
DELETE /records/:id?hard=true — hard delete
```

**`GET /records` query params:**

```
?typeId=
?parentId=           (use "null" for root records)
?appId=
?entityId=
?createdBefore=
?createdAfter=
?updatedBefore=
?updatedAfter=
?tag=                (repeatable: ?tag=starred&tag=important)
?hasAttachment=
?attachmentFileId=
?relatedTo=
?search=
?sort=createdAt|updatedAt|version
?direction=asc|desc
?limit=
?cursor=
?includeDeleted=
```

`GET /records` covers all native field queries and is usable from a browser or simple HTTP client without a JSON body. `POST /records/query` is a superset — it accepts the full `Query` object as a JSON body and additionally supports `content` field filtering. A server that declares `contentFieldQuery: false` in discovery does not support the POST query endpoint.

`PATCH /records/:id` accepts a partial content object. Omitted fields retain their current values. A field set to `null` is removed (RFC 7396 / JSON Merge Patch). Associations and permissions are managed via their own endpoints.

### Permissions

```
GET  /records/:id/permissions        — get current permissions
PUT  /records/:id/permissions        — replace all permissions (empty array = private)
```

**Response envelope:**

```json
{
  "records": [...],
  "cursor": "opaque-string-or-null",
  "total": 142
}
```

### Versions

The server snapshots a record's state automatically on every `PATCH /records/:id` — there is no client-initiated endpoint to write a version directly.

```
GET  /records/:id/versions            — list all versions (newest first)
GET  /records/:id/versions/:version   — get a specific version
POST /records/:id/restore/:version    — restore a version (creates new version, no rewrite)
```

### Associations

Associations are always in the context of a Record:

```
GET    /records/:id/associations               — all associations
GET    /records/:id/associations?kind=tag
GET    /records/:id/associations?kind=attachment
GET    /records/:id/associations?kind=relationship
GET    /records/:id/associations?label=avatar  — filter by label across all kinds
POST   /records/:id/associations               — add an association
DELETE /records/:id/associations               — remove an association (by body)
```

Response shape is consistent regardless of kind:

```json
{
  "associations": [
    { "kind": "tag", "label": "starred" },
    { "kind": "attachment", "label": "avatar", "fileId": "abc123", "mimeType": "image/png" },
    { "kind": "relationship", "label": "reply-to", "recordId": "xyz789" }
  ]
}
```

### Types

```
GET  /types        — list all types known to this stack
GET  /types/:id    — get one type definition (id is URL-encoded)
POST /types        — register or replace a type
```

### Attachments

```
POST   /attachments           — store raw file bytes, returns { fileId }
GET    /attachments/:fileId   — download a file
DELETE /attachments/:fileId   — delete a file
```

Attachments are uploaded first to get a `fileId`, then referenced in an Association when creating or updating a Record. This keeps all Record endpoints JSON-only.

File IDs are SHA-256 hashes of the content. Uploading identical bytes twice returns the same `fileId` without writing a second copy.

**Upload:** Send the raw binary as the request body. `Content-Type` and `Content-Disposition` headers are ignored — `POST /attachments` stores bytes only and does **not** create an `_attachment@1` record. To record metadata (MIME type, filename, size), create an `_attachment@1` record via `POST /records` after upload.

```
POST /attachments
Authorization: Bearer <token>

<binary data>
```

Returns `413 Request Entity Too Large` if the payload exceeds the server's configured limit (default 50 MB, controlled by `MAX_ATTACHMENT_BYTES`).

The SDK's `Stack.putAttachment()` and `ScopedStack.putAttachment()` perform both steps automatically. Direct HTTP callers must create the `_attachment@1` record separately if metadata is needed.

**Download:** If an `_attachment@1` record exists for the `fileId`, the response uses the stored `mimeType` as `Content-Type`. If the requester owns an `_attachment@1` record with a `filename`, the response includes `Content-Disposition: attachment; filename="..."`. When no metadata record exists (e.g. immediately after a raw upload before the caller has created one), the response falls back to `Content-Type: application/octet-stream`.

**Attachment permissions** are governed by the Record(s) that reference them, not the attachment itself. If any Record referencing a `fileId` is accessible to the requester, the attachment is accessible. A non-owner requester can also access a file if they own an `_attachment@1` record for it, enabling access in the window between upload and record association.

### Entity

```
GET   /entity    — get the stack owner's entity record
PATCH /entity    — update it
```

A convenience alias for the owner entity rather than requiring clients to look it up by ID.

---

## Open Questions

- **Multi-stack patterns** — apps managing multiple stacks (personal + group stacks) will likely repeat common fan-out and merge patterns; a `StackWorkspace` abstraction is a likely future addition once real usage patterns emerge
