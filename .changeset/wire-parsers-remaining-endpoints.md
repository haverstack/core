---
'@haverstack/core': minor
'@haverstack/conformance-fixtures': minor
---

`@haverstack/core/wire` adds a parser for every remaining endpoint core specifies, so a server no longer keeps its own list of their param and field names: `parseAuthChallengeBody()`, `parseAuthTokenBody()`, `parseEntityPatchBody()`, `parseTypeBody()`, `parseMigrationBody()`, `parseDeleteParams()`, `parseDownloadParams()` and `parseAssociationParams()`. Each refuses an unknown name or a malformed boolean with `StackBadRequestError`, and a known body field of the wrong type with `StackValidationError`. Two error fixtures pin a non-boolean `purge` and an unknown key on `POST /auth/token`.

`Stack` refuses an association, permission or grant-target element carrying a key its kind does not define, at every depth, with `StackBadRequestError`. This applies on every write that takes an element, on a `relatedTo` filter target, and on `grantType()`, `revokeType()` and `listTypeGrants()`. A `_grant` record's `grantee` is held to the same keys and refused with `StackValidationError`. A new error fixture pins an unknown key on a permission grantee.
