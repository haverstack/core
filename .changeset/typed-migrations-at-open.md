---
'@haverstack/core': minor
'@haverstack/commons': minor
---

A type handle carries what `defineType()` takes: `typeHandle({ id, name, schema, migratesFrom })`, with `migratesFrom` given as a handle or a `TypeId`. `defineType(handle)` and a manifest's `types` take it as written. Migrations are typed values built with `migration(from, to, fn)`, where `fn` is checked as the first handle's content to the second's, and are passed to `Stack.open(adapter, { migrations })`. `registerMigration()` and `MigrationFn` are removed. `@haverstack/commons` drops `CommonsType`; its exports are plain type handles.
