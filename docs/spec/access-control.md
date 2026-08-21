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
  granteeEntityId?: string; // Who the grant applies to — a DID. Mutually exclusive with granteeGroupId.
  granteeGroupId?: string; // A `_group` Record ID whose roster the grant applies to (any member or admin). Mutually exclusive with granteeEntityId.
  // Both absent = default grant (any authenticated entity).
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
- **A `_grant` Record is only writable by the owner acting alone.** Refusing grants _on_ `_grant` closes one route to authority; record-level `write` on a grant Record is another, reaching the same escalation by editing what an existing grant confers — its `actions`, `typeId`, or `granteeEntityId` — rather than by minting a fresh one. So `ScopedStack` refuses `update()`, `associate()`, `dissociate()`, `delete()`, `undelete()`, `restoreVersion()` and `setPermissions()` on any `_grant` Record with `StackPermissionError`, whatever the Record's own `permissions` say, and delegation does not carry it (see [Delegation](#delegation-principal-and-subject)). Nothing legitimate is lost: `grant()` and `revoke()` live on `Stack`, never on `StackClient`, so a scoped caller has no business writing one.
- **`commitMigration()` is owner-acting-alone, and no grant substitutes for it.** Moving a Record between type families is not something record-level `write` or an `update` grant confers, in any combination: `ScopedStack.commitMigration()` refuses every requester but the owner acting alone, delegation included. This mirrors the bulk path — `migrateAll()` lives on `Stack` and is absent from `StackClient` for the same reason `grant()`/`revoke()` are — so the per-record verb carries the restriction the family-wide one already had, instead of introducing a grant model beside it.

  The restriction is what makes the verb safe to expose. `commitMigration()` replaces `content` and `typeId` wholesale, so it is create-shaped at the destination and update-shaped over the Record as it stands: a grant-based version would have to re-derive every gate `create()` applies _and_ every gate `update()` applies, and would reopen each one it missed. The sharpest is the non-owner `_attachment@1` refusal (see [Attachments](./attachments.md#creating-_attachment1-records-directly)) — a requester holding a create grant on `_attachment@1` and write access to any Record they authored could otherwise migrate that Record into the family naming any `fileId`, then read the bytes through the uploader clause. Ordinary write access to a Record is not consent to move it between families.

**The fence is on writes only.** `get()`, `query()`, `getVersions()` and `getVersion()` on a `_grant` Record stay on their ordinary gates. Reading how a Record you can already reach came to be is not the escalation the fence exists to stop, and taking history away would leave a write-holder unable to audit the grant they hold — [history](./versioning.md#history-access) is the recovery surface, so losing it costs more than it protects. Snapshot `permissions` are stripped there as everywhere, so a grant's history discloses no more of the sharing graph than its current state does. `restoreVersion()` is a write and stays refused, even though reading the snapshot it would restore does not. `_config` is already unreachable through `Stack.get()`; `_app` keeps record-level `write` for its display fields, fenced only on the bindings a trust decision reads (see [DID bindings](./identity.md#did-bindings)).

- **Grants target the type family, not the exact version**: a grant naming `com.example/comment@1` also covers `com.example/comment@2` — matching is by `baseId`, derived from whichever form the grant's `typeId` was given in. This keeps a version bump from silently orphaning existing grants (grants are checked in memory _before_ any migration applies). `revoke()` matches at the same granularity.
- **Default grants** (no `granteeEntityId`/`granteeGroupId` in content): apply to any authenticated entity. Useful for "any logged-in user can comment" scenarios. Anonymous requesters (no `entityId`) are always denied, even under a default grant. They also **do not count on the principal's side** of a delegated request (see [Delegation](#delegation-principal-and-subject)): "any authenticated entity" means the people who turn up, not software the owner installed, so a contained app reaches only the types it is named in.
- **Actions are independent**: `'create'` does not imply `'read-own'`, and so on. `['create', 'read-own', 'update-own', 'delete-own']` is a common bundle for contributor access, but each action must be listed explicitly.
- **`-own` scope**: `-own` actions apply only to Records where `record.entityId` equals the requester. Records with no `entityId` (written by an unscoped `Stack`) do not satisfy any `-own` check.
- **The grantee may be an app**: `granteeEntityId` is a DID, and an app that holds its own key has one — so granting an installed app the types it needs is the existing model applied, not new machinery (see [App](./identity.md#app)). When such an app acts for a person, the `-own`/`-any` distinction on _its_ grant collapses to the bare verb; see [Delegation](#delegation-principal-and-subject).
- **Group-targeted grants match any roster role.** A `granteeGroupId` grant is satisfied by any entity holding a `member` or `admin` association on the named `_group` Record — unlike record-level `access: 'group'` permissions, there's no `role: 'admin'` narrowing on the grant side; a set of grantees is undifferentiated by role, so the narrower record-level shape doesn't carry over. `granteeEntityId` and `granteeGroupId` are mutually exclusive on grants written through `grant()`; a `_grant` Record naming both (only reachable by writing around it) requires both to be satisfied, consistent with the refuse-again-at-evaluation posture above.
- **Group roster resolution is memoized per `ScopedStack` instance.** Resolving `granteeGroupId` re-fetches the `_group` Record the same way `access: 'group'` permission resolution does (walking `relationship` associations), so it costs the same per-group lookup. Since `ScopedStack` instances are already created per request (`asEntity()`/`forSession()`), caching resolved roles for the instance's lifetime keeps a query examining many Records from re-walking the same roster once per candidate — the same problem `prefetchedGrants` solves for the `_grant` family itself.

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

Two rules sit across both columns rather than in either. **`setPermissions()` and `_group` management are asked of both identities**: each is a privileged verb, so the principal must hold it, and each acts on a named Record, so the subject must be able to reach that Record. Both identities must independently satisfy the rule — owner-or-creator for `setPermissions()`, owner-or-admin for a Group. Requiring only the principal would let an owner principal — software the owner trusts unconditionally — carry its subject to Records the subject could not otherwise touch, which is the reach `create()` already withholds.

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
| Hard delete                                                   | Irreversible; the subject holds soft delete already                                                                  |
| `deleteAttachment()`, `collectAttachmentGarbage()`            | Irreversible, and neither takes a Record to gate on                                                                  |
| Unstripped snapshot `permissions`                             | Discloses the stack's sharing graph                                                                                  |
| The `restoreVersion()` reference-gate exemption               | The gate resolves against the subject, whose reach a restore would widen                                             |
| Setting an `_app` card's `did` or `appId`                     | Names who may speak as what — the owner's trust decision, not a reach lent to a subject holding record-level `write` |
| Writing a `_grant` Record                                     | The Record _is_ authority; deciding it is the owner's call, and no scoped caller writes one legitimately             |
| Claiming the owner's own DID on an `_entity` card             | `ownerProfile` adopts whichever card holds it, so the stack's own profile is not a reach lent to a subject           |
| The owner's exemption from the `_attachment@1` create refusal | The refusal fences a guessed `fileId`, and the uploader clause that would then match resolves against the subject    |

Everything else an owner principal does still runs the subject's checks first, so a subject is never carried past one by the software acting for it: `delete()` and `restoreVersion()` through the update/delete gate, `setPermissions()` and Group management through the two-sided rule above, reads through the ordinary permission and grant path.

The one place an owner principal is deliberately unbounded is grant lookup — it is the owner's own software, so its side of the intersection is not fenced by grants. The subject's side still is, which is what keeps that from being a way around anything.

The right-hand column is why delegation is worth having: `-own` keeps meaning "this person's Records, through whichever app they used", so two apps writing the same commons type still interoperate. The principal's column is why it is safe. Those operations have no grant fence at all — `setPermissions()` has only owner-or-creator behind it, and `_group` mutation bypasses grants entirely — so resolving them against the subject _alone_ would let any delegated app reshare its subject's data or seize a group it was never granted. An app with no standing of its own is refused them outright.

Standing, not a grant, is what the two-sided rule asks for, and that has a consequence worth naming: an app the owner rosters as a Group `admin` may mutate that Group when acting for another admin, holding no grant on `_group` at all — while still needing a `read-any`/`read-own` grant to _read_ the Group Record, since `_group` is grantable. Mutating a Group widens access to every Record shared with it, so rostering an app's DID as `admin` is the same trust decision as granting it a type, and should be made as deliberately.

Refusing `setPermissions()` only contains an app if the same reach isn't available a step earlier, so **`permissions` passed to `create()` is refused under delegation** with `StackPermissionError`, unless the principal is the owner. The general argument that create-time `permissions` is "the same capability exercised earlier, not a new one" holds for a human contributor, who genuinely does hold `setPermissions()`. It does not transfer to a principal denied that capability by design.

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

Two consequences worth stating plainly rather than leaving to be discovered:

- **Per-app isolation on a shared type is not offered.** Two apps both granted `commons/note@1` for the same person see the same notes. Containment is per type — an app reaches only the types the owner granted it — which is what keeps shared commons types interoperable by default.
- **In a personal stack, a delegated `-own` grant is close to `-any`.** Nearly every Record is owner-authored, so `-own` covers nearly all of them. The precision of `-own` pays off in multi-person stacks, not single-owner ones. An owner reaching for `read-own` to _contain_ an app should know it buys almost nothing there — containment comes from which types the app is granted, not from the suffix.

### Reference-creation gating

A `create` grant on a type authorizes writing Records of that type — it does not, by itself, authorize referencing arbitrary other Records or files through that Record. `ScopedStack.create()` and `ScopedStack.associate()` both additionally check that the requester may create the specific reference being written, since a reference elsewhere confers access (an `attachment` association or file-ref content field makes the referenced file downloadable via `getAttachment()`):

- **`attachment` associations and file-ref content fields** require file access: the requester is the owner, uploaded the file themselves (holds an `_attachment@1` Record for it), or can already read some Record referencing it. This is exactly `getAttachment()`'s own access rule — reference creation requires what reference possession would grant.
- **`relationship` associations and `parentId`** require read access to the target Record.
- **`tag` associations** carry no reference and are never gated.
- **`_group` roster associations are exempt** from the `relationship` check — a roster association's `recordId` names an Entity, not a readable Record (see [Group](./identity.md#group)), and roster mutation is already gated by the stricter admin-or-owner rule there.

A missing target and an existing-but-inaccessible one **always produce the same `StackPermissionError`**, with no distinguishing detail — otherwise the check itself becomes a confirmation oracle (e.g. for a guessed file hash: content-addressed `fileId`s mean a successful attach-then-read round-trip would otherwise confirm the stack holds those exact bytes). On `update()`, only file-ref fields actually present in the patch are checked — untouched fields carry no new reference.

`appId` and `permissions` are deliberately **not** gated by this: `appId` is self-reported, untrusted metadata everywhere (see [App](./identity.md#app) for what can and cannot be checked after the fact), never a permission input. `permissions` at create time is consistent with `setPermissions()`'s owner-or-creator policy — a contributor authoring a Record in your Stack can already widen its access up to and including `public`; create-time is the same capability exercised earlier, not a new one.

That last argument holds for a requester who genuinely holds `setPermissions()`, which is every undelegated one. It does **not** transfer to a delegated principal, which is denied that capability by design — so create-time `permissions` is refused there rather than ungated. See [Delegation](#delegation-principal-and-subject).

### Errors and information exposure

Reading or writing a Record that exists but isn't accessible throws `StackPermissionError`; a missing Record throws `StackNotFoundError`, so callers can distinguish "not found" from "forbidden" (typically 404 vs 403 at the HTTP layer).

`ScopedStack.query()`'s `total` is always `null`. The adapter's unfiltered count would otherwise leak the existence and cardinality of Records the requester can't read, even when the returned `records` array comes back empty. Computing an exact filtered count would require evaluating every match rather than just the returned page, so it's intentionally not attempted.

### Known limitation

`ScopedStack`'s group-membership check only resolves `_group` Records living in the same stack as the Record being accessed — it does not yet implement the cross-stack case described above. A server relying on cross-stack groups must still handle that case itself. The same limitation applies to `granteeGroupId` resolution for type-level grants (above): a group-targeted grant only resolves a roster in the same stack as the `_grant` Record.
