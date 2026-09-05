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

### Backdating on import

`Stack.create()` also accepts `createdAt`/`updatedAt` (`BackdatableCreateRecordOptions`) so an app can import an existing corpus with its real dates instead of every record landing stamped with the import moment:

- **Unconditional on unscoped `Stack.create()`** — the same full-trust context as the `id` option above.
- **Owner-only on `ScopedStack.create()`.** Refused to everyone but the stack owner acting alone (undelegated, authenticated as themselves — the same `ownerActingAlone` tier that already gates hard delete, `commitMigration()`, and `includeUnlisted`): a grantee, or a delegated app acting for the owner, could otherwise forge a sort position through `createdAt` the same way the `id` skew check exists to stop it forging one through `id`. `ScopedStack.create()` refuses both fields outright for anyone else.
- **Owner-authenticated only, over the wire.** `POST /records` may carry `createdAt`/`updatedAt` when the request authenticates as the stack owner acting alone. Unlike `entityId`/`principalId`, this is **not** inherited from `ScopedStack` for free: those are silently overridden, while `createdAt`/`updatedAt` are refused outright, and every client sends both fields on every create (a record body is a whole record). A server must therefore drop them from a non-owner body itself — forwarding one unfiltered turns an ordinary grantee create into a `StackPermissionError` rather than a create stamped with the current time. See [Wire format § Records](./wire-format.md#records).
- **`id` and `createdAt` must agree.** Omit `id` and it's derived from `createdAt`'s timestamp, so the two can't diverge. Supply both, and they're checked against each other using the same `idTimestampSkewMs` tolerance the `id`-vs-current-time check above uses (default 24 hours; `null` disables this check too) — disagreement beyond that tolerance throws `StackValidationError` rather than silently diverging. Supplying `id` alone, with no `createdAt`, is unaffected: that stays a pure position choice, exactly as before this option existed — including for the owner, whose plain `id`-only creates through `ScopedStack` still get the ordinary `id`-vs-current-time check, not this one.
- **`updatedAt` defaults to `createdAt`**, not to the actual current time, so a plain import doesn't fabricate a fake edit and inflate version history. Supplying an `updatedAt` earlier than `createdAt` is a validation error — including when `createdAt` was left to default to now.
- **Both fields must be valid, representable Dates.** An `Invalid Date` (what `new Date()` yields for a malformed date string, a common shape for a bad row in an imported corpus) is a `StackValidationError`, not a record: its `getTime()` is `NaN`, and every comparison against `NaN` is false, so an unchecked one would switch off the ordering and skew checks above rather than fail them. The representable range is the range a record ID's 9-character timestamp prefix can encode — `1970-01-01T00:00:00.000Z` through `3084-12-12T12:41:28.831Z` — since a `createdAt` outside it has no ID that can agree with it. Content genuinely dated outside that window belongs in the record's own content fields, not in `createdAt`.
- **Backdated records are invisible to an `updatedAt` cursor.** A backdated record's `updatedAt` predates its import by construction, so a consumer syncing incrementally by `filter.updatedAt.after` never sees it arrive — which is the point (an import is not a recent edit), but it means an import is picked up by a full corpus read, not by a change cursor.

## Associations

Tags, attachments, and relationships are unified under a single **Association** model. All three associate a Record with a labeled payload — the label carries semantic meaning (e.g. `"avatar"`, `"parent"`, `"reply-to"`).

```ts
type Association =
  | { kind: 'tag'; label: string }
  | { kind: 'attachment'; label: string; fileId: string }
  | { kind: 'relationship'; label: string; target: RelationshipTarget };

type RelationshipTarget =
  | { scope: 'record'; recordId: string; stackUrl?: string }
  | { scope: 'entity'; entityId: string }
  | { scope: 'external'; ns: string; id: string };
```

**Examples:**

- A `contact` type uses `{ kind: "attachment", label: "avatar", fileId: "..." }` as a profile picture.
- A `tweet` type uses `{ kind: "relationship", label: "reply-to", target: { scope: "record", recordId: "..." } }` to reference another tweet.
- Any record can use `{ kind: "tag", label: "starred" }` for user-defined labels.

`parentId` is a separate native field (not an Association) because hierarchical containment is fundamental enough to warrant indexing at the library level. Associations are for metadata and cross-references.

### Relationship targets

A relationship's `scope` names **which identifier space its value belongs to**. The three are not interchangeable: the same string can be a Record ID in one and a DID in another, and matching across them would make a group roster look like a record reference.

- **`record`** — a Record. `recordId` is unique within one stack only, so a reference to a Record in a _different_ stack carries that stack's `stackUrl` alongside it. An absent `stackUrl` means this stack; it is not a wildcard, and a filter that omits it does not match a target that carries one.
- **`entity`** — a "who", as a DID. This is what [group rosters](./identity.md#group) are made of: membership names identities, which mean the same thing in every stack, rather than the local Records that happen to describe them.
- **`external`** — something outside the stack entirely. `ns` names the scheme that interprets `id` — `"atproto"`, `"activitypub"`, `"email"`, `"url"`, anything — and is part of the association's identity, so the same `id` under two namespaces is two associations. Haverstack expresses the reference; the app or adapter interprets it. No protocol is privileged, and nothing in core dereferences one.

**A target names exactly one thing, exactly one way.** Every part of a target that names something must be a non-empty string, and a target whose `scope` is outside these three is rejected with `StackValidationError` — a discriminated union is a compile-time promise, and a Record arriving from a request body or a foreign server has made no such promise. Where absence is meaningful it is the only way to say so: this stack is named by omitting `stackUrl`, never by sending an empty one, and a whole namespace by omitting an external `id`. An empty string would claim a name while carrying none, and be stored and matched as though it were absent.

Association identity is `(kind, label)` plus the payload: `fileId` for an attachment, and the whole target for a relationship. Two relationships differing in any target field are two associations, and `dissociate()` removes only the one it names exactly.

**Reference creation is gated on `ScopedStack`:** an `attachment` association or file-ref content field requires file access, and a `relationship` naming a Record _in this stack_ — plus `parentId` — requires read access to the target. The other target arms are ungated; see [Reference-creation gating](./access-control.md#reference-creation-gating) for why that is safe rather than a hole. Plain `Stack` is unscoped and does not apply this.

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

**Array and object fields** are schema-validated on write and reachable by query: a content filter key is a path, and an array along it is matched element-wise (see [Filter](#filter)).

**`date` fields validate against an ISO 8601 shape, not bare `Date.parse`** — `YYYY-MM-DD`, optionally extended with `THH:mm:ss`, optional fractional seconds, and an optional `Z`/numeric-offset suffix. A regex pins the shape; `Date.parse` then runs as a calendar sanity check on top of it (catching e.g. an invalid month). `Date.parse` alone also accepts engine-dependent, non-ISO formats (`"March 1 2020"`), which would let cross-runtime stacks disagree about what's valid and produce non-canonical stored values.

**`file-ref` fields are real references, not just strings that look like fileIds.** A `file-ref` value must be a well-formed fileId (SHA-256 hex) — validated at write time, though referential existence is not (the same stance as `record-ref`; upload-before-associate flows make strictness hostile). What `file-ref` buys over a plain `string` field holding the same value: the [`attachmentFileId` query filter](#filter), [`deleteAttachment()`'s reference check](./attachments.md#deleting-attachments), and attachment-access conveyance under `ScopedStack` all treat a top-level `file-ref` field as a real reference to the file, the same way an `attachment` Association is. An app that stores a fileId in a plain `string` field keeps working but gets none of that — no delete protection, no access conveyance, no garbage-collection protection. Only top-level scalar `file-ref` fields are indexed this way; a `file-ref` nested in an array or object is validated, and reachable by a content filter path, but not indexed as a reference — so it gets no delete protection, access conveyance or GC protection. **Indexing a content field, whether as a reference or [for sorting](#sorting-by-a-content-field), reaches top-level scalars only**, while query reach extends to depth: they are separate mechanisms, and one rule covers both.

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
- **`presentAt: 'latest'`** — an explicit opt-in on both `get()` and `query()` that applies the registered migration chain in memory before returning. Nothing is written to disk; this is a read-time convenience, never a persistence mechanism. It is a property of the app instance that registered the chain, so it never travels: a server [rejects a request carrying `presentAt`](./wire-format.md#records) rather than dropping it. Throws `StackMigrationError` when a matched Record's version can't be reconciled with what this app instance has registered (see stale-writer behavior below).
- **`update()` never migrates.** It validates the merge-patched content against the Record's _own current_ stored Type — never the latest — and writes back at the same `typeId`. An unrelated content edit can never fold an invisible schema rewrite into the same version-history entry.
- **Path composition** — migrations between adjacent versions are automatically chained (v1→v2→v3), so apps only ever register one step at a time.
- **`migrateAll("com.example.myapp/note")`** eagerly commits all pending migrations for a type family in one deliberate pass — call it at app startup after registering migrations, or after a schema change. It sweeps soft-deleted and unlisted Records unconditionally (`includeDeleted`/`includeUnlisted` are not caller options in either direction — see [Deletion](./versioning.md#deletion) and [Unlisted records](./unlisted.md)), validates each migrated result against the target Type's schema before writing, and aborts immediately on the first validation failure (a buggy migration function is a bug to surface, not to paper over by skipping the offending records) — anything already committed earlier in the pass stays committed. Previous content is snapshotted to version history before each write.
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

### Undefined values in a patch

`update()` takes a merge patch: an omitted field keeps its current value, and a field set to `null` is removed (RFC 7396). `undefined` is neither, and there is no third meaning left for it to carry — so **a top-level patch key whose value is `undefined` is rejected with `StackValidationError` (422)**. This is an `update()` rule only: `create()` and `commitMigration()` take a whole content object, where an undefined field is simply a field the record does not have, and the schema's own required-field check already speaks to it.

It cannot arrive over the wire — JSON has no `undefined`, and `JSON.stringify` omits the key rather than emitting one — so every occurrence is an in-process caller spreading a partial object, meaning either "leave this alone" or "remove this" and spelling neither. Accepting it would resolve the ambiguity twice over, differently each time: storage drops the key on serialization, landing on the first, while the checks that ask whether a patch _names_ a field land on the second. Those checks are load-bearing — [binding immutability](./identity.md#did-bindings), [attachment field immutability](./attachments.md#the-_attachment-record-type), and `ScopedStack`'s owner-only fence on `_app` bindings all read the key as a claim on the field. A write-holder patching an `_app` card with `{ did: undefined }` would be refused for repointing a DID it never sent, and the refusal would be a permission error naming a field the caller did not set.

This is a `Stack` invariant, so every adapter inherits it. `ScopedStack.update()` additionally applies it ahead of its own binding fences, so a patch carrying `undefined` is a validation error for every requester rather than a validation error for the owner and a permission refusal for everyone else.

### Content field names

A content filter key is a **dot-separated path** (see [Filter](#filter)), so a field named `emails.value` and a path reaching `value` inside `emails` would be the same string asking two different questions. The ambiguity is removed from the field name rather than from the path: **a content field name may not contain `.`, `[`, `]`, `$`, `"`, `*`, or `#`** — rejected with `StackValidationError` (422) on `create()`, in an `update()` patch, and on `commitMigration()`.

**This holds at every depth**, unlike the three reserved keys above: a nested field named `b.c` makes the path `a.b.c` ambiguous exactly as a top-level `a.b` does. The check therefore walks undeclared subtrees too — they are precisely the fields no schema promised anything about — bounded by the same nesting depth validation already applies.

`defineType()` applies the same rule to **declared** field names, recursively through `object` properties and `array` items, with the same error. A schema is a promise that a field is meaningful; declaring one no filter could ever name breaks that promise at definition time rather than at query time.

The reserved set is wider than what SQLite's JSON path grammar treats as syntax today (`.`, `[`, `]`, `$`, `"`). `*` and `#` are held back against a path grammar that later grows a wildcard or a last-element form. Reserving a character costs nothing while no record contains one and costs every stored record afterward, so the choice is deliberately made early and wide.

The escape-convention alternative — a filter key of `emails\.value` meaning the literal field — was rejected because it fails silently in the one case that matters: app code building a key from a variable field name forgets to escape and gets a different question answered, with no error anywhere. A write-time rule fails loudly, at the moment a caller can still choose another name.

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
  relatedTo?:
    | { label: string; target?: RelationshipTargetPattern }
    | { label?: string; target: RelationshipTargetPattern };
  attachmentFileId?: string; // records that reference a specific attachment file ID, via an `attachment` Association or a top-level `file-ref` content field

  // Content fields (exact match; the key is a dot-separated path)
  content?: { [key: string]: unknown };
  contentPresent?: string[]; // paths that must hold a value

  // Full-text search (capability varies by adapter)
  search?: string;
};

type DateRange = {
  before?: Date;
  after?: Date;
};
```

**`relatedTo` names a label, a target, or both — never neither**, and a filter naming neither is rejected with `StackQueryError` rather than widening to every Record carrying a relationship. Its target follows the same naming rules as a stored one (above), checked the same way. A `RelationshipTargetPattern` is the association's own target shape with the parts a query may leave open. Each half is a pattern: a bare `label` matches every target under it; an `external` target with no `id` matches the whole namespace, which is how a syndication tool asks what it has already published. A `record` target with no `stackUrl` matches only local targets — absence names this stack rather than acting as a wildcard, so a Record referenced in someone else's stack is reachable only by naming that stack. Matching is exact within a scope and never across scopes.

**"Carries any relationship at all" is deliberately not expressible.** `tags` and `hasAttachment` have no match-any form either, so a relationship one would be the odd exception rather than a missing convenience — and a filter that can encode to nothing is a filter that can silently widen a query when it crosses the wire. The type refuses the empty filter rather than defining it, and `Stack.query()` refuses it again at runtime, where a filter decoded from query parameters is a plain object the type never saw.

**`contentPresent` asks whether a path holds a value at all**, which a filter value cannot: a value matches what is there, never whether anything is. It lists paths, all of which must hold a value — an intersection, like `tags` — and an empty list filters nothing, like an empty `tags`. A path holds a value when **at least one non-null value is reachable at it**, so it reads an array element-wise exactly as a `content` filter does: `{ contentPresent: ['emails.value'] }` matches a contact with an address in any of its `emails`, and a path reaching only nulls, an empty array, or nothing at all holds no value.

`contentPresent` and a `null` `content` filter answer opposite questions but are **not strict complements where a path is multi-valued**: `tags: [null, 'x']` satisfies "something there is null" and "something there is present" alike. That falls out of element-wise matching rather than being a special case, and the alternative — making one of them quantify over every element while the other quantifies over some — would make the pair harder to reason about than the overlap does.

The motivating query is a listing: an article's `publishedAt` is optional, so drafts are `{ content: { publishedAt: null } }` and published articles are `{ contentPresent: ['publishedAt'] }`. Neither is a value match, and a redundant `draft` boolean beside the date — two fields that can disagree — is what a type would otherwise have to carry.

#### Nested content paths

**A content filter key is a path**, its segments separated by `.`: `{ content: { 'emails.value': 'ada@example.com' } }` asks which records hold that value at `value` inside `emails`. Field names cannot contain `.` (see [Content field names](#content-field-names)), so a key never means both a path and a literal name, and no escape convention is needed to tell them apart.

**An array along the path is matched element-wise.** `contact@1` stores `emails` as an array of `{ value, label }`, and the question that motivates paths at all — which contact holds this address — is that shape. Traversal and containment are therefore one feature rather than two: a segment applies to each element of an array it meets, and the final comparison does the same, so `{ content: { tags: 'starred' } }` matches a record whose `tags` array contains `'starred'`. A record storing a scalar where another stores an array is matched by the same filter either way.

A path that descends through a scalar, or through a field that isn't there, reaches no value and matches nothing — it is not an error. A path may be at most **32 segments**; longer is `StackQueryError` (400), as is an empty segment (`a..b`) or a segment containing a reserved character. Those are structural faults in the request, refused rather than answered with an empty result, on the same reasoning as a malformed cursor.

**A segment is a value, never syntax.** An adapter resolving a path MUST carry each segment as a bound parameter matched against a key, rather than assembling it into a path expression — so no field name a write would accept can be reinterpreted as syntax, and no key can make the statement itself malformed. The 32-segment cap is what keeps that statement inside the engine's own limits: a SQLite adapter walks a segment with two `json_each` joins, and 32 segments is the longest path that fits SQLite's 64-table join limit. The cap and the generated shape move together — a longer path is refused because it could not be executed, not merely because it is unusual.

**Multi-segment keys are gated on `nestedContentQuery`**, separately from `contentFieldQuery` — see [Capability-gated filters](#capability-gated-filters).

**Nested fields are not indexed, and depth multiplies cost.** A path filter is an unindexed walk of every candidate record's JSON: the grammar is bounded, the execution time is not. It is a harsher bucket than full-text search, which at least runs against an index — here each segment fans out across every element of an array it meets, so a deep path over records holding large arrays costs the product of those widths, and both SQLite engines run it synchronously in-process with no way to interrupt one from inside the call. On a personal stack the only session it slows is the caller's own; a server serving many requesters owes the bound described in [Wire format § Bounding query cost](./wire-format.md#bounding-query-cost), with `StackTimeoutError` as the answer, and should treat path depth as an input worth limiting below the cap.

**A `content` filter value of `null` means "no value at the path, or a value that is `null`"** — not "match nothing." Plain equality (SQL `= NULL`, or JS `===` against a possibly-absent key) is never true for a missing field, which would make `{ content: { x: null } }` silently return an empty result. Every adapter, including test doubles, matches a record whose path reaches nothing and one that stores a literal `null` alike, since from the caller's side both mean "no value here." A _missing intermediate_ therefore matches too: `{ content: { 'address.city': null } }` matches a record with no `address` at all, one whose `address` has no `city`, and one storing `city: null`. So does an empty array along the path, which reaches no value by the same reading.

`baseId` matches every version of a type family — resolved against registered Types (via `listTypes()`), not string-parsed from `typeId`, so it works regardless of which versions happen to exist. This is what keeps `typeId`-filtered queries from silently missing not-yet-migrated older-version records under [explicit, owner-driven migration](#type-migrations): filter by `baseId` to see the whole family, or `typeId` for an exact version. Given both, they intersect. `Stack.query()` resolves `baseId` client-side before dispatching to the adapter — adapters and the wire protocol only ever see a concrete `typeId` set, and a server [rejects a request carrying `baseId`](./wire-format.md#records) rather than dropping it. An unknown `baseId` returns an empty result set rather than throwing.

By default, `query()` (like `get()`) returns Records exactly as stored — see [`presentAt: 'latest'`](#type-migrations) to migrate results in memory instead.

**`query()` never returns the `_config` record**, regardless of filter — it's addressable only by ID, via `get('_config')` or the adapter's own typed `ownerEntityId`/`timezone` properties (see [Stack initialization](../spec.md#stack-initialization)). This is the one exception to "adapters are storage engines, `Stack` is the invariant layer": the exclusion must live in the adapter's own query predicate (a `WHERE` clause, or the equivalent for an in-memory adapter) rather than be post-filtered by `Stack`, since post-filtering after the adapter applies `limit` would silently under-fill a page. Every adapter — including test doubles — implements this exclusion directly; it is not optional convention.

**Unlisted Records are excluded by default too**, the same posture as soft-deleted ones: `includeUnlisted` opts a query back in, and — unlike `includeDeleted` — `ScopedStack` restricts that opt-in to the owner acting alone. See [Unlisted records](./unlisted.md).

### Sorting and pagination

```ts
type Query = {
  filter?: Filter;
  sort?:
    | { field: 'createdAt' | 'updatedAt' | 'version'; direction?: 'asc' | 'desc' }
    | { contentField: string; direction?: 'asc' | 'desc' }; // see Sorting by a content field
  limit?: number;
  cursor?: string; // Opaque cursor for page-based pagination
};
```

Pagination is cursor-based rather than offset-based, so it works consistently across adapters and doesn't drift when records are inserted mid-page. A `cursor` that can't be decoded — an unknown sort field, a non-numeric sort value, or a corrupted/malformed blob — is a structurally malformed request, not a content-validation failure: adapters throw `StackQueryError`, which maps to **400** (code `bad_request`), not 422 and not a bare 500.

**A sort names either a native column or a content field, never both**, and a request naming both is rejected with `StackQueryError` (**400**) rather than resolved in one direction. They are two members rather than one widened `field` because a content field may be named `version`, `createdAt` or `updatedAt`, and a `'content.publishedAt'` prefix would collide with the [path separator](#filter) a filter key is split on.

**`sort.field` and `sort.direction` are validated, not merely typed.** The `'asc' | 'desc'` and three-field types are a compile-time contract only; a request arriving over the wire (a server mapping `?sort=`/`?direction=`) or from a delegated app supplies raw strings. A SQLite record adapter interpolates the direction into its `ORDER BY`, so `Stack.query()`/`ScopedStack.query()` reject a field or direction outside the enumerated set with `StackQueryError` (**400**, `bad_request`) before it reaches an adapter — the same posture as a malformed cursor. The value never reaches SQL as anything but one of the two keywords.

**`query()` always paginates.** An absent `limit` means one adapter-default page (50), never "every matching Record." Any caller — app code or library-internal — that needs the complete result set MUST follow `cursor` to exhaustion; treating a single `query()` call as exhaustive is a caller bug, not a pagination bug, however the pages are sized.

**`cursor: null` is the only end-of-results signal. A page may be empty while `cursor` is non-null** — possibly several in a row — and a caller that stops on an empty page is the same truncation bug as one that stops after the first page. The case is reachable, not theoretical: a [permission-scoped](./access-control.md) query reads a bounded window of stored Records per call and returns only the ones the requester may read, so a low-visibility requester scanning a large Stack legitimately gets `{ records: [], cursor: "..." }` until the window reaches something they can see. The same holds for any filter an adapter applies after paging. Loop on `cursor`, never on `records.length`.

**A permission-scoped query reports `total: null`.** The count of matching Records, unfiltered, would reveal how many Records exist that the requester cannot read — the cardinality of what the permission check just hid. `ScopedStack.query()` therefore always reports `null` rather than a number, and so does every response on the wire (see [Wire format § Response envelope](./wire-format.md#response-envelope)). A `total` is only ever a number on a direct, unscoped `Stack.query()` in-process, where there is no permission boundary to leak across.

### Sorting by a content field

`sort.contentField` orders by a **top-level scalar** content field — an article listing by `publishedAt`, a contact list by `name`. Without it, a consumer wanting a bounded page in a meaningful order has to read the whole matched set and sort it in memory, a cost that grows with the Stack while the page stays the same size. Content filtering already reaches into `content`; this closes the asymmetry for ordering.

**Only top-level scalars are indexed for sorting**, the same line [`file-ref` indexing draws](#types) and for the same reason: a value inside an array or an object has no single position to order its Record by. Sorting reach stops at depth 1 while `filter.content` keeps its path traversal — query reach and indexing are separate mechanisms, and only the first extends to depth. A `contentField` carrying a path separator is refused with `StackQueryError` (400), and one naming a field no Type declares is a legitimate query whose Records simply have no value to order by.

**Every top-level scalar is sortable, with no per-field opt-in.** A `sortable` marker in `TypeSchema` would change the schema hash, so making an existing field sortable would run the [schema drift](#schema-drift-detection) path for a change that alters no stored shape. The write cost is bounded by the number of top-level scalars on a Type.

**A field orders as the kind its schema declares, not as the value a Record happens to hold.** `number` and `boolean` order numerically (false before true), `date` as epoch milliseconds — so a date field orders the way `createdAt` does rather than by ISO string collation — and every string-shaped kind as text. A value that doesn't match its declared kind orders as nothing. Deriving from the schema is what keeps an order stable across Records that spell a field differently.

**A `date` holding no UTC offset is read as UTC.** The offset is optional in the [shape a `date` accepts](#types), and resolving an offset-less date-time in whatever zone the host runs in would make the order depend on the machine: an index written on one host and a cursor re-derived on another would disagree, dropping or repeating a Record at a page boundary. UTC is also what a date-only value already resolves to, so `2020-03-01` and `2020-03-01T00:00:00` order alike.

**A Record with no value at the sort field sorts after every Record that has one, in both directions.** An undated post belongs at the end of a date-ordered listing whichever way it runs; a rule that flipped with `direction` would put undated posts in the middle of the first page as often as not. Absence is not a value: `direction` reverses the order _between values_ and never moves absence.

**Where a query spans Types that declare one field name differently, numbers sort before text**, and `direction` reverses that with everything else. Stating it here rather than leaving it to each engine's collation is what stops two adapters answering one query in two orders.

**A content sort orders the stored shape, not the migrated one.** Migrations run in memory after the query returns (see [Type migrations](#type-migrations)), so a Stack mid-migration, sorting on a field a migration rewrites, gets an order derived from what is on disk. The distinction cannot arise for the native three.

Sorting by an association — a relationship target, or a tag — is a different mechanism with a different cost and is not expressible; `order` on an association is ruled out by the [commons convention](../commons/README.md) that associations point and mark but never carry data.

#### Text ordering

Text orders by a **folded key**, not by code point: compatibility-decompose (NFKD), drop combining marks, lowercase. `apple` precedes `Émile` precedes `Zebra`, where raw code-point order files every capital ahead of every lowercase letter and every accented word after both. Two values that fold together (`Emile`, `Émile`) are then ordered by the stored value itself, so the order is total and a page boundary falls in the same place on every read.

Both comparisons — the folded key, and the stored value that breaks its ties — run **by code point**. The distinction is not academic: UTF-16 code units, which a JavaScript `<` compares, file every character above U+FFFF below the U+E000–U+FFFF range, while a SQLite adapter compares the same text as UTF-8 bytes, whose order is code-point order. Comparing by code point is what lets an in-memory adapter and an indexed one answer one query in one order.

The lowercasing is **locale-independent**. A locale-sensitive fold orders Turkish `İstanbul` differently from every other runtime's, and the key is stored in an index — the divergence would be baked in rather than merely observed.

**This is a fold, not a collation.** It buys the two things a reader notices — case and accents — and promises nothing beyond them:

- No locale tailoring. Swedish `å ä ö` sort with `a`/`o` rather than after `z`; German `ß` does not fold to `ss`.
- No script-aware ordering. CJK orders by code point.
- No natural-number ordering: `item10` precedes `item9`.

Locale-correct ordering is out of reach for a stored key regardless of effort, because the correct locale is the _reader's_ and a single index can only encode one. It would need a comparator registered with the engine, which neither SQLite build this project targets can accept — and an ICU-backed comparator would make an order depend on the ICU version each runtime happens to bundle, which is exactly the divergence the [conformance fixtures](./adapters.md) exist to catch.

### Capability-gated filters

`content` filtering and `search` depend on adapter capabilities (see [Adapter capabilities](./adapters.md#adapter-capabilities)). `query()` fails loud rather than silently widening: `Stack.query()` checks `filter.content`/`filter.search` against `adapter.capabilities` before dispatching, and throws `StackQueryError` (`bad_request`/400) if the adapter hasn't declared the matching capability — local and remote behave identically.

**`contentPresent` needs `contentPresenceQuery` on top of `contentFieldQuery`**, a third flag on the same reasoning as `nestedContentQuery`: a server promising to match a content value has not thereby promised to answer whether one is there, and reading it as such would hand a client the unfiltered superset that ignoring the filter produces. A multi-segment presence path needs `nestedContentQuery` too, exactly as a filter key does.

**A sort is gated the same way.** `sort.contentField` needs `contentFieldSort`, and a native `sort.field` must appear in the adapter's `sortableFields`; a sort an adapter hasn't declared throws `StackQueryError` rather than being answered in some other order — which a caller reading one bounded page has no way to notice. `contentFieldSort` and `contentFieldQuery` are independent: a server may order by a content field without offering to filter on one, or the reverse.

**A multi-segment content key needs `nestedContentQuery` on top of `contentFieldQuery`**; a single-segment key needs `contentFieldQuery` alone. Why these are two flags rather than one widened flag is [Adapter capabilities](./adapters.md#adapter-capabilities). A `search` that sanitizes to nothing (a bare `*`, punctuation-only input) is treated as a legitimate zero-match query rather than an omitted filter — matching nothing is honest; silently returning the full table is not.

**Search text is repaired, not rejected.** `filter.search` is the one filter carrying a query language, and it holds what a person typed into a box — where an unbalanced quote (`5" nails`), a trailing operator (`cats AND`) or a leading one is ordinary input on the way to a longer query, not a malformed request. The FTS sanitizers close an odd trailing quote, drop operators left without an operand, and reduce everything outside a phrase to letters, digits, marks, whitespace, parens and quotes — so the search runs against the terms actually present rather than failing. Text inside a phrase is left alone: `"cats AND dogs"` is literal to the engine, and rewriting inside it would change what was asked for.

**The reduction is an allow-list, not a list of characters to strip.** FTS5's column-filter syntax is wider than `colname:term` — `-name` and `{a b}` filter columns with no colon in them — so a strip-list written against the colon form still let `-cats` and even the hyphen in `cats-dogs` reach the engine as column names, answered with `no such column`. Naming what may pass means the next piece of syntax nobody anticipated arrives as a separator rather than as an error, and nothing is lost: the default tokenizer already splits terms on those characters, so `cats-dogs` searches for the two tokens it was indexed as. Two grammar rules the same reduction has to respect: a group needs an explicit operator beside it (`cats (dogs)` is an error where `cats AND (dogs)` is not, so the implied `AND` is written back in), and a control character ends the string early for SQLite's C API, so control characters are dropped inside a phrase as well as outside.

The repair claims no completeness against the engine's grammar, so adapters back it with a rule that does: **whatever reaches the engine as search text and fails to parse surfaces as `StackQueryError`** (`bad_request`/400), never as a raw engine error. Membership in the [error taxonomy](./wire-format.md#the-taxonomy-root) is what gives a server a status to answer with — an error outside it has no mapping, and ordinary search input would land as a 500. The rule is scoped to `filter.search` deliberately: every other clause is built from bound parameters, so a parse failure in one is the adapter's own bug and must not be relabelled as the caller's.

**Sanitization bounds a search's grammar, not its cost.** The FTS sanitizers strip the operators that make a query pathological to parse, but a syntactically ordinary search over a large index can still be expensive to execute. Full-text search therefore lands in the same best-effort-on-cost bucket as [a nested content path](#nested-content-paths), for the same reason — both SQLite engines run synchronously in-process, with no way to interrupt one from inside the call — and a server owes the same bound, with `StackTimeoutError` as the answer. See [Wire format § Bounding query cost](./wire-format.md#bounding-query-cost).
