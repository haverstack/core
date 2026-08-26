# Changesets

Every change that reaches the registry carries a **changeset** — a small
Markdown file in this directory naming the packages it affects and how far
their versions move. CI reads them, opens a "Version Packages" pull request,
and publishes when that merges.

```sh
pnpm changeset
```

No checkout to hand? **Actions → Add changeset → Run workflow** does the same
from the browser.

Two rules to know before writing one:

- **Every package is on `0.x`**, so `minor` is the breaking slot and `major`
  is not a per-change decision.
- **Name only the packages you changed.** Dependents are worked out during
  versioning; listing them by hand double-counts.

[CONTRIBUTING.md § Releasing](../CONTRIBUTING.md#releasing) has the rest — the
bump table, the ripple rule, and how the publish authenticates.
