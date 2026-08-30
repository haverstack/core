---
'@haverstack/commons': minor
---

Add `org.haverstack/post@1` — the broadcast utterance, completing the fourth cell
(speech / unbounded audience) of the commons' text-type contract 2×2.

`POST` exports `{ text: required, format, url }`, no date field by design — uttering
is creating, and a mirrored `publishedAt` would equal `createdAt` on every record. See
`docs/commons/post.md` for the full rationale and conventions.
