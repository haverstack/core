---
'@haverstack/core': minor
---

Every install apply names the plan it approves. `installApp(manifest, { did, fingerprint })` replaces `installApp(plan)`: it plans the manifest again for `did` and refuses with `StackConflictError` unless the result is the plan whose `fingerprint` it was given, so a server that shows the owner a plan in one request and applies it in another checks the approval exactly as an in-process caller passing `plan.fingerprint` does. `InstallPlan` carries that `fingerprint`: a SHA-256 over a canonical form of what the plan was made from — the manifest, the key and what was read from the stack — with schemas by `schemaHash` and actions and every list as sets, so a manifest whose keys or lists a store reordered is the same plan. `planInstall()` refuses a manifest requesting a family twice, as it refuses a type listed twice. `InstallAppOptions` is exported from `@haverstack/core`.
