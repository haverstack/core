---
'@haverstack/core': patch
---

Split `Stack` and `ScopedStack` into folders of smaller modules — the `StackClient` interface and its option types, the migration registry, system Type definitions, write invariants, app installs, type grants, attachment cleanup, scope authority and the scoped change feed each live in a file of their own — and fold logic the two classes repeated into shared helpers. The public API and behaviour are unchanged.
