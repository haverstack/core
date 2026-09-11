---
'@haverstack/core': minor
'@haverstack/adapter-api': minor
'@haverstack/adapter-local': minor
'@haverstack/record-adapter-sqlite': minor
'@haverstack/record-adapter-do-sqlite': minor
'@haverstack/conformance-fixtures': minor
'@haverstack/wire-types': minor
---

Move a record's aspects in one call, one version

**`mutate(id, changes, opts)` replaces `update()`, `setPermissions()`, `setUnlisted()` and
`setParent()`.** It takes a change set naming any combination of `contentPatch`, `parentId`,
`permissions`, `associations` and `unlisted`, applies it as one atomic write, and produces
exactly one version carrying one snapshot.

```ts
await stack.mutate(note.id, {
  contentPatch: { title: 'Q3 plan' },
  parentId: folder.id,
  unlisted: false,
});
```

Each aspect used to have its own verb, so "save and move", "save and share" and "save and
publish" each cost a version apiece and three round trips — and could not be fenced by one
`ifVersion`, since the second call had to be pinned against a version only the first call's
response could supply.

**Keys are read for presence, not truthiness.** `unlisted: false` and `parentId: null` name
aspects and are applied; an omitted key is untouched. A change set naming no key at all is
`StackQueryError` (wire: 400) — it addresses nothing, so there is nothing it could have
failed to satisfy. A change set already satisfied in every key writes nothing and returns
the record unchanged.

**`patchContent(id, patch, opts)` is the content-only spelling**, and the name the adapter
primitive already used. `update()` is gone: it promised a symmetry with `create()` that a
merge patch does not have.

## `contentPatch` is the one key that merges

Every other key replaces the aspect it names. Content stays a patch for three concrete
reasons: `limits.contentBytes` bounds what travels, so a whole-document write would charge a
one-field edit against the full ceiling; two apps editing different top-level fields both
survive a patch and clobber one another under replacement; and content read through
`presentAt: 'latest'` cannot be written back wholesale at all, since a write validates
against the record's _own stored_ type and a read-modify-write across a pending migration
would submit migrated content to the schema it was migrated away from.

The key is named for its semantic so that asymmetry is visible at the call site rather than
resident in prose.

## Authority resolves per key, against the record as it stands

The aspects do not share a gate — content is reachable by a write-holder or an `update-*`
grantee, `permissions` and `unlisted` only by the owner or the record's own creator. So a
change set resolves each key on its own and lands exactly where the same caller would have
landed one key at a time: **a requester who may perform every key may perform the set, and a
requester who may not perform one of them may not perform any of it.**

Every gate reads the record's **pre-change** state. A widened `permissions` in a change set
never satisfies the read check on a `parentId` named in the same call, and a `_group` roster
never satisfies the admin check that same call must pass — either would be a one-call
escalation out of a gate the single-key spelling enforces. A refused key refuses the whole
call: nothing is partially applied and no key is silently dropped.

## `associate()` / `dissociate()` stay their own verbs

They amend the association set where the `associations` key replaces it. Two apps tagging
one record both succeed through the methods and race through the key, so the delta spelling
is kept for the operation that most needs it rather than folded into a declarative envelope,
where "add this one" is not a thing that can be said.

## Change events name every aspect that moved

`RecordChange.op` becomes **`ops: ChangeOp[]`**, derived by diffing the record against its
prior state rather than read off the request — so naming an aspect without moving it is
never reported as moving it. The `update` op is renamed **`patch`**. `kind` resolves to the
most conservative entry: a change set carrying `unlist` is `deleted` whatever else it
carries, because a subscriber holding the record still has to drop it. Every op outside
`mutate()`'s reach (`create`, `delete`, `undelete`, `hard-delete`, `migrate`, `restore`) is
still emitted alone, so a multi-entry `ops` is always a change set.

## Wire format

`PATCH /records/:id` now takes the change-set envelope, and `PUT .../parent`,
`PUT .../permissions` and `PUT .../unlisted` are gone — one `If-Match` fences a whole
multi-aspect edit. `GET /records/:id/permissions` stays. An unrecognized top-level key is
**400** and a key the type does not declare inside `contentPatch` is **422**, the same split
every other write endpoint makes. `changesFromWireBody()` in `@haverstack/core/wire` applies
this for servers built on core.

The envelope also retires a wart: `contentPatch.parentId` and the native `parentId` are now
unambiguous by construction, rather than by a rule the spec had to state twice.

## Adapters

The four single-aspect adapter methods (`patchContent`, `setPermissions`, `setUnlisted`,
`setParent`) collapse into one **`mutateRecord(id, changes, opts)`**. This shrinks the
contract rather than growing it: in `sqlite-shared` those four were already the same
`UPDATE records SET <col>, version = version + 1, updated_at = ?, ...` with one column
swapped, and they are now one statement with a variable SET list. `Stack` narrows a change
set to the aspects that actually moved before it reaches an adapter, so every key an adapter
receives is one it must write — which is what keeps a restated `unlisted: true` from
dragging `unlistedAt` forward with no op reporting it.

## Also

**Fixed: the content merge was documented as RFC 7396, which recurses, but is one level
deep.** `applyMergePatch` iterates top-level keys and replaces each value whole, so a nested
object in a patch replaces rather than merges. The spec now states the top-level rule and
drops the RFC citation; an app author trusting the reference would have expected a nested
patch to preserve sibling keys and silently lost them. Behavior is unchanged — only the
claim about it.
