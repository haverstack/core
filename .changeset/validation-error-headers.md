---
'@haverstack/core': minor
'@haverstack/wire-types': minor
'@haverstack/conformance-fixtures': minor
---

`StackValidationError`'s message header names what was validated: record content keeps "Content validation failed", a type schema reads "Schema validation failed", and argument checks read "Invalid arguments". `associate()`/`dissociate()` and `grantAccess()`/`revokeAccess()` report list errors under `associations`/`permissions`, the parameter the caller passed, rather than `changes`. `deserializeError()` keeps the header a server sent.
