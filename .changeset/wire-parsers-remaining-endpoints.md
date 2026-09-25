---
'@haverstack/core': minor
'@haverstack/conformance-fixtures': minor
---

`@haverstack/core/wire` adds a parser for every remaining endpoint core specifies, so a server no longer keeps its own list of their param and field names: `parseAuthChallengeBody()`, `parseAuthTokenBody()`, `parseEntityPatchBody()`, `parseTypeBody()`, `parseMigrationBody()`, `parseDeleteParams()`, `parseDownloadParams()` and `parseAssociationParams()`. Each refuses an unknown name or a malformed boolean with `StackBadRequestError`, and a known body field of the wrong type with `StackValidationError`. Two new error fixtures pin a non-boolean `purge` and an unknown key on `POST /auth/token`.
