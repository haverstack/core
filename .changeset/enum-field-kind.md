---
'@haverstack/core': minor
'@haverstack/conformance-fixtures': minor
'@haverstack/adapter-conformance': patch
---

`enum` is a field kind: `{ kind: 'enum', values: [...] }` replaces `{ kind: 'string', enum: [...] }`. `defineType()` refuses the `enum` key on any field. `isCompatible()` now checks enums: a required enum accepts only an enum candidate whose values it lists all of, and a required `string` or `text` accepts an enum. An enum becoming a plain `string` is additive; a `string` becoming an enum needs a version bump. Conformance fixtures pin a 422 for a value outside the list and a 409 for removing values. The adapter conformance suite checks that an enum field sorts by value.
