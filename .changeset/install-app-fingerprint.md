---
'@haverstack/core': minor
---

Every install apply names the plan it approves. `installApp(manifest, { did, ifFingerprint })` replaces `installApp(plan)`: it plans the manifest again for `did` and refuses with `StackConflictError` unless the result's fingerprint is `ifFingerprint`, so a server that shows the owner a plan in one request and applies it in another checks the approval exactly as an in-process caller passing `plan.fingerprint` does. `InstallPlan` carries that `fingerprint`, a SHA-256 over the manifest and the stack-dependent parts of the plan in the forms core already compares them in — types by `schemaHash`, requests as sets of actions, every list sorted — so reordering a manifest's keys, types, requests, actions or enum values leaves it unchanged. `InstallAppOptions` is exported from `@haverstack/core`.
