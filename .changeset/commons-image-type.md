---
'@haverstack/commons': minor
---

Rename the `org.haverstack/photo@1` type to `org.haverstack/image@1` (export `PHOTO` → `IMAGE`), since paintings, drawings, scans, and screenshots belong in it as much as photos. Its required `file-ref` field is `file` (was `image`) and the capture-time field is `capturedAt` (was `takenAt`). See docs/commons/image.md.
