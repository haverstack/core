---
'@haverstack/adapter-conformance': minor
---

The blob suite requires `getBlob()` to return a plain `Uint8Array` (not a subclass such as `Buffer`) and checks that the returned array and the array passed to `putBlob()` are independent of the stored bytes.
