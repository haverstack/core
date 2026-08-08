# Contributing to Haverstack

Thanks for working on this. This document covers how to get set up, what to run before you push, and the conventions the codebase already follows — the ones that aren't obvious from reading a single file.

---

## Setup

The repo is a [pnpm workspace](https://pnpm.io/workspaces). CI runs Node 22 and pnpm 10; match those locally.

```sh
pnpm install
```

---

## Before you push

Run all five, in this order:

```sh
pnpm run format:check   # or: pnpm run format, to fix in place
pnpm run lint
pnpm test
pnpm run build
pnpm run typecheck      # must come after build — see below
```

These mirror `.github/workflows/ci.yml` exactly, so a clean local run means a green PR.

**`pnpm run typecheck` requires `pnpm run build` first.** Packages import each other through their published entry points (`@haverstack/core`, `@haverstack/sqlite-shared`, …), which resolve to `dist/*.d.ts`. Without a build, those imports fail with `TS2307: Cannot find module '@haverstack/core'`, and every type that came through them degrades to `unknown` — producing a cascade of unrelated-looking errors (`TS18046: 'err' is of type 'unknown'`) in code that is perfectly fine. CI encodes this: its `typecheck` job declares `needs: build`. If you see a wall of `unknown` errors, check whether the _first_ error in the list is a missing module, and build before doing anything else.

**`pnpm test` does not need a build.** Each package's `vitest.config.ts` aliases `@haverstack/*` to the other package's `src/index.ts`, so tests always run against current source rather than a stale `dist`. A new cross-package dependency needs a matching alias added to the dependent package's vitest config, or its tests will resolve to `dist` and behave inconsistently.

---

## Commits and pull requests

Commit subjects follow [Conventional Commits](https://www.conventionalcommits.org/): `docs:`, `fix:`, `feat:`, optionally scoped — `fix(conformance-fixtures): …`. Write the subject in the imperative, and use the body to explain _why_ the change was made, not what the diff already shows.

Issue references (`#123`) belong in commit messages, PR titles, and PR bodies. They do **not** belong in code comments — see [Comments](#comments) below.

Work on a branch and open a PR; CI must be green before merge.

---

## Comments

The convention this codebase follows, in order of how often it comes up:

**Comments answer _why_. The _how_ should be visible in the code itself.** If a comment is narrating what the next few lines do, delete it and let the code speak. If the code is hard enough to follow that it needs narration, that's usually a signal to simplify the code.

**Keep them short — four or five lines is the extreme case, not the target.** Anything needing more explanation than that links out to the spec instead of carrying the argument inline:

```ts
/**
 * `_group` records are managed, not merely written: only the owner or an
 * `admin` roster holder may mutate them — ordinary write permissions and
 * grants don't apply. See docs/spec/identity.md § Group.
 */
```

**File-top module comments are exempt.** A comment at the top of a file may be as long as it needs to be to explain what the module does and why it exists.

**No GitHub issue references.** An issue captured something that needed to change, and the change is now reflected in the spec and the code. A `(#106)` in a comment adds nothing a reader can act on, and it makes the source unreadable anywhere the issue tracker isn't at hand. If the rationale matters, state it or link to the spec section that holds it.

**No references to previous implementations.** Comments describe the code as it is now. Phrases like "the old two-call design", "this used to take a single page", or "before this fix" date the comment and describe code that no longer exists. State the invariant instead:

```ts
// Don't:
// The old two-call design could crash between saveVersion() and the
// mutation, leaving an orphan row that collided with every future snapshot.

// Do:
// A versions row at the record's own current version is an orphan: no
// legitimate snapshot carries that number, since a snapshot commits
// atomically with the bump past it.
```

The same applies to tests. A regression test's comment should say what invariant it pins, not what bug prompted it.

**If a rule needs more than a few lines to justify, it belongs in the spec.** Add the section, then link to it. Comments that duplicate spec prose drift out of sync with it.

---

## The spec is the source of truth

Design decisions live in [`docs/spec.md`](./docs/spec.md) and its sub-documents under [`docs/spec/`](./docs/spec/). Code comments link _to_ the spec; they don't restate it.

A change to observable behavior — an API contract, a permission rule, a wire shape, an error mapping — updates the spec in the same PR. If you find yourself writing a long comment to explain a rule that isn't in the spec, that's the signal the spec is missing a section.

When you link to a spec section from a comment, use the `docs/spec/<file>.md § Section` form and make sure the section actually exists. Section names are load-bearing; renaming a heading means updating the references to it.

---

## No backward compatibility yet

**There is no install base.** Nothing depends on this library's current behavior, so there is nothing to preserve. Prefer changing things in place over carrying compatibility shims:

- No accepting an older data format "just in case" — no such data exists.
- No deprecation cycles; delete the old thing.
- No `legacy` branches in decoders, and no `legacy` in prose. A third-party implementation of the wire protocol is _foreign_, not legacy — that distinction is real and worth keeping.

The same policy is written down for the Schema Commons ([`docs/commons/README.md`](./docs/commons/README.md)), which changes definitions in place without version bumps for exactly this reason. When an install base appears, this section is the first thing that should change.

Note that this is about _our_ history, not about inputs we genuinely receive. Handling a foreign server's response shape, or a stack file written by another adapter, is current-behavior compatibility and stays.

---

## Architecture conventions

**`Stack` is the invariant layer; adapters are storage engines.** Validation, `_config` protection, ID rules, migration policy, and permission logic live in `packages/core` so every adapter inherits them. An adapter that reimplements an invariant is a bug waiting to diverge. The deliberate exception is documented in the spec: the `_config` query exclusion must live in each adapter's own query predicate, because post-filtering in `Stack` would under-fill a page.

**Package naming declares the adapter contract**, per [`docs/spec/adapters.md`](./docs/spec/adapters.md):

| Prefix             | Implements           |
| ------------------ | -------------------- |
| `adapter-*`        | full `StackAdapter`  |
| `record-adapter-*` | `StackRecordAdapter` |
| `blob-adapter-*`   | `StackBlobAdapter`   |

**Optional adapter capabilities follow one pattern**: an optional interface method, checked for truthiness at the call site, with a described fallback when absent — never a boolean flag in `capabilities`. `combineAdapters()` forwards an optional method only when the underlying part actually implements it.

**Logic shared between the two SQLite adapters goes in `@haverstack/sqlite-shared`**, an internal (unpublished-as-public-API) package. Keeping schema DDL, the cursor codec, and the CRUD logic in one place is what keeps the two engines from silently drifting and keeps a cursor minted by one decodable by the other. Only genuinely engine-specific code (WASM init vs. `DatabaseSync`, pragma setup, lifecycle) belongs in the adapter packages.

**Wire-format behavior is pinned by shared fixtures.** `@haverstack/conformance-fixtures` is pure data — no test framework, no adapter, no server. Two independent consumers exercise the same fixtures: `adapter-api`'s tests, and any server implementation. A change to the wire contract updates the fixtures, the spec, and the implementation together.

---

## Testing conventions

Tests use [Vitest](https://vitest.dev/) and live in each package's `tests/` directory.

`@haverstack/core/testing` exports the shared test doubles:

- **`MemoryAdapter`** — an in-memory `StackAdapter` implementing the full `RecordFilter` shape, so permission logic under test exercises real predicates rather than an adapter that quietly ignores filters. It declares `contentFieldQuery: true`, as every local adapter must.
- **`IncapableMemoryAdapter`** — declares `contentFieldQuery: false`, simulating the one legitimate case (a wire adapter whose server declined the capability). Use it to exercise capability-gated fallback paths; don't reach for a `false` override on `MemoryAdapter`.

Name tests after the behavior they pin, not the defect that prompted them. `'a grant beyond the first page (>50 _grant records) is still honored'` survives refactoring; `'regression for #50'` doesn't.

---

## Where things live

```
docs/
  spec.md                 # Design spec — overview and index
  spec/                   # Data model, identity, access control, versioning,
                          #   attachments, adapters, wire format
  commons/                # Schema Commons — shared, app-neutral record types
packages/
  core/                   # Stack, ScopedStack, types, schema, validation, MemoryAdapter
  sqlite-shared/          # Internal: shared SQL logic for both SQLite adapters
  record-adapter-sqlite/  # Node native SQLite (node:sqlite), FTS5, WAL
  record-adapter-sqljs/   # Browser sql.js, FTS4, pluggable persistence
  blob-adapter-disk/      # Content-addressed blobs on disk
  adapter-local/          # Convenience: SQLite records + disk blobs
  adapter-api/            # HTTP client for stack servers
  wire-types/             # Wire serialization shapes and error mapping
  conformance-fixtures/   # Wire-format fixtures shared by client and server
```
