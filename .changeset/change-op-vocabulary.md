---
'@haverstack/core': minor
'@haverstack/adapter-api': minor
'@haverstack/conformance-fixtures': minor
'@haverstack/adapter-local': minor
'@haverstack/record-adapter-sqlite': minor
'@haverstack/record-adapter-do-sqlite': minor
'@haverstack/adapter-conformance': patch
---

Make every `ChangeOp` a verb and spell permanent deletion one way. The record-level ACL op `'permissions'` is now `'reshare'`. Permanent deletion is `purge` everywhere: `delete(id, { purge: true })` (was `{ hard: true }`), `deleteRecord(id, { purge: true })` on every adapter, `DELETE /records/:id?purge=true` on the wire (was `?hard=true`), and the op `'purge'` (was `'hard-delete'`), matching the existing `'purged'` kind.
