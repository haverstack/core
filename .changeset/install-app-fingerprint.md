---
'@haverstack/core': minor
---

Every install apply names the plan it approves. `installApp(manifest, { did, ifFingerprint })` replaces `installApp(plan)`: it plans the manifest again for `did` and refuses with `StackConflictError` unless the result's fingerprint is `ifFingerprint`, so a server that shows the owner a plan in one request and applies it in another checks the approval exactly as an in-process caller passing `plan.fingerprint` does. `InstallPlan` carries that `fingerprint`, a SHA-256 over the manifest and the stack-dependent parts of the plan, with types taken by `schemaHash` and every list as a sorted set, so reordering a manifest's keys, types, requests, actions or enum values leaves it unchanged. `planInstall()` puts a manifest's requests in the form core compares them in — sorted, a repeated request or action dropped — so the `_install` record stores what the plan compared. `InstallAppOptions` is exported from `@haverstack/core`.
