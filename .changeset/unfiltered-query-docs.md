---
'@haverstack/core': patch
---

Document that an unfiltered `query()` returns every readable record, system records included, so an app filters by `typeId`, `baseId` or `appId` to get its own.
