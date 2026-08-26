# @haverstack/core

## 0.13.0

### Minor Changes

- [#193](https://github.com/haverstack/core/pull/193) [`d556069`](https://github.com/haverstack/core/commit/d5560696f3ec1d08e9d49f66b79cbf2f5036dfef) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Relay changes that originate elsewhere. `Stack.subscribe()` now opens the adapter's feed alongside its own emitter, so a subscriber to a remote stack hears about writes made by anyone, and `onReset` — until now a documented option that could never fire — reaches the app when a gap opens that resumption could not close.

  `APIAdapter.subscribeChanges()` consumes `GET /changes` as SSE over `fetch`: refused locally when discovery advertises no feed, resolved once the server's `ready` frame makes subscribe-then-query gap-free, resumed with `Last-Event-ID`, reconnected with exponential backoff and full jitter, and re-authenticated through the existing single-flight 401 path.

  A relay is opened per subscription and carries that subscription's filter, because `entityId` and `parentId` are answerable only where the record is. A scoped view of a stack that relays refuses to subscribe with the new `StackRelayScopeError` rather than narrow a feed it cannot re-scope.

## 0.12.0

### Minor Changes

- [#185](https://github.com/haverstack/core/pull/185) [`779ddd6`](https://github.com/haverstack/core/commit/779ddd6599c8b9049ca6fbf1516a4a54705e9609) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Stop `ScopedStack` refusals from confirming which record IDs exist.

  A record the request cannot read now answers exactly as a missing one does. `ScopedStack.get()` returns `null` for an unreadable record instead of throwing `StackPermissionError`, and `update()`, `associate()`, `dissociate()`, `setPermissions()`, `delete()`, `undelete()`, `getVersions()`, `getVersion()` and `restoreVersion()` throw `StackNotFoundError` rather than `StackPermissionError` where the requester holds no read access. `StackPermissionError` is now reserved for a requester who can read the record — over the wire, 403 is earned by readability and everything else is 404.

  Record IDs encode their creation millisecond and increment within it, so the old distinction let anyone holding one ID confirm its same-millisecond siblings. Callers that branch on `StackPermissionError` to detect "exists but forbidden" will see `StackNotFoundError`/`null` instead; the distinction is still available to server operators, which `docs/spec/wire-format.md` § Server implementation checklist now asks them to log.

  Unaffected: refusals that never read the record — `commitMigration()`, `deleteAttachment()` and `collectAttachmentGarbage()` answer identically whether or not it exists — and reference-creation gating, which continues to collapse missing and inaccessible targets onto `StackPermissionError`.

  Fixtures gain `error-not-found-record-the-requester-cannot-read`, so a server that answers 403 there now fails conformance.

## 0.11.2

### Patch Changes

- [#184](https://github.com/haverstack/core/pull/184) [`fb33761`](https://github.com/haverstack/core/commit/fb33761ed30ddc26d9fd5beb4c1559267e2d01dc) Thanks [@cuibonobo](https://github.com/cuibonobo)! - Correct the `repository` URL to the `git+https://github.com/haverstack/core.git` form npm validates provenance against.
