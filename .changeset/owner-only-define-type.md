---
'@haverstack/core': patch
---

Document the two layers of an app — a data layer over `StackClient` and an owner-run install function over `Stack` — and that migration registration runs at every startup. The spec now states that `POST /types` is served to the owner acting alone.
