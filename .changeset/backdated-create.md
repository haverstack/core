---
'@haverstack/core': minor
---

Add `createdAt`/`updatedAt` options to `Stack.create()`, so an app — or a stack owner, through
their own server — can import an existing corpus with its real dates instead of every record
landing stamped with the import moment.

- Unconditional on unscoped `Stack.create()`, like the existing client-minted `id` option.
  `ScopedStack.create()` accepts the same two fields, but only from the stack owner acting
  alone (undelegated, authenticated as themselves — the same tier that already gates hard
  delete, `commitMigration()`, and `includeUnlisted`); a grantee, or a delegated app acting for
  the owner, is refused with `StackPermissionError`. `POST /records` inherits this rule
  automatically on a server built on `ScopedStack`: an owner-authenticated request may carry
  both fields, anyone else's has them ignored, as before.
- Omit `id` and it is derived from `createdAt`'s timestamp, so the two agree by construction.
  Supply both, and they are checked against each other using the same `idTimestampSkewMs`
  tolerance the ordinary `id`-vs-current-time check already uses (default 24 hours; `null`
  disables this check too) — disagreement beyond that tolerance throws `StackValidationError`
  rather than silently diverging. An owner's plain `id`-only create through `ScopedStack` is
  unaffected — it still gets the ordinary `id`-vs-current-time check, not this one.
- `updatedAt` defaults to `createdAt`, not to the actual current time, so a plain import
  doesn't fabricate a fake edit and inflate version history. An `updatedAt` earlier than
  `createdAt` is a validation error, including when `createdAt` defaulted to now.
- Both fields must be valid Dates within the range a record ID's timestamp prefix can
  encode (1970-01-01 through 3084-12-12); anything else is a `StackValidationError`. An
  `Invalid Date` in particular is refused rather than stored, since its `NaN` timestamp
  would silently switch off the checks above instead of failing them.
- Dates are copied on the way in, so an import loop that advances and reuses a single
  `Date` across rows doesn't retro-edit the records it already wrote.

See docs/spec/data-model.md § Record IDs.
