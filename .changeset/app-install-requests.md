---
'@haverstack/core': minor
'@haverstack/wire-types': minor
'@haverstack/conformance-fixtures': minor
'@haverstack/adapter-api': minor
---

`POST /installs` lets an app present its manifest for the owner to approve, as the key its session authenticated with: `202 { status: 'pending' }` until approved, `200 { status: 'installed', install }` once applying it would change nothing. Discovery advertises it with `installs: { requests: true }`. `APIAdapter.requestInstall()` sends it, `parseInstallBody()` and `isPlanEmpty()` serve it, and `installApp()` gives each linked key read on its own `_install` record. A manifest may define only types in its own namespace (the family's namespace is the `appId`) and commons types, which it defines without claiming.
