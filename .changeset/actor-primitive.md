---
'@haverstack/core': minor
'@haverstack/wire-types': minor
'@haverstack/adapter-api': minor
'@haverstack/adapter-local': minor
'@haverstack/record-adapter-sqlite': minor
'@haverstack/conformance-fixtures': minor
---

"Who did this, and through which principal" is one `Actor` type — `{ subjectId, principalId? }` — everywhere it appears. `StackRecord` and `RecordVersion` carry `createdBy: Actor` (replacing `entityId` + `principalId`) and `updatedBy: Actor` (replacing `updatedBy` + `updatedVia`), on the wire as in memory. `ChangeActor` is `Actor & { appId? }`, `TokenSession` is an `Actor` with `principalId` always set, and `ActorOptions` is `{ actor?: Actor }`. `RecordFilter.createdBy` and `ChangeFilter.createdBy` replace the author filters (query params `createdBySubject` / `createdByPrincipal`). `Stack.asActor(actor)` replaces `forSession()` and `asEntity()`'s `onBehalfOf` option, and `StackTokenStore.createToken()` takes an `Actor`. The SQLite `versions` table gains a `principal_id` column so a snapshot keeps its author's principal.
