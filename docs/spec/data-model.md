# Data Model

Records, IDs, associations, types, and queries. For who may read or write them, see [Access control](./access-control.md); for version history and deletion, see [Versioning & deletion](./versioning.md).

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
  version: number; // Increments on each write. Powers rollback and soft-delete recovery; can optionally gate writes via ifVersion (see Versioning & deletion)

  // --- Optional native fields ---
  parentId?: string; // ID of a parent Record (for hierarchy/folders)
  entityId?: string; // Author Entity. A scoped write always stamps it, so absent means an unscoped Stack wrote the Record (see Access control)
  appId?: string; // Software that created this Record, reverse-DNS e.g. "com.example.myapp". Self-reported; never a permission input (see Identity)
  principalId?: string; // The authenticated principal, when it isn't the author — a delegated app's own DID. Absent means the writer authenticated as the author (see Identity)
  updatedBy?: string; // Who performed the most recent mutation. Unlike entityId, it moves with every write (see Authorship and attribution)
  updatedVia?: string; // The principal behind that mutation, when it isn't updatedBy
  deletedAt?: Date; // Present if soft-deleted
  unlistedAt?: Date; // Present if withheld from enumeration — reachable by get(), absent from query()/the feed by default (see Access control)
  permissions?: Permission[]; // Access control (see Access control)
  associations?: Association[]; // Tags, attachments, relationships
};
```

**Design principle:** native fields are things the library needs to operate (routing, querying, syncing, hierarchy). Everything semantic and domain-specific goes in `content`.

### Authorship and attribution

Two different questions, answered by two different pairs of fields.

**`entityId` and `principalId` describe the Record.** `entityId` is its author, stamped once by `create()`; it never moves, because "whose Record is this" does not change when someone else edits it. `principalId` is the principal behind that create. Together they are the Record's provenance, and `entityId` is what every `-own` grant resolves against — so a later editor never acquires `-own` standing over what they edited.

**`updatedBy` and `updatedVia` describe the latest mutation.** Every mutation restamps them: `updatedBy` is the requester (the subject), and `updatedVia` names the principal beside it only when the two differ, exactly as `principalId` does for the create. At version 1 the two pairs agree, since a Record's first actor is its author; from version 2 they diverge whenever anyone but the author writes.

Because a [version snapshot](./versioning.md#version-history) captures the Record as it stood at that version, each snapshot carries the actor that produced it. **A version history is therefore a record of both states and actors**, and the live Record answers for the current version.

- **Absent means unknown, never "the author".** An unscoped `Stack` names no requester, so it writes no actor — and clears any the Record carried, rather than leaving the previous one in place to be read as this one.
- **Neither is a permission input.** No grant, permission entry or gate resolves against `updatedBy`. It is an audit fact, not an authority one, and reading it as authority would let a write-holder acquire standing by touching a Record.
- **Both are assigned from the authenticated session** and ignored on input, on the same terms and for the same reason as `entityId` and `principalId` — see [Wire format § Records](./wire-format.md#records).
- **`restoreVersion()` stamps the restorer.** A rollback is a write by whoever performs it, so it never restores the stamp along with the content — the same carve-out that keeps it from restoring `permissions`.

### Record IDs

IDs are Crockford base-32, lowercase, exactly 12 characters: a 9-character timestamp prefix (so lexicographic order matches creation order) plus a 3-character random suffix, monotonically incremented for IDs generated in the same millisecond.

**Client-minted IDs are the default and stay supported.** `Stack.create()` accepts an optional `id`, so an app that needs the ID before the write round-trips can supply its own; omit it and the library generates one. A server in front of the stack doesn't change this — the client still mints the ID — but the receiver validates it rather than trusting it:

- **Charset and length** — exactly 12 characters, lowercase Crockford base-32 (`0-9`, `a-z` excluding `i`, `l`, `o`, `u`). Violations → **400**.
- **Reserved prefix** — an `id` beginning with `_` is rejected; that namespace is reserved for system records (`_config`, `_entity`, etc. — see [System types](#system-types)). Violations → **400**.
- **Duplicate ID** — an `id` that already exists in the stack → **409** (`StackConflictError`), never a silent overwrite.

A server MAY additionally reject an `id` whose timestamp prefix is implausibly far from server time (a clock-skew tolerance measured in hours, not years). This is optional: legitimate offline-created records carry an honest but stale prefix, so it's a per-deployment policy choice, not a spec mandate.

**IDs are guessable, and nothing here tries to fix that.** The prefix decodes to the creation millisecond exactly, and same-millisecond IDs increment rather than re-randomise, so holding one ID from a batch yields its siblings. Both properties are the point — the first is what makes IDs sortable, the second is what keeps them sortable within a millisecond — and 12 characters is a deliberate ceiling, since an ID is meant to be typed by a human and to keep a URL short enough not to be auto-shortened when shared. Widening the suffix would buy little (it does nothing about siblings) and randomising it collides too often at three characters. What closes the gap instead is refusing to confirm a candidate: see [Access control § Errors and information exposure](./access-control.md#errors-and-information-exposure). The duplicate-`id` conflict above is the one confirmation that survives, deliberately — it is what makes a create idempotent under retry — and it is bounded by the skew check and visible to the owner, since a probe has to write a record to ask.

The same rules are enforced locally, so a client-minted ID behaves identically whether it travels over the wire or stays in-process:

- `Stack.create(typeId, content, { id })` validates charset, length, and the reserved prefix, and throws `StackConflictError` on a duplicate. This is a full-trust context (an embedded single-app stack, or the server's own code) — no clock-skew check.
- `ScopedStack.create()` — a grantee minting an ID — applies the same validation **plus** the timestamp-skew check, since a grantee is exactly the untrusted actor who could otherwise forge a sort position. The tolerance is configurable per Stack via `Stack.create(adapter, { idTimestampSkewMs })` (default 24 hours; pass `null` to disable).

## Associations

Tags, attachments, and relationships are unified under a single **Association** model. All three associate a Record with a labeled payload — the label carries semantic meaning (e.g. `"avatar"`, `"parent"`, `"reply-to"`).

```ts
type Association =
  | { kind: 'tag'; label: string }
  | { kind: 'attachment'; label: string; fileId: string }
  | { kind: 'relationship'; label: string; recordId: string };
```

**Examples:**

- A `contact` type uses `{ kind: "attachment", label: "avatar", fileId: "..." }` as a profile picture.
- A `tweet` type uses `{ kind: "relationship", label: "reply-to", recordId: "..." }` to reference another tweet.
- Any record can use `{ kind: "tag", label: "starred" }` for user-defined labels.

`parentId` is a separate native field (not an Association) because hierarchical containment is fundamental enough to warrant indexing at the library level. Associations are for metadata and cross-references.

**Reference creation is gated on `ScopedStack`:** an `attachment` association or file-ref content field requires file access, and a `relationship` association or `parentId` requires read access to the target — see [Reference-creation gating](./access-control.md#reference-creation-gating). Plain `Stack` is unscoped and does not apply this.

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

**`date` fields validate against an ISO 8601 shape, not bare `Date.parse`** — `YYYY-MM-DD`, optionally extended with `THH:mm:ss`, optional fractional seconds, and an optional `Z`/numeric-offset suffix. A regex pins the shape; `Date.parse` then runs as a calendar sanity check on top of it (catching e.g. an invalid month). `Date.parse` alone also accepts engine-dependent, non-ISO formats (`"March 1 2020"`), which would let cross-runtime stacks disagree about what's valid and produce non-canonical stored values.

**`file-ref` fields are real references, not just strings that look like fileIds.** A `file-ref` value must be a well-formed fileId (SHA-256 hex) — validated at write time, though referential existence is not (the same stance as `record-ref`; upload-before-associate flows make strictness hostile). What `file-ref` buys over a plain `string` field holding the same value: the [`attachmentFileId` query filter](#filter), [`deleteAttachment()`'s reference check](./attachments.md#deleting-attachments), and attachment-access conveyance under `ScopedStack` all treat a top-level `file-ref` field as a real reference to the file, the same way an `attachment` Association is. An app that stores a fileId in a plain `string` field keeps working but gets none of that — no delete protection, no access conveyance, no garbage-collection protection. Only top-level scalar `file-ref` fields are indexed this way (matching the content-filtering limit above); a `file-ref` nested in an array or object is validated but not indexed as a reference.

**Type identity:** two Types are the same if their `id` matches (including version). Two stacks running the same app will have the same Type IDs and can rely on that for interop.

### Schema drift detection

`defineType()` on an `id` that already has a stored Type is checked against it, rather than silently replacing it — same `schemaHash` as stored is unambiguously the same schema (a different `schemaHash` for the same `typeId` with no version bump is the exact corruption `schemaHash` exists to catch):

- **Identical schema** (`schemaHash` matches) — a no-op; the stored Type is returned unchanged, `createdAt` untouched. Calling `defineType()` for every Type at every app startup is therefore cheap, not a rewrite each time.
- **Identical schema, different `name`** — always persists (display metadata, not schema), `createdAt` still preserved.
- **Different schema** — legal only if the change is a pure [additive-in-place evolution](#additive-evolution-within-a-version): new _optional_ fields only, recursively into `object` properties and `array` items; nothing removed, no field's `kind` changed, no field's `required` flipped in either direction. An illegal change throws `StackSchemaDriftError` (wire: **409**, code `schema_drift`) naming each violation — the remedy is always a new version (`defineType('...@n+1', ...)` + `registerMigration()`), never redefining the same `id` in place.

`POST /types` (see [Wire format § Types](./wire-format.md#types)) applies the same check server-side, so the wire path can't silently replace a Type either.

### Type cache

`Stack` caches every Type it fetches or defines in memory, keyed by versioned `id` — populated by `getType()`, `defineType()`, and `listTypes()`. Since a Type's schema is immutable once defined (a legal schema change always gets a new `id` via a version bump), the cache is never invalidated, only added to — `create()`, `update()`, and `restoreVersion()` validate against the cached entry instead of re-fetching the Type on every write. Over the API adapter this removes a `GET /types/:id` round trip from every write after a type's first use in the process. `listTypes()` refreshes the cache wholesale, which is the explicit way to pick up a `name`-only rename made by another writer — the one field `defineType()` permits changing without a version bump.

### Type compatibility

Structural/duck-typed — a Type is **read-compatible** with a required schema if, for every required field, the candidate declares that same field as required, at a read-compatible kind. Array and object fields recurse: their `items`/`properties` must themselves be read-compatible. This licenses _consuming_ Records, not writing them — a consumer writing through a "compatible" view still has to validate against the candidate's full schema (its other required fields, which compatibility checking never inspects).

**Two distinct relations, easy to conflate:** schema drift detection (above) answers _"may this schema replace that one under the same `id`?"_ — evolution legality. Type compatibility answers _"may a consumer expecting this shape read Records of that Type?"_ — read compatibility. They deliberately disagree on `text`/`string`: read-compatible (both are strings at the value level) but **not** evolution-legal — a stored `kind: 'string'` field silently becoming `kind: 'text'` is exactly the kind of change a version bump should surface, even though every existing reader could still consume the value.

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

`string` and `text` are mutually read-compatible — the distinction is presentation/indexing intent. Every other kind requires an exact match; notably `date` is not compatible with `string`, since `date` carries a parse/validity guarantee a plain string doesn't.

Apps that care about semantics filter by exact `typeId`; apps that want flexibility (e.g. "any Type with a required `text` field") use `isCompatible()` — see `packages/core/src/schema.ts` for the authoritative implementation and `packages/core/tests/schema.test.ts` for its behavior under nesting and the string/text equivalence.

### System types

Reserved, library-defined types: `_config@1` ([Stack initialization](../spec.md#stack-initialization)), `_entity@1`, `_app@1`, `_group@1` ([Identity](./identity.md)), `_grant@1` ([Access control](./access-control.md#type-level-grants)), and `_attachment@1` ([Attachments](./attachments.md)). System types follow the same versioned ID format as user-defined types and can evolve using the same migration mechanism. All six are pre-seeded when a Stack is created via `Stack.create()` — always available without any setup by the caller.

### Type migrations

A Type's defining app is the only serious writer of its own types, so migration is **explicit and owner-driven**, not a side effect of a read or an unrelated write. Disk state changes version only via a deliberate `migrateAll()` pass or a per-record `commitMigration()` call — the invariant is that a Record's `typeId` never moves except through one of these two, so `query({ filter: { typeId } })` and grants targeting a type never silently miss not-yet-migrated records.

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

- **`get()` and `query()` return Records exactly as stored** — their own `typeId` and `content`, with no implicit migration. This is what makes `query()` a reliable way to find every record of a family regardless of migration state.
- **`presentAt: 'latest'`** — an explicit opt-in on both `get()` and `query()` that applies the registered migration chain in memory before returning. Nothing is written to disk; this is a read-time convenience, never a persistence mechanism. Throws `StackMigrationError` when a matched Record's version can't be reconciled with what this app instance has registered (see stale-writer behavior below).
- **`update()` never migrates.** It validates the merge-patched content against the Record's _own current_ stored Type — never the latest — and writes back at the same `typeId`. An unrelated content edit can never fold an invisible schema rewrite into the same version-history entry.
- **Path composition** — migrations between adjacent versions are automatically chained (v1→v2→v3), so apps only ever register one step at a time.
- **`migrateAll("com.example.myapp/note")`** eagerly commits all pending migrations for a type family in one deliberate pass — call it at app startup after registering migrations, or after a schema change. It sweeps soft-deleted and unlisted Records unconditionally (`includeDeleted`/`includeUnlisted` are not caller options in either direction — see [Deletion](./versioning.md#deletion) and [Unlisted records](./access-control.md#unlisted-records)), validates each migrated result against the target Type's schema before writing, and aborts immediately on the first validation failure (a buggy migration function is a bug to surface, not to paper over by skipping the offending records) — anything already committed earlier in the pass stays committed. Previous content is snapshotted to version history before each write.
- **`commitMigration(id, toTypeId, content)`** is the single-record counterpart, changing one Record's `typeId` and `content` together in one step. Unlike `migrateAll()`, `content` here is supplied by the caller rather than produced by a registered `Migration` function — the client-side app that owns `toTypeId` computes it, and the library validates it against `toTypeId`'s schema exactly as `create()`/`update()` validate against a schema. This is what backs the wire's `POST /records/:id/migrate` (see [Wire format](./wire-format.md#records)). Under `ScopedStack` it is **owner-acting-alone**, matching `migrateAll()`'s own absence from `StackClient` — no grant or record-level `write` substitutes for it (see [Access control](./access-control.md#type-level-grants)). Previous content and `typeId` are snapshotted to version history first, same as `migrateAll()`.

  Because `content` is a full replacement written under a new `typeId`, a migration commit is create-shaped at the destination and update-shaped over the Record as it stands, and owes both sets of integrity checks. DID bindings are held to immutability across the union of the two families' binding fields — a card can neither shed its `did` by migrating out of `_entity`/`_app` nor pick one up on the way in — and to uniqueness in the destination family (see [Identity § DID bindings](./identity.md#did-bindings)). An `_attachment@1` Record's `fileId`, `mimeType` and `size` stay immutable, and a Record arriving from outside that family is held to the same mimeType-establishment check `create()` applies. Migrating _into_ `_group` is refused outright: a group's `admin` roster entry is stamped at creation and a migration cannot stamp one, so it would produce a group nobody but the owner can manage — version-to-version migration within `_group` stays open and carries the existing roster with it.

  **`migrateAll()` applies these same checks**, on the same shared write path. That a `Migration` function is app code rather than a request body is not a trust boundary here: the app calling `commitMigration()` is the same app that registered the function, and neither is entitled to move a DID binding or repoint an attachment. `registerMigration()` also places no constraint on `from` and `to` sharing a `baseId`, so a registered path can itself cross type families — which is precisely what these checks are about. A migration function that would violate one aborts the pass like any other validation failure.

**Stale-writer behavior.** A Record whose version this app instance can't reconcile — older than what it's registered _and_ not bridged by a migration path, or newer than anything it has ever `defineType()`'d — is an explicit error (`StackMigrationError`) under `presentAt: 'latest'`, not a silent pass-through. This covers both directions of "the same app at two versions" meeting via a shared stack. Reading the Record as stored (the default, no `presentAt`) always succeeds regardless — the stale-writer signal only fires when the app explicitly asks for the migrated view and the library can't honestly provide one.

### Additive evolution within a version

Not every schema change needs a version bump. **Additive-in-place** changes — new optional fields only — can be added to a Type's schema without minting a new version, and are the default path for evolving a type family:

- **Readers ignore unknown fields** — validation already permits undeclared content fields.
- **Writers preserve unknown fields** — the merge-patch semantics of `update()` retain any field the caller didn't touch.

This is what makes duck-typed cross-app consumption (`isCompatible()`, above) work in practice: most evolution needs no coordination at all, and consumers that were never taught about a field simply don't see it.

**A version bump is a consolidation point**, warranted when:

- a field becomes _required_ (paired with a migration that backfills a real value for existing records),
- a field's meaning changes, or
- the shape is restructured.

A schema accumulating many optional fields is a named smell that a consolidating bump is due — but the bump itself stays rare and semantic ("`@2` means `dueDate` is now guaranteed"), not a changelog entry for every field ever added. Bumping per addition costs a full-table rewrite per field and version-number noise, and — since records only reach a new version when the owning app next runs `migrateAll()` — doesn't even deliver per-record schema exactness in the interim; consumers face mixed-version data either way and need `baseId` queries plus duck typing regardless.

The boundary between "accept in place" and "bump the version" is exactly what `defineType()`'s [schema drift detection](#schema-drift-detection) mechanically enforces — a diff, not the hash alone, since the hash necessarily changes on any legal additive diff too.

> **Not yet implemented:** validation of migration function output against the target schema at _registration_ time (write-time validation, in `migrateAll()`, is the enforced backstop today).

### Reserved content keys

Undeclared content fields are permitted by design (above), with three exceptions: **`__proto__`, `constructor`, and `prototype` are rejected as top-level content keys** — on `create()` and in an `update()` patch alike — with `StackValidationError` (422).

They name JavaScript's object machinery rather than a field, and the two write paths disagree about them: a merge patch to `__proto__` reaches the prototype setter instead of setting a field, so the write silently does nothing, while the same key through `create()` stores as an ordinary property. Refusing all three makes the two paths agree, and says so out loud instead of accepting a write that will quietly vanish.

This is a `Stack` invariant, not an adapter or server concern — it holds for every backend and for `ScopedStack`, which delegates (the layering of [System types](#system-types) and `_config`'s protections). Nested occurrences are not rejected: they survive the JSON round trip as inert own properties, since `JSON.parse` creates `__proto__` as a data property rather than invoking the setter.

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
  principalId?: string | string[];
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

**A `content` filter value of `null` means "the field is absent or stored as `null`"** — not "match nothing." Plain equality (SQL `= NULL`, or JS `===` against a possibly-absent key) is never true for a missing field, which would make `{ content: { x: null } }` silently return an empty result. Every adapter, including test doubles, implements `IS NULL` / missing-path semantics for a `null` filter value: it matches a record whose content omits the key entirely and one that stores a literal `null` alike, since from the caller's side both mean "no value here."

`baseId` matches every version of a type family — resolved against registered Types (via `listTypes()`), not string-parsed from `typeId`, so it works regardless of which versions happen to exist. This is what keeps `typeId`-filtered queries from silently missing not-yet-migrated older-version records under [explicit, owner-driven migration](#type-migrations): filter by `baseId` to see the whole family, or `typeId` for an exact version. Given both, they intersect. `Stack.query()` resolves `baseId` client-side before dispatching to the adapter — adapters and the wire protocol only ever see a concrete `typeId` set. An unknown `baseId` returns an empty result set rather than throwing.

By default, `query()` (like `get()`) returns Records exactly as stored — see [`presentAt: 'latest'`](#type-migrations) to migrate results in memory instead.

**`query()` never returns the `_config` record**, regardless of filter — it's addressable only by ID, via `get('_config')` or the adapter's own typed `ownerEntityId`/`timezone` properties (see [Stack initialization](../spec.md#stack-initialization)). This is the one exception to "adapters are storage engines, `Stack` is the invariant layer": the exclusion must live in the adapter's own query predicate (a `WHERE` clause, or the equivalent for an in-memory adapter) rather than be post-filtered by `Stack`, since post-filtering after the adapter applies `limit` would silently under-fill a page. Every adapter — including test doubles — implements this exclusion directly; it is not optional convention.

**Unlisted Records are excluded by default too**, the same posture as soft-deleted ones: `includeUnlisted` opts a query back in, and — unlike `includeDeleted` — `ScopedStack` restricts that opt-in to the owner acting alone. See [Unlisted records](./access-control.md#unlisted-records).

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

**`sort.field` and `sort.direction` are validated, not merely typed.** The `'asc' | 'desc'` and three-field types are a compile-time contract only; a request arriving over the wire (a server mapping `?sort=`/`?direction=`) or from a delegated app supplies raw strings. A SQLite record adapter interpolates the direction into its `ORDER BY`, so `Stack.query()`/`ScopedStack.query()` reject a field or direction outside the enumerated set with `StackQueryError` (**400**, `bad_request`) before it reaches an adapter — the same posture as a malformed cursor. The value never reaches SQL as anything but one of the two keywords.

**`query()` always paginates.** An absent `limit` means one adapter-default page (50), never "every matching Record." Any caller — app code or library-internal — that needs the complete result set MUST follow `cursor` to exhaustion; treating a single `query()` call as exhaustive is a caller bug, not a pagination bug, however the pages are sized.

**`cursor: null` is the only end-of-results signal. A page may be empty while `cursor` is non-null** — possibly several in a row — and a caller that stops on an empty page is the same truncation bug as one that stops after the first page. The case is reachable, not theoretical: a [permission-scoped](./access-control.md) query reads a bounded window of stored Records per call and returns only the ones the requester may read, so a low-visibility requester scanning a large Stack legitimately gets `{ records: [], cursor: "..." }` until the window reaches something they can see. The same holds for any filter an adapter applies after paging. Loop on `cursor`, never on `records.length`.

**A permission-scoped query reports `total: null`.** The count of matching Records, unfiltered, would reveal how many Records exist that the requester cannot read — the cardinality of what the permission check just hid. `ScopedStack.query()` therefore always reports `null` rather than a number, and so does every response on the wire (see [Wire format § Response envelope](./wire-format.md#response-envelope)). A `total` is only ever a number on a direct, unscoped `Stack.query()` in-process, where there is no permission boundary to leak across.

### Capability-gated filters

`content` filtering and `search` depend on adapter capabilities (see [Adapter capabilities](./adapters.md#adapter-capabilities)). `query()` fails loud rather than silently widening: `Stack.query()` checks `filter.content`/`filter.search` against `adapter.capabilities` before dispatching, and throws `StackQueryError` (`bad_request`/400) if the adapter hasn't declared the matching capability — local and remote behave identically. A `search` that sanitizes to nothing (a bare `*`, punctuation-only input) is treated as a legitimate zero-match query rather than an omitted filter — matching nothing is honest; silently returning the full table is not.

**Sanitization bounds a search's grammar, not its cost.** The FTS sanitizers strip the operators that make a query pathological to parse, but a syntactically ordinary search over a large index can still be expensive to execute, and both SQLite engines run synchronously in-process — there is no way to interrupt one from inside the call. Full-text search is therefore best-effort on cost: fine on a personal Stack, where the only session a slow query blocks is the caller's own, and a server-side concern the moment one process serves many requesters. See [Wire format § Bounding query cost](./wire-format.md#bounding-query-cost) for what a server owes here and the `timeout` error it may answer with.
