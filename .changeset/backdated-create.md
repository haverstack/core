---
'@haverstack/core': minor
---

Add `createdAt`/`updatedAt` options to unscoped `Stack.create()`, so an app can import an
existing corpus with its real dates instead of every record landing stamped with the import
moment.

- Full-trust context only, like the existing client-minted `id` option: `ScopedStack.create()`
  never accepts `createdAt`/`updatedAt`, and `POST /records` keeps refusing both, unchanged.
- Omit `id` and it is derived from `createdAt`'s timestamp, so the two agree by construction.
  Supply both, and they are checked against each other using the same `idTimestampSkewMs`
  tolerance `ScopedStack.create()`'s grantee check already uses (default 24 hours; `null`
  disables this check too) — disagreement beyond that tolerance throws `StackValidationError`
  rather than silently diverging.
- `updatedAt` defaults to `createdAt`, not to the actual current time, so a plain import
  doesn't fabricate a fake edit and inflate version history. An `updatedAt` earlier than
  `createdAt` is a validation error.

See docs/spec/data-model.md § Record IDs.
