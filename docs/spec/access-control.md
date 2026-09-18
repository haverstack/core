# Access Control

Access control in a Stack has two complementary layers: **record-level permissions** (per-record sharing) and **type-level grants** (per-type delegation). `ScopedStack` enforces both; plain `Stack` is unscoped and performs no checks — correct for single-entity embedded use, where there's no requester distinct from the app itself.

Whether a Record is _enumerable_ is a separate question from who may read it, and has its own document: [Unlisted records](./unlisted.md).

## Record-level permissions

All Records are **private by default** — readable only by the stack owner. The `permissions` field is absent or empty on private records; there is no explicit `private` permission value. Permissions represent _grants_ of access, not restrictions. Enforcement is the responsibility of the API adapter; the local storage adapters ignore the permissions field.

**A permission is an association.** It has element identity, so granting and revoking are a plain add and remove, and the same delta the association tier already computes describes it exactly. That is what lets a permission change be journalled like any other edge rather than snapshotted as a whole list — see [Journal § The entry](./journal.md#the-entry).

```ts
// Absence of permissions (empty or undefined) = private, owner only.
type PermissionAssociation = {
  kind: 'permission';
  label: 'read' | 'write';
  grantee:
    | { scope: 'entity'; entityId: string } // a DID
    | { scope: 'group'; groupId: string; role: 'member' | 'admin' };
};

type AnyoneAssociation = {
  kind: 'anyone';
  label: 'read';
};
```

- **Bits are labels.** A grantee reaching a Record for reading and writing carries two elements, not one element with two booleans, so the element's identity carries its whole meaning and there is no "revoke by writing `false`" spelling.
- **`anyone` is its own kind.** It names no grantee and carries no bit beyond `read`, so it cannot be spelled as a `permission` whose grantee went missing. Reach to the world is affirmatively written; no dropped field produces it.
- **`role` is required.** There is no "any member" default: `role: 'member'` is the wider set and `role: 'admin'` the narrower, matching the roster labels where admin implies member (see [Group](./identity.md#group)).
- **A permission's grantee is its own shape**, not a [`RelationshipTarget`](./data-model.md#relationship-targets), which has no role and no group scope.

Group permissions reference a `_group` Record by ID. The group may be a simple permission group or a collaborative group with its own stack — the permission model is the same either way.

**Permission resolution:**

- no elements — owner only
- `anyone` — any requester can read
- a `permission` whose grantee is an `entity` — check the requester's entityId directly
- a `permission` whose grantee is a `group` — fetch the referenced `_group` Record, walk its `relationship` associations to determine the requester's role; the element is satisfied if `role: 'admin'` is set and the requester is an admin, or if `role: 'member'` is set and the requester is a member or admin

**Only a `_group` Record carries a roster.** A `groupId` naming a Record outside the `_group` family resolves to no role and the element confers nothing — the same rule [type-level grants](#type-level-grants) apply to `granteeGroupId`. Rosters are read from ordinary `relationship` associations, which any Record may carry: without the family check, an app modelling its own `member` or `admin` links (a project and the people on it, say) would turn every Record a permission was pointed at into an ACL, and a Record migrated out of `_group` would keep resolving after it stopped being a group. The `groupId` is still not format-checked, unlike a caller-named [`parentId`](./data-model.md#reparenting): it is read on the permission path rather than asserted on a write, and one that resolves to nothing simply denies.

Cross-stack group resolution (where the `_group` Record lives in a different stack than the Record being accessed) requires the server to have read access to that stack.

### Storage unifies; the API does not

Permission elements share a table, a delta shape and a durability tier with ordinary associations. They stay a **separate call surface**, because they carry different authority.

- **A Record presents two fields.** `associations` and `permissions` are projections over one stored set, partitioned by kind. An app editing tags is never shown the authority half, so a round trip through `associations` cannot drop it.
- **Two change-set keys**, each replacing only within its own domain. A `permission` or `anyone` kind named in the `associations` key — or a `tag`, `attachment` or `relationship` named in `permissions` — is a `StackQueryError`, not a validation error: the caller named the wrong surface rather than a malformed value. The refusal lives in `Stack`, so an unscoped caller, an import and a server mapping a request body are all held to it.
- **`associate()`/`dissociate()` refuse authority kinds.** They are gated on the write bit alone, which is exactly why: an authority element reaching them would let a write-holder grant themselves access.
- **`grantAccess()`/`revokeAccess()`** are the record-level ACL verbs, mirroring the type-level `grant()`/`revoke()`, and carry the reshare gate below. They amend the set where the `permissions` key replaces it — which is the spelling that survives two admins sharing one Record at once, since the later of two concurrent key writes drops what the earlier granted. Same concurrency shape as an [`associations` key write](./data-model.md#mutations), for the same reason.

**The reshare gate reads the computed delta**, not the elements a caller supplied: any `add`, `remove` or `repoint` of a `permission` or `anyone` element, in either direction, requires reshare authority. A gate that inspected only what was named would miss the wholesale replacement that drops everything, which names nothing at all. A `permissions` key that restates the set moves nothing and is not a reshare.

Three things are therefore impossible for a write-holder, who cannot reshare: wiping the ACL through a wholesale `associations` write, granting themselves a `permission` element, and revoking someone else's.

### The `write` bit: a recoverability trust model

Record-level `write` stays a single coarse bit — no per-verb fencing (`update` vs `associate` vs `delete`) at the record level. That's a deliberate scale decision: per-record sharing among a small, cohesive group doesn't call for maintained per-verb ACLs. What makes one bit safe is this:

> **Anything a write-holder does, the owner can undo.** Recoverability is the backstop, not per-verb precision.

| Verb, via `write: true`                                   | Reversible?                 | How                                                                                                                                                                                                                             |
| --------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `patchContent`, a change set's `contentPatch`             | Yes                         | Versioned — `restoreVersion()` undoes it                                                                                                                                                                                        |
| `associate` / `dissociate`, a change set's `associations` | Yes                         | Directly invertible — the opposite call (`dissociate` undoes `associate` and back) reconstructs the prior state exactly, with no version history involved — see [Versioning § Version history](./versioning.md#version-history) |
| A change set's `parentId`, a change set's `unlisted`      | Yes                         | Directly invertible — the journal entry names where the Record came from, and the opposite call puts it back, with no version history involved — see [Versioning § Version history](./versioning.md#version-history)            |
| `restoreVersion`                                          | Yes                         | Update-shaped; itself creates a new, restorable version                                                                                                                                                                         |
| `delete` (soft)                                           | Yes                         | `undelete()` reverses it — the owner can always undelete, regardless of who deleted                                                                                                                                             |
| `delete` (hard)                                           | Never reachable via `write` | Owner-only, unconditionally — see below                                                                                                                                                                                         |

Operations that sit outside the `write` bit entirely, regardless of grants:

- **Hard delete** is owner-only (see [Deletion](./versioning.md#deletion)) — it destroys the Record and its version history, so there's nothing left to undo. An irreversible verb has no place in a bit whose entire safety argument is recoverability.
- **Resharing — `grantAccess()`/`revokeAccess()`, the `permissions` key and the `unlisted` key** — is owner-or-creator-only. A write-holder who is neither cannot change who else can access the Record — otherwise a `write` element would let its holder escalate to granting others access, defeating the point of scoping access in the first place. Same pattern as hard delete: a privilege-bearing operation stays outside the coarse bit. (`restoreVersion()` reinforces this from the other direction — it restores `content` and `typeId` and nothing else, so a content rollback can't silently change who has access, or a Record's roster, tags or listing state, either.)
- **`_group` Records** opt out of the write bit (and type-level grants) entirely, for every mutating verb including `grantAccess()`/`revokeAccess()` and a change set's `permissions` key. A Group's own `permissions`/grants govern who can _read_ it, not who can _manage_ it. See [Group](./identity.md#group) for the admin-or-owner rule that replaces it.

This is about the **served topology**: for `adapter-local`, direct adapter access is full trust and the permission model doesn't apply — `Stack` is unscoped by design. Record-level permissions exist for the requester on the far side of a server, who has no direct database access. For them, the `write` bit is the only fence, so what it permits has to hold up as a real policy surface — which is exactly why everything it reaches has to be undoable by the owner.

### Write implies read

> **Mutation is never blind.** No grantee holds `write` on a Record without a `read` for the same grantee beside it, and a Grant conveys a mutate action only alongside a read action of matching scope.

Recoverability is what makes one coarse bit safe, and undo means seeing prior content — so the mutate surface hands back the Record it wrote and opens the Record's whole [history](./versioning.md#history-access), which is retroactive and deliberately not time-sliced. A requester holding `write` with no `read` would therefore be refused by `get()` and `query()` while reading current _and_ every historical content through `mutate()`, `getVersions()` and `restoreVersion()`. The ACL would say strictly less than it does. Both layers refuse the combination instead:

| Written                                                        | Refused because                                                     |
| -------------------------------------------------------------- | ------------------------------------------------------------------- |
| A `write` element with no `read` for the same `entity` grantee | The write bit is inert without a `read` reaching the same grantee   |
| A `write` element with no `read` for the same `group` grantee  | Same rule; roster resolution doesn't change it                      |
| Revoking a `read` while its `write` stands                     | Same rule, reached from the other side                              |
| Grant `['update-any']`, `['delete-any']`                       | A `-any` verb needs `read-any` — read over the reach it can mutate  |
| Grant `['read-own', 'update-any']`                             | Scope mismatch: reading one's own is not reading what it may mutate |
| Grant `['update-own']`, `['delete-own']`                       | A `-own` verb needs `read-own` or `read-any`                        |

Because the bits are separate elements, this is a **cross-element invariant**, not a check on one element: no element alone can tell whether a `write` means anything. It is asked of the permission set the write would _produce_, the same way the `_group` [at-least-one-admin check](./identity.md#group) reads its post-state — which is what makes `revokeAccess()` of a `read` refusable while the matching `write` still stands.

`grantAccess()`/`revokeAccess()`, the `permissions` key at create time and after, and `grant()` reject these with `StackValidationError`, and **evaluation refuses them again** — the same posture the ungrantable system families take. Permission elements or a `_grant` Record can also arrive from an unscoped `Stack`, a JSON import, or a server mapping a request body onto storage, and refusing only at the helper would hold only for what went through it. A `write` element with no `read` beside it, or a Grant carrying mutation without read, confers nothing however it came to exist.

The invariant rests on history being gated on the mutate surface: it is [`getVersions()`/`getVersion()`](./versioning.md#history-access) sitting there, rather than on plain read, that makes "a write-holder can already see this Record" the fact the rule trades on.

**The read action must sit in the same `_grant` Record**, not merely somewhere in the grantee's set. A grant is revoked whole, at the granularity `grant()` writes: a rule satisfied across two Records would let revoking the read one leave a mutate-without-read grant standing — arriving at exactly the configuration this rule refuses, without anyone having written it. Each grant is coherent on its own, so no revocation can produce an incoherent pair.

What this buys is an invariant the mutate gate already assumed: **anything that passes it can be read by the same requester.** `getVersions()`/`getVersion()` gate on the mutate surface precisely so that history isn't as public as the present, and this closes the reverse — the past never reaches a requester denied the present. The one deliberate exception is `_group`, which opts out of the write bit entirely: Group management is owner-or-admin (see [Group](./identity.md#group)), and an admin may mutate a Group — and read its history — without a read grant on `_group`. Roster standing, not a withheld read bit, is what carries it.

**Blind write is offered, and it is `create`.** Contribute-without-reading — a tip box, a contact form, comments held for moderation, an app filing telemetry — is a `create` grant with no read action, and that combination is deliberately left alone: writing a Record you cannot read back discloses nothing. The contributor can neither re-read their own submission nor enumerate the type; `query()` returns nothing to them and the owner sees everything in the box. `putAttachment()` follows the same gate, so a drop box can take files. Three edges are worth knowing before building one:

- **Anonymous requesters are always refused**, default grant or not, so a contributor needs a DID — cheap to mint client-side, and it becomes the Record's `entityId`. An open box (a default `create` grant) is an unauthenticated-adjacent surface in every way that matters for abuse; rate limiting is the server's business, not the permission model's.
- **Parenting into a container needs read on the container** — `parentId` is a reference, gated like any other, at creation and on a later move alike (see [Reference-creation gating](#reference-creation-gating)). Share the container Record `read: true, write: false` (it holds no submissions; each is its own private Record), or use no parent and correlate through a content field or tag.
- **The contributor keeps no sent copy.** That's the federated shape — a sender who wants one writes it to their own stack — not something the box can hand back.

What is _not_ offered is blind mutation of an existing Record. a content patch is defined over content the requester would not be able to see, `ifVersion` needs a version number that comes from a read, and the write bit's recoverability argument requires prior content by construction. A write-only surface is a total write; nothing in this model is one.

## Type-level grants

A Grant authorises one or more Entities to perform specific actions on Records of a given Type, without touching individual records — a `read-any` grant on `comment@1` makes all comments of that type readable by the grantee without setting `permissions` on each one. Grants are modeled as Records of the built-in system type `_grant`, making them queryable, versioned, and subject to the same lifecycle as any other Record.

```ts
type GrantContent = {
  typeId: TypeId; // Which record type this grant covers
  actions: GrantAction[]; // Which actions are permitted
  granteeEntityId?: string; // Who the grant applies to — a DID. Mutually exclusive with granteeGroupId.
  granteeGroupId?: string; // A `_group` Record ID whose roster the grant applies to (any member or admin). Mutually exclusive with granteeEntityId; never satisfies a delegated principal.
  // Both absent = default grant (any authenticated entity). Empty is not "absent" — a grant must name someone.
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

The grantee lives in `content.granteeEntityId` / `content.granteeGroupId`, not `record.entityId`. `entityId` means "author" on every other Record in the system, and a `_grant` Record is always authored by the stack owner (the only caller of `grant()`) — never by the entity or group it names. A grant Record therefore carries no `entityId` of its own, and "everything this entity authored" queries (`filter: { entityId }`) don't pick up grants that merely name that entity.

`Stack.grant()` is the owner-facing helper for creating grant records; `Stack.listGrants(target?)` and `Stack.revoke(target, grants)` are the read/undo counterparts. `target` is `EntityId | { groupId: RecordId } | null`:

```ts
// Grant a specific entity permission to create comments and manage their own
await stack.grant('bob-entity-id', [
  { typeId: 'com.example/comment@1', actions: ['create', 'read-own', 'update-own', 'delete-own'] },
]);

// Grant a _group Record's roster — any member or admin qualifies
await stack.grant({ groupId: 'editors-group-id' }, [
  { typeId: 'com.example/comment@1', actions: ['create', 'read-any'] },
]);

// Default grant — applies to any authenticated entity (no granteeEntityId/granteeGroupId in content)
await stack.grant(null, [{ typeId: 'com.example/comment@1', actions: ['create', 'read-own'] }]);

await stack.listGrants(); // every grant record, any grantee
await stack.listGrants(null); // only default grants
await stack.listGrants('bob-entity-id'); // grants naming Bob, grants naming a group he belongs to, plus every default grant — what currently applies to him
await stack.listGrants({ groupId: 'editors-group-id' }); // grants naming that exact group

// The inverse of grant(): soft-deletes the _grant record(s) matching target
// (null for a default grant) and each { typeId, actions } pair, matched by
// typeId baseId and action set — the same granularity grant() writes at.
await stack.revoke('bob-entity-id', [{ typeId: 'com.example/comment@1', actions: ['create'] }]);
await stack.revoke({ groupId: 'editors-group-id' }, [
  { typeId: 'com.example/comment@1', actions: ['create'] },
]);
```

A revocation is a soft delete like any other mutation — the owner can `undelete()` it the same as an accidental delete anywhere else.

**Design decisions:**

- **No wildcard `typeId`**: there is no `*` or catch-all. Every grant is opt-in per type. Adding a new type never implicitly inherits existing grants — it starts default-deny.
- **Some system types can't be granted at all**: `grant()` refuses `_grant`, `_config`, and `_app`. Each would hand the grantee the machinery the model rests on — minting their own grants, rewriting stack ownership, or registering an app card claiming a DID that isn't theirs (see [App](./identity.md#app)). Other reserved types (`_attachment`, `_entity`, `_group`) stay grantable. The refusal is enforced **again at evaluation**: a `_grant` Record naming one of these families confers nothing, however it came to exist. `grant()` is not the only way a Record gets written — an unscoped `Stack`, a JSON import, or a server mapping a request body onto `Stack` can all mint one — so a rule enforced only at the writing helper would hold only for records that went through it.
- **A `_grant` Record is only writable by the owner acting alone.** Refusing grants _on_ `_grant` closes one route to authority; record-level `write` on a grant Record is another, reaching the same escalation by editing what an existing grant confers — its `actions`, `typeId`, or `granteeEntityId` — rather than by minting a fresh one. So `ScopedStack` refuses `mutate()`, `patchContent()`, `associate()`, `dissociate()`, `delete()`, `undelete()` and `restoreVersion()` on any `_grant` Record with `StackPermissionError`, whatever the Record's own `permissions` say, and delegation does not carry it (see [Delegation](#delegation-principal-and-subject)). Nothing legitimate is lost: `grant()` and `revoke()` live on `Stack`, never on `StackClient`, so a scoped caller has no business writing one.
- **`commitMigration()` is owner-acting-alone, and no grant substitutes for it.** Moving a Record between type families is not something record-level `write` or an `update` grant confers, in any combination: `ScopedStack.commitMigration()` refuses every requester but the owner acting alone, delegation included. This mirrors the bulk path — `migrateAll()` lives on `Stack` and is absent from `StackClient` for the same reason `grant()`/`revoke()` are — so the per-record verb carries the restriction the family-wide one already had, instead of introducing a grant model beside it.

  The restriction is what makes the verb safe to expose. `commitMigration()` replaces `content` and `typeId` wholesale, so it is create-shaped at the destination and update-shaped over the Record as it stands: a grant-based version would have to re-derive every gate `create()` applies _and_ every gate `mutate()` applies, and would reopen each one it missed. The sharpest is the non-owner `_attachment@1` refusal (see [Attachments](./attachments.md#creating-_attachment1-records-directly)) — a requester holding a create grant on `_attachment@1` and write access to any Record they authored could otherwise migrate that Record into the family naming any `fileId`, then read the bytes through the uploader clause. Ordinary write access to a Record is not consent to move it between families.

**The fence is on writes only.** `get()`, `query()`, `getVersions()` and `getVersion()` on a `_grant` Record stay on their ordinary gates. Reading how a Record you can already reach came to be is not the escalation the fence exists to stop, and taking history away would leave a write-holder unable to audit the grant they hold — [history](./versioning.md#history-access) is the recovery surface, so losing it costs more than it protects. Snapshot `permissions` are stripped there as everywhere, so a grant's history discloses no more of the sharing graph than its current state does. `restoreVersion()` is a write and stays refused, even though reading the snapshot it would restore does not. `_config` is already unreachable through `Stack.get()`; `_app` keeps record-level `write` for its display fields, fenced only on the bindings a trust decision reads (see [DID bindings](./identity.md#did-bindings)).

- **Grants target the type family, not the exact version**: a grant naming `com.example/comment@1` also covers `com.example/comment@2` — matching is by `baseId`, derived from whichever form the grant's `typeId` was given in. This keeps a version bump from silently orphaning existing grants (grants are checked in memory _before_ any migration applies). `revoke()` matches at the same granularity.
- **Default grants** (no `granteeEntityId`/`granteeGroupId` in content): apply to any authenticated entity. Useful for "any logged-in user can comment" scenarios. Anonymous requesters (no `entityId`) are always denied, even under a default grant. They also **do not count on the principal's side** of a delegated request (see [Delegation](#delegation-principal-and-subject)): "any authenticated entity" means the people who turn up, not software the owner installed, so a contained app reaches only the types it is named in.
- **Actions are independent, with one dependency**: `'create'` does not imply `'read-own'`, and so on — each action must be listed explicitly. `['create', 'read-own', 'update-own', 'delete-own']` is the common bundle for contributor access. The dependency is that a mutate action needs a read action of matching scope in the same grant, or it conveys nothing; `'create'` alone stays valid and is the [blind-write](#write-implies-read) shape.
- **`-own` scope**: `-own` actions apply only to Records where `record.entityId` equals the requester. Records with no `entityId` (written by an unscoped `Stack`) do not satisfy any `-own` check.
- **The grantee may be an app**: `granteeEntityId` is a DID, and an app that holds its own key has one — so granting an installed app the types it needs is the existing model applied, not new machinery (see [App](./identity.md#app)). When such an app acts for a person, the `-own`/`-any` distinction on _its_ grant collapses to the bare verb; see [Delegation](#delegation-principal-and-subject).
- **Group-targeted grants match any roster role.** A `granteeGroupId` grant is satisfied by any entity holding a `member` or `admin` association on the named `_group` Record — unlike a record-level permission's `group` grantee, a grant carries no `role` narrowing; a set of grantees is undifferentiated by role, so the narrower record-level shape doesn't carry over. `granteeEntityId` and `granteeGroupId` are mutually exclusive on grants written through `grant()`; a `_grant` Record naming both (only reachable by writing around it) requires both to be satisfied, consistent with the refuse-again-at-evaluation posture above. The named Record must be in the `_group` family: any Record's `relationship` associations would otherwise serve as a roster, and a group migrated out of the family would keep resolving after it had stopped being a group.
- **Group-targeted grants do not count on the principal's side** of a delegated request, for the same reason default grants don't (see [Delegation](#delegation-principal-and-subject)) — one step removed. A `_group` roster is editable by any of its admins, not only by the stack owner, so a grant reaching a principal through a roster would let someone other than the owner name an app to a type the owner never named it to. The rule is about **how the authority arrived, not who holds it**, which is what makes it enforceable: a roster entry is an opaque DID and an `_app` Record's `did` is optional, so nothing can reliably tell an app's DID from a person's. An owner who means to grant an app names it directly, one grant at a time — the same shape as any other capability system that has to name software. Group grants still apply to the **subject** under delegation; only the principal half refuses them.
- **A grant target must name someone.** `grant()`, `revoke()` and `listGrants()` reject an empty `entityId` or an empty or absent `groupId` with `StackQueryError`. `null` is the only way to say "default grant": both an empty string and an absent field are falsy, so a target that names nobody would otherwise be stored as — and evaluated as — a grant to every authenticated entity. Evaluation refuses the same shape again, so a `_grant` Record carrying an empty `granteeEntityId` or `granteeGroupId` confers nothing however it came to exist. The `groupId` itself is not format-checked, and the Record it names must be in the `_group` family — both on the same terms as a record-level permission's `group` grantee (see [Record-level permissions](#record-level-permissions)).
- **Group roster resolution is memoized per operation.** Resolving `granteeGroupId` re-fetches the `_group` Record the same way a `group` grantee's resolution does (walking `relationship` associations), so it costs the same per-group lookup. The resolved roles are cached for the lifetime of one operation and threaded alongside `prefetchedGrants` — exactly the lifetime that has — so a `query()` examining many Records resolves a given roster once instead of once per candidate. Deliberately **not** cached for the life of a `ScopedStack`: `asEntity()`/`forSession()` return an object a caller may hold for as long as it likes, and a cache outliving the operation would let removal from a group go unnoticed by that instance. Revocation is the direction an authorization cache must never fail in.

**Granting a group grants everyone its admins ever add.** A `_group` roster is managed by the stack owner _and_ by any entity holding an `admin` association on it, and an admin may appoint further admins. So a group-targeted grant is a standing delegation, not a fixed list: whoever holds `admin` on that group decides, from then on, who the grant reaches. This is what delegating group management means, and it is bounded in two ways — the owner outranks the roster, so ownership can never be locked out of a group and pruning is always available; and roster-derived authority stops at the principal boundary (above), so it can never reach an app acting for someone. An owner who wants a roster only they can change appoints no other admins: a group begins with exactly one admin, its creator, and plain members hold no roster authority at all. Where one group would need two levels of trust, use two groups.

**Groups are intended for people, and nothing enforces that.** A roster entry is an opaque DID; the system has no notion of "person" to check against, and an `_app` Record's `did` field is optional, so an app operating without one is indistinguishable from a person. Treat "members are people" as a convention of your own data, never as a guarantee the library upholds — the guarantee that _does_ hold is the principal-side rule above, which is written to be independent of telling the two apart.

**The two layers deliberately use different granularities.** Record-level `write` is one coarse bit (above); grants are precise per verb. Type-wide access for a third-party app warrants verb precision in a way per-record sharing among intimates doesn't. `associate()`/`dissociate()` don't get their own grant action — they ride `update-own`/`update-any`, the same as content changes, keeping the grant vocabulary from growing a verb for every mutation kind.

## Enforcement: `Stack.asEntity()`

The core library ships a permission-enforcing wrapper so server implementations don't need to reimplement resolution logic. `stack.asEntity(entityId)` — `entityId` is `null` for an anonymous/unauthenticated requester — returns a `ScopedStack`: the same surface as `Stack`, but every operation is checked against both permission layers. If either the Record's own `permissions` or a matching `_grant` record permits the action, access is granted. The owner always has full access and bypasses both checks.

Use `asEntity()` when one `Stack` instance serves requests from multiple, possibly untrusted, entities — e.g. a server adapter.

**Resolution may be cached for the lifetime of a single request.** A scoped query cursor-walks the `_grant@1` family and resolves Group rosters per candidate Record — correct, and cheap at the scale a personal Stack has, but repeated work when one request examines many Records. A server MAY resolve the requester's grants and Group memberships once and reuse that snapshot for every check within the same request without deviating from this spec; `ScopedStack.query()` already does exactly this with its prefetched grants. Caching **across** requests is out of scope here: a grant revoked between two requests must take effect on the second, so any longer-lived cache needs an invalidation story this spec does not define.

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
| Grant lookup for the app's own reach              | `record.entityId` on writes                |
| Setting `permissions` at create time              | `-own` matching                            |
|                                                   | Record-level `permissions` resolution      |
|                                                   | The `getAttachment()` uploader clause      |

Two rules sit across both columns rather than in either. **Resharing and `_group` management are asked of both identities**: each is a privileged capability, so the principal must hold it, and each acts on a named Record, so the subject must be able to reach that Record. Both identities must independently satisfy the rule — owner-or-creator to reshare, owner-or-admin for a Group. Requiring only the principal would let an owner principal — software the owner trusts unconditionally — carry its subject to Records the subject could not otherwise touch, which is the reach `create()` already withholds.

Omitting `onBehalfOf` makes the two the same entity, which is the undelegated case and behaves exactly as it always has: the second check asks the same question of the same identity. An anonymous principal cannot act on behalf of anyone — `asEntity(null, { onBehalfOf })` throws.

**A server at its request boundary should use `forSession()` instead**, which takes the pair a token names whole:

```ts
const session = await tokens.lookupToken(bearer); // { principalId, subjectId }
const scoped = stack.forSession(session);
```

Both identities are DIDs, so passing them positionally to `asEntity()` leaves nothing to catch a swap — and a swapped pair is undetectable in the undelegated case, where the two are equal. It would surface only once delegation is in use, as authority no longer fenced by the app's grants and every write attributed to the app rather than the person it acted for. `forSession()` removes the order to get wrong; `asEntity()` remains the direct form for callers that genuinely have one identity in hand.

**Unconditional owner access splits across both identities**, rather than belonging to one. It answers _what data is reachable_ against the subject — an owner subject passes every record-level permission check — and _who may exercise a privileged verb_ against the principal. So an app delegated for the owner reaches what the owner can, on the types it was granted, and still cannot hard delete, manage a group, or decide who else sees a Record.

Read in the other direction, an **owner principal** acting for someone else — what the owner's own server does when it serves a visitor — would otherwise hand that visitor the owner's own powers. Being the owner is therefore never on its own enough under delegation. Where a privileged verb has a rule to apply, it is applied to both identities; where it rests on nothing but ownership, it is refused outright:

| Verb                                                          | Why delegation doesn't carry it                                                                                      |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `includeUnlisted` on `query()`/`subscribe()`                  | Enumeration standing rests on nothing but ownership — see [Unlisted records](./unlisted.md)                          |
| Hard delete                                                   | Irreversible; the subject holds soft delete already                                                                  |
| `deleteAttachment()`, `collectAttachmentGarbage()`            | Irreversible, and neither takes a Record to gate on                                                                  |
| Unstripped snapshot `permissions`                             | Discloses the stack's sharing graph                                                                                  |
| The `restoreVersion()` reference-gate exemption               | The gate resolves against the subject, whose reach a restore would widen                                             |
| Setting an `_app` card's `did` or `appId`                     | Names who may speak as what — the owner's trust decision, not a reach lent to a subject holding record-level `write` |
| Writing a `_grant` Record                                     | The Record _is_ authority; deciding it is the owner's call, and no scoped caller writes one legitimately             |
| Claiming the owner's own DID on an `_entity` card             | `ownerProfile` adopts whichever card holds it, so the stack's own profile is not a reach lent to a subject           |
| The owner's exemption from the `_attachment@1` create refusal | The refusal fences a guessed `fileId`, and the uploader clause that would then match resolves against the subject    |

Everything else an owner principal does still runs the subject's checks first, so a subject is never carried past one by the software acting for it: `delete()` and `restoreVersion()` through the update/delete gate, resharing and Group management through the two-sided rule above, reads through the ordinary permission and grant path.

The one place an owner principal is deliberately unbounded is grant lookup — it is the owner's own software, so its side of the intersection is not fenced by grants. The subject's side still is, which is what keeps that from being a way around anything.

The right-hand column is why delegation is worth having: `-own` keeps meaning "this person's Records, through whichever app they used", so two apps writing the same commons type still interoperate. The principal's column is why it is safe. Those operations have no grant fence at all — resharing has only owner-or-creator behind it, and `_group` mutation bypasses grants entirely — so resolving them against the subject _alone_ would let any delegated app reshare its subject's data or seize a group it was never granted. An app with no standing of its own is refused them outright.

Standing, not a grant, is what the two-sided rule asks for, and that has a consequence worth naming: an app the owner rosters as a Group `admin` may mutate that Group when acting for another admin, holding no grant on `_group` at all — while still needing a `read-any`/`read-own` grant to _read_ the Group Record, since `_group` is grantable. Mutating a Group widens access to every Record shared with it, so rostering an app's DID as `admin` is the same trust decision as granting it a type, and should be made as deliberately.

Refusing a delegated reshare only contains an app if the same reach isn't available a step earlier, so **`permissions` passed to `create()` is refused under delegation** with `StackPermissionError`, unless the principal is the owner. The general argument that create-time `permissions` is "the same capability exercised earlier, not a new one" holds for a human contributor, who genuinely does hold it after the fact. It does not transfer to a principal denied that capability by design.

The create is refused outright rather than written with the `permissions` quietly stripped: silently narrowing a write leaves the app believing it shared something it didn't, and a containment boundary an app can't see isn't one it can respect. An empty `permissions` array carries no request and is not refused.

Attachment bytes follow the records that describe them. Reaching a file through a Record the requester can read is already intersected — the check ran against that Record's own type. The uploader clause is not a second grant: it decides _which_ files the subject authored, so the principal still needs a read verb on `_attachment@1` of its own.

**Effective authority is the intersection of both parties' grants.** An app can do only what both it and its subject may do:

| App's grant | Subject's grant | Effective     |
| ----------- | --------------- | ------------- |
| `read-any`  | none            | denied        |
| none        | `read-any`      | denied        |
| `read-any`  | `read-own`      | subject's own |
| `read-own`  | `read-any`      | everything    |

Neither party can lend the other reach it lacks. This matters because the principal/subject binding is asserted when a token is issued, not by the app itself: intersection means a mis-issued delegation cannot escalate anyone, so the binding is a question of correctness rather than a security boundary. A server MAY narrow the principal's side further from what the subject consented to at issuance — OAuth-style scopes — but nothing in core requires it.

On the principal's side of the intersection, **`-own` and `-any` mean the same thing**: the question asked of the app is only whether it may perform this verb on this type at all, since which Records are reachable is settled by the subject. The suffix keeps its ordinary meaning for every undelegated principal.

**Only a grant naming the principal directly counts on its side.** Neither a default grant nor a group-targeted one satisfies the principal half — both would let an app be named by someone other than the owner (by nobody at all, or by any admin of a granted group), and containment rests on the owner having named it. Both still count on the **subject's** side, where they mean what they ordinarily do. See [Type-level grants](#type-level-grants).

Two consequences worth stating plainly rather than leaving to be discovered:

- **Per-app isolation on a shared type is not offered.** Two apps both granted `commons/note@1` for the same person see the same notes. Containment is per type — an app reaches only the types the owner granted it — which is what keeps shared commons types interoperable by default.
- **In a personal stack, a delegated `-own` grant is close to `-any`.** Nearly every Record is owner-authored, so `-own` covers nearly all of them. The precision of `-own` pays off in multi-person stacks, not single-owner ones. An owner reaching for `read-own` to _contain_ an app should know it buys almost nothing there — containment comes from which types the app is granted, not from the suffix.

### Reference-creation gating

A `create` grant on a type authorizes writing Records of that type — it does not, by itself, authorize referencing arbitrary other Records or files through that Record. `ScopedStack.create()` and `ScopedStack.associate()` both additionally check that the requester may create the specific reference being written, since a reference elsewhere confers access (an `attachment` association or file-ref content field makes the referenced file downloadable via `getAttachment()`):

- **`attachment` associations and file-ref content fields** require file access: the requester is the owner, uploaded the file themselves (holds an `_attachment@1` Record for it), or can already read some Record referencing it. This is exactly `getAttachment()`'s own access rule — reference creation requires what reference possession would grant.
- **`parentId`, and a `relationship` whose target is a Record in this stack** (`{ scope: 'record' }` naming no `stackUrl`), require read access to that Record. The gate tests `stackUrl` for a value rather than for presence, because absent and empty are one target everywhere else — storage, association identity, and the filter all read both as this stack — so both spellings meet the same check. This gate runs before the target's shape is validated, so a reference is refused for the access it names rather than reporting what was wrong with it.
- **`tag` associations** carry no reference and are never gated.
- **The other relationship target arms are never gated** — a `record` target carrying a `stackUrl`, an `entity` target, and an `external` target alike. This is not a gap in the check but the absence of anything for it to protect: the gate exists so that creating a reference cannot convey access to, or confirm the existence of, a Record the requester may not read, and none of these three names a Record in this stack. Core never dereferences them, so no access flows through one, and an accepted write reports back only what the requester already supplied. Gating a target in another stack would additionally require dereferencing that stack at write time, which core does not do — and a stack cannot even recognize its own URL, since `_config` holds no `stackUrl`.
- **`_group` roster associations are exempt** from the `relationship` check — a roster association names an Entity rather than a readable Record (see [Group](./identity.md#group)), and roster mutation is already gated by the stricter admin-or-owner rule there.

**The owner acting alone is exempt from this gate**, before the target is resolved rather than by reading it — there is no Record in their own stack they may not read, so the gate could only ever refuse them for the target's _absence_, and absence is not its question. Refusing there would put a permission error in front of the answers a caller-named `parentId` is owed — the **400** for a malformed one and the **409** for one naming no Record ([Data model § Reparenting](./data-model.md#reparenting)) — making both unreachable through a scope, which is every request a server serves. The exemption grants nothing: it hands the question to `Stack`, which refuses or accepts on its own terms. Delegation does not carry it, on either side; the predicate is the owner acting as itself, the same one [unconditional owner authority](#delegation-principal-and-subject) rests on. The owner may therefore name a `relationship` target that does not exist, exactly as an unscoped `Stack` allows — a dangling relationship is an ordinary state at rest, and no check anywhere refuses one.

A missing target and an existing-but-inaccessible one **always produce the same `StackPermissionError`** for everyone else, with no distinguishing detail — otherwise the check itself becomes a confirmation oracle (e.g. for a guessed file hash: content-addressed `fileId`s mean a successful attach-then-read round-trip would otherwise confirm the stack holds those exact bytes). In a content patch, only file-ref fields actually present in the patch are checked — untouched fields carry no new reference.

**The `parentId` key applies the same gate as `create()`**, so a move cannot reach a container an authoring call could not have named. It is the only route: [a restore settles no containment](./versioning.md#restore-semantics), so it can neither reach a container nor need gating on one. It is otherwise an ordinary write on the record — not reshare-gated like `permissions` and `unlisted`, because containment decides which listings enumerate a record rather than who may read it, so a move discloses it to nobody who could not already read it and withdraws it from nobody who could. The origin container is ungated: naming it requires reading the record, which the caller has already had to do. See [Data model § Reparenting](./data-model.md#reparenting).

`appId` and `permissions` are deliberately **not** gated by this: `appId` is self-reported, untrusted metadata everywhere (see [App](./identity.md#app) for what can and cannot be checked after the fact), never a permission input. `permissions` at create time is consistent with the same key's owner-or-creator policy after it — a contributor authoring a Record in your Stack can already widen its access up to and including `public`; create-time is the same capability exercised earlier, not a new one.

That last argument holds for a requester who genuinely holds the reshare capability, which is every undelegated one. It does **not** transfer to a delegated principal, which is denied that capability by design — so create-time `permissions` is refused there rather than ungated. See [Delegation](#delegation-principal-and-subject).

### Composing a change set

[`mutate()`](./data-model.md#mutations) names several aspects in one call, and the aspects do not share a gate. Content is reachable by a write-holder or an `update-*` grantee; `permissions` and `unlisted` are reachable only by the owner or the Record's own creator; a `_group`'s roster is reachable only by its admins. One verb over all of them therefore resolves authority **per key**, and lands exactly where the same caller would have landed one key at a time:

> **Combining changes creates no authority.** A requester who may perform every key in a change set may perform the set; a requester who may not perform one of them may not perform any of it.

Four rules make that hold.

- **Every key present is gated, and gated on presence.** `unlisted: false` and `parentId: null` name aspects and are checked like any other value — only an omitted key goes unchecked. A gate is never skipped because a value looks inert.
- **Every gate settles before any of the write lands.** A change set is one atomic write, so there is no state in which part of it has been applied while the rest is still being authorized, and no ordering among the keys for a caller to exploit.
- **Every gate reads the Record as it stands, never as the change set would leave it.** This is what stops a change set from bootstrapping its own authority. `{ permissions: [...], parentId: x }` does not let the widened permissions satisfy the [read check on `x`](#reference-creation-gating); `{ associations: [...], permissions: [...] }` against a `_group` does not let a roster naming the requester `admin` satisfy the admin check that same call must pass. Either would otherwise be a one-call escalation out of a gate the single-key spelling enforces.
- **A refused key refuses the call.** Nothing is partially applied and no key is quietly dropped. An app that believed it had published a Record it had not is worse served by a success than by `StackPermissionError`.

Per key, over a Record in no system family:

| Key                       | What the requester must hold                                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `contentPatch`            | record-level `write`, or an `update-own`/`update-any` grant on the type — required of the principal and the subject both                               |
| `associations`            | the same, plus [reference-creation gating](#reference-creation-gating) on every Association the change adds                                            |
| `parentId`                | the same, plus read access to the destination                                                                                                          |
| `permissions`, `unlisted` | owner or the Record's creator, on both sides of a delegation — and never a delegated principal, as at [create time](#delegation-principal-and-subject) |

The family fences apply to every key alike, whatever the table says: a `_group` Record is writable only by an admin or the owner, a `_grant` Record only by the owner acting alone, and an `_app` card's `did`/`appId` only by the owner acting alone (see [Identity § DID bindings](./identity.md#did-bindings)).

**A single coarse gate over the whole verb is deliberately not the rule.** Requiring the strictest of them — the owner acting alone — for any multi-key call would be simpler to state, and would leave every collaborator back at one call per aspect, which is the cost the verb exists to remove. Requiring the loosest would hand a write-holder the reshare the [`write` bit](#the-write-bit-a-recoverability-trust-model) is defined not to carry. Per-key composition is the only one that changes nobody's reach.

### Errors and information exposure

One rule governs which of the two a refused Record answers with:

> **A refusal never tells a requester anything a read wouldn't have.** The "forbidden" answer is available exactly to requesters who can already read the Record; to everyone else a Record that exists answers precisely as a missing one does.

So `get()` returns `null` for an unreadable Record just as it does for a missing one — it never throws `StackPermissionError` — and every verb that names a Record by ID (`mutate()`, `patchContent()`, `associate()`, `dissociate()`, `delete()`, `undelete()`, `getVersions()`, `getVersion()`, `restoreVersion()`) throws `StackNotFoundError` where the requester cannot read the Record, and `StackPermissionError` where it can. Over the wire that is 404 and 403 per [§ Error responses](./wire-format.md#error-responses). The same rule places the refusal's message: it reaches only a requester holding the Record already, so it is free to be specific.

**The distinction is withheld from the client, not from the operator.** A server should record which of the two a 404 was, and the check that refused — see [Wire format § Server implementation checklist](./wire-format.md#server-implementation-checklist). Nothing above asks anyone to debug a misconfigured grant blind, and a deployment that keeps no such log is the one most likely to conclude this rule costs more than it is worth.

**The distinction is a disclosure, which is why it is earned.** Record IDs are guessable in two ways, and neither yields anything without an answer that separates hit from miss. The 9-character prefix decodes to the creation millisecond, leaving a 32³ search for anyone who knows when a Record was written; and IDs minted in the same millisecond carry strictly consecutive suffixes — deliberate, since it is what makes them sort — so **anyone holding one ID from a batch can derive its siblings by incrementing**. Bulk creates, imports and `migrateAll()` all produce such batches. The realistic attacker is not searching the ID space: it is someone legitimately handed one Record who wants to enumerate what was created alongside it, and learn the Stack's write timing and volume. Existence and creation timing are not content, but for a personal Stack, when its owner was writing is itself behavioural information.

Keying on readability rather than on authentication is what makes the rule hold. `did:key` identities are self-minted with no registration authority, so "authenticated" is anonymous with extra steps — [§ Authentication](./identity.md#authentication-challengeresponse) already separates 401 from 403 for that reason. Keying on the Record instead reaches every requester who could not read it: a `read-own` holder is not told about another entity's Record of the same type, and a blind-`create` contributor — the drop-box case, and the one most likely to hold a legitimately-shared ID — is told nothing about the submissions filed beside its own. Nothing is lost in the other direction, because a requester who can read the Record learns nothing from being told it exists.

Two edges follow from stating the rule this way rather than in terms of grants:

- **Record-level `permissions` count, like any other route to a read.** A requester holding `read: true` on a Record is told plainly that a write was refused, rather than that a Record it can fetch does not exist.
- **A refusal that never reads the Record discloses nothing either way, and stays as it is.** `commitMigration()`, `deleteAttachment()` and `collectAttachmentGarbage()` refuse every non-owner identically whether or not the named Record or file exists, so they are not oracles despite answering 403.

This is the same closure [reference-creation gating](#reference-creation-gating) applies, pointed the other way. There, a missing target and an inaccessible one both raise `StackPermissionError` for every requester the gate applies to: what failed is the `create()` or `associate()` the requester asked for — that call is genuinely forbidden — and the Record it named is a reference, not the thing addressed. Here the Record _is_ what was addressed, so "not found" is the answer that discloses least. Both collapse the pair; each takes the answer that fits what the caller asked for.

**The closure is in the answer, not in the timing.** Refusing an existing Record does strictly more work than refusing a missing one — a fetch, then a read check that may walk grants and a Group roster — so a caller measuring closely enough can still tell the two apart. Constant-time refusal is not attempted: it would mean paying the read check on every miss, and the deployments this spec targets are not where that trade pays.

A query result carries no count of the whole match, for the same reason — see [Data model § Sorting and pagination](./data-model.md#sorting-and-pagination). Reporting an exact _filtered_ count instead would mean evaluating every match rather than just the returned page, so that is not offered either.

### Known limitation

`ScopedStack`'s group-membership check only resolves `_group` Records living in the same stack as the Record being accessed — it does not yet implement the cross-stack case described above. A server relying on cross-stack groups must still handle that case itself. The same limitation applies to `granteeGroupId` resolution for type-level grants (above): a group-targeted grant only resolves a roster in the same stack as the `_grant` Record.
