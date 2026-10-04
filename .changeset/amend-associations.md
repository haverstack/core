---
'@haverstack/core': minor
'@haverstack/adapter-api': minor
'@haverstack/adapter-conformance': minor
'@haverstack/conformance-fixtures': minor
'@haverstack/wire-types': minor
'@haverstack/adapter-local': minor
'@haverstack/record-adapter-sqlite': minor
'@haverstack/record-adapter-do-sqlite': minor
---

`StackRecordAdapter.associate()` and `dissociate()` are replaced by `amendAssociations(id, changes, opts?)`, which applies a list of `AssociationEdit` as one write. `POST /records/:id/associations` and `/permissions` take `{ changes }` and the `/delete` sub-paths are removed. `parseAssociationEditsBody()` and `assertOneSurface()` are exported from `@haverstack/core`.
