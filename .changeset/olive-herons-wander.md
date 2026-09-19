---
'@haverstack/core': patch
'@haverstack/conformance-fixtures': patch
---

Point spec citations at the document that now carries the rule

The 404-over-403 rule moved out of `docs/spec/access-control.md` into its own
`docs/spec/disclosure.md`. JSDoc on `ScopedStack` and one conformance
fixture's description cited the old section, and both ship — the comments in
`.d.ts`, the description in the fixture data. No behavior changes.
