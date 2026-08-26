# Changesets

Every change that should reach the registry carries a **changeset** — a small
Markdown file in this directory naming the packages it affects and how far
their versions should move. CI reads them, opens a "Version Packages" pull
request, and publishes once that PR merges. See
[CONTRIBUTING.md § Releasing](../CONTRIBUTING.md#releasing) for the full flow.

Add one with:

```sh
pnpm changeset
```

No checkout to hand? **Actions → Add changeset → Run workflow** does the same thing from the browser — see [CONTRIBUTING.md § Without a checkout](../CONTRIBUTING.md#without-a-checkout).

## Choosing a bump while we are pre-1.0

Every package is still on `0.x`, where semver puts breaking changes in the
**minor** slot:

| Change                                                                                               | Bump           |
| ---------------------------------------------------------------------------------------------------- | -------------- |
| Bug fix, docs, internals — no API movement                                                           | `patch`        |
| Anything a consumer could notice: renamed or removed exports, changed behavior, new required options | `minor`        |
| Nothing — the change never ships                                                                     | _no changeset_ |

**Don't pick `major`.** It would cut a 1.0 release, which is a deliberate
decision and not something a single pull request should make.

## You only write changesets for what you changed

Dependents are handled for you. Because packages depend on each other through
`workspace:^` ranges — a range that accepts patches but not minors while we are
on `0.x` — the two directions fall out of the version numbers themselves:

- **A `patch` to `@haverstack/core` does not move its dependents.** `^0.11.1`
  already accepts `0.11.2`, so nothing else needs to be republished.
- **A `minor` to `@haverstack/core` moves every dependent by a `minor` too.**
  `^0.11.1` does not accept `0.12.0`, so each dependent needs a release that
  points at the new core — and since that release can carry a breaking change
  through, it is breaking in turn.

`scripts/expand-changesets.mjs` applies that second rule during `pnpm run
version`, transitively and for every workspace dependency, not just `core`. So
a changeset naming only `@haverstack/core` is complete; do not list the
dependents by hand.
