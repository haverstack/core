---
'@haverstack/commons': minor
---

Export each commons type as a type handle (`id`, `baseId`, `schema`, plus `name`), so `stack.create(NOTE, …)` and the other typed overloads derive content types from the canonical schema. `CommonsType` is now generic over its schema.
