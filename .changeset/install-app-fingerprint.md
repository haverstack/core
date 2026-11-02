---
'@haverstack/core': minor
---

Every install apply names the plan it approves. `installApp(manifest, { did, fingerprint })` replaces `installApp(plan)`: it plans the manifest again for `did` and refuses with `StackConflictError` unless the result is the plan whose `fingerprint` it was given, so a server that shows the owner a plan in one request and applies it in another checks the approval exactly as an in-process caller passing `plan.fingerprint` does. `InstallPlan` carries that `fingerprint`, a SHA-256 over the plan exactly as planned, so a reordered manifest is a different plan. `planInstall()` refuses a manifest listing a request's family, or an action within a request, more than once, as it refuses a type listed twice. `InstallAppOptions` is exported from `@haverstack/core`.
