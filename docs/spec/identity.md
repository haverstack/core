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

The Stack has a designated owner, identified by `_config.entityId` (a DID) — not by pointing at any particular `_entity` record's `RecordId`. The owner's own `_entity` record (`content.did === ownerEntityId`) is created automatically by `Stack.create(adapter, { ownerProfile })` if one doesn't exist yet — idempotent, safe to pass on every open. Anything the [binding rules](#did-bindings) count as holding the owner's `did` counts as existing here too, or the bootstrap would mint a card those rules then refuse and reopening with `ownerProfile` would fail: a soft-deleted card still reserves the `did`, and so does one migrated to a later `_entity` version, since uniqueness spans the whole type family. Restoring a deleted owner card is `undelete()`'s job, not reopening's. An Entity record's `entityId` (author) may point to itself but doesn't have to; `Stack.create()`'s bootstrap leaves it unset, matching the owner-attributed, no-`entityId` convention used elsewhere.

## App

Apps that write to a Stack are also modeled as Records, using the built-in system type `_app`, so all Records created by a specific app are queryable.

```ts
type AppContent = {
  appId: string; // The software this card is about, reverse-DNS. e.g. "com.example.myapp"
  name: string; // Display name of the app e.g. "My Notes App"
  version?: string; // Semver string e.g. "1.0.0". appId is the machine-readable
  // identity, so no handle is needed.
  did?: string; // The DID this app authenticates with, when it holds a key of its own.
  // Absent for apps that ride their user's identity.
};
```

`appId` is a **reverse-DNS string** (`"com.example.myapp"`), not a `RecordId` — it names software, not a Record, and the same string means the same app in every stack.

**A card carries two `appId`s, and they answer different questions.** `content.appId` names the software the card is _about_; the card Record's own `appId` names whatever _wrote_ the card, exactly as it does on every other Record. Registering a third-party app through an admin console is the ordinary case where the two differ, so the cross-check below reads `content.appId` — the Record-level field would report the console.

### Two ways an app reaches a stack

Nothing here requires an app to have an identity. Which posture applies depends on who chose the software, and only one of them involves the stack owner naming it:

- **The app rides its user's identity.** It authenticates as the person using it and reports `appId` as attribution. This is the default and it is what a visitor's own software does — someone posting to your stack with their own client, the shape IndieAuth and Micropub already use, where clients are never pre-registered by the resource owner. The owner grants **types to people** (often via a default grant), never software they have never heard of. An unknown app is bounded by the person it acts as, who is bounded by the owner's grants.
- **The app holds its own key.** An app the owner installs mints a `did:key` keypair, authenticates with it, and is granted the types it needs. This is the _containment_ posture, for software the owner chose and can enumerate — a third-party notes app, a blog server, an indexing bot. It is opt-in, never a mandate.

An app that holds a key acts in one of two ways. Alone — an indexer with no person behind it authors its own Records, and `-own` scoping fences it exactly as it fences any entity. Or **on behalf of** a person, which is what a blog server does when a visitor comments through it. That second case splits "who authenticated" from "who authored", and [Access control § Enforcement](./access-control.md#enforcement-stackasentity) defines what each half governs.

### Attribution and what can be trusted

`appId` **grants nothing** — it is never an input to an access decision, in any posture. Whether it can be _trusted_ depends on whether there is a verified principal to check it against:

- A Record written by a delegated app carries `principalId` — the DID that actually authenticated. That DID is verified by construction (the handshake proved key possession), so a claimed `appId` is checked at the write: find the `_app` Record whose `content.did` equals the principal, and compare that card's `content.appId` to the `appId` being stamped. A mismatch is refused with `StackPermissionError`. The check runs where the fact is known rather than being left to each reader, so a stored `appId` on a Record carrying `principalId` is one the registry agreed to.
- A delegated app the owner never registered has no card to check against, so its `appId` stays a bare self-report. Registering the app is what turns it into a checked claim — which is the same act that makes `principalId` resolvable at all.
- A Record written by an app riding its user's identity carries no `principalId`, because there was no separate principal. Its `appId` is an assertion by whoever held the token and cannot be checked against anything.

So `appId` is sound for "posted via X" display and for grouping a stack's Records by the software that wrote them. On a Record with no `principalId` it is not an audit trail on its own; `principalId` is the field that answers _which principal actually did this_, and only for delegated writes.

The check costs a lookup over the `_app` family per delegated write that carries an `appId`, narrowed to `content.did` where the adapter advertises [`contentFieldQuery`](./adapters.md#adapter-capabilities) and cursor-walked where it doesn't — the same shape, and the same cost, as the binding-uniqueness check described below.

**Both fields describe the write that created the Record, and are never restamped.** `update()` is a content patch: it leaves `appId` and `principalId` naming whoever authored the Record, so a Record edited later by different software still reports its creator — as `entityId` does, and for the same reason. The cross-check above therefore answers "which app _wrote_ this", not "which app touched it last".

**Per-edit app attribution does not exist**, and version history is not a way around that: a [snapshot](./versioning.md#version-history) carries `content`, `associations`, `permissions` and the author's `entityId`, never `appId` or `principalId`. So a Record whose creator is a verified delegated app says nothing about the software behind any later edit, and nothing records it. An app that needs edits attributable individually should model them as Records of its own rather than reading attribution off the edited one.

Linking the two is the owner's job, not the library's: an `_app` Record with a `did` is the owner's card for a piece of software, the same way an `_entity` Record is their card for a person. Nothing creates one automatically — `grant()` writes a `_grant` Record and nothing else, since naming an app is a display decision the library has no truthful answer for.

**The `_app` registry is integrity-bearing.** It is the only thing standing between "this DID authenticated" and "this is My Notes App", and a lookup is worth no more than the registry behind it. Two protections apply, and they close different routes to the same end — a card bearing a name the owner trusts, pointing at a key someone else holds:

- **`_app` cannot be granted.** It sits alongside `_grant` and `_config` in the types `grant()` refuses (see [Access control § Type-level grants](./access-control.md#type-level-grants)), so no type-level grant ever authorises writing a card. Otherwise anyone holding `create` on `_app@1` could register a card claiming a DID belonging to a legitimately installed app, and the cross-check would resolve to a name they chose.
- **`did` and `appId` are owner-only to set.** Both are halves of the lookup — one finds the card, the other is what the claim is checked against — so a write-holder who could set either would reach the same impersonation: repoint a card at their own key, or relabel a card they control to claim another app's `appId`. `ScopedStack` refuses both with `StackPermissionError`, and asks it of the owner [acting alone](./access-control.md#delegation-principal-and-subject) — an owner principal acting for a write-holder would otherwise reach the same impersonation from the other side.

That second rule is what makes "only the owner writes cards" true, rather than nearly true. Type-level grants are refused, but record-level `write` on an individual card is shareable like on any other Record, so a write-holder is a real writer of that card — free to correct its `name` or `version`, and refused the two fields a trust decision reads.

Both fields are also **bindings** in the sense defined next, which is where uniqueness and immutability come from.

## DID bindings

Two system types carry fields that are **lookup keys rather than display values**: something resolves _through_ them to reach a name the owner chose.

| Field         | What resolves through it                        |
| ------------- | ----------------------------------------------- |
| `_entity.did` | a Record's `entityId` → who authored it         |
| `_app.did`    | a Record's `principalId` → which app wrote it   |
| `_app.appId`  | a verified principal → the `appId` it may claim |

A binding is not a value a card happens to hold; it is what makes the card _about_ something. Two rules follow, and they apply to every field in that table:

- **Unique within a stack.** A second card claiming a value already in use is refused with `StackConflictError`, on create and on update. A soft-deleted card keeps its claim: a deleted card is `undelete()`-able, so releasing the value on delete would let a new card take it and the old one come back beside it. Without uniqueness, "the Record whose `did` matches" has no single answer — and ambiguity is all an impersonating card needs.
- **Immutable once set.** Uniqueness stops a second card claiming a value; only immutability stops an existing card being _moved_ onto one, which reaches the same impersonation by another route. `update()` and `restoreVersion()` both refuse to change or clear a binding with `StackValidationError`. Adopting a value is a one-way step a card carrying none can still take. A subject whose key changes gets a new card, matching this document's deferral of [key rotation](#deferred-key-rotation) — a new key is a new identity, not the same one relabelled.

**`_entity` stays grantable; `_app` does not.** Naming people is ordinary app work — a contacts app creates and relabels cards — so `_entity` cards are reachable by grant and only the two binding rules fence them. Naming software is a trust decision about who may speak as what, so `_app` adds the owner-only rule above. The asymmetry is deliberate: both registries resolve a name, but only one of them is deciding whether to believe a claim.

Note the contrast with `handle`, where duplicates are explicitly fine on both `_entity` and `_group`. A handle is a display label nothing resolves by; the fields above are lookup keys a trust decision reads.

**One DID is reserved: the owner's own.** A card claiming `ownerEntityId` is refused to everyone but the owner acting alone, on create and on adoption, with `StackPermissionError`. The reservation exists because this is the one binding that feeds back into the stack's own identity: `ownerProfile` adopts whichever card holds the owner's DID rather than minting a second one, so a card written by someone else would _become_ the owner's profile, and uniqueness would then make that permanent. Every other DID stays open, which is the reach `_entity` is grantable for.

**Residual, stated rather than fixed:** the rules bind an _existing_ card, so a grantee holding `create` on `_entity@1` can still mint the _first_ card for any other DID no card names yet, with whatever display name they like. That is inherent to letting apps write contact cards at all; an owner who wants every petname to be their own choice should not grant `create` on `_entity`. The card is attributed to whoever wrote it — `entityId` names the grantee, not the owner — so a petname's provenance is always checkable. `_app` has no equivalent gap, being ungrantable.

The uniqueness check reads before it writes, so two creates racing on one value can both pass. Closing that properly means a unique index over a JSON field that each adapter would enforce separately, which is a decision about where uniqueness lives rather than a fix belonging to this rule.

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

**Role-gated group management.** Mutating a `_group` Record — `update`, `associate`/`dissociate` of roster associations, `setPermissions`, `delete`, `undelete` — requires the requester to be an `admin` of that Group, or the stack owner. This replaces the ordinary write-bit/grant check for `_group` Records specifically: membership rosters live on the very Record that write access would otherwise let a write-holder rewrite, so "can write this record" is deliberately not sufficient to add or remove members. `ScopedStack` enforces this. Under [delegation](./access-control.md#delegation-principal-and-subject) the rule is asked of both identities: the principal and the subject must each be an `admin` or the owner, so neither a contained app nor the owner's own software seizes a Group on the other's behalf.

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
