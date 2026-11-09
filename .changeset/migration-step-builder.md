---
'@haverstack/core': minor
---

`migration(from, to, steps)` now takes a function that receives a step builder typed by both handles and returns the list: `migration(BookV1, Book, ({ map }) => [map('status', { done: 'finished' })])`. `add(field, value)` and `derive(field, fn)` are typed by the target: `field` must be one of its top-level fields and `value`, or what `fn` returns, that field's write type, so a `derive` from free text into an enum must map every value to compile. `migration()` also refuses a `rename`, `map` or `drop` of a field an earlier `add` or `derive` produced. The top-level `rename`, `map`, `add`, `drop` and `derive` exports are removed; `Steps` is exported.
