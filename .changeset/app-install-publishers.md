---
'@haverstack/core': minor
'@haverstack/wire-types': minor
'@haverstack/conformance-fixtures': minor
'@haverstack/adapter-api': minor
---

App manifests name a `publisher` DID and travel signed: `planInstall()`, `installApp()`, `POST /installs` and `APIAdapter.requestInstall()` take `{ manifest, signature }`, made with `signManifest()` over `manifestPayload()`. A `did:key` publisher verifies with no lookup; any other method needs a `verifyPublisher` callback. The first install pins its publisher on `_install.publisher`, so a manifest under the same `appId` signed by anyone else is refused, whichever key presents it. A plan's `namespaceVerified` is true when a `did:web` publisher's domain, reversed, is the `appId`.
