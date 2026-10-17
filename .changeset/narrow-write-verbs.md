---
'@haverstack/core': minor
'@haverstack/adapter-api': minor
'@haverstack/adapter-local': minor
'@haverstack/adapter-conformance': minor
'@haverstack/conformance-fixtures': minor
'@haverstack/record-adapter-sqlite': minor
'@haverstack/record-adapter-do-sqlite': minor
---

Every aspect of a record has one narrow write verb, so no call can change more than its caller means to. `mutate()` and its change set are removed: content is written with `patchContent()`, containment with `setParent(id, parentId | null)`, listing with `setUnlisted(id, boolean)`, associations with `editAssociations()` or `setAssociations()`, and permissions with `editAccess()` or `setAccess()`. `edit*` applies a list of `add`/`remove` edits; `set*` replaces the whole set. `associate()`, `dissociate()`, `grantAccess()` and `revokeAccess()` are removed in favour of the `edit*` verbs, and `amendAssociations()`/`amendAccess()` are renamed to them. `deleteAndReturn()` is removed: `delete()` always returns `{ record, referencedFileIds }`.

Every write accepts `ifVersion` and always checks it, including the writes that never bump `version`, so a publish can fence `setAccess()` and `setUnlisted()` to the content it reviewed.

`StackRecordAdapter` narrows to match: `mutateRecord()` and `amendAssociations()` are replaced by `patchContent()`, `setParent()`, `setUnlisted()`, `editAssociations()`, `setAssociations()`, `editAccess()` and `setAccess()`, each taking `ifVersion`. `BumpVersionOptions`, `RecordChangeSet`, `assertOneSurface()`, `partitionAssociations()` and `AUTHORITY_ASSOCIATION_KINDS` are removed. SQLite adapters store permissions in a `permissions` table of their own.

On the wire, `PATCH /records/:id` is replaced by `PATCH /records/:id/content` (a bare patch body), `PUT /records/:id/parent` and `PUT /records/:id/unlisted`; `PUT /records/:id/associations` and `PUT /records/:id/permissions` replace a set; `PATCH /entity` becomes `PATCH /entity/content`. Every write endpoint reads and checks `If-Match`. `changesFromWireBody()` and `parseEntityPatchBody()` are replaced by `parseContentPatchBody()`, `parseParentBody()`, `parseUnlistedBody()`, `parseAssociationsBody()` and `parsePermissionsBody()`.
