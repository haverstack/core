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
  entityId: 'abc123',          // required — owner entity ID
  timezone: 'America/New_York', // required — IANA timezone string
});

// Subsequent runs — open an existing database
const adapter = await SQLiteAdapter.open({ path: './my-stack.db' });

// Always the same — reads config from the adapter
const stack = await Stack.create(adapter);
stack.ownerEntityId  // read from adapter config
stack.timezone       // read from adapter config
```

`SQLiteAdapter.initialize()` fails if the file already exists. `SQLiteAdapter.open()` fails if the file does not exist. This makes the distinction explicit and prevents silent config divergence.

**Stack config** is stored in a `stack_config` key/value table in the adapter. Current keys:

| Key | Description |
|---|---|
| `entity_id` | The owner Entity's record ID |
| `timezone` | IANA timezone string e.g. `"America/New_York"` |
| `version` | Stack schema version |

The `timezone` field is a property of the stack owner, not the app — an app running against two different stacks should display dates in each stack's configured timezone.

**For the API adapter**, config is not stored locally. The values are sourced from the discovery endpoint (`GET /.well-known/stack`) when the adapter is opened and cached for the session. `setConfig` is not supported and will throw — server configuration is managed server-side.

---

### Entity

An Entity represents the owner or author of a Stack — a person or organization. Entities are modeled as **Records** of the built-in system type `_entity`, rather than as a separate object type. This means Entities can have attachments (e.g. an avatar), relationships, and all other Record capabilities for free.

The Stack has a designated owner Entity, stored as a config value pointing to an `_entity` Record's ID.

**Content fields:**
```ts
type EntityContent = {
  name: string;      // Display name — human-friendly, not necessarily unique. May contain spaces and punctuation. e.g. "Jane Smith"
  handle?: string;   // Short unique identifier — URL-safe, no spaces. e.g. "janesmith". Like a username. Optional for private entities.
};
```

An Entity record's `entityId` may point to itself (the owner Entity authored its own record).

---

### App

Apps that write to a Stack are also modeled as Records, using the built-in system type `_app`. This allows querying all Records created by a specific app, and provides a foundation for future enforcement in the API adapter.

**Content fields:**
```ts
type AppContent = {
  name: string;      // Display name of the app e.g. "My Notes App"
  version?: string;  // Semver string e.g. "1.0.0". The app's unique machine-readable identity
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
  name: string;       // Display name — human-friendly, not necessarily unique. e.g. "Jane's Book Club"
  handle?: string;    // Short unique identifier — URL-safe, no spaces. e.g. "janes-book-club". Optional for private groups.
  stackUrl?: string;  // If present, this group owns a shared collaborative stack at this URL. Absent = permission-only group.
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

## Types

A **Type** defines the schema for the `content` field of a Record. Types are identified by a **namespaced, versioned string ID** controlled by the app author — the app is the real coordination mechanism between stacks, so Type identity is scoped to the app that defined it.

```ts
type ScalarFieldKind =
  | "string"
  | "number"
  | "boolean"
  | "date"
  | "text"        // Long-form string (e.g. markdown body)
  | "record-ref"; // Reference to another record by ID

type FieldDef =
  | { kind: ScalarFieldKind; required?: boolean }
  | { kind: "array";  items: FieldDef;        required?: boolean }  // recursive
  | { kind: "object"; properties: TypeSchema; required?: boolean }; // recursive

type TypeSchema = {
  [fieldName: string]: FieldDef;
};

type StackType = {
  id: string;              // Versioned identifier, e.g. "com.example.myapp/note@2"
  baseId: string;          // Derived from id by stripping version suffix, e.g. "com.example.myapp/note"
  version: number;         // Incrementing integer
  name: string;            // Human-readable label, e.g. "Note"
  schema: TypeSchema;
  schemaHash: string;      // SHA-256 of canonical (minified, alpha-sorted) schema
  migratesFrom?: string;   // e.g. "com.example.myapp/note@1" — documents lineage
  createdAt: Date;
};
```

**Array and object fields** are schema-validated on write but opaque to the query engine in v1 — only top-level scalar fields support exact-match content filtering in queries.

**Type identity:** Two Types are the same if their `id` matches (including version). Two stacks running the same app will have the same Type IDs and can rely on that for interop.

**Schema drift detection:** If two Records share a `typeId` but their Type definitions have different `schemaHash` values, that is unambiguously a bug — intentional changes always produce a new version number.

**Type compatibility:** Structural/duck-typed — a Type is compatible with a required schema if it contains all required fields with matching kinds. Used by apps that want to work with Records regardless of exact Type, e.g. any Type with `{ text: string }`:

```ts
function isCompatible(
  candidateSchema: TypeSchema,   // the Record's actual Type
  requiredSchema: TypeSchema     // minimum fields the app needs
): boolean {
  return Object.entries(requiredSchema).every(([key, def]) => {
    if (!def.required) return true;
    const field = candidateSchema[key];
    return field !== undefined && field.kind === def.kind;
  });
}
```

Apps that care about semantics filter by exact `typeId`. Apps that want flexibility use `isCompatible()`.

**System types** (reserved, library-defined): `_entity@1`, `_app@1`, `_group@1`. System types follow the same versioned ID format as user-defined types and can evolve using the same migration mechanism.

### Type migrations

Apps register migration functions between adjacent Type versions at startup. The library composes them into a full migration graph, so an app that only knows about v3 doesn't need to know that v1 ever existed.

```ts
stack.registerMigration({
  from: "com.example.myapp/note@1",
  to:   "com.example.myapp/note@2",
  migrate: (content) => ({ ...content, title: "" })
});

stack.registerMigration({
  from: "com.example.myapp/note@2",
  to:   "com.example.myapp/note@3",
  migrate: (content) => ({ ...content, pinned: false })
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
  id: string;                  // Crockford base-32, time-sortable, unique within a stack
  typeId: string;              // Versioned Type ID e.g. "com.example.myapp/note@2"
  createdAt: Date;
  updatedAt: Date;
  content: Record<string, unknown>;  // Validated against the Type's schema
  version: number;             // Increments on each write (for conflict detection)

  // --- Optional native fields ---
  parentId?: string;           // ID of a parent Record (for hierarchy/folders)
  entityId?: string;           // Author Entity, if different from stack owner
  appId?: string;              // App that created this Record
  deletedAt?: Date;            // Present if soft-deleted
  permissions?: Permission[];  // Access control (see Permissions)
  associations?: Association[]; // Tags, attachments, relationships
};
```

**Design principle:** Native fields are things the library needs to operate (routing, querying, syncing, hierarchy). Everything semantic and domain-specific goes in `content`.

---

## Associations

Tags, attachments, and relationships are unified under a single **Association** model. All three associate a Record with a labeled payload — the label carries semantic meaning (e.g. `"avatar"`, `"parent"`, `"reply-to"`).

```ts
type Association =
  | { kind: "tag";          label: string }
  | { kind: "attachment";   label: string; fileId: string; mimeType: string }
  | { kind: "relationship"; label: string; recordId: string };
```

**Examples:**
- A `contact` type uses `{ kind: "attachment", label: "avatar", fileId: "..." }` as a profile picture.
- A `tweet` type uses `{ kind: "relationship", label: "reply-to", recordId: "..." }` to reference another tweet.
- Any record can use `{ kind: "tag", label: "starred" }` for user-defined labels.

**Note:** `parentId` is a separate native field (not an Association) because hierarchical containment is fundamental enough to warrant indexing at the library level. Associations are for metadata and cross-references.

---

## Permissions

All Records are **private by default** — readable only by the stack owner. The `permissions` field is absent or empty on private records; there is no explicit `private` permission value. Permissions represent *grants* of access, not restrictions. Enforcement is the responsibility of the API adapter. The JSON and SQLite adapters ignore the permissions field.

```ts
// Absence of permissions (empty or undefined) = private, owner only.
type Permission =
  | { access: "public" }
  | { access: "entity"; entityId: string; read: boolean; write: boolean }
  | { access: "group";  groupId: string;  read: boolean; write: boolean };
```

Group permissions reference a `_group` Record by ID. The group may be a simple permission group (living in the stack owner's personal stack) or a collaborative group with its own stack — the permission model is the same either way.

**Permission resolution for the API adapter:**
- `private` — owner only
- `public` — any requester can read
- `entity` — check the requester's entityId directly
- `group` — fetch the referenced `_group` Record, walk its `relationship` associations to verify the requester is a member or admin

Cross-stack group resolution (where the `_group` Record lives in a different stack than the Record being accessed) requires the server to have read access to that stack.

---

## Versions

Version history is managed by the library as a side channel — apps do not manage it directly. On every `update()`, the library snapshots the previous state.

```ts
type RecordVersion = {
  version: number;
  content: object;
  updatedAt: Date;
  entityId?: string;   // Who made this change
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

| Adapter | Use case | Notes |
|---|---|---|
| **JSON files** | Portable, human-readable, backup/export | Slow queries (O(n) scan); may maintain an `_index.json` |
| **SQLite** | Local app storage, fast queries | Indexes associations, parentId, appId, etc. |
| **Server API** | Hosted/shared stacks | Enforces permissions and app identity |

All adapters support the full Record API. Performance guarantees differ; correctness does not.

---

## Attachments

Binary files are stored and retrieved through the library, abstracted away from the adapter:

```ts
stack.putAttachment(data: Blob | Buffer, mimeType: string): Promise<string>  // returns fileId
stack.getAttachment(fileId: string): Promise<Blob | Buffer>
```

A `fileId` is then referenced in an `Association` of kind `"attachment"`.

---

## Queries

Queries are expressed as a `Query` object passed to `stack.query()`. All adapters support the full query shape; performance guarantees differ.

### Filter

```ts
type Filter = {
  // Native fields
  typeId?: string | string[];
  parentId?: string | null;          // null = root records only
  appId?: string | string[];
  entityId?: string | string[];
  createdAt?: DateRange;
  updatedAt?: DateRange;

  // Association filters
  tags?: string[];                   // records that have ALL of these tags
  hasAttachment?: string;            // records with an attachment of this label
  relatedTo?: { recordId: string; label?: string };

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
    field: "createdAt" | "updatedAt" | "version";
    direction?: "asc" | "desc";
  };
  limit?: number;
  cursor?: string;    // Opaque cursor for page-based pagination
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
stack.delete(recordId)                  // soft delete — reversible
stack.delete(recordId, { hard: true })  // hard delete — permanent
```

Queries exclude soft-deleted Records by default. Opt in with:

```ts
stack.query({ filter: { includeDeleted: true } })
```

**Restore** always creates a new version with the old content — it never rewrites history. The act of restoring is itself part of the version history.

```ts
stack.restoreVersion(recordId, version)  // creates a new version, doesn't rewrite history
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
POST   /attachments           — upload a file, returns { fileId }
GET    /attachments/:fileId   — download a file
DELETE /attachments/:fileId   — delete a file
```

Attachments are uploaded first to get a `fileId`, then referenced in an Association when creating or updating a Record. This keeps all Record endpoints JSON-only.

**Upload format:** Send the binary data as the request body with `Content-Type` set to the file's MIME type. The server infers the MIME type from this header and stores it alongside the file.

```
POST /attachments
Content-Type: image/png
Authorization: Bearer <token>

<binary data>
```

**Attachment permissions** are governed by the Record(s) that reference them, not the attachment itself. If any Record referencing a `fileId` is accessible to the requester, the attachment is accessible.

### Entity

```
GET   /entity    — get the stack owner's entity record
PATCH /entity    — update it
```

A convenience alias for the owner entity rather than requiring clients to look it up by ID.

---

## Open Questions

- **Token issuance** — authentication mechanism for the API adapter is server-defined and out of scope for v1
- **Multi-stack patterns** — apps managing multiple stacks (personal + group stacks) will likely repeat common fan-out and merge patterns; a `StackWorkspace` abstraction is a likely future addition once real usage patterns emerge
