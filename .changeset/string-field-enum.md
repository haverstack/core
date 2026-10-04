---
'@haverstack/core': minor
---

String fields can declare `enum: [...]`, a non-empty list of allowed values. Validation refuses a value outside the list, `defineType()` refuses a malformed list, schema drift treats adding an `enum` or removing values as a change that needs a version bump, and the schema hash sorts the values.
