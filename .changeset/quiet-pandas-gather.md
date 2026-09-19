---
'@haverstack/conformance-fixtures': patch
---

Point the journal read-gate fixture at the section that states the rule

`error-permission-denied-journal-read-only` cited
`docs/spec/versioning.md § Reading it`, which is not a section. The
mutate-surface gate on `GET /records/:id/journal` is stated in
`docs/spec/journal.md § Reading it`.
