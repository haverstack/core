---
'@haverstack/core': minor
---

An `InstallPlan` carries a `fingerprint` naming it — the manifest, with its keys sorted, and every part of the plan that depends on the stack — and `installApp(plan, { fingerprint })` refuses with `StackConflictError` unless planning again still produces the plan with that fingerprint. A server that shows the owner a plan in one request and applies it in another carries the reviewed plan's fingerprint between them, so what lands is what was approved. `InstallAppOptions` is exported from `@haverstack/core`.
