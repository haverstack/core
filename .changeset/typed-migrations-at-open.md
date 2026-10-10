---
'@haverstack/core': minor
'@haverstack/commons': minor
---

A type handle carries what `defineType()` takes: `typeHandle({ id, name, schema, migratesFrom })`, with `migratesFrom` given as a handle or a `TypeId`. `defineType(handle)` and a manifest's `types` take it as written. Migrations are typed values built with `migration(from, to, fn)`, where `fn` is checked as the first handle's content to the second's, and are passed to `Stack.open(adapter, { migrations })`. `migratesFrom` must name an earlier version of the same family, and `typeHandle()` and `defineType()` refuse anything else. `migration()` checks that pairing within a family and builds a step into another family without it, so an app's own type can migrate into a commons type. `Stack.open()` refuses a set of migrations it could not walk: a duplicate `from`, a malformed TypeId, a step backwards within a family, or a cycle. `registerMigration()` and `MigrationFn` are removed. `@haverstack/commons` drops `CommonsType`; its exports are plain type handles.
