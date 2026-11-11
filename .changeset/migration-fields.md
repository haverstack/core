---
'@haverstack/core': minor
---

A migration now declares where each of the target's fields comes from, instead of listing steps. `migration(from, to, declare)` passes `declare` a builder typed by both handles, and `declare` returns `fields({ … })`, one origin per field: `field(source)` or `field(source, table)` for a source field, renamed or remapped; `constant(value)`; `derive(fn)`; or `absent()` for no value. For example, `migration(BookV1, Book, ({ fields, field }) => fields({ status: field('status', { done: 'finished' }) }))`.

Every origin reads the record as stored, so a declaration has no order and names each field once. The compiler checks each origin against the field it is declared for: target and source field names, a constant's type, what a `field()` carries and a table's keys and values, and what a `derive` returns, so a `derive` or `field()` from free text into an enum must map every value. A target field the source does not declare must be named, required or optional, so a rename cannot be left out; a field it does not name is carried from the source field of the same name. A source field the target does not declare is removed without being named.

The `rename`, `map`, `add`, `drop` and `derive` exports, the step types and `Migration.steps` are removed; `MigrationBuilder`, `MigrationFields`, `DeclaredFields` and `Origin` are exported.
