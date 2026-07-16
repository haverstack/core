# Stack Spec — Core Design

> Living document. Captures design decisions made so far.

---

## Overview

A **Stack** is a structured, portable personal or organizational data store. It provides a unified API for reading and writing **Records** regardless of the underlying storage backend. Apps integrate a single library and don't need to know or care how data is stored.

---

## Stack initialization

A Stack is created via an async factory that reads identity and timezone from the adapter.

```ts
// First run — create a new database with initial config
const adapter = await LocalAdapter.initialize({
  path: './my-stack.db',
  entityId: 'abc123', // required — owner entity ID
  timezone: 'America/New_York', // required — IANA timezone string
});

// Subsequent runs — open an existing database
const adapter = await LocalAdapter.open({ path: './my-stack.db' });

// Always the same — reads identity and timezone from the adapter
const stack = await Stack.create(adapter);
stack.ownerEntityId; // from adapter.ownerEntityId
stack.timezone; // from adapter.timezone
```

`LocalAdapter.initialize()` fails if the file already exists. `LocalAdapter.open()` fails if the file does not exist. This makes the distinction explicit and prevents silent config divergence.

Plugin and extension code that doesn't need to know the underlying backend should accept `StackClient` rather than the concrete `Stack` or `ScopedStack`. `StackClient` is the passable interface covering the full record API (`create`, `get`, `query`, `update`, `delete`, `undelete`, `associate`, `dissociate`, `setPermissions`, `getVersions`, `getVersion`, `restoreVersion`, `getAttachment`, `putAttachment`, `deleteAttachment`, `collectAttachmentGarbage`) plus a `features` getter. Both `Stack` and `ScopedStack` implement it.

**Stack identity** (`ownerEntityId`, `timezone`) is stored as a singleton `_config@1` record in the records table. Adapters expose these values as typed readonly properties (`adapter.ownerEntityId`, `adapter.timezone`) rather than as a generic key/value store.

**For the API adapter**, identity values are sourced from the discovery endpoint (`GET /.well-known/stack`) when the adapter is opened and cached for the session as adapter properties.

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

This gives roles for free via association labels, and membership is queryable and versioned like any other Record data. There is no role hierarchy beyond this single distinction — matching the scale a Group actually serves (a small, cohesive set of Entities), not a general-purpose permissions system:

- **`member`** — counted by group ACLs (`{ access: 'group', groupId, ... }` permission entries, unless the entry names `role: 'admin'`).
- **`admin`** — everything `member` gets, plus may manage the Group Record itself: update its content, add or remove roster (`member`/`admin`) associations, and delete it. An `admin` association implies `member` for every purpose.

**Role-gated group management.** Mutating a `_group` Record — `update`, `associate`/`dissociate` of roster associations, `setPermissions`, `delete`, `undelete` — requires the requester to be an `admin` of that Group, or the stack owner. This replaces the ordinary write-bit/grant check for `_group` Records specifically: membership rosters live on the very Record that write access would otherwise let a write-holder rewrite, so "can write this record" is deliberately not sufficient to add or remove members. `ScopedStack` enforces this.

**Bootstrap.** The creator of a `_group` Record is automatically stamped as its first `admin` (a `relationship` association added at create time) — no Group is ever management-orphaned. The stack owner can always manage any Group regardless of roster, per the owner's unconditional-access rule.

**Implementation note for the API adapter:** When enforcing group-based permissions, the server must resolve group membership by fetching the `_group` Record and walking its `relationship` associations. This requires the server to have read access to the stack where the `_group` Record lives.

**Open question, deliberately not resolved here:** the roles above describe who may manage the Group _Record_. A Group that holds its own key (a future direction for collaborative groups owning a Stack) will eventually need to answer "who may act _as_ the Group" — accept grants on its behalf, speak for it to other stacks. That's a distinct question from record management and isn't foreclosed by this definition.

---

### Grant

A Grant authorises one or more Entities to perform specific actions on Records of a given Type. Grants are modeled as Records of the built-in system type `_grant`, making them queryable, versioned, and subject to the same lifecycle as any other Record.

**Content fields:**

```ts
type GrantContent = {
  typeId: TypeId; // Which record type this grant covers
  actions: GrantAction[]; // Which actions are permitted
  granteeEntityId?: string; // Who the grant applies to. Absent = default grant (any authenticated entity).
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

The grantee lives in `content.granteeEntityId`, not `record.entityId`. `entityId` means "author" on every other Record in the system, and a `_grant` Record is always authored by the stack owner (the only caller of `grant()`) — never by the entity it names. A grant Record therefore carries no `entityId` of its own, consistent with the owner-authored-records invariant, and "everything this entity authored" queries (`filter: { entityId }`) don't pick up grants that merely name that entity.

`Stack.grant()` is the owner-facing helper for creating grant records:

```ts
// Grant a specific entity permission to create comments and manage their own
await stack.grant('bob-entity-id', [
  { typeId: 'com.example/comment@1', actions: ['create', 'read-own', 'update-own', 'delete-own'] },
]);

// Default grant — applies to any authenticated entity (no granteeEntityId in content)
await stack.grant(null, [{ typeId: 'com.example/comment@1', actions: ['create', 'read-own'] }]);
```

`Stack.listGrants(entityId?)` and `Stack.revoke(entityId, grants)` are the read/undo counterparts, both owner-facing like `grant()`:

```ts
await stack.listGrants(); // every grant record, any grantee
await stack.listGrants(null); // only default grants
await stack.listGrants('bob-entity-id'); // grants naming Bob, plus every default grant — what currently applies to him

// The inverse of grant(): soft-deletes the _grant record(s) matching entityId
// (null for a default grant) and each { typeId, actions } pair, matched by
// typeId baseId and action set — the same granularity grant() writes at.
await stack.revoke('bob-entity-id', [{ typeId: 'com.example/comment@1', actions: ['create'] }]);
```

A revocation is a soft delete like any other mutation — the owner can `undelete()` it the same as an accidental delete anywhere else (see [Versions](#versions)).

**Design decisions:**

- **No wildcard `typeId`**: there is no `*` or catch-all. Every grant is opt-in per type. Adding a new type never implicitly inherits existing grants — it starts default-deny.
- **Grants target the type family, not the exact version**: a grant naming `com.example/comment@1` also covers `com.example/comment@2` — matching is by `baseId`, derived from whichever form the grant's `typeId` was given in. This is what keeps a version bump from silently orphaning existing grants (previously, registering a migration broke every grant pinned to the old version, with no data change at all — grants are checked in memory _before_ any migration applies). `revoke()` matches at the same granularity.
- **Default grants** (grant content has no `granteeEntityId`): apply to any authenticated entity. Useful for "any logged-in user can comment" scenarios. Anonymous requesters (no `entityId`) are always denied, even under a default grant.
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

An `_attachment@1` record is created each time `stack.putAttachment()` or `scopedStack.putAttachment()` is called — even if the same bytes were previously uploaded. Multiple `_attachment@1` records may therefore exist for the same `fileId`, each with its own `filename`. The binary is stored only once (content-addressed deduplication), but each upload gets its own metadata record.

`mimeType` is not a per-record perspective the way `filename` is: it's a property of the `fileId` established by the first `_attachment@1` record ever created for it. Later uploads of the same bytes must declare a matching `mimeType` — a conflicting one is rejected with `StackValidationError` (422) — and once a record exists, none of `fileId`, `size`, or `mimeType` can be changed by `update()`; `filename` is the only mutable field. See [Attachments](#attachments) for the full rule and rationale.

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
  | 'record-ref' // Reference to another record by ID
  | 'file-ref'; // Reference to an attachment file ID (SHA-256 hex)

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

**`file-ref` fields are real references, not just strings that look like fileIds.** A `file-ref` value must be a well-formed fileId (SHA-256 hex) — validated at write time, though referential existence is not (the same stance as `record-ref`; upload-before-associate flows make strictness hostile). What `file-ref` buys over a plain `string` field holding the same value: the [`attachmentFileId` query filter](#queries), [`deleteAttachment()`'s reference check](#attachments), and attachment-access conveyance under `ScopedStack` all treat a top-level `file-ref` field as a real reference to the file, the same way an `attachment` Association is. An app that stores a fileId in a plain `string` field keeps working, but gets **none** of that — no delete protection, no access conveyance, no garbage-collection protection. Only top-level scalar `file-ref` fields are indexed this way (matching the content-filtering limit above); a `file-ref` nested in an array or object is validated but not indexed as a reference.

**Type identity:** Two Types are the same if their `id` matches (including version). Two stacks running the same app will have the same Type IDs and can rely on that for interop.

**Schema drift detection:** If two Records share a `typeId` but their Type definitions have different `schemaHash` values, that is unambiguously a bug — intentional changes always produce a new version number.

**Type compatibility:** Structural/duck-typed — a Type is **read-compatible** with a required schema if, for every required field, the candidate declares that same field as required, at a read-compatible kind. Array and object fields recurse: their `items`/`properties` must themselves be read-compatible. This licenses _consuming_ Records, not writing them — a consumer writing through a "compatible" view still has to validate against the candidate's full schema (its other required fields, which compatibility checking never inspects).

A field's kind is read-compatible with a required kind per this table (row = required kind, columns = candidate kinds accepted):

| required →   | `string` | `text` | `number` | `boolean` | `date` | `record-ref` | `file-ref` |
| ------------ | -------- | ------ | -------- | --------- | ------ | ------------ | ---------- |
| `string`     | ✓        | ✓      |          |           |        |              |            |
| `text`       | ✓        | ✓      |          |           |        |              |            |
| `number`     |          |        | ✓        |           |        |              |            |
| `boolean`    |          |        |          | ✓         |        |              |            |
| `date`       |          |        |          |           | ✓      |              |            |
| `record-ref` |          |        |          |           |        | ✓            |            |
| `file-ref`   |          |        |          |           |        |              | ✓          |

`string` and `text` are mutually read-compatible — both are strings at the value level, and the distinction is presentation/indexing intent. Every other kind requires an exact match; notably `date` is not compatible with `string`, since `date` carries a parse/validity guarantee a plain string doesn't.

Used by apps that want to work with Records regardless of exact Type, e.g. any Type with a required `text` or `string` field. Apps that care about semantics filter by exact `typeId`. Apps that want flexibility use `isCompatible()` — see `packages/core/src/schema.ts` for the authoritative implementation and `packages/core/tests/schema.test.ts` for its behavior under nesting and the string/text equivalence.

**System types** (reserved, library-defined): `_config@1`, `_entity@1`, `_app@1`, `_group@1`, `_grant@1`, `_attachment@1`. System types follow the same versioned ID format as user-defined types and can evolve using the same migration mechanism. All six are pre-seeded when a Stack is created via `Stack.create()` — they are always available without any setup by the caller.

### Type migrations

A Type's defining app is the only serious writer of its own types, so migration is **explicit and owner-driven**, not something that happens as a side effect of a read or an unrelated write. Disk state changes version only via a deliberate `migrateAll()` pass — the invariant is that all Records of a family sit at version N until the owning app moves them, so `query({ filter: { typeId } })` and grants targeting a type never silently miss not-yet-migrated records (see [Queries](#queries) and [Grant](#grant)).

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

- **`get()` and `query()` return Records exactly as stored** — their own `typeId` and `content`, with no implicit migration. This is what makes `query()` a reliable way to find every record of a family regardless of migration state (previously a divergence from `get()`, which migrated in memory by default).
- **`presentAt: 'latest'`** — an explicit opt-in on both `get()` and `query()` that applies the registered migration chain in memory before returning. Nothing is written to disk; this is a read-time convenience, never a persistence mechanism. Throws `StackMigrationError` rather than warning and returning a raw record when a matched Record's version can't be reconciled with what this app instance has registered (see stale-writer behavior, below).
- **`update()` never migrates.** It validates the merge-patched content against the Record's _own current_ stored Type — never the latest — and writes back at the same `typeId`. An unrelated content edit can never fold an invisible schema rewrite into the same version-history entry.
- **Path composition** — migrations between adjacent versions are automatically chained (v1→v2→v3), so apps only ever register one step at a time.
- **`migrateAll("com.example.myapp/note")`** is the _only_ way disk state changes version. It eagerly commits all pending migrations for a type family in one deliberate pass — call it at app startup after registering migrations, or after a schema change. Sweeps soft-deleted Records unconditionally (`includeDeleted: true` is not a caller option in either direction — see [Deletion](#deletion)), validates each migrated result against the target Type's schema before writing, and aborts immediately on the first validation failure (a buggy migration function is a bug to surface, not to paper over by skipping the offending records) — anything already committed earlier in the pass stays committed. Previous content is snapshotted to version history before each write.

**Stale-writer behavior.** A Record whose version this app instance can't reconcile — older than what it's registered _and_ not bridged by a migration path, or newer than anything it has ever `defineType()`'d — is an explicit error (`StackMigrationError`) under `presentAt: 'latest'`, not a silent pass-through. This covers both directions of "the same app at two versions" meeting via a shared stack: a stale binary encountering a record newer than it understands, or an app that's defined a later Type version but never registered the migration to reach it. Reading the Record as stored (the default, no `presentAt`) always succeeds regardless — the stale-writer signal only fires when the app explicitly asks for the migrated view and the library can't honestly provide one.

### Additive evolution within a version

Not every schema change needs a version bump. **Additive-in-place** changes — new optional fields only — can be added to a Type's schema without minting a new version, and are the default path for evolving a type family:

- **Readers ignore unknown fields** — validation already permits undeclared content fields.
- **Writers preserve unknown fields** — the merge-patch semantics of `update()` retain any field the caller didn't touch.

This is what makes duck-typed cross-app consumption (`isCompatible()`, see [Types](#types)) actually work in practice: most evolution needs no coordination at all, and consumers that were never taught about a field simply don't see it.

**A version bump is a consolidation point**, warranted when:

- a field becomes _required_ (paired with a migration that backfills a real value for existing records),
- a field's meaning changes, or
- the shape is restructured.

A schema accumulating many optional fields is a named smell that a consolidating bump is due — but the bump itself stays rare and semantic ("`@2` means `dueDate` is now guaranteed"), not a changelog entry for every field ever added. Bumping per addition costs a full-table rewrite per field, version-number noise, and — since records only reach a new version when the owning app next runs `migrateAll()` — doesn't even deliver per-record schema exactness in the interim; consumers face mixed-version data either way and need `baseId` queries plus duck typing regardless.

> **Not yet implemented:** a drift guard that mechanically enforces this boundary (accepting additive-in-place diffs, rejecting anything else with "bump the version"), and validation of migration function output against the target schema at _registration_ time (write-time validation, in `migrateAll()`, is the enforced backstop today).

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
  version: number; // Increments on each write. Powers rollback and soft-delete recovery; can optionally gate writes via ifVersion (see Versions)

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

### Record IDs

IDs are Crockford base-32, lowercase, exactly 12 characters — a 9-character timestamp prefix (so IDs are time-sortable: lexicographic order matches creation order) plus a 3-character random suffix, monotonically incremented for IDs generated in the same millisecond.

**Client-minted IDs are the default and stay supported.** `Stack.create()` accepts an optional `id`, so an app that needs the ID before the write round-trips (e.g. to reference it immediately) can supply its own; omit it and the library generates one. Nothing about this changes with a server in front of the stack — the client still mints the ID — but the server (and, locally, `Stack` itself) now validates what it's given rather than trusting it blindly:

- **Charset and length** — exactly 12 characters, lowercase Crockford base-32 (`0-9`, `a-z` excluding `i`, `l`, `o`, `u`). Violations → **400**.
- **Reserved prefix** — an `id` beginning with `_` is rejected; that namespace is reserved for system records (`_config`, `_entity`, etc. — see System types under [Types](#types)). Violations → **400**.
- **Duplicate ID** — an `id` that already exists in the stack → **409** (`StackConflictError`), never a silent overwrite.

A server MAY additionally reject an `id` whose timestamp prefix is implausibly far from server time (a clock-skew tolerance measured in hours, not years). This is optional: legitimate offline-created records carry an honest but stale prefix, so the trade-off is a per-deployment policy choice, not a spec mandate.

**In `@haverstack/core`**, the same rules are enforced locally so a client-minted ID behaves identically whether it travels over the wire or stays in-process:

- `Stack.create(typeId, content, { id })` validates charset, length, and the reserved prefix, and throws `StackConflictError` on a duplicate. This is a full-trust context (an embedded single-app stack, or the server's own code) — no clock-skew check.
- `ScopedStack.create()` — a grantee minting an ID — applies the same validation **plus** the timestamp-skew check, since a grantee is exactly the untrusted actor who could otherwise forge a sort position. The tolerance is configurable per Stack via `Stack.create(adapter, { idTimestampSkewMs })` (default 24 hours; pass `null` to disable).

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

**Reference creation is gated on `ScopedStack`:** an `attachment` association or file-ref content field requires file access, and a `relationship` association or `parentId` requires read access to the target — see Reference-creation gating under [Permissions](#permissions) for the full rule and its `_group`-roster carve-out. Plain `Stack` is unscoped and does not apply this.

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
  | { access: 'group'; groupId: string; role?: 'admin'; read: boolean; write: boolean };
```

Group permissions reference a `_group` Record by ID. The group may be a simple permission group (living in the stack owner's personal stack) or a collaborative group with its own stack — the permission model is the same either way. `role` narrows a group entry to admins only; absent `role` means any member qualifies (an `admin` association satisfies this too — see [Group](#group)).

**Permission resolution:**

- `private` — owner only
- `public` — any requester can read
- `entity` — check the requester's entityId directly
- `group` — fetch the referenced `_group` Record, walk its `relationship` associations to determine the requester's role (`admin`, `member`, or none); the entry is satisfied if `role: 'admin'` is set and the requester is an admin, or if `role` is absent and the requester is a member or admin

Cross-stack group resolution (where the `_group` Record lives in a different stack than the Record being accessed) requires the server to have read access to that stack.

### The `write` bit: a recoverability trust model

Record-level `write` stays a single coarse bit — no per-verb fencing (`update` vs `associate` vs `delete`) at the record level. That's a deliberate scale decision: per-record sharing among a small, cohesive group doesn't call for maintained per-verb ACLs. What makes one bit safe is this:

> **Anything a write-holder does, the owner can undo.** Recoverability is the backstop, not per-verb precision.

| Verb, via `write: true`    | Reversible?                 | How                                                                                                             |
| -------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `update`                   | Yes                         | Versioned — `restoreVersion()` undoes it                                                                        |
| `associate` / `dissociate` | Yes                         | Versioned (see [Versions](#versions)) — `restoreVersion()` restores prior associations                          |
| `restoreVersion`           | Yes                         | Update-shaped; itself creates a new, restorable version                                                         |
| `delete` (soft)            | Yes                         | `undelete()` reverses it — the owner can always undelete, regardless of who deleted (see [Deletion](#deletion)) |
| `delete` (hard)            | Never reachable via `write` | Owner-only, unconditionally — see below                                                                         |

Two operations sit outside the `write` bit entirely, regardless of grants:

- **Hard delete** is owner-only (see [Deletion](#deletion)) — it destroys the Record and its version history, so there's nothing left to undo. An irreversible verb has no place in a bit whose entire safety argument is recoverability.
- **`setPermissions()`** is owner-or-creator-only. A write-holder who is neither the owner nor the Record's creator cannot change who else can access it — otherwise a `write: true` grant would let its holder escalate to granting others access, defeating the point of scoping access in the first place. This is not a special case bolted onto `setPermissions` alone; it's the same pattern as hard delete: a privilege-bearing operation stays outside the coarse bit. (`restoreVersion()` reinforces this from the other direction — it restores `content` and `associations` but never `permissions`, so a content rollback can't silently change who has access either.)
- **`_group` Records** opt out of the write bit (and type-level grants) entirely, for every mutating verb including `setPermissions`. A Group's own `permissions`/grants govern who can _read_ it, not who can _manage_ it — membership rosters live on the very Record that write access would otherwise let a write-holder rewrite. See [Group](#group) for the `admin`-or-owner rule that replaces it here.

This is about the **served topology**: for `adapter-local`, direct adapter access is full trust and the permission model doesn't apply — `Stack` is unscoped by design. Record-level permissions exist for the requester on the far side of a server, who has no direct database access. For them, the `write` bit is the only fence, so what it permits has to hold up as a real policy surface — which is exactly why everything it reaches has to be undoable by the owner.

### Layer 2: Type-level grants

`_grant` records (see [Grant](#grant)) authorise Entities to perform actions across all Records of a given Type, without touching individual records. A read-any grant on `comment@1`, for example, makes all comments of that type readable by the grantee without setting `permissions` on each one.

`ScopedStack` checks both layers on every operation: if either the Record's own `permissions` or a matching `_grant` record permits the action, access is granted. The owner always has full access and bypasses both checks.

The two layers deliberately use different granularities. Record-level `write` is one coarse bit (above); grants are precise per verb (`update-own`/`update-any`, `delete-own`/`delete-any`, etc. — see [Grant](#grant)). Type-wide access for a third-party app warrants verb precision in a way per-record sharing among intimates doesn't. `associate()`/`dissociate()` don't get their own grant action — they ride `update-own`/`update-any`, the same as content changes, keeping the grant vocabulary from growing a verb for every mutation kind.

### Enforcement: `Stack.asEntity()`

The core library ships a permission-enforcing wrapper so server implementations don't need to reimplement this resolution logic. `stack.asEntity(entityId)` — `entityId` is `null` for an anonymous/unauthenticated requester — returns a `ScopedStack`: the same surface as `Stack`, but every operation is checked against both permission layers.

**`ScopedStack.create()`** additionally checks `_grant` records for a `'create'` action on the target type before allowing the Record to be written. Anonymous requesters are always denied. The owner always passes. The created Record's `entityId` is always set to the requester, so `-own` grants apply to it immediately.

**Reference-creation gating.** A `create` grant on a type authorizes writing Records of that type — it does not, by itself, authorize referencing arbitrary other Records or files through that Record. `ScopedStack.create()` and `ScopedStack.associate()` both additionally check that the requester may create the specific reference being written, since a reference elsewhere confers access (an `attachment` association or file-ref content field makes the referenced file downloadable via `getAttachment`; see [Attachment](#attachment)):

- **`attachment` associations and file-ref content fields** require file access: the requester is the owner, uploaded the file themselves (holds an `_attachment@1` Record for it), or can already read some Record referencing it. This is exactly `getAttachment()`'s own access rule — reference creation requires what reference possession would grant.
- **`relationship` associations and `parentId`** require read access to the target Record.
- **`tag` associations** carry no reference and are never gated.
- **`_group` roster associations are exempt** from the `relationship` check above — a roster association's `recordId` names an Entity, not a readable Record (see [Group](#group)), and roster mutation is already gated by the stricter admin-or-owner rule there.

A missing target and an existing-but-inaccessible one **always produce the same `StackPermissionError`**, with no distinguishing detail — otherwise the check itself becomes a confirmation oracle (e.g. for a guessed file hash: content-addressed `fileId`s mean a successful attach-then-read round-trip would otherwise confirm the stack holds those exact bytes). On `update()`, only file-ref fields actually present in the patch are checked — untouched fields carry no new reference.

`appId` and `permissions` are deliberately **not** gated by this: `appId` is self-reported, untrusted metadata everywhere (no verification mechanism exists yet — a foundation for future enforcement, per [App](#app)), never a permission input. `permissions` at create time is consistent with `setPermissions()`'s existing owner-or-creator policy — a contributor authoring a Record in your Stack can already widen its access up to and including `public`; create-time is not a new capability, just the same one exercised earlier.

Reading or writing a Record that exists but isn't accessible throws `StackPermissionError`; a missing Record throws `StackNotFoundError`, so callers can distinguish "not found" from "forbidden" (typically 404 vs 403 at the HTTP layer).

Plain `Stack` methods remain unscoped and perform no permission checks — correct for single-entity embedded use, where there's no requester distinct from the app itself. Use `asEntity()` when one `Stack` instance serves requests from multiple, possibly untrusted, entities, e.g. a server adapter.

`ScopedStack.query()`'s `total` is always `null`. The adapter's unfiltered count would otherwise leak the existence and cardinality of Records the requester can't read, even when the returned `records` array comes back empty. Computing an exact filtered count would require evaluating every match rather than just the returned page, so it's intentionally not attempted.

`ScopedStack`'s group-membership check only resolves `_group` Records living in the same stack as the Record being accessed — it does not yet implement the cross-stack case described above. A server relying on cross-stack groups must still handle that case itself.

---

## Versions

Version history is managed by the library as a side channel — apps do not manage it directly.

**One rule, no special cases:** every mutation of a Record — content (`update`), associations (`associate`/`dissociate`), permissions (`setPermissions`), soft delete, undelete — snapshots the Record's prior full state and bumps `version`. A mutation that changes nothing (re-adding an association that's already present, removing one that isn't there, setting a deep-equal permission set, deleting an already-deleted Record) is a no-op: no bump, no snapshot. Hard delete is the one exception — it destroys the Record and its version history outright, so there's nothing to snapshot.

```ts
type RecordVersion = {
  version: number;
  typeId: string; // The Record's typeId at the moment this version was snapshotted
  content: object;
  updatedAt: Date;
  entityId?: string; // Who made this change
  associations?: Association[]; // Present if the record had associations at snapshot time
  permissions?: Permission[]; // Present if the record had permissions at snapshot time
};
```

`typeId` makes a version entry interpretable regardless of migration state: a snapshot taken before a migration records the pre-migration type, so restoring it later doesn't mislabel `@1`-shaped content as `@2` (see [restoreVersion](#type-migrations) and the `_grant` baseId matching this enables independent of exactly which version a snapshot predates).

**API surface:**

- `stack.getVersions(recordId)` — retrieve version history
- `stack.restoreVersion(recordId, version, opts?)` — revert to a prior version. Restores `content`, `typeId`, and `associations` when the target snapshot has them, but **never restores `permissions`** — those are owner/creator territory (see [Permissions](#permissions)), and silently reverting an ACL as a side effect of a content rollback would be a surprise nobody wants. Permissions in a snapshot are for audit and deliberate owner action, not automatic restore.

### Optimistic concurrency (`ifVersion`)

`version` is not conflict detection by itself — it exists to power rollback and soft-delete recovery. Nothing reads or writes it unless a caller opts in. Every mutating method (`update`, `delete`, `undelete`, `associate`, `dissociate`, `setPermissions`, `restoreVersion`) accepts an optional `ifVersion`:

```ts
await stack.update(id, { title: 'New' }, { ifVersion: 5 });
// throws StackVersionConflictError if the record's current version ≠ 5, and changes nothing
```

- **Omitting `ifVersion` keeps last-writer-wins** — the pre-existing, unconditional behavior. Apps that don't care about races don't pay for this.
- On a mismatch, the call throws `StackVersionConflictError` carrying `recordId`, `expectedVersion`, and `actualVersion`, so a caller can re-fetch, inspect what actually won the race, and decide whether to retry. It is a distinct error type from `StackConflictError` — the two have different recovery stories (fix your input vs. retry after re-reading) and different HTTP statuses (see below), so they don't share a class.
- **The check is atomic at the adapter**, not a read-then-write in `Stack`: adapters implement it as part of the same write (e.g. `UPDATE ... WHERE id = ? AND version = ?`, inspecting the affected-row count) — doing the check in `Stack` alone would just move the race down a layer, since another writer could land between `Stack`'s read and its write.
- This covers every mutation path per the one-rule-no-special-cases versioning model above: a lost race on an association or permission change is caught exactly like a lost race on content.
- Over the wire, this is the `If-Match` header (see [API Adapter Wire Format § Records](#records)) — local and remote behave identically.

**Never silently dropped:** two writers racing past the same version without `ifVersion` (or a server race that outpaces `ifVersion` entirely) can still collide on the same version number when both snapshot their prior state. Rather than silently discarding the second snapshot — which would leave a hole in rollback history exactly where a conflict happened — adapters reject the collision loudly (`StackConflictError`), so the losing write fails outright rather than corrupting history.

The snapshot's content is validated against **the type it claims** (`typeId` as stored in the snapshot), not the Record's current type — a snapshot taken before a migration is `@1`-shaped, and validating it against a since-migrated `@2` schema would wrongly reject a legitimate restore. A snapshot that fails validation against its own claimed type — in-place schema drift, or a corrupted/buggy adapter — throws `StackValidationError` instead of being written back; restore is a recovery path, so it is not a backdoor around content validation.

Restoring a pre-migration snapshot therefore also restores its old `typeId`, leaving the Record legitimately **stale** rather than mislabeled. No forward-migration happens at restore time — migration functions are app code (see [Type migrations](#type-migrations)), so restore behaves the same locally as it does through the server-side restore endpoint, which cannot run them either. A stale restored Record self-heals the same way any other stale Record does: on the owning app's next `migrateAll()` sweep.

**Storage per adapter:**

- JSON: sibling file `{id}.versions.json`
- SQLite: `versions` table
- API: server snapshots automatically on every mutating endpoint (`PATCH /records/:id`, associations, permissions, delete, undelete); history is read via `/records/:id/versions`

---

## Adapters

### Interface split

The adapter contract is split into two focused interfaces that are composed into a single `StackAdapter`:

**`StackRecordAdapter`** — structured storage: capabilities, stack identity (`ownerEntityId`, `timezone`), all record/association/version/type methods, and optional lifecycle hooks (`flush`, `close`).

**`StackBlobAdapter`** — binary storage: `putAttachment`, `getAttachment`, `deleteAttachment`, an optional `listFiles()` capability, and optional lifecycle hooks.

```ts
type StackAdapter = StackRecordAdapter & StackBlobAdapter;
```

**Optional capabilities**, present on some adapters and not others, follow one pattern throughout: an optional interface method, checked for truthiness at the call site, with a described fallback when absent. `StackRecordAdapter.deleteUnreferencedAttachmentRecords()` (atomic reference check, [Attachments](#attachments)) and `StackBlobAdapter.listFiles()` (blob enumeration, used by [`collectAttachmentGarbage()`](#garbage-collection) to find bare-bytes orphans) are both this shape — no boolean flag in `capabilities`, just an optional method a caller checks for before using. `combineAdapters()` (below) preserves this: it forwards an optional method only when the underlying part actually implements it, never as a wrapper around a missing one.

### Package naming convention

Packages follow a naming convention that makes the adapter type discoverable:

- **`adapter-*`** — full `StackAdapter` (convenience packages covering both halves)
- **`record-adapter-*`** — `StackRecordAdapter` only
- **`blob-adapter-*`** — `StackBlobAdapter` only

### Adapter backends

| Package                 | Type   | Use case                                                 |
| ----------------------- | ------ | -------------------------------------------------------- |
| `adapter-local`         | full   | Local app storage — native SQLite + disk blobs           |
| `record-adapter-sqlite` | record | Node native SQLite (`node:sqlite`) records, FTS5, WAL    |
| `record-adapter-sqljs`  | record | Browser-only sql.js records, FTS4, pluggable persistence |
| `blob-adapter-disk`     | blob   | Content-addressed blobs on disk                          |
| `adapter-api`           | full   | Hosted/shared stacks via HTTP                            |
| `adapter-json`          | full   | Portable JSON files _(planned)_                          |

`adapter-local` is the batteries-included package for the common local case. It wraps `NativeSQLiteRecordAdapter` and `DiskBlobAdapter` and stores attachments in an `attachments/` subdirectory next to the database file. Bearer tokens, when used, live in a separate sibling file (`<path>.tokens`, via `NativeTokenStore`) — never inside the portable stack database.

Use `combineAdapters()` from `@haverstack/core` when you want different backends for records and blobs — for example, native SQLite records with S3 blob storage:

```ts
import { combineAdapters } from '@haverstack/core';
import { NativeSQLiteRecordAdapter } from '@haverstack/record-adapter-sqlite';
import { S3BlobAdapter } from '@haverstack/blob-adapter-s3'; // hypothetical

const record = await NativeSQLiteRecordAdapter.initialize({ path, entityId, timezone });
const blob = new S3BlobAdapter(bucketConfig);
const adapter = combineAdapters({ record, blob });
const stack = await Stack.create(adapter);
```

All adapters support the full Record API. Performance guarantees differ; correctness does not.

**`@haverstack/sqlite-shared`** is an internal, non-public package holding everything identical across the two SQLite-backed record adapters — schema DDL, `WHERE`/`ORDER` building, the cursor codec, row mappers, both FTS sanitizers, the storage-ownership lock, and (via a small `SqlExecutor` interface normalizing sql.js's and `node:sqlite`'s different call conventions) the actual CRUD/query/version/type/association/token logic itself. Each adapter implements only what's genuinely engine-specific: WASM init vs. `DatabaseSync` construction, pragma/WAL setup, and lifecycle. Keeping this in one place is what keeps a cursor minted by one SQLite-backed adapter decodable by another, and what keeps the two engines from silently drifting in behavior.

Both SQLite-backed adapters enable foreign-key enforcement (`PRAGMA foreign_keys = ON`) so that operations like `associate()` against a nonexistent record fail loudly (`StackNotFoundError`) instead of silently creating an orphan row.

**File compatibility:** both adapters produce standard SQLite files, so `record-adapter-sqlite` can open a stack created by `record-adapter-sqljs` — `open()` detects an FTS4 `records_fts` table (sqljs's dialect) and transparently rebuilds it as FTS5, once.

---

## Concurrency & storage ownership

A stack's backing storage (a SQLite file, a JSON directory) has exactly one owning process at a time. Multi-app access goes through a server implementation over the wire protocol (`adapter-api`, against `localhost` or a hosted provider) — never by pointing multiple apps at the same storage file directly. This is also the only topology in which permissions, grants, and `appId` attribution mean anything: `Stack` performs no permission checks, `ScopedStack` is opt-in, and `appId` is self-reported by the writing app, so direct storage access implies full trust over everything in the store, including grants and token hashes.

How each adapter honors the single-writer rule differs by what it actually is:

- **`record-adapter-sqlite`** (Node, real files) writes through `node:sqlite` under WAL journaling — page-level writes and crash safety are properties of the storage engine itself, not something the adapter has to implement. It still acquires a PID-stamped lock file beside the database on `open()`/`initialize()`, released on `close()`, so a second opener gets a clear, immediate error rather than discovering the trust-boundary problem the hard way; a stale lock (owning process no longer alive) is reclaimed automatically, and an explicit override is available for the rare case of PID reuse.
- **`record-adapter-sqljs`** (browser, no filesystem of its own) is a purely in-memory engine — it has no file, no PID, and no lock to speak of. Durability and multi-tab/multi-process coordination are the embedding host's concern entirely: the adapter calls an optional `persist(bytes) => Promise<void>` callback after every write, and the host wires that to OPFS, IndexedDB, or a download, with whatever locking that storage layer provides.
- **The planned whole-file `adapter-json`** is the adapter this guidance was originally written for: an adapter that reads its entire store into memory on open and rewrites it whole on every persist needs its own PID lock file (to fail loudly on double-open) and its own atomic temp-file-and-`rename()` persist (so a crash mid-write can't leave a torn, unreadable file) — `record-adapter-sqlite` no longer needs either, since WAL and real file locking already provide them.

---

## Attachments

Binary files are stored and retrieved through the library using **content-addressed storage**. A file's ID is the SHA-256 hash of its bytes, so uploading identical bytes twice returns the same `fileId` without writing a second binary copy. Each upload creates a new `_attachment@1` record (see [Attachment](#attachment)) regardless of deduplication, so metadata (mimeType, size, filename) is tracked per upload.

```ts
// Upload a file — returns a stable SHA-256 hex ID and creates an _attachment@1 record
const fileId = await stack.putAttachment(data: Uint8Array, mimeType: string, filename?: string): Promise<string>

// Fetch the binary
const data: Uint8Array = await stack.getAttachment(fileId)

// Delete the binary and its _attachment@1 metadata record(s)
// Throws StackConflictError if any record still references the file
await stack.deleteAttachment(fileId)
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

**`Stack` vs `ScopedStack` attachment methods:**

- `Stack.putAttachment(data, mimeType, filename?)` — owner-level upload. Creates an `_attachment@1` record with no `entityId`. No grant check.
- `ScopedStack.putAttachment(data, mimeType, filename?)` — entity-scoped upload. Requires a `create` grant on `_attachment@1`. The created record's `entityId` is set to the uploading entity.
- `Stack.putAttachmentBytes(data)` — owner-level, bytes only. Stores the file and returns its `fileId` without creating an `_attachment@1` record. No grant check.
- `ScopedStack.putAttachmentBytes(data)` — entity-scoped, bytes only. Gated identically to `ScopedStack.putAttachment()` (a `create` grant on `_attachment@1`): a bytes upload is only meaningful as a precursor to metadata creation, so the two share one authorization check. Anonymous requesters are always denied.

- `Stack.getAttachment(fileId)` — no permission check; always succeeds if the bytes exist.
- `ScopedStack.getAttachment(fileId)` — accessible if the requester is the owner, can read any record that references the file, or uploaded the file themselves and it hasn't been associated with a record yet. Throws `StackPermissionError` otherwise.

- `Stack.deleteAttachment(fileId)` — deletes bytes and all `_attachment@1` metadata records for the file (including soft-deleted ones). Throws `StackConflictError` if any record — **live or soft-deleted** — still references the file, either via an `attachment` Association or via a top-level `file-ref` content field (see [Types](#types)). A soft-deleted record is recoverable via `undelete()` (see [Deletion](#deletion)) and must find its attachments intact, so it counts as a reference exactly like a live one. Throws `StackNotFoundError` if the file doesn't exist.
- `ScopedStack.deleteAttachment(fileId)` — owner only. Throws `StackPermissionError` for non-owners. Delegates to `Stack.deleteAttachment()`.

**Atomicity of the reference check.** The reference check and the metadata-record deletes must happen as one unit — otherwise a concurrent `associate()` can add a new reference in the gap between them, leaving a dangling association after the delete completes. Adapters MAY implement `StackRecordAdapter.deleteUnreferencedAttachmentRecords(fileId, metadataTypeId)` to close this race (`Stack.deleteAttachment()` uses it when present, falling back to a non-atomic check-then-act sequence otherwise). Byte deletion always happens after the metadata step commits: a crash in between leaves orphaned bytes, which is harmless and later reclaimed by garbage collection, rather than a dangling reference, which is not.

**Deduplication:** Bytes are deduplicated — uploading the same content twice stores the binary only once. However, each call to `putAttachment()` creates a new `_attachment@1` record, so the same `fileId` may have multiple `_attachment@1` records from separate uploads.

**`mimeType` is a property of the `fileId`, not the uploader's perspective.** The first `_attachment@1` record created for a given `fileId` establishes its `mimeType`; this is the value later served as `Content-Type` when no `?contentType`/`?filename` override is given (see Download, below). A later upload of the same bytes is free to declare a matching `mimeType` — it creates its own record with its own `filename` and `entityId`, same as always — but a **conflicting `mimeType` is rejected with `StackValidationError` (422)** rather than stored: a contradictory execution claim (e.g. one uploader's `image/png` against another's `text/html` for byte-identical content) must not survive in the data to confuse the next reader or a downstream cache. `filename` has no such rule — it stays per-uploader, and the requester's own record's `filename` is what's served to them (see Download).

**Once created, an `_attachment@1` record's `fileId`, `size`, and `mimeType` are immutable — `filename` is the only field `update()` may change.** `fileId` and `size` describe the bytes themselves, so any attempted change is rejected (`StackValidationError`, 422). `mimeType`'s value was already pinned to the `fileId`'s established type at create time, so `update()` rejects any patch that touches it at all, including one that restates the same value — there's nothing a legitimate `mimeType` edit could accomplish that isn't already covered by the create-time rule above. To correct a wrongly-declared type, delete the attachment and re-upload: identical bytes hash to the same `fileId`, and the fresh first record establishes the corrected type.

### Garbage collection

Attachment bytes are only ever removed by an explicit `deleteAttachment(fileId)` call — normal app flows delete _records_, and nothing notices when the last record referencing a file goes away. `collectAttachmentGarbage()` is an explicit, owner-invoked sweep that finds and removes those orphans. It is **not** automatic reference-counting: auto-delete on last dissociate/record-delete would coupling every record write to blob lifecycle and would race without a transactional adapter.

```ts
stack.collectAttachmentGarbage(opts?: {
  graceMs?: number; // default: 24 hours
  dryRun?: boolean; // default: false
}): Promise<{ deleted: string[]; reclaimedBytes: number }>
```

**What counts as garbage:** a file is collectable only when _no_ record — live or soft-deleted — references it via an `attachment` Association or a `file-ref` content field. This is the same reference definition `deleteAttachment()` uses (above), and the same recoverability principle: nothing reachable from a soft-deleted (undelete-able) state gets destroyed.

**`_attachment@1` metadata records never themselves count as references** — otherwise nothing would ever be garbage — but a file's _newest_ metadata record (or, for bare bytes with no metadata record at all, the blob's own storage timestamp) must be older than `graceMs` to be collected. This protects the legitimate upload-then-associate window: a file just uploaded and not yet attached to anything is not yet garbage, just new.

**Bare-bytes orphans** — bytes stored by `putAttachmentBytes()`/`putAttachment()` with no `_attachment@1` record at all (e.g. a crash between storing bytes and writing metadata) — are only discoverable by enumerating the blob store directly, via the optional `StackBlobAdapter.listFiles()` capability (see [Adapters](#adapters)). An adapter that doesn't implement it still gets full protection for the common case (metadata-tracked files with no remaining reference); it simply can't find this rarer orphan class.

Deletion goes through `deleteAttachment()` itself, so its usual conflict check runs once more per file at delete time. A file that turns out to be referenced again (or already gone) by then is skipped, not treated as a sweep failure — the sweep always completes and reports what it actually collected.

`dryRun: true` computes and returns what _would_ be deleted, without deleting anything — useful for previewing a sweep before running it for real.

**`Stack` vs `ScopedStack`:**

- `Stack.collectAttachmentGarbage(opts?)` — owner-level, no permission check.
- `ScopedStack.collectAttachmentGarbage(opts?)` — owner only. Throws `StackPermissionError` for non-owners (including anonymous requesters). Delegates to `Stack.collectAttachmentGarbage()`.

---

## Queries

Queries are expressed as a `Query` object passed to `stack.query()`. All adapters support the full query shape; performance guarantees differ.

### Filter

```ts
type Filter = {
  // Native fields
  typeId?: string | string[];
  baseId?: string | string[]; // matches every version of a type family
  parentId?: string | null; // null = root records only
  appId?: string | string[];
  entityId?: string | string[];
  createdAt?: DateRange;
  updatedAt?: DateRange;

  // Association filters
  tags?: string[]; // records that have ALL of these tags
  hasAttachment?: string; // records with an attachment of this label
  relatedTo?: { recordId: string; label?: string };
  attachmentFileId?: string; // records that reference a specific attachment file ID, via an `attachment` Association or a top-level `file-ref` content field

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

`baseId` matches every version of a type family — resolved against registered Types (via `listTypes()`), not string-parsed from `typeId`, so it works regardless of which versions happen to exist. This is what fixes `typeId`-filtered queries silently missing not-yet-migrated older-version records under [explicit, owner-driven migration](#type-migrations): filter by `baseId` to see the whole family, or `typeId` for an exact version. Given both, they intersect. `Stack.query()` resolves `baseId` client-side before dispatching to the adapter — adapters and the wire protocol only ever see a concrete `typeId` set, so no adapter needs its own `baseId` concept. An unknown `baseId` returns an empty result set rather than throwing.

By default, `query()` (like `get()`) returns Records exactly as stored — see [presentAt: 'latest'](#type-migrations) to migrate results in memory instead.

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

Pagination is cursor-based rather than offset-based, so it works consistently across adapters and doesn't drift when records are inserted mid-page. A `cursor` that can't be decoded — an unknown sort field, a non-numeric sort value, or a corrupted/malformed blob — is a structurally malformed request, not a content-validation failure: adapters throw `StackQueryError`, which maps to **400** (code `bad_request`), not 422 and not a bare 500.

**`query()` always paginates.** An absent `limit` means one adapter-default page (50), never "every matching Record." Any caller — app code or library-internal — that needs the complete result set MUST follow `cursor` to exhaustion; treating a single `query()` call as exhaustive is a caller bug, not a pagination bug, however the pages are sized.

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
- **Native SQLite adapter** (`record-adapter-sqlite`) — indexes all native fields and association labels; supports content field queries and full-text search via FTS5
- **sql.js adapter** (`record-adapter-sqljs`, browser-only) — same query support as the native adapter, but full-text search via FTS4 (the sql.js WASM build's dialect)
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

**Hard delete is owner-only under `ScopedStack`.** Neither the record-level `write` bit nor `delete-own`/`delete-any` grants reach it — a non-owner requesting `{ hard: true }` gets `StackPermissionError`, regardless of what would otherwise authorize a delete. It's irreversible and destroys version history, so it stays outside every delegated-access vocabulary; only the owner can invoke it. Non-owners are always limited to soft delete, which remains recoverable. (Plain `Stack` is unscoped and trusted-by-definition, so this restriction applies only to the `asEntity()` wrapper.)

Queries exclude soft-deleted Records by default. Opt in with:

```ts
stack.query({ filter: { includeDeleted: true } });
```

**Undelete** reverses a soft delete. It's idempotent — calling it on a Record that isn't deleted succeeds and returns the Record unchanged, so a retried call after a network blip never fails. A missing Record throws `StackNotFoundError`; a hard-deleted Record is simply missing, so it throws the same way.

```ts
const record = await stack.undelete(recordId); // clears deletedAt, returns the record
```

Under `ScopedStack`, `undelete()` is gated the same way as `delete()` — the `write` bit or a `delete-own`/`delete-any` grant. Undelete is the inverse of soft delete, so the same capability governs both directions; granting one without the other would be backwards. (Hard delete's owner-only carve-out above is unaffected — it has no inverse.)

Undelete does not re-run migrations. If a soft-deleted Record's schema fell behind while it was deleted, it comes back stale — a legal state, self-healing the same way any other stale Record is, the next time it's written or `migrateAll()` sweeps it. `migrateAll()` includes soft-deleted Records in its sweep, so a Record can be migrated while deleted and come back current on undelete.

**Restore** always creates a new version with the old content and `typeId` — it never rewrites history. The act of restoring is itself part of the version history. The snapshot's content is validated against the type it claims (its own stored `typeId`, not the Record's current one) before being written back; a snapshot that fails that validation — schema drift, or a corrupted/buggy adapter — throws `StackValidationError` rather than being restored. Restoring an old snapshot does not migrate it forward, so a restored pre-migration Record comes back stale, same as undelete above — legal, and healed by the next `migrateAll()` sweep.

```ts
stack.restoreVersion(recordId, version); // creates a new version, doesn't rewrite history
```

---

## API Adapter Wire Format

The API adapter speaks REST over HTTP with JSON bodies and standard status codes. It is the only adapter where permissions are enforced and app identity can be validated.

### Discovery

A client hits this endpoint first to understand the server's identity and capabilities. The response supplies `entityId` and `timezone`, which the `APIAdapter` caches as `ownerEntityId` and `timezone` properties for the session.

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

(As a non-normative example, `@haverstack/core` defines a `StackTokenStore` contract — `createToken` / `lookupToken` / `listTokens` / `revokeToken` — and `record-adapter-sqlite` ships `NativeTokenStore`, a hashed-token reference implementation in its own file, separate from the records database, for servers that want DB-backed bearer tokens without rolling their own storage. This is optional tooling, not part of the wire protocol; other adapters and servers are free to manage tokens however they like, or not at all.)

### Error responses

Standard HTTP status codes are used throughout:

| Status  | Meaning                  | When                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **400** | Bad request              | `StackQueryError` (code `bad_request`) where the library can identify the malformed input itself — e.g. an undecodable pagination cursor; otherwise a lower-level parse failure (missing required field, invalid JSON) with no core-taxonomy equivalent                                                                                                                                                                                                                                       |
| **401** | Unauthorized             | Missing or invalid bearer token                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **403** | Forbidden                | `StackPermissionError` — record exists but the requester lacks access                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **404** | Not found                | `StackNotFoundError` — record or version does not exist                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **409** | Conflict                 | `StackConflictError` — operation blocked by a constraint violation (e.g. deleting an attachment still referenced by a record, a client-supplied `id` that already exists)                                                                                                                                                                                                                                                                                                                     |
| **412** | Precondition failed      | `StackVersionConflictError` (code `version_conflict`) — an `If-Match` precondition doesn't match the record's current version (see [Versions](#versions)). A distinct error type and status from `StackConflictError`/409, not a subtype of it — the two have different recovery stories                                                                                                                                                                                                      |
| **413** | Request entity too large | Attachment upload exceeds the server's size limit                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **422** | Unprocessable entity     | `StackValidationError` — request is syntactically valid but content fails schema validation (e.g. a required field has the wrong type)                                                                                                                                                                                                                                                                                                                                                        |
| **500** | Internal server error    | Reserved for `StackMigrationError` (code `migration`) — migration-graph corruption. No current code path produces this over the wire (migration-graph errors are thrown during client-side migration registration, never as a server response); the mapping exists for forward compatibility only. **Not** used as a generic catch-all: an unrelated server crash is a plain 500 with no wire error body, and clients must not infer `StackMigrationError` from status 500 alone (see below). |

The distinction between **400** and **422** matters for write endpoints (`POST /records`, `PATCH /records/:id`, `POST /records/:id/migrate`, `POST /types`): a 400 means the request couldn't be parsed at all; a 422 means the server understood the request but the content didn't satisfy the type schema.

#### Wire error body

Every non-2xx response whose failure maps to the core error taxonomy carries a JSON body of the shape:

```json
{
  "error": {
    "code": "permission" | "not_found" | "conflict" | "version_conflict" | "validation" | "migration" | "bad_request",
    "message": "human-readable description",
    "details": [ { "path": "title", "message": "expected string, got number" } ],
    "versionConflict": { "recordId": "rec-abc123", "expectedVersion": 5, "actualVersion": 7 }
  }
}
```

Each error code that carries extra structured data gets its own uniquely-named, uniquely-typed field, present only for that code — `details` for `code: "validation"` (`StackValidationError.errors`), `versionConflict` for `code: "version_conflict"` (`StackVersionConflictError`'s `recordId`/`expectedVersion`/`actualVersion` — the data an `ifVersion` retry loop needs: which record, what it expected, what actually won the race). This keeps each field's shape fixed rather than making any one field polymorphic across codes.

`code` is the authoritative discriminator — HTTP status is a transport hint (proxies and intermediaries rewrite statuses more often than bodies). Each core error class exposes the mapping as a static `code` (e.g. `StackPermissionError.code === 'permission'`), so a server serializes a caught error mechanically rather than via a hand-maintained switch, and `APIAdapter` reconstructs the same class from the response. Every wire code maps to exactly one status — `version_conflict` gets its own **412**, deliberately not sharing **409** with `conflict` — so when a response has no parseable wire error body (a foreign or legacy server, or a proxy that strips bodies but preserves status), `APIAdapter` still recovers the precise error from status alone for the unambiguous statuses above (400/403/404/409/412/422) — **not** for 500, since that status is a generic "unhandled server exception" signal and would misclassify ordinary server bugs as `StackMigrationError`. When neither the body nor the status yields a typed error, `APIAdapter` throws its own generic `APIAdapterError`.

This mapping is pinned by the shared conformance fixtures (`@haverstack/conformance-fixtures`) so `APIAdapter` and any server implementation can't drift on it independently.

### Records

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

**Optimistic concurrency:** `PATCH`, `DELETE`, `POST .../undelete`, `POST .../restore/:version`, and the association/permission endpoints below all accept an optional `If-Match` header:

```
PATCH /records/abc123
If-Match: "5"
```

When present, the server applies the mutation only if the record's current version equals the header's value; otherwise it returns **412** with a `version_conflict` wire error (see [Error responses](#error-responses)) and changes nothing. Omit the header to keep unconditional last-writer-wins behavior — this is opt-in, so callers that don't need it don't pay for it. See [Versions](#versions) for the corresponding `Stack`/`StackClient` API (`ifVersion`).

`POST /records` accepts a full record body, including an optional client-supplied `id` — see [Record IDs](#record-ids) for the validation and duplicate-conflict rules the server applies.

`POST /records/:id/migrate` is the only way a record's `typeId` changes after creation. Body: `{ "toTypeId": "...", "content": {...} }` — the full post-migration content, computed client-side by the type's owning app (migration functions are app code, not server code) and validated by the server against `toTypeId`'s schema before writing. This is what `stack.update()` uses to commit a pending lazy migration alongside a content patch (a content-only `PATCH` can't carry a `typeId` change), and what `stack.migrateAll()` uses for each record in a batch pass.

### Permissions

```
GET  /records/:id/permissions        — get current permissions
PUT  /records/:id/permissions        — replace all permissions (empty array = private)
```

Both endpoints use the envelope `{ "permissions": [...] }` as the request/response body. `PUT` accepts the same optional `If-Match` precondition described under [Records](#records).

**Response envelope:**

```json
{
  "records": [...],
  "cursor": "opaque-string-or-null",
  "total": 142
}
```

### Versions

The server snapshots a record's state automatically on every mutating endpoint — content, associations, permissions, delete, undelete (see [Versions](#versions) for the full rule) — there is no client-initiated endpoint to write a version directly.

```
GET  /records/:id/versions            — list all versions (newest first)
GET  /records/:id/versions/:version   — get a specific version
POST /records/:id/restore/:version    — restore a version (creates new version, no rewrite)
```

`POST .../restore/:version` accepts the same optional `If-Match` precondition described under [Records](#records).

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

`POST`/`DELETE` accept the same optional `If-Match` precondition described under [Records](#records).

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

`POST /attachments` requires the same authorization as creating an `_attachment@1` record: `401` for anonymous/missing tokens, `403` if the requester lacks a `create` grant on `_attachment@1`. A bytes upload is only meaningful as a precursor to metadata creation, so the two share one authorization requirement.

Returns `413 Request Entity Too Large` if the payload exceeds the server's configured limit (default 50 MB, controlled by `MAX_ATTACHMENT_BYTES`).

The SDK's `Stack.putAttachment()` and `ScopedStack.putAttachment()` perform both steps automatically. Direct HTTP callers must create the `_attachment@1` record separately if metadata is needed.

**Download:** Two optional query parameters control the response metadata and, when both are supplied, allow the server to skip the `_attachment@1` database lookup entirely:

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
3. The **first-recorded** `mimeType` on an `_attachment@1` record for the file (see [Attachments](#attachments)) — deterministic regardless of how many records exist for the `fileId` or which requester is asking, since conflicting `mimeType`s are rejected at write time and can never coexist.
4. `application/octet-stream`, if none of the above apply.

**Dangerous-type forcing applies to the result of that resolution, not to whichever source produced it** (#66) — a server that forces only the `?contentType` case and leaves the other two sources unguarded has a spec-conformance gap, not a defensible partial implementation. Compute the candidate first, _then_ apply the policy below to whatever came out:

- **Safe list** — passes through unforced: `image/*` (**except** `image/svg+xml`), `video/*`, `audio/*`, `application/pdf`, `text/plain`, `application/octet-stream`. Checked against the MIME type's base (parameters like `; charset=...` stripped, comparison case-insensitive), so neither casing nor a parameter can smuggle an unsafe type past the check.
- **Everything else** is forced to `Content-Type: application/octet-stream` with `Content-Disposition: attachment` — forcing the content type alone is not sufficient, since disposition determines whether a browser treats the response as inline-renderable at all.
- **`X-Content-Type-Options: nosniff` is sent on every attachment download response**, forced or not — without it, browsers may sniff an `application/octet-stream` body back into the dangerous type the forcing just removed, undoing the downgrade.

`@haverstack/core` exports the canonical implementation of this resolution and policy — `resolveAttachmentDownloadContentType()`, `isSafeAttachmentContentType()`, `inferContentTypeFromFilename()`, and the `NOSNIFF_HEADER_NAME`/`NOSNIFF_HEADER_VALUE` constants — so server implementations share one safe-list rather than each re-deriving it.

The filename in `Content-Disposition` is taken from `?filename` if given, else the requester's own `_attachment@1` record (if one exists), falling back to the first record's filename otherwise.

**Delete:** Owner only. Returns `409 Conflict` if any record in the stack still references the file (i.e. has it in an `attachment` association or its content references the `fileId`). The bytes and all `_attachment@1` metadata records for the file are removed atomically on success.

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
