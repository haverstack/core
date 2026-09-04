# Agent Guide

Instructions for AI coding agents working in this repository. Humans should read [CONTRIBUTING.md](./CONTRIBUTING.md), which explains the reasoning behind everything here; this file is the short, checkable form.

## Build before you typecheck

```sh
pnpm install
pnpm run build      # required before typecheck
pnpm run typecheck
```

Packages resolve each other through `dist/*.d.ts`. On a fresh checkout, `pnpm run typecheck` without a prior build produces a cascade of confusing errors — the real one is the **first** in the list:

```
src/index.ts(9,8): error TS2307: Cannot find module '@haverstack/core'
```

Every type from that import then degrades to `unknown`, so you get a wall of `TS18046: 'err' is of type 'unknown'` in code that is completely fine. **Do not "fix" those errors.** Build, then re-run.

`pnpm test` does _not_ need a build — vitest aliases `@haverstack/*` to sibling `src/`.

## Before you push

Run all five. They mirror `.github/workflows/ci.yml`, so a clean local run means a green PR.

```sh
pnpm run format:check   # pnpm run format to fix in place
pnpm run lint
pnpm test
pnpm run build
pnpm run typecheck
```

Report results honestly. If something fails, say so with the output rather than describing the change as complete.

## Writing comments

These rules are enforced in review. Applying them to code you touch is expected; a sweeping unrelated comment refactor is not.

- **Answer _why_, not _how_.** The how should be readable in the code. Don't narrate the next few lines.
- **Four or five lines is the maximum**, not the target. Longer explanations link to the spec instead: `See docs/spec/identity.md § Group.`
- **File-top module comments are exempt** — they may be as long as needed to say what the module is and why it exists.
- **Never cite GitHub issues** (`#106`) in code comments. They belong in commit messages and PR descriptions only.
- **Never describe previous implementations.** No "the old design", "this used to…", "before this fix". State the current invariant. This applies to test comments too: say what the test pins, not what bug prompted it.
- **If a rule needs more justification than fits, put it in the spec** and link to the section. Don't duplicate spec prose in a comment.

## The spec is the source of truth

Design lives in [`docs/spec.md`](./docs/spec.md) and [`docs/spec/`](./docs/spec/): data model, identity, access control, unlisted records, versioning, attachments, change events, adapters, wire format, change feed.

- A change to observable behavior (API contract, permission rule, wire shape, error mapping) **updates the spec in the same change**.
- Section names are load-bearing — code comments reference them as `docs/spec/<file>.md § Section`. Verify a section exists before linking to it, and update inbound references when renaming a heading.
- Needing a long comment to explain a rule that isn't in the spec means the spec is missing a section. Add it.
- **Spec prose states the system as it is, never how it got there.** The no-previous-implementations rule above applies to prose: "is in core now", "this used to be flat", "when #16 lands" date the document and describe a system the reader can't see. Say which layer carries what instead. This covers `docs/commons/` too — a design guide, not a changelog.

## No backward compatibility

There is **no install base**. Nothing depends on current behavior.

- Don't add compatibility shims, deprecation paths, or decoder branches for formats this codebase never produced.
- Delete rather than deprecate.
- Don't use the word "legacy". A third-party implementation of the wire protocol is _foreign_, not legacy.

This is about _our_ history. Genuinely foreign input — a third-party server's response, a stack file from another adapter — is current-behavior handling and stays.

## Architecture rules

- **`Stack` is the invariant layer; adapters are storage engines.** Validation, `_config` protection, ID rules, migration policy, and permission checks live in `packages/core` so every adapter inherits them. Don't reimplement an invariant inside an adapter. (The one documented exception: the `_config` query exclusion must live in each adapter's own query predicate.)
- **Package prefixes declare the contract**: `adapter-*` = full `StackAdapter`, `record-adapter-*` = `StackRecordAdapter`, `blob-adapter-*` = `StackBlobAdapter`.
- **Optional capabilities are optional methods**, checked for truthiness at the call site with a documented fallback — never a boolean in `capabilities`.
- **Shared SQLite logic goes in `@haverstack/sqlite-shared`**, not duplicated across adapters. It is `private` and bundled into its consumers at build time, so it is never a `dependencies` entry and adding an export to it does not widen any package's public API.
- **Wire behavior is pinned by `@haverstack/conformance-fixtures`** — pure data, consumed by both `adapter-api` and server implementations. Changing the wire contract means updating fixtures, spec, and implementation together.

## Tests

Vitest, in each package's `tests/`. `@haverstack/core/testing` provides `MemoryAdapter` (declares `contentFieldQuery: true` and `nestedContentQuery: true`, as every local adapter must) and `IncapableMemoryAdapter` (declares both `false`, for exercising capability-gated fallbacks).

Name tests after the invariant they pin, not the defect that prompted them.

## Changesets

Every change that ships to npm carries a changeset. Add one in the same commit:

```sh
pnpm changeset
```

- **Name only the packages you edited.** Dependents are expanded automatically at version time by `scripts/expand-changesets.mjs` — listing them by hand double-counts.
- **`patch`** for anything a consumer cannot observe; **`minor`** for anything they can. Every package is `0.x`, so minor _is_ the breaking slot.
- **Never `major`** — that cuts a 1.0 release, which is not a PR-level decision.
- **No changeset** for tests, CI, or repo tooling.
- `@haverstack/sqlite-shared` is `private` and has no version to publish. Record a change to it against `@haverstack/record-adapter-sqlite`, which bundles it — a changeset naming only private packages is rejected. If a template hands you a list of every package (changeset-bot's does), trim it to what you changed.

A `minor` on a package minor-bumps everything that depends on it, transitively; a `patch` bumps nothing else. Preview with `node scripts/expand-changesets.mjs --dry-run`. Never hand-edit a `version` field or a `CHANGELOG.md` — CI owns both. See [CONTRIBUTING.md § Releasing](./CONTRIBUTING.md#releasing).

## Commits and pull requests

- Conventional Commits: `docs:`, `fix:`, `feat:`, optionally scoped — `fix(conformance-fixtures): …`. Imperative subject; the body explains why.
- Issue references are welcome here and in PR bodies.
- Fill in `.github/pull_request_template.md`, including the Spec section.
- Don't open a PR unless asked to.
