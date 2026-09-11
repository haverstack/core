# Versioning & Deletion

Version history is managed by the library as a side channel — apps do not manage it directly.

## Version history

**One rule, no special cases:** every mutation of a Record — a [change set](./data-model.md#mutations) naming content, containment, permissions, associations or listing in any combination, a single `associate`/`dissociate`, a soft delete, an undelete — snapshots the Record's prior full state and bumps `version` exactly once. **One call is one version**, however many aspects it moved: a change set that edits content and moves the Record produces a single snapshot of how it stood before either. A mutation that changes nothing (re-adding an association that's already present, removing one that isn't there, restating a deep-equal permission set, deleting an already-deleted Record) is a no-op: no bump, no snapshot. Hard delete is the one exception — it destroys the Record and its version history outright, so there's nothing to snapshot.

**Every mutating method answers with the Record it produced.** `mutate()`, `patchContent()`, `associate()`, `dissociate()`, `undelete()`, `restoreVersion()` and `commitMigration()` all return the Record as it now stands, so a caller can report what it just wrote without a second read — the same body [their wire endpoints answer with](./wire-format.md#records), rather than a client that discards it. A no-op returns the Record unchanged: what distinguishes it is the version that didn't move, not an answer that never came. `delete()` is the one that returns nothing, because it is the one verb with a variant that has nothing to return — a hard delete leaves no Record and no version behind (a soft delete's tombstone is read back with `get(id, { includeDeleted: true })`).

```ts
type RecordVersion = {
  version: number;
  typeId: string; // The Record's typeId at the moment this version was snapshotted
  content: object;
  updatedAt: Date;
  entityId?: string; // The Record's author, carried through from the snapshot
  updatedBy?: string; // Who performed the mutation that produced this version
  updatedVia?: string; // The principal behind it, when it isn't updatedBy
  parentId?: string; // The container the record sat in; absent = the root
  associations?: Association[]; // Present if the record had associations at snapshot time
  permissions?: Permission[]; // Present if the record had permissions at snapshot time
};
```

**`parentId` is spelled exactly as it is on a Record: absent is the root.** A snapshot states where the Record _was_, so it takes the same shape as the thing it describes, and `null` never appears on one. That is the general rule the field follows throughout:

- **Inputs** spell the root `null` — a change set's `parentId`, a `RecordFilter`, the `?parentId=null` query string. An input has to tell "the root" apart from "not specified", so it needs the extra spelling.
- **State** spells the root by omission — `StackRecord`, `RecordChange`, and `RecordVersion` here. A Record is always somewhere, so absence is unambiguous.

`associations` is not a parallel case: its `[]` distinguishes a _cleared_ list from an unread one, which is a distinction containment does not have — there is no such thing as a Record in no container. Because absence is the root rather than a missing claim, a restore always settles containment; it never leaves the Record where it currently sits. A snapshot from [a foreign server](./wire-format.md#versions) that omits the key therefore reads as the root, and one that spells the root `null` — mirroring the input side — is read as the root too.

`typeId` makes a version entry interpretable regardless of migration state: a snapshot taken before a migration records the pre-migration type, so restoring it later doesn't mislabel `@1`-shaped content as `@2`. It's also what lets `_grant` baseId matching work independent of which version a snapshot predates.

**`entityId` on a version is authorship; `updatedBy` is attribution of the change.** `entityId` is the Record's own author copied into the snapshot, and it never moves — so every version reports the same author. `updatedBy` is the requester that produced _that_ version, with `updatedVia` naming the principal beside it under delegation. The two agree at version 1 and diverge whenever anyone but the author writes. See [Data model § Authorship and attribution](./data-model.md#authorship-and-attribution).

**API surface:**

- `stack.getVersions(recordId)` — retrieve version history
- `stack.restoreVersion(recordId, version, opts?)` — revert to a prior version. Restores `content`, `typeId`, `parentId` (always: absent on the snapshot is the root) and `associations` when the target snapshot has them, but **never restores `permissions`** — those are owner/creator territory (see [Access control](./access-control.md#the-write-bit-a-recoverability-trust-model)), and silently reverting an ACL as a side effect of a content rollback would be a surprise nobody wants. Permissions in a snapshot are for audit and deliberate owner action, not automatic restore. The snapshot deliberately does not capture `appId`, so restore never reverts an app reattribution — that field keeps its current value. On a `_group` Record, `associations` are held back entire on the same principle the permissions rule rests on — see [Restore semantics](#restore-semantics).

**Why `parentId` rolls back and `permissions` does not.** A change set can move both in one version, which makes the asymmetry easier to meet: rolling that version back puts the Record's container back and leaves its access where it now stands. The two are not the same kind of field wearing different policies. Permissions decide who may reach the Record, so reverting them silently would widen or narrow access as a side effect of a verb the caller asked for its content; `parentId` decides which listings enumerate it and nothing else — [containment is not an access-control edge](./data-model.md#reparenting) — so putting it back changes what the Record's own history already describes and no one else's reach. `appId` is not policy either way: it names the software that authored the Record, a create-time fact that no later write moves, so there is nothing for a rollback to revert it to.

## Snapshot atomicity

**A snapshot is written as part of the same atomic write as the mutation it precedes**, never as a separate call before it. Adapters accept the snapshot as an option on every mutating method and fold the insert into their own transaction; `Stack` builds it from the record it has already read and passes it through. A standalone `saveVersion()` exists for tooling, but no mutation path uses it — and it is a deliberate no-op over `APIAdapter`, where the server is the only snapshot writer.

The reason is recoverability of the history mechanism itself. Were the snapshot a separate call preceding the mutation, a crash in between would leave a `versions` row at the record's own current version — a version number no legitimate snapshot can carry, since a snapshot is written in the same breath as the bump past it. That orphan would then collide with every future mutation's snapshot attempt, permanently blocking writes to the record.

Adapters therefore treat a `(recordId, version)` collision two ways:

- **Colliding row below the record's current version** — a genuine conflict: two writers read the same stale version and raced to snapshot it. The loser is rejected with `StackConflictError` before its mutation applies. Never silently discarded, which would leave a hole in rollback history exactly where a conflict happened.
- **Colliding row _at_ the record's current version** — an orphan from an interrupted write, impossible to produce under atomic snapshotting. The row is overwritten and the mutation proceeds, healing the record.

The distinction is a pure version-number comparison against the live record, never a comparison of snapshot content. The tempting "same payload ⇒ treat as success" shortcut is unsound: it would let two genuinely concurrent writers both proceed and corrupt history.

## History access

**History is the mutation/recovery surface, not a read surface.** Under `ScopedStack`, `getVersions()`/`getVersion()` require the same access `patchContent()`/`associate()` require — a write-holder, or the owner/creator (or a Group's admin, for a `_group`'s own history) — not plain read access. Gating history on current read access would make a Record's entire past exactly as public as its present: share a Record after editing out something sensitive, and every current reader would see the pre-edit revisions too, as an automatic side effect of an ACL that only describes _now_. Requiring the mutate surface instead ties history access to "can undo," the same justification the `write` bit rests on. History is deliberately **not** time-sliced per reader (a contributor added today sees the same history a contributor added last year would, including pre-their-involvement content); ACLs aren't per-version timestamped, and building that slicing is out of scope. That is exactly why the rule only runs one way: history is narrower than read, never wider. A requester who cannot read a Record's present is never handed its past, because [write implies read](./access-control.md#write-implies-read) — mutation authority the requester's own read doesn't cover conveys nothing, at either layer. The retroactive reach of an untimesliced history is what makes that companion rule worth enforcing rather than documenting. A denied requester gets `StackPermissionError`, matching every other write-gated verb. "The same access" means the same permission and grant resolution, not the owner-only fences a few families put on mutation: a `_grant` Record is [owner-write-only](./access-control.md#type-level-grants), and its history is still readable by a write-holder, since reading it changes nothing and a write-holder who cannot audit the grant they hold has lost the recovery this gate exists to protect.

Independently, snapshot `permissions` — audit data by design — are **stripped from every `RecordVersion` returned to anyone but the owner acting as itself**, including a write-holder who passes the history gate, and including a delegated request whose principal is the owner. A write-holder never needs the ACL trail to undo content or associations, and a snapshot's `permissions` are the stack's sharing graph, which [delegation](./access-control.md#delegation-principal-and-subject) is not a route to. `entityId` (the Record's author, per [above](#version-history)) is not stripped — it is the same value the live Record already exposes to every reader, and far less sensitive than a permissions history. Neither is a snapshot's `parentId`: it names a container the Record sat in, which is the same class of fact as the `relationship` targets a snapshot's `associations` already carry unstripped, and a write-holder who is to undo a move has to be able to see the one that happened.

**Publishing history is a projection, not a history read.** An app that wants to expose a Record's revisions publicly (e.g. a static-site generator's changelog) does not do so by relaxing the rule above — it materializes the chosen revisions as first-class, app-defined Records (their own content, their own `permissions`, decoupled from `RecordVersion`'s audit shape), built at the point the app decides to publish. That's a deliberate, curatable act — the embarrassing draft or the edited-out paragraph never leaks unless the owner chooses to include it.

## Restore semantics

**Restore always creates a new version with the old content and `typeId` — it never rewrites history.** The act of restoring is itself part of the version history.

**Snapshot content is validated against the type it claims** (`typeId` as stored in the snapshot), not the Record's current type — a snapshot taken before a migration is `@1`-shaped, and validating it against a since-migrated `@2` schema would wrongly reject a legitimate restore. A snapshot that fails validation against its own claimed type — in-place schema drift, or a corrupted/buggy adapter — throws `StackValidationError` instead of being written back; restore is a recovery path, not a backdoor around content validation.

Restoring a pre-migration snapshot therefore also restores its old `typeId`, leaving the Record legitimately **stale** rather than mislabeled. No forward-migration happens at restore time — migration functions are app code (see [Type migrations](./data-model.md#type-migrations)), so restore behaves the same locally as through the server-side restore endpoint, which cannot run them either. A stale restored Record self-heals the same way any other stale Record does: on the owning app's next `migrateAll()` sweep.

**A restore puts the Record back where the snapshot was taken.** A move is a mutation like any other, so it snapshots like any other and rolls back like any other — the point of a move bumping `version` at all. A restore that changes `parentId` is therefore a containment edge added after the fact, and it is refused with `StackConflictError` on the same terms a change set's `parentId` refuses one: a snapshot that would make the Record its own ancestor cannot be restored, because the chain above that container may have moved since the snapshot was taken. It is announced to both containers it concerns, exactly as a move is — see [Events § The reparent transition](./events.md#the-reparent-transition). **A snapshot naming a container that has since been deleted restores anyway**, for the owner. A change set would refuse that container, since it checks that a caller-named `parentId` [exists](./data-model.md#reparenting) — but a restore is not a caller naming a destination, it is history being put back, and refusing would let an unrelated deletion cost the Record its content rollback. That makes a restore the one write that can produce a [dangling parent](./data-model.md#reparenting); it is the same stance restore takes on content, honoring the snapshot's own `typeId` rather than re-litigating it against the current one. A non-owner is still refused, not by that check but by the reference gate below, which cannot grant read on a container that is gone.

**A restore does not roll back a Group's roster.** On a `_group` Record, `content` and `parentId` roll back as they do anywhere; the Record's `associations` are left exactly as they stand — the snapshot's are not put back, and the current ones are not taken away. This is the stance restore already takes on `permissions`, applied to the whole roster on the grounds that a roster is authority rather than data: a Group's `member` and `admin` entries are what [group ACLs](./access-control.md#record-level-permissions) and [group-targeted grants](./access-control.md#type-level-grants) resolve against, so rolling one back silently re-grants access — management to an `admin` who had been deliberately removed, reach to a `member` who had been dropped — as a side effect of a verb the caller asked for its content. Recovering a former roster is then a deliberate `associate()`, which is the point.

It is also what lets [the invariant](./identity.md#group) hold without a check here. A restore cannot move the roster, so it cannot be the write that empties one, and no version of a `_group` is ever unrestorable on that ground. The rule is `Stack`'s, not the adapter's: `StackRecordAdapter.restoreVersion()` takes `restoreAssociations: false` and no association list ever travels to an adapter, so there is nothing a restore writes that could disagree with what the Record already holds.

**`restoreVersion()` re-runs reference-creation checks against the snapshot, for non-owner requesters.** Restoring re-attaches whatever `parentId`, `associations` and file-ref content fields the target snapshot carried. For a write-holder who is not the owner, that could re-convey access to a file or Record they can no longer reach today — the reference was legitimate when created, but access has since moved on. `ScopedStack.restoreVersion()` closes this by applying the same [reference-creation gating](./access-control.md#reference-creation-gating) `associate()`/`create()` apply, against the snapshot's associations and file-ref fields: an `attachment` association or file-ref field the requester couldn't currently attach fresh is rejected (`StackPermissionError`), and a `relationship` association — or a `parentId` naming a container the Record is not already in — requires current read access to its target. A snapshot taken at the root names no container, so a restore that returns the Record to the root creates no reference and is never gated on one. A `parentId` the restore would not change is not re-gated: the Record is already there, so no reference is being created, and a rollback of content would otherwise be refused on the strength of a move it isn't making. A `_group` Record's `associations` are not gated at all, for the same reason: a restore does not move its roster, so it introduces no association to check. The owner acting as itself is exempt, per the same recoverability principle that exempts them from every other write-path gate — but an owner principal acting for someone else is not, since the gate resolves against the subject and it is the subject's reach a restore would widen.

Restoring an `_app` or `_entity` Record is fenced for the same reason, by the rules that govern their binding fields directly: a card's `did` (and, on `_app`, its `appId`) is immutable once set, so a rollback that would move or clear one is refused no matter which verb reaches for it — see [Identity § DID bindings](./identity.md#did-bindings). Content rollback is a route to a write, not an exemption from what that write is allowed to be.

## Optimistic concurrency (`ifVersion`)

`version` is not conflict detection by itself — it exists to power rollback and soft-delete recovery. Nothing reads or writes it unless a caller opts in. Every mutating method (`mutate`, `patchContent`, `delete`, `undelete`, `associate`, `dissociate`, `restoreVersion`, `commitMigration`) accepts an optional `ifVersion`:

```ts
await stack.patchContent(id, { title: 'New' }, { ifVersion: 5 });
// throws StackVersionConflictError if the record's current version ≠ 5, and changes nothing
```

- **Omitting `ifVersion` keeps last-writer-wins** — the unconditional default. Apps that don't care about races don't pay for this.
- On a mismatch, the call throws `StackVersionConflictError` carrying `recordId`, `expectedVersion`, and `actualVersion`, so a caller can re-fetch, inspect what actually won the race, and decide whether to retry. It is a distinct error type from `StackConflictError` — the two have different recovery stories (fix your input vs. retry after re-reading) and different HTTP statuses.
- **The check is atomic at the adapter**, not a read-then-write in `Stack`: adapters implement it as part of the same write (e.g. `UPDATE ... WHERE id = ? AND version = ?`, inspecting the affected-row count). Doing the check in `Stack` alone would just move the race down a layer.
- This covers every mutation path per the one-rule versioning model above: a lost race on an association or permission change is caught exactly like a lost race on content.
- Over the wire, this is the `If-Match` header (see [Wire format § Records](./wire-format.md#records)) — local and remote behave identically.

**Collisions are never silently dropped.** Two writers racing past the same version — without `ifVersion`, or through a server race that outpaces it — can still collide on the same snapshot version number. Adapters reject the loser with `StackConflictError` rather than discarding its snapshot; see [Snapshot atomicity](#snapshot-atomicity).

## Storage per adapter

- JSON: sibling file `{id}.versions.json`
- SQLite: `versions` table
- API: **the server is the only snapshot writer** — `saveVersion()` is a deliberate no-op over `APIAdapter`, so a server implementing anything less than the full list of version-bumping endpoints silently loses rollback history for the ones it skipped. See [Wire format § Versions](./wire-format.md#versions) for that list.

## Deletion

Records are never hard-deleted by default. Two levels of deletion are supported:

**Soft delete** — the default. A deleted Record is flagged with a `deletedAt` timestamp and excluded from normal queries, but remains recoverable. Version history is preserved. A soft-deleted Record is a tombstone — its current state is gone but its history is not.

### The tombstone is literal

Under `ScopedStack`, a soft-deleted Record is **presented as** a tombstone rather than merely described as one. `get()` and `query({ includeDeleted: true })` return:

```ts
{
  id, typeId, createdAt, updatedAt, version,
  deletedAt,        // what makes it a tombstone
  permissions,      // retained — see below
  content: {},      // empty: the current state is what a soft delete removes
}
```

`associations`, `parentId` and the authorship fields (`entityId`, `appId`, `principalId`, `updatedBy`, `updatedVia`) are absent. The [change feed carries the same projection](./events.md#soft-deleted-records-reach-the-feed-as-tombstones), so no channel serves more of a deleted Record than a fetch by ID does.

**`permissions` is retained** because it is what decides whether the caller may `undelete()`. A write-holder who could not see the bit would have to attempt the verb to discover it. It discloses nothing further: a tombstone only ever reaches a requester who passed the same read check the live Record required, and one who fails it gets `null`, exactly as a missing ID gives.

**It applies to every requester, the owner included.** A Record's state is a property of the Record, not of who is asking — the owner wanting the content back reads history, or holds the unscoped `Stack`, which is trusted by definition and projects nothing.

**History is deliberately exempt.** `getVersions()` still serves the content the tombstone withholds, because reviewing what a Record held is how a caller decides whether to restore it. "Its current state is gone" is the whole of the claim; the history sentence beside it is the other half of the same rule, not an oversight.

### Mutations are refused, not applied to a tombstone

A soft-deleted Record has no current state to edit, so `mutate()`, `patchContent()`, `associate()`, `dissociate()` and `restoreVersion()` throw `StackConflictError` (`409`) under `ScopedStack` — a change set is refused whole, whichever of its keys would otherwise have applied. `undelete()` is the way back, and it is deliberately not gated this way.

The refusal is asked **after** the authority decision, never before. It names a state, so a requester who may not read the Record must still hear what a missing ID sounds like — otherwise "exists but deleted" becomes a probe a stranger can run against guessed IDs, the same [information-exposure rule](./access-control.md#errors-and-information-exposure) that governs every other refusal.

`commitMigration()` is exempt: migration deliberately sweeps soft-deleted Records so one can come back current on undelete (see `migrateAll()` below), and it is owner-acting-alone only.

**Hard delete** — permanent and explicit. Removes the Record and all its version history. Requires deliberate intent via a flag. The escape hatch for sensitive, secret, or harmful content.

```ts
stack.delete(recordId); // soft delete — reversible
stack.delete(recordId, { hard: true }); // hard delete — permanent
```

**Hard delete is owner-only under `ScopedStack`.** Neither the record-level `write` bit nor `delete-own`/`delete-any` grants reach it — a non-owner requesting `{ hard: true }` gets `StackPermissionError`, regardless of what would otherwise authorize a delete. It's irreversible and destroys version history, so it stays outside every delegated-access vocabulary. Non-owners are always limited to soft delete. (Plain `Stack` is unscoped and trusted-by-definition, so this restriction applies only to the `asEntity()` wrapper.)

Queries exclude soft-deleted Records by default. Opt in with:

```ts
stack.query({ filter: { includeDeleted: true } });
```

**Undelete** reverses a soft delete. It's idempotent — calling it on a Record that isn't deleted succeeds and returns the Record unchanged, so a retried call after a network blip never fails. A missing Record throws `StackNotFoundError`; a hard-deleted Record is simply missing, so it throws the same way.

```ts
const record = await stack.undelete(recordId); // clears deletedAt, returns the record
```

Under `ScopedStack`, `undelete()` is gated the same way as `delete()` — the `write` bit or a `delete-own`/`delete-any` grant. Undelete is the inverse of soft delete, so the same capability governs both directions; granting one without the other would be backwards. (Hard delete's owner-only carve-out is unaffected — it has no inverse.)

Undelete does not re-run migrations. If a soft-deleted Record's schema fell behind while it was deleted, it comes back stale — a legal state, self-healing the next time it's written or `migrateAll()` sweeps it. `migrateAll()` includes soft-deleted Records in its sweep, so a Record can be migrated while deleted and come back current on undelete.

**`unlistedAt` is a sibling mechanism, not a variant of this one.** It withholds a Record from enumeration rather than from access — the Record stays fully readable and mutable throughout — and its own opt-in flag, ownership rule, and feed behavior differ from soft delete's in ways worth reading directly rather than assuming symmetric. See [Unlisted records](./unlisted.md).
