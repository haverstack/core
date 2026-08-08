# Stack Spec — Core Design

> Living document. Captures design decisions made so far.

## Overview

A **Stack** is a structured, portable personal or organizational data store. It provides a unified API for reading and writing **Records** regardless of the underlying storage backend. Apps integrate a single library and don't need to know or care how data is stored.

The spec is split into focused documents:

| Document                                      | Covers                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------- |
| [Data model](./spec/data-model.md)            | Records, IDs, associations, types, schemas, migrations, queries           |
| [Identity](./spec/identity.md)                | DIDs, entities, apps, groups, authentication, key rotation                |
| [Access control](./spec/access-control.md)    | Record-level permissions, type-level grants, `ScopedStack` enforcement    |
| [Versioning & deletion](./spec/versioning.md) | Version history, restore, optimistic concurrency, soft/hard delete        |
| [Attachments](./spec/attachments.md)          | Content-addressed binary storage, metadata records, garbage collection    |
| [Adapters](./spec/adapters.md)                | Adapter contract, backends, capabilities, concurrency & storage ownership |
| [Wire format](./spec/wire-format.md)          | The HTTP API stack servers implement and `adapter-api` consumes           |

## Stack initialization

A Stack is created via an async factory that reads identity (and, optionally, timezone) from the adapter.

```ts
// First run — generate an identity keypair and create a new database.
// `did` is a "did:key:z6Mk..." string — that's the owner entityId.
// Persist `privateKey` yourself (OS keychain, encrypted file, ...); the
// stack never stores it. See Identity.
const { did, privateKey } = await generateDidKeypair();
const adapter = await LocalAdapter.initialize({
  path: './my-stack.db',
  entityId: did, // required — owner entity ID (a DID)
  timezone: 'America/New_York', // optional — IANA timezone string, passthrough metadata
});

// Subsequent runs — open an existing database
const adapter = await LocalAdapter.open({ path: './my-stack.db' });

// Always the same — reads identity and timezone from the adapter.
// ownerProfile creates the owner's own _entity profile record on first
// run; a no-op on every later call once that record exists.
const stack = await Stack.create(adapter, { ownerProfile: { name: 'Jane Smith' } });
stack.ownerEntityId; // from adapter.ownerEntityId
stack.timezone; // from adapter.timezone — string | undefined
```

`LocalAdapter.initialize()` fails if the file already exists. `LocalAdapter.open()` fails if the file does not exist. This makes the distinction explicit and prevents silent config divergence.

**`StackClient` is the passable interface.** Plugin and extension code that doesn't need to know the underlying backend should accept `StackClient` rather than the concrete `Stack` or `ScopedStack`. It covers the full record API (`create`, `get`, `query`, `update`, `delete`, `undelete`, `associate`, `dissociate`, `setPermissions`, `getVersions`, `getVersion`, `restoreVersion`, `getAttachment`, `putAttachment`, `deleteAttachment`, `collectAttachmentGarbage`) plus a `features` getter. Both `Stack` and `ScopedStack` implement it.

### The `_config` record

**Stack identity** (`ownerEntityId`, `timezone`) is stored as a singleton `_config@1` record in the records table. Adapters expose these values as typed readonly properties (`adapter.ownerEntityId`, `adapter.timezone`) rather than as a generic key/value store. For the API adapter, they are sourced from the discovery endpoint (`GET /.well-known/stack`) when the adapter is opened and cached for the session.

**`timezone` is optional, passthrough app metadata — nothing in core reads it for behavior.** It's a presentation concern that lives at the data layer because `_config` is the natural place to store one fact per stack. There is no default: an absent `timezone` stays `undefined` end to end (`ConfigContent.timezone`, `adapter.timezone`, discovery's `timezone` field) rather than being defaulted to `'UTC'` — a default would assert knowledge the stack was never actually given. Apps that want a display default apply it themselves, explicitly, at the point they format something.

**`_config` is protected**, by `Stack` itself rather than any one adapter — the same layering as schema validation, so every adapter and `ScopedStack` (which delegates to `Stack`) inherit it automatically:

- **Addressable only by ID.** `get('_config')` works; a generic `query()` never returns it, regardless of filter — matching every other reserved-ID system record, but load-bearing here since `_config` is read at open and consulted by every permission check.
- **`entityId` is immutable.** `update('_config', { entityId: '...' })` throws `StackConflictError` — changing it would silently re-anchor stack ownership out from under a running system, and identity is a DID: the field isn't a label, it's the key the whole stack answers to. Other fields (`timezone` today) update normally. `restoreVersion('_config', ...)` inherits the same rule: a snapshot whose `entityId` disagrees with the live record's cannot be restored. Ownership transfer, if ever added, is a deliberate future API with key-custody semantics — not a field write.
- **Never deletable**, soft or hard. `delete('_config')` always throws `StackConflictError`: a soft-deleted config is unreadable through normal paths, and a hard-deleted one leaves nothing to reopen the stack against.

## Open questions

- **Multi-stack patterns** — apps managing multiple stacks (personal + group stacks) will likely repeat common fan-out and merge patterns; a `StackWorkspace` abstraction is a likely future addition once real usage patterns emerge.
