# Identity

Everywhere the system means "who" — `Permission`, `GrantContent.granteeEntityId`, group membership associations, `StackTokenStore`, `record.entityId`, `_config.entityId` — the value is a **DID** ([Decentralized Identifier](https://www.w3.org/TR/did-core/)) string, e.g. `did:key:z6Mk...`.

**Why DIDs, why no provider.** Stacks are for individuals and small groups with cohesive identity, not a global directory of principals. Identity must be _verifiable without a provider_, but doesn't need global discovery infrastructure. Once central providers are ruled out and a domain is undesirable as a hard requirement (a domain is rented identity with a renewal-date failure mode), one primitive remains: cryptographic self-certification. An identity is a keypair; claims are signatures; anyone can verify without asking anyone.

**`did:key` is the mandatory floor.** Adopting DID _syntax_, rather than inventing a bespoke identifier format, means not having to pick a winner among self-certifying schemes — the field just needs a `did:` prefix, and every method is distinguishable by it without the data model caring:

| Method    | What it is                           | Role here                                      |
| --------- | ------------------------------------ | ---------------------------------------------- |
| `did:key` | a public key, encoded — nothing else | **the floor — mandatory to implement**         |
| `did:web` | a domain in DID clothing             | optional, for those who _want_ domain identity |
| `did:plc` | ATProto's rotation directory         | optional, for a future ATProto bridge          |

`@haverstack/core` generates and verifies `did:key` (Ed25519) via `generateDidKeypair()` / `verifyDidSignature()` / etc. (`did.ts`) using Web Crypto only — zero infrastructure, zero resolution, zero registry, no dependency. Other methods are valid `entityId` values but core doesn't mint or resolve them.

**Key custody is not this library's job.** `generateDidKeypair()` returns a `privateKey`; nothing in `@haverstack/core` or any adapter stores it — only the public DID travels with stack data. Where the private key lives (OS keychain, encrypted file, hardware key) and how it's backed up is an app/UX concern.

## Entity

An Entity represents the owner or author of a Stack — a person or organization. Entities are modeled as **Records** of the built-in system type `_entity`, rather than as a separate object type, so they get attachments (e.g. an avatar), relationships, and all other Record capabilities for free.

Crucially, an `_entity` record is a **stack-local profile card about a DID** — not the identity itself:

```ts
type EntityContent = {
  did: string; // The identity this profile is about, e.g. "did:key:z6Mk..."
  name: string; // Display name — human-friendly, not necessarily unique. May contain spaces and punctuation. e.g. "Jane Smith"
  handle?: string; // Short, conventionally URL-safe label. e.g. "janesmith". Optional.
};
```

`name`/`handle` are _this stack owner's_ labels for that DID — the petname pattern (Zooko's triangle: global, human-readable, decentralized — pick two; the escape is names local to the observer). Two stacks holding `_entity` cards with different display names for the same `did:key:...` is correct behavior: each is its owner's own contact card for that identity. Cross-stack ID collisions are a non-issue mechanically — DIDs are globally unique by construction, unlike a `RecordId` (unique within a stack only; see [Record IDs](./data-model.md#record-ids)).

**`handle` is a label, not a key, and nothing enforces its uniqueness — deliberately.** The petname model makes global uniqueness incoherent: a handle is one observer's name for a DID, so two stacks are free to use the same handle for different people, or different handles for the same person. Uniqueness _within_ a stack is coherent but pointless, since `did` already identifies the profile and nothing in the library ever resolves an entity by handle. Two cards labeled `janesmith` are a display problem for the app that allowed it, not a data-integrity violation — and forbidding them would reject ordinary states like a half-finished rename or a contact import. The URL-safe, no-spaces shape is likewise conventional: `_entity@1` declares `handle` as a plain string and validates nothing beyond that.

An app that wants handle lookup anyway builds it on `query({ filter: { content: { handle } } })` and must handle duplicates itself. Note that filtering on `content` requires the `contentFieldQuery` capability, which a server behind `adapter-api` may decline (see [Adapters](./adapters.md#adapter-capabilities)) — another reason not to design a lookup around it.

The Stack has a designated owner, identified by `_config.entityId` (a DID) — not by pointing at any particular `_entity` record's `RecordId`. The owner's own `_entity` record (`content.did === ownerEntityId`) is created automatically by `Stack.create(adapter, { ownerProfile })` if one doesn't exist yet — idempotent, safe to pass on every open. An Entity record's `entityId` (author) may point to itself but doesn't have to; `Stack.create()`'s bootstrap leaves it unset, matching the owner-attributed, no-`entityId` convention used elsewhere.

## App

Apps that write to a Stack are also modeled as Records, using the built-in system type `_app`. This allows querying all Records created by a specific app, and provides a foundation for future enforcement in the API adapter.

```ts
type AppContent = {
  name: string; // Display name of the app e.g. "My Notes App"
  version?: string; // Semver string e.g. "1.0.0". The app's unique machine-readable identity
  // is captured by the _app record's appId (e.g. "com.example.myapp"),
  // so no handle is needed.
};
```

## Group

A Group is a set of Entities, modeled as a Record of the built-in system type `_group`. Groups serve two distinct purposes, distinguished by a single optional field:

- **Permission group** — lives in a personal stack, used purely to manage access to Records. No shared stack. Lets you grant permissions to a set of Entities without listing them individually on every Record.
- **Collaborative group** — a Group that additionally owns its own Stack, used as a shared workspace. The presence of `stackUrl` in content is what makes a Group collaborative.

A permission group can be promoted to a collaborative group at any time by adding a `stackUrl` — no migration, no restructuring.

```ts
type GroupContent = {
  name: string; // Display name — human-friendly, not necessarily unique. e.g. "Jane's Book Club"
  handle?: string; // Short, conventionally URL-safe label. e.g. "janes-book-club". Optional.
  stackUrl?: string; // If present, this group owns a shared collaborative stack at this URL. Absent = permission-only group.
};
```

A group's `handle` is a label on the same terms as an entity's — unenforced, not a key, and not what addresses the group. A collaborative group is reached at its `stackUrl`; a permission group is referenced by its record id.

**Group identity.** "A group with cohesive identity" is anything that controls a key: a group can be given its own keypair (held by its admins), so it can be granted access, own a collaborative stack (`stackUrl`), and sign as itself. Membership associations list member DIDs, same as any other entity reference — no new machinery. Group key generation/custody is deferred; nothing here blocks it.

**Membership** is expressed via associations on the `_group` Record, using the existing Association model:

```ts
{ kind: "relationship", label: "member", recordId: "<entity DID>" }
{ kind: "relationship", label: "admin",  recordId: "<entity DID>" }
```

(`recordId` here names an Entity by DID, not a Record within the target stack — the field is reused rather than duplicated.)

This gives roles for free via association labels, and membership is queryable and versioned like any other Record data. There is no role hierarchy beyond this single distinction — matching the scale a Group actually serves (a small, cohesive set of Entities), not a general-purpose permissions system:

- **`member`** — counted by group ACLs (`{ access: 'group', groupId, ... }` permission entries, unless the entry names `role: 'admin'`).
- **`admin`** — everything `member` gets, plus may manage the Group Record itself: update its content, add or remove roster (`member`/`admin`) associations, and delete it. An `admin` association implies `member` for every purpose.

**Role-gated group management.** Mutating a `_group` Record — `update`, `associate`/`dissociate` of roster associations, `setPermissions`, `delete`, `undelete` — requires the requester to be an `admin` of that Group, or the stack owner. This replaces the ordinary write-bit/grant check for `_group` Records specifically: membership rosters live on the very Record that write access would otherwise let a write-holder rewrite, so "can write this record" is deliberately not sufficient to add or remove members. `ScopedStack` enforces this.

**Bootstrap.** The creator of a `_group` Record is automatically stamped as its first `admin` (a `relationship` association added at create time) — no Group is ever management-orphaned. The stack owner can always manage any Group regardless of roster, per the owner's unconditional-access rule.

**Implementation note for the API adapter:** when enforcing group-based permissions, the server must resolve group membership by fetching the `_group` Record and walking its `relationship` associations. This requires the server to have read access to the stack where the `_group` Record lives.

**Open question, deliberately not resolved here:** the roles above describe who may manage the Group _Record_. A Group that holds its own key will eventually need to answer "who may act _as_ the Group" — accept grants on its behalf, speak for it to other stacks. That's a distinct question from record management and isn't foreclosed by this definition.

## Authentication: challenge–response

Token issuance (see [Wire format § Authentication](./wire-format.md#authentication)) is not an out-of-band secret handoff. Sketch of the handshake a server implements — not a normative wire contract, since the concrete HTTP endpoint lives in server implementations (`@haverstack/core` verifies signatures; it doesn't run a server):

1. Client requests a nonce for its DID: `POST /auth/challenge { did }` → server responds `{ nonce, expiresAt }`.
2. Client signs the nonce with the private key behind its DID (`signWithDid()`) and sends it back: `POST /auth/token { did, nonce, signature }`.
3. Server verifies (`verifyDidSignature()` — for `did:key` this requires no lookup at all; the public key is decoded from the DID string) and, on success, calls `StackTokenStore.createToken(did)` and returns the bearer token.

"Access granted to the holder of key X" is verifiable with no provider, no email loop, no OAuth.

**Verified-but-ungranted is distinguishable from anonymous.** Verification establishes "this requester controls the key behind this identifier, and will be the same someone next time" — exactly the line `Permission`/`Grant`'s "any authenticated entity" depends on. Concretely: anonymous → **401**; verified-but-ungranted → **403** (see [Wire format § Error responses](./wire-format.md#error-responses)). Verified ≠ trusted, or even human — DIDs are free to mint, so this is about stability and accountability of the identifier, not vetting of the person. Default grants remain appropriate only for low-stakes actions; anything of consequence should be granted to specific known DIDs. Servers SHOULD log the requester DID on denied-but-verified requests — actionable signal that plain anonymous noise isn't.

## Deferred: key rotation

With pure `did:key`, identity _is_ the key: lose it and you're a new identity. For individuals and small groups who know each other, that's a recoverable social event ("new key, it's me" over a trusted channel; contacts update their `_entity` cards), not a protocol failure. Rotation — a signed chain of "key A hands off to key B" records, hosted by the stack itself — is a native fit for a future RFC, but nothing here blocks it: a rotated identity is either a new DID _documented by_ that log, or a method upgrade (`did:key` → stack-hosted method) for those who opt in. Multi-device works without rotation in the meantime: the identity key bootstraps a session per device via challenge–response; devices hold revocable tokens, never the key.
