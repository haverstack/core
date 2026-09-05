---
'@haverstack/core': minor
---

Add the parse half of the request encoding to `@haverstack/core/wire`

`adapter-api` builds requests and nothing in core parsed them, so every
mirror pair was split across repositories with the parse side hand-written
per implementation. `parseQueryParams()`, `parseQueryBody()`,
`parseChangeParams()`, `parseIfMatch()` and `parseUploadFilename()` are now
exported, and the round trip against the builders is pinned by a test rather
than by each implementer transcribing the query-parameter table correctly.

The parsers do not clamp `limit` — a ceiling is deployment policy — and do
not gate on capabilities, which stays a separate `assertQueryCapabilities()`
call.

Two behavioural changes come with them. A malformed `If-Match` is now
refused with `StackQueryError` instead of read as an absent header, which
had silently degraded a fenced write to unconditional last-writer-wins. And
`filter.baseId` and `presentAt`, which have no wire encoding, are refused
rather than dropped: dropping either answers with a result set wider, or
staler, than the one that was asked for.

`parseDate()` moves to core and `@haverstack/wire-types` re-exports it, so
the request and response sides share one definition.
