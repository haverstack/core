---
'@haverstack/core': minor
'@haverstack/adapter-api': minor
---

Relay changes that originate elsewhere. `Stack.subscribe()` now opens the adapter's feed alongside its own emitter, so a subscriber to a remote stack hears about writes made by anyone, and `onReset` — until now a documented option that could never fire — reaches the app when a gap opens that resumption could not close.

`APIAdapter.subscribeChanges()` consumes `GET /changes` as SSE over `fetch`: refused locally when discovery advertises no feed, resolved once the server's `ready` frame makes subscribe-then-query gap-free, resumed with `Last-Event-ID`, reconnected with exponential backoff and full jitter, and re-authenticated through the existing single-flight 401 path.

A relay is opened per subscription and carries that subscription's filter, because `entityId` and `parentId` are answerable only where the record is. A scoped view of a stack that relays refuses to subscribe with the new `StackRelayScopeError` rather than narrow a feed it cannot re-scope.
