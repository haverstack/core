# Access Control

Access control in a Stack has two complementary layers: **record-level permissions** (per-record sharing) and **type-level grants** (per-type delegation). `ScopedStack` enforces both; plain `Stack` is unscoped and performs no checks — correct for single-entity embedded use, where there's no requester distinct from the app itself.

## Record-level permissions

All Records are **private by default** — readable only by the stack owner. The `permissions` field is absent or empty on private records; there is no explicit `private` permission value. Permissions represent _grants_ of access, not restrictions. Enforcement is the responsibility of the API adapter; the local storage adapters ignore the permissions field.

```ts
// Absence of permissions (empty or undefined) = private, owner only.
type Permission =
  | { access: 'public' }
  | { access: 'entity'; entityId: string; read: boolean; write: boolean } // entityId is a DID
  | { access: 'group'; groupId: string; role?: 'admin'; read: boolean; write: boolean };
```

Group permissions reference a `_group` Record by ID. The group may be a simple permission group or a collaborative group with its own stack — the permission model is the same either way. `role` narrows a group entry to admins only; absent `role` means any member qualifies (an `admin` association satisfies this too — see [Group](./identity.md#group)).

**Permission resolution:**

- `private` — owner only
- `public` — any requester can read
- `entity` — check the requester's entityId directly
- `group` — fetch the referenced `_group` Record, walk its `relationship` associations to determine the requester's role; the entry is satisfied if `role: 'admin'` is set and the requester is an admin, or if `role` is absent and the requester is a member or admin

Cross-stack group resolution (where the `_group` Record lives in a different stack than the Record being accessed) requires the server to have read access to that stack.

### The `write` bit: a recoverability trust model

Record-level `write` stays a single coarse bit — no per-verb fencing (`update` vs `associate` vs `delete`) at the record level. That's a deliberate scale decision: per-record sharing among a small, cohesive group doesn't call for maintained per-verb ACLs. What makes one bit safe is this:

> **Anything a write-holder does, the owner can undo.** Recoverability is the backstop, not per-verb precision.

| Verb, via `write: true`    | Reversible?                 | How                                                                                 |
| -------------------------- | --------------------------- | ----------------------------------------------------------------------------------- |
| `update`                   | Yes                         | Versioned — `restoreVersion()` undoes it                                            |
| `associate` / `dissociate` | Yes                         | Versioned — `restoreVersion()` restores prior associations                          |
| `restoreVersion`           | Yes                         | Update-shaped; itself creates a new, restorable version                             |
| `delete` (soft)            | Yes                         | `undelete()` reverses it — the owner can always undelete, regardless of who deleted |
| `delete` (hard)            | Never reachable via `write` | Owner-only, unconditionally — see below                                             |

Operations that sit outside the `write` bit entirely, regardless of grants:

- **Hard delete** is owner-only (see [Deletion](./versioning.md#deletion)) — it destroys the Record and its version history, so there's nothing left to undo. An irreversible verb has no place in a bit whose entire safety argument is recoverability.
- **`setPermissions()`** is owner-or-creator-only. A write-holder who is neither cannot change who else can access the Record — otherwise a `write: true` grant would let its holder escalate to granting others access, defeating the point of scoping access in the first place. Same pattern as hard delete: a privilege-bearing operation stays outside the coarse bit. (`restoreVersion()` reinforces this from the other direction — it restores `content` and `associations` but never `permissions`, so a content rollback can't silently change who has access either.)
- **`_group` Records** opt out of the write bit (and type-level grants) entirely, for every mutating verb including `setPermissions`. A Group's own `permissions`/grants govern who can _read_ it, not who can _manage_ it. See [Group](./identity.md#group) for the admin-or-owner rule that replaces it.

This is about the **served topology**: for `adapter-local`, direct adapter access is full trust and the permission model doesn't apply — `Stack` is unscoped by design. Record-level permissions exist for the requester on the far side of a server, who has no direct database access. For them, the `write` bit is the only fence, so what it permits has to hold up as a real policy surface — which is exactly why everything it reaches has to be undoable by the owner.

## Type-level grants

A Grant authorises one or more Entities to perform specific actions on Records of a given Type, without touching individual records — a `read-any` grant on `comment@1` makes all comments of that type readable by the grantee without setting `permissions` on each one. Grants are modeled as Records of the built-in system type `_grant`, making them queryable, versioned, and subject to the same lifecycle as any other Record.

```ts
type GrantContent = {
  typeId: TypeId; // Which record type this grant covers
  actions: GrantAction[]; // Which actions are permitted
  granteeEntityId?: string; // Who the grant applies to — a DID. Absent = default grant (any authenticated entity).
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

The grantee lives in `content.granteeEntityId`, not `record.entityId`. `entityId` means "author" on every other Record in the system, and a `_grant` Record is always authored by the stack owner (the only caller of `grant()`) — never by the entity it names. A grant Record therefore carries no `entityId` of its own, and "everything this entity authored" queries (`filter: { entityId }`) don't pick up grants that merely name that entity.

`Stack.grant()` is the owner-facing helper for creating grant records; `Stack.listGrants(entityId?)` and `Stack.revoke(entityId, grants)` are the read/undo counterparts:

```ts
// Grant a specific entity permission to create comments and manage their own
await stack.grant('bob-entity-id', [
  { typeId: 'com.example/comment@1', actions: ['create', 'read-own', 'update-own', 'delete-own'] },
]);

// Default grant — applies to any authenticated entity (no granteeEntityId in content)
await stack.grant(null, [{ typeId: 'com.example/comment@1', actions: ['create', 'read-own'] }]);

await stack.listGrants(); // every grant record, any grantee
await stack.listGrants(null); // only default grants
await stack.listGrants('bob-entity-id'); // grants naming Bob, plus every default grant — what currently applies to him

// The inverse of grant(): soft-deletes the _grant record(s) matching entityId
// (null for a default grant) and each { typeId, actions } pair, matched by
// typeId baseId and action set — the same granularity grant() writes at.
await stack.revoke('bob-entity-id', [{ typeId: 'com.example/comment@1', actions: ['create'] }]);
```

A revocation is a soft delete like any other mutation — the owner can `undelete()` it the same as an accidental delete anywhere else.

**Design decisions:**

- **No wildcard `typeId`**: there is no `*` or catch-all. Every grant is opt-in per type. Adding a new type never implicitly inherits existing grants — it starts default-deny.
- **Grants target the type family, not the exact version**: a grant naming `com.example/comment@1` also covers `com.example/comment@2` — matching is by `baseId`, derived from whichever form the grant's `typeId` was given in. This keeps a version bump from silently orphaning existing grants (grants are checked in memory _before_ any migration applies). `revoke()` matches at the same granularity.
- **Default grants** (no `granteeEntityId` in content): apply to any authenticated entity. Useful for "any logged-in user can comment" scenarios. Anonymous requesters (no `entityId`) are always denied, even under a default grant.
- **Actions are independent**: `'create'` does not imply `'read-own'`, and so on. `['create', 'read-own', 'update-own', 'delete-own']` is a common bundle for contributor access, but each action must be listed explicitly.
- **`-own` scope**: `-own` actions apply only to Records where `record.entityId` equals the requester. Records with no `entityId` (written by an unscoped `Stack`) do not satisfy any `-own` check.
- **The grantee may be an app**: `granteeEntityId` is a DID, and an app that holds its own key has one — so granting an installed app the types it needs is the existing model applied, not new machinery (see [App](./identity.md#app)). When such an app acts for a person, the `-own`/`-any` distinction on _its_ grant collapses to the bare verb; see [Delegation](#delegation-principal-and-subject).

**The two layers deliberately use different granularities.** Record-level `write` is one coarse bit (above); grants are precise per verb. Type-wide access for a third-party app warrants verb precision in a way per-record sharing among intimates doesn't. `associate()`/`dissociate()` don't get their own grant action — they ride `update-own`/`update-any`, the same as content changes, keeping the grant vocabulary from growing a verb for every mutation kind.

## Enforcement: `Stack.asEntity()`

The core library ships a permission-enforcing wrapper so server implementations don't need to reimplement resolution logic. `stack.asEntity(entityId)` — `entityId` is `null` for an anonymous/unauthenticated requester — returns a `ScopedStack`: the same surface as `Stack`, but every operation is checked against both permission layers. If either the Record's own `permissions` or a matching `_grant` record permits the action, access is granted. The owner always has full access and bypasses both checks.

Use `asEntity()` when one `Stack` instance serves requests from multiple, possibly untrusted, entities — e.g. a server adapter.

**`ScopedStack.create()`** additionally checks `_grant` records for a `'create'` action on the target type before allowing the Record to be written. Anonymous requesters are always denied. The owner always passes. The created Record's `entityId` is always set to the subject, so `-own` grants apply to it immediately — a scoped write always names its author, so an absent `entityId` means an unscoped `Stack` wrote the Record.

### Delegation: principal and subject

An app that holds its own key may act _on behalf of_ a person (see [App](./identity.md#app)). `asEntity()` takes that second identity:

```ts
// The app authenticated; the comment is Bob's.
const scoped = stack.asEntity(appDid, { onBehalfOf: bobDid });
```

Two identities are then in play, and one rule separates them:

> **The principal governs authority; the subject governs attribution.**

| Governed by the **principal** (who authenticated) | Governed by the **subject** (who it's for) |
| ------------------------------------------------- | ------------------------------------------ |
| Owner bypass                                      | `record.entityId` on writes                |
| Grant lookup for the app's own reach              | `-own` matching                            |
| `setPermissions()`'s owner-or-creator check       | Record-level `permissions` resolution      |
| `_group` admin-or-owner management                | The `getAttachment()` uploader clause      |
| Hard delete                                       |                                            |

Omitting `onBehalfOf` makes the two the same entity, which is the undelegated case and behaves exactly as it always has. An anonymous principal cannot act on behalf of anyone — `asEntity(null, { onBehalfOf })` throws.

The right-hand column is why delegation is worth having: `-own` keeps meaning "this person's Records, through whichever app they used", so two apps writing the same commons type still interoperate. The left-hand column is why it is safe. Those operations have no grant fence at all — `setPermissions()` checks only owner-or-creator, and `_group` mutation bypasses grants entirely — so resolving them against the subject would let any delegated app reshare its subject's data or seize a group it was never granted. A contained app is refused them outright.

**Effective authority is the intersection of both parties' grants.** An app can do only what both it and its subject may do:

| App's grant | Subject's grant | Effective     |
| ----------- | --------------- | ------------- |
| `read-any`  | none            | denied        |
| none        | `read-any`      | denied        |
| `read-any`  | `read-own`      | subject's own |
| `read-own`  | `read-any`      | everything    |

Neither party can lend the other reach it lacks. This matters because the principal/subject binding is asserted when a token is issued, not by the app itself: intersection means a mis-issued delegation cannot escalate anyone, so the binding is a question of correctness rather than a security boundary. A server MAY narrow the principal's side further from what the subject consented to at issuance — OAuth-style scopes — but nothing in core requires it.

On the principal's side of the intersection, **`-own` and `-any` mean the same thing**: the question asked of the app is only whether it may perform this verb on this type at all, since which Records are reachable is settled by the subject. The suffix keeps its ordinary meaning for every undelegated principal.

Two consequences worth stating plainly rather than leaving to be discovered:

- **Per-app isolation on a shared type is not offered.** Two apps both granted `commons/note@1` for the same person see the same notes. Containment is per type — an app reaches only the types the owner granted it — which is what keeps shared commons types interoperable by default.
- **In a personal stack, a delegated `-own` grant is close to `-any`.** Nearly every Record is owner-authored, so `-own` covers nearly all of them. The precision of `-own` pays off in multi-person stacks, not single-owner ones.

### Reference-creation gating

A `create` grant on a type authorizes writing Records of that type — it does not, by itself, authorize referencing arbitrary other Records or files through that Record. `ScopedStack.create()` and `ScopedStack.associate()` both additionally check that the requester may create the specific reference being written, since a reference elsewhere confers access (an `attachment` association or file-ref content field makes the referenced file downloadable via `getAttachment()`):

- **`attachment` associations and file-ref content fields** require file access: the requester is the owner, uploaded the file themselves (holds an `_attachment@1` Record for it), or can already read some Record referencing it. This is exactly `getAttachment()`'s own access rule — reference creation requires what reference possession would grant.
- **`relationship` associations and `parentId`** require read access to the target Record.
- **`tag` associations** carry no reference and are never gated.
- **`_group` roster associations are exempt** from the `relationship` check — a roster association's `recordId` names an Entity, not a readable Record (see [Group](./identity.md#group)), and roster mutation is already gated by the stricter admin-or-owner rule there.

A missing target and an existing-but-inaccessible one **always produce the same `StackPermissionError`**, with no distinguishing detail — otherwise the check itself becomes a confirmation oracle (e.g. for a guessed file hash: content-addressed `fileId`s mean a successful attach-then-read round-trip would otherwise confirm the stack holds those exact bytes). On `update()`, only file-ref fields actually present in the patch are checked — untouched fields carry no new reference.

`appId` and `permissions` are deliberately **not** gated by this: `appId` is self-reported, untrusted metadata everywhere (see [App](./identity.md#app) for what can and cannot be checked after the fact), never a permission input. `permissions` at create time is consistent with `setPermissions()`'s owner-or-creator policy — a contributor authoring a Record in your Stack can already widen its access up to and including `public`; create-time is the same capability exercised earlier, not a new one.

### Errors and information exposure

Reading or writing a Record that exists but isn't accessible throws `StackPermissionError`; a missing Record throws `StackNotFoundError`, so callers can distinguish "not found" from "forbidden" (typically 404 vs 403 at the HTTP layer).

`ScopedStack.query()`'s `total` is always `null`. The adapter's unfiltered count would otherwise leak the existence and cardinality of Records the requester can't read, even when the returned `records` array comes back empty. Computing an exact filtered count would require evaluating every match rather than just the returned page, so it's intentionally not attempted.

### Known limitation

`ScopedStack`'s group-membership check only resolves `_group` Records living in the same stack as the Record being accessed — it does not yet implement the cross-stack case described above. A server relying on cross-stack groups must still handle that case itself.
