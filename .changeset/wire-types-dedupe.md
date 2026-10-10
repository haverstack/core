---
'@haverstack/wire-types': minor
'@haverstack/conformance-fixtures': patch
---

`@haverstack/wire-types` no longer restates shapes `@haverstack/core` already defines:

- `AuthChallengeRequest` and `AuthTokenRequest` are removed. Use `WireAuthChallengeRequest` and `WireAuthTokenRequest`, re-exported from `@haverstack/core/wire`, where the parsers that return them live.
- `WireActor` and `WireChangeActor` are now aliases of core's `Actor` and `ChangeActor`. Their shape is unchanged.
- `WireAssociationEditsRequest` is removed; nothing referenced it.
